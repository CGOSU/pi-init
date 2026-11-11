import assert from "node:assert/strict";
import test from "node:test";
import { ROLE_RECOVERY_ENTRY_TYPE } from "../extensions/role-recovery.ts";
import { DEFAULT_ROLE_CONFIG } from "../src/roles.ts";
import { createExtensionHarness, emitExtensionEvent, callToolCall } from "./support/extension-harness.js";
import { createWorkflowState } from "./support/workflow-fixtures.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { withTempDirectory } from "./support/temp-directory.js";

function getHandler(harness, name) {
  const handler = harness.handlers.get(name)?.[0];
  assert.ok(handler, `缺少 ${name} 处理器`);
  return handler;
}

function recoveryBranch(status = "pending") {
  return [{
    type: "custom",
    customType: ROLE_RECOVERY_ENTRY_TYPE,
    data: { status, reason: "test" },
  }];
}

async function beforeAgentStart(harness) {
  const event = {
    type: "before_agent_start",
    prompt: "简单问题",
    systemPrompt: "",
    systemPromptOptions: { sections: {} },
  };
  for (const handler of harness.handlers.get("before_agent_start") ?? []) {
    await handler(event, harness.context);
  }
  return event;
}

async function withConfiguredHarness(mode, branch, options, run) {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, ".pi"), { recursive: true });
    const roleModels = { ...(options.roleModels ?? {}) };
    await writeFile(
      path.join(directory, ".pi", "role-models.json"),
      `${JSON.stringify({ ...DEFAULT_ROLE_CONFIG, mode, roleModels })}\n`,
    );
    await run(createExtensionHarness(branch, { ...options, cwd: directory, trusted: true }));
  });
}

test("before_agent_start 为无活动工作流的恢复门提供简单问答快速通道", async () => {
  const harness = createExtensionHarness(recoveryBranch());
  await emitExtensionEvent(harness, "session_start", { reason: "new" });

  await beforeAgentStart(harness);
  assert.equal(harness.branch.at(-1).data.status, "pending");
  assert.equal(
    (await emitExtensionEvent(harness, "tool_call", { toolName: "edit", input: {} })).block,
    true,
  );
});

test("before_agent_start 在活动 Local 工作流恢复时保留职责恢复门", async () => {
  const workflow = createWorkflowState({
    summary: "恢复状态测试",
    tasks: [{ id: "task", role: "developer-test", task: "执行任务", files: ["src"], acceptanceCriteria: ["完成"] }],
  });
  workflow.status = "running";
  workflow.currentTaskId = "task";
  const harness = createExtensionHarness([
    ...recoveryBranch(),
    { type: "custom", customType: "pi-init-workflow", data: workflow },
  ]);
  await emitExtensionEvent(harness, "session_start", { reason: "new" });

  await beforeAgentStart(harness);
  assert.equal(harness.branch.findLast((entry) => entry.customType === ROLE_RECOVERY_ENTRY_TYPE).data.status, "pending");
});

test("before_agent_start 注入已确认角色和快速路由规则", async () => {
  const model = { provider: "openai-codex", id: "gpt-5.6-luna" };
  await withConfiguredHarness("auto", recoveryBranch("acknowledged"), {
    model,
    availableModels: [model],
    thinkingLevel: "max",
    roleModels: {
      "developer-test": { provider: model.provider, model: model.id, thinkingLevel: "max" },
    },
  }, async (harness) => {
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    await beforeAgentStart(harness);
    assert.equal(harness.branch.some((entry) => entry.customType === ROLE_RECOVERY_ENTRY_TYPE && entry.data.status === "pending"), false);
  });
});

test("架构师恢复门只允许工作流状态和职责切换", async () => {
  const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
  const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };
  const harness = createExtensionHarness(recoveryBranch(), {
    model: architect,
    availableModels: [architect, developer],
  });
  await emitExtensionEvent(harness, "session_start");

  for (const toolName of ["read", "grep", "find", "ls", "ffgrep", "fffind", "graph_locate", "graph_inspect", "obs_recall", "agent_message"]) {
    assert.equal((await callToolCall(harness, toolName))?.block, true, toolName);
  }
  assert.equal(await callToolCall(harness, "task_workflow", { action: "status" }), undefined);
  assert.equal((await callToolCall(harness, "task_workflow", { action: "plan" }))?.block, true);
  assert.equal(await callToolCall(harness, "switch_role", { role: "docs-commit" }), undefined);
});

test("上下文压缩后必须恢复职责才能执行写入工具", async () => {
  const harness = createExtensionHarness();
  await emitExtensionEvent(harness, "session_start");
  await harness.tools.find((tool) => tool.name === "switch_role").execute(
    "initial-role", { role: "developer-test" }, undefined, undefined, harness.context,
  );
  await harness.completeCompaction({ reason: "manual" });
  assert.equal(harness.entries.at(-1).type, ROLE_RECOVERY_ENTRY_TYPE);
  assert.equal(harness.branch.at(-1).customType, ROLE_RECOVERY_ENTRY_TYPE);
  assert.equal(harness.entries.at(-1).data.status, "pending");

  const context = (event, ctx) => {
    let messages = event.messages;
    for (const handler of harness.handlers.get("context_with_system") ?? []) {
      messages = handler({ type: "context_with_system", messages }, ctx)?.messages ?? messages;
    }
    return { messages };
  };
  const recoveryContext = context({
    messages: [{ role: "user", content: "继续任务", timestamp: Date.now() }],
  }, harness.context);
  const recoveryMessage = recoveryContext.messages.at(-1);
  assert.equal(recoveryMessage.customType, ROLE_RECOVERY_ENTRY_TYPE);
  const repeated = context(recoveryContext, harness.context);
  assert.equal(
    repeated.messages.filter((message) => message.customType === ROLE_RECOVERY_ENTRY_TYPE).length,
    1,
  );

  const toolCall = (event) => emitExtensionEvent(harness, "tool_call", event);
  const blocked = await toolCall({ toolName: "edit", input: { path: "src/feature.js" } });
  assert.equal(blocked.block, true);
  assert.equal(blocked.terminate, undefined);
  assert.equal(await toolCall({ toolName: "read", input: { path: "src/feature.js" } }), undefined);
  assert.equal(await toolCall({ toolName: "task_workflow", input: { action: "status" } }), undefined);
  assert.equal((await toolCall({ toolName: "task_workflow", input: { action: "complete" } })).block, true);

  const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
  await switchRole.execute("developer-test", { role: "developer-test" }, undefined, undefined, harness.context);
  assert.equal(await toolCall({ toolName: "edit", input: { path: "src/feature.js" } }), undefined);
  assert.equal(harness.entries.at(-1).data.status, "acknowledged");
});

test("职责恢复门在会话恢复后继续生效，并允许显式角色切换解除", async () => {
  const pending = [{
    type: "custom",
    customType: ROLE_RECOVERY_ENTRY_TYPE,
    data: { status: "pending", reason: "threshold" },
  }];
  const harness = createExtensionHarness(pending);
  await emitExtensionEvent(harness, "session_start");
  const toolCall = (event) => emitExtensionEvent(harness, "tool_call", event);
  assert.equal((await toolCall({ toolName: "write", input: { path: "README.md" } })).block, true);

  const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
  await switchRole.execute("developer-test", { role: "developer-test" }, undefined, undefined, harness.context);
  assert.equal(await toolCall({ toolName: "write", input: { path: "README.md" } }), undefined);
});

test("session_start 按恢复原因和 branch 内容重新锁定职责", async () => {
  const cases = [
    ["reload", [{ type: "message" }], true],
    ["resume", [{ type: "message" }], true],
    ["fork", [{ type: "message" }], true],
    ["startup", [{ type: "message" }], true],
    ["new", [{ type: "message" }], false],
    ["startup", [], false],
    ["reload", [], false],
  ];
  for (const [reason, branch, expectedPending] of cases) {
    const harness = createExtensionHarness(branch);
    await emitExtensionEvent(harness, "session_start", { reason });
    const result = await emitExtensionEvent(harness, "tool_call", {
      toolName: "write",
      input: { path: "README.md" },
    });
    assert.equal(result?.block ?? false, expectedPending, reason);
    assert.equal(harness.entries.length, expectedPending ? 1 : 0, reason);
  }

  const acknowledged = createExtensionHarness([{ type: "message" }, ...recoveryBranch("acknowledged")]);
  await emitExtensionEvent(acknowledged, "session_start", { reason: "resume" });
  assert.equal(acknowledged.branch.at(-1).data.status, "pending");
  assert.equal(acknowledged.entries.length, 1);
});

test("session_tree 切换分支后必须重新确认职责，不能复用历史 acknowledged", async () => {
  const branch = recoveryBranch();
  const harness = createExtensionHarness(branch);
  await emitExtensionEvent(harness, "session_start", { reason: "new" });
  const toolCall = (event) => emitExtensionEvent(harness, "tool_call", event);
  assert.equal((await toolCall({ toolName: "write", input: { path: "README.md" } })).block, true);

  branch.splice(0, branch.length, ...recoveryBranch("acknowledged"));
  await emitExtensionEvent(harness, "session_tree", { oldLeafId: "pending-leaf", newLeafId: "acknowledged-leaf" });
  assert.equal((await toolCall({ toolName: "write", input: { path: "README.md" } })).block, true);
  assert.equal(harness.branch.at(-1).data.status, "pending");

  branch.splice(0, branch.length, ...recoveryBranch());
  await emitExtensionEvent(harness, "session_tree", { oldLeafId: "acknowledged-leaf", newLeafId: "pending-leaf" });
  assert.equal((await toolCall({ toolName: "write", input: { path: "README.md" } })).block, true);
});

test("旧限制配置的显式迁移不解除 branch 职责恢复门", async () => {
  for (const mode of ["manual", "confirm"]) {
    const model = { provider: "test-provider", id: "configured" };
    let activated = false;
    await withConfiguredHarness(mode, recoveryBranch("acknowledged"), {
      model, availableModels: [model],
      roleModels: { "developer-test": { provider: model.provider, model: model.id, thinkingLevel: "max" } },
      select: async (_title, items) => {
        if (!activated) { activated = true; return items.find(item => item === "启用全自动并迁移旧配置"); }
      },
    }, async (harness) => {
      const configPath = path.join(harness.context.cwd, ".pi", "role-models.json");
      const original = await readFile(configPath, "utf8");
      await emitExtensionEvent(harness, "session_start", { reason: "new" });
      await emitExtensionEvent(harness, "session_tree", { oldLeafId: "old", newLeafId: "new" });
      const switchRole = harness.tools.find(tool => tool.name === "switch_role");
      await assert.rejects(
        switchRole.execute("legacy", { role: "developer-test" }, undefined, undefined, harness.context),
        error => error.code === "AUTOMATIC_MIGRATION_REQUIRED",
      );
      assert.equal(harness.branch.at(-1).data.status, "pending");
      await harness.commands.get("pi-init").handler("config", harness.context);
      assert.equal(harness.branch.at(-1).data.status, "pending");
      assert.equal(await readFile(configPath, "utf8"), original);
      await switchRole.execute("activated", { role: "developer-test" }, undefined, undefined, harness.context);
      assert.equal(harness.branch.at(-1).data.status, "acknowledged");
      assert.equal(await emitExtensionEvent(harness, "tool_call", { toolName: "write", input: {} }), undefined);
    });
  }
});

test("职责恢复门持久化失败后仍 fail-closed，必须重新成功确认", async () => {
  let failPersistence = true;
  await withConfiguredHarness("auto", recoveryBranch("acknowledged"), {
    appendEntry(type) {
      if (failPersistence && type === ROLE_RECOVERY_ENTRY_TYPE) throw new Error("append failed");
    },
  }, async (harness) => {
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    await harness.completeCompaction({ reason: "manual" });
    const toolCall = (event) => emitExtensionEvent(harness, "tool_call", event);
    assert.equal((await toolCall({ toolName: "write", input: {} })).block, true);

    await emitExtensionEvent(harness, "session_tree", { oldLeafId: "same", newLeafId: "same" });
    assert.equal((await toolCall({ toolName: "write", input: {} })).block, true);
    failPersistence = false;
    await harness.tools.find((tool) => tool.name === "switch_role").execute(
      "restore-after-persist-failure", { role: "developer-test" }, undefined, undefined, harness.context,
    );
    assert.equal(harness.branch.at(-1).data.status, "acknowledged");
    assert.equal(await toolCall({ toolName: "write", input: {} }), undefined);
  });
});

test("损坏角色配置不被当作缺失配置触发会话模型 fallback", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, ".pi"), { recursive: true });
    await writeFile(path.join(directory, ".pi", "role-models.json"), "{ invalid json");
    const model = { provider: "test-provider", id: "session-default" };
    const harness = createExtensionHarness(recoveryBranch(), {
      cwd: directory,
      trusted: true,
      model,
      availableModels: [model],
    });
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    assert.match(harness.notifications.at(-1).message, /不是有效 JSON/);
    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    await assert.rejects(
      switchRole.execute("invalid-config", { role: "developer-test" }, undefined, undefined, harness.context),
      (error) => error.code === "ROLE_CONFIG_INVALID_JSON",
    );
    assert.equal(harness.context.model, model);
    assert.equal(harness.branch.at(-1).data.status, "pending");
  });
});

test("auto 模式只有角色应用成功才解除恢复门", async () => {
  await withConfiguredHarness("auto", recoveryBranch(), {}, async (harness) => {
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    await assert.rejects(
      switchRole.execute("unknown", { role: "unknown" }, undefined, undefined, harness.context),
      /未启用/
    );
    assert.equal(harness.branch.at(-1).data.status, "pending");
    await switchRole.execute("developer-test", { role: "developer-test" }, undefined, undefined, harness.context);
    assert.equal(harness.branch.at(-1).data.status, "acknowledged");
  });

  await withConfiguredHarness("auto", recoveryBranch(), {
    roleModels: {
      "developer-test": { provider: "test-provider", model: "missing-model", thinkingLevel: "max" },
    },
  }, async (harness) => {
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    await assert.rejects(
      switchRole.execute("missing", { role: "developer-test" }, undefined, undefined, harness.context),
      /模型不存在/,
    );
    assert.equal(harness.branch.at(-1).data.status, "pending");
  });

  const configuredModel = { provider: "test-provider", id: "configured-developer" };
  await withConfiguredHarness("auto", recoveryBranch(), {
    setModelResult: false,
    availableModels: [{ provider: "test-provider", id: "session-default" }, configuredModel],
    roleModels: {
      "developer-test": { provider: configuredModel.provider, model: configuredModel.id, thinkingLevel: "max" },
    },
  }, async (harness) => {
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    await assert.rejects(
      switchRole.execute("credentials", { role: "developer-test" }, undefined, undefined, harness.context),
      /缺少可用凭据/,
    );
    assert.equal(harness.branch.at(-1).data.status, "pending");
  });

  const currentModel = { provider: "test-provider", id: "session-default" };
  await withConfiguredHarness("auto", recoveryBranch(), {
    setModelResult: false,
    model: currentModel,
    availableModels: [currentModel],
    roleModels: {
      "developer-test": { provider: currentModel.provider, model: currentModel.id, thinkingLevel: "max" },
    },
  }, async (harness) => {
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    await assert.rejects(
      switchRole.execute("same-model-credentials", { role: "developer-test" }, undefined, undefined, harness.context),
      /缺少可用凭据/,
    );
    assert.equal(harness.branch.at(-1).data.status, "pending");
  });
});

test("未配置标准角色模型且当前会话无模型时失败并保留恢复门", async () => {
  await withConfiguredHarness("auto", recoveryBranch(), { model: null, availableModels: [] }, async (harness) => {
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    await assert.rejects(
      switchRole.execute("no-default", { role: "developer-test" }, undefined, undefined, harness.context),
      (error) => error.code === "SESSION_MODEL_UNAVAILABLE",
    );
    assert.equal(harness.branch.at(-1).data.status, "pending");
  });
});

test("全自动职责恢复不要求交互确认，取消或凭据失败仍保留恢复门", async () => {
  const architect = { provider: "test-provider", id: "architect" };
  const developer = { provider: "test-provider", id: "developer" };
  for (const scenario of ["same", "different", "aborted", "credentials"]) {
    await withConfiguredHarness("auto", recoveryBranch(), {
      model: scenario === "same" ? developer : architect,
      availableModels: [architect, developer],
      hasUI: false,
      roleModels: { "developer-test": { provider: developer.provider, model: developer.id, thinkingLevel: "max" } },
      select: () => assert.fail("normal role transitions must not ask for confirmation"),
      setModelResult: scenario !== "credentials",
    }, async harness => {
      await emitExtensionEvent(harness, "session_start", { reason: "new" });
      const controller = new AbortController();
      if (scenario === "aborted") controller.abort();
      const operation = harness.tools.find(tool => tool.name === "switch_role").execute(
        scenario, { role: "developer-test" }, controller.signal, undefined, harness.context,
      );
      if (scenario === "credentials") {
        await assert.rejects(operation, /缺少可用凭据/);
      } else {
        const result = await operation;
        if (scenario === "aborted") assert.equal(result.details.ok, false);
        else {
          assert.equal(result.details.model, developer.id);
          assert.equal("mode" in result.details, false);
        }
      }
      assert.equal(harness.branch.at(-1).data.status,
        ["aborted", "credentials"].includes(scenario) ? "pending" : "acknowledged");
    });
  }
});

test("第三方扩展提供的压缩仍进入职责恢复门", async () => {
  const harness = createExtensionHarness();
  const beforeHandlers = harness.handlers.get("session_before_compact") ?? [];
  beforeHandlers.push(() => ({
    compaction: {
      summary: "第三方摘要",
      firstKeptEntryId: "kept",
      tokensBefore: 100,
    },
  }));
  harness.handlers.set("session_before_compact", beforeHandlers);
  await harness.completeCompaction({ reason: "threshold" });

  const toolCall = (event) => emitExtensionEvent(harness, "tool_call", event);
  assert.equal((await toolCall({ toolName: "edit", input: { path: "src/feature.js" } })).block, true);
  assert.equal(harness.entries.at(-1).data.status, "pending");
});
