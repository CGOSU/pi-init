import assert from "node:assert/strict";
import test from "node:test";
import { ROLE_RECOVERY_ENTRY_TYPE } from "../extensions/role-recovery.ts";
import {
  DEFAULT_ROLE_CONFIG,
  createExtensionHarness,
  createWorkflowState,
  emitExtensionEvent,
  mkdir,
  path,
  withTempDirectory,
  writeFile,
} from "./helpers.js";

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
    harness.handlers.get("tool_call")[0]({ toolName: "edit", input: {} }, harness.context).block,
    true,
  );
});

test("before_agent_start 在活动 Local 工作流恢复时仍要求先查看状态", async () => {
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

  const callTool = async (toolName, input = {}) => {
    let blocked;
    for (const handler of harness.handlers.get("tool_call") ?? []) {
      const result = await handler({ toolName, input }, harness.context);
      if (result?.block) blocked = result;
    }
    return blocked;
  };
  assert.equal((await callTool("read"))?.block, true);
  assert.equal((await callTool("agent_message"))?.block, true);
  assert.equal(await callTool("task_workflow", { action: "status" }), undefined);
  assert.equal((await callTool("task_workflow", { action: "plan" }))?.block, true);
  assert.equal(await callTool("switch_role", { role: "docs-commit" }), undefined);
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

  const context = getHandler(harness, "context");
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

  const toolCall = getHandler(harness, "tool_call");
  const blocked = toolCall({ toolName: "edit", input: { path: "src/feature.js" } }, harness.context);
  assert.equal(blocked.block, true);
  assert.equal(blocked.terminate, undefined);
  assert.equal(toolCall({ toolName: "read", input: { path: "src/feature.js" } }, harness.context), undefined);
  assert.equal(toolCall({ toolName: "task_workflow", input: { action: "status" } }, harness.context), undefined);
  assert.equal(toolCall({ toolName: "task_workflow", input: { action: "complete" } }, harness.context).block, true);

  const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
  await switchRole.execute("developer-test", { role: "developer-test" }, undefined, undefined, harness.context);
  assert.equal(toolCall({ toolName: "edit", input: { path: "src/feature.js" } }, harness.context), undefined);
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
  const toolCall = getHandler(harness, "tool_call");
  assert.equal(toolCall({ toolName: "write", input: { path: "README.md" } }, harness.context).block, true);

  const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
  await switchRole.execute("developer-test", { role: "developer-test" }, undefined, undefined, harness.context);
  assert.equal(toolCall({ toolName: "write", input: { path: "README.md" } }, harness.context), undefined);
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
    const result = getHandler(harness, "tool_call")({
      toolName: "write",
      input: { path: "README.md" },
    }, harness.context);
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
  const toolCall = getHandler(harness, "tool_call");
  assert.equal(toolCall({ toolName: "write", input: { path: "README.md" } }, harness.context).block, true);

  branch.splice(0, branch.length, ...recoveryBranch("acknowledged"));
  await emitExtensionEvent(harness, "session_tree", { oldLeafId: "pending-leaf", newLeafId: "acknowledged-leaf" });
  assert.equal(toolCall({ toolName: "write", input: { path: "README.md" } }, harness.context).block, true);
  assert.equal(harness.branch.at(-1).data.status, "pending");

  branch.splice(0, branch.length, ...recoveryBranch());
  await emitExtensionEvent(harness, "session_tree", { oldLeafId: "acknowledged-leaf", newLeafId: "pending-leaf" });
  assert.equal(toolCall({ toolName: "write", input: { path: "README.md" } }, harness.context).block, true);
});

test("manual 模式的 branch 恢复指引使用 /pi-init role，避免重复调用 switch_role", async () => {
  const model = { provider: "test-provider", id: "manual-model" };
  await withConfiguredHarness("manual", recoveryBranch("acknowledged"), {
    model,
    availableModels: [model],
    roleModels: { "developer-test": { provider: model.provider, model: model.id, thinkingLevel: "max" } },
  }, async (harness) => {
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    await emitExtensionEvent(harness, "session_tree", { oldLeafId: "old", newLeafId: "new" });
    const runtime = await beforeAgentStart(harness);
    assert.match(Object.values(runtime.systemPromptOptions.sections).join("\\n"), /manual 模式.*\/pi-init role/);

    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    await assert.rejects(
      switchRole.execute("manual-unestablished", { role: "developer-test" }, undefined, undefined, harness.context),
      /当前为手动模式/,
    );
    assert.equal(harness.branch.at(-1).data.status, "pending");

    await harness.commands.get("pi-init").handler("role developer-test", harness.context);
    assert.equal(harness.branch.at(-1).data.status, "acknowledged");
    assert.equal(getHandler(harness, "tool_call")({ toolName: "write", input: {} }, harness.context), undefined);
  });
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
    const toolCall = getHandler(harness, "tool_call");
    assert.equal(toolCall({ toolName: "write", input: {} }, harness.context).block, true);

    await emitExtensionEvent(harness, "session_tree", { oldLeafId: "same", newLeafId: "same" });
    assert.equal(toolCall({ toolName: "write", input: {} }, harness.context).block, true);
    failPersistence = false;
    await harness.tools.find((tool) => tool.name === "switch_role").execute(
      "restore-after-persist-failure", { role: "developer-test" }, undefined, undefined, harness.context,
    );
    assert.equal(harness.branch.at(-1).data.status, "acknowledged");
    assert.equal(toolCall({ toolName: "write", input: {} }, harness.context), undefined);
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

test("confirm 模式的当前确认、接受、取消和失败路径统一维护恢复门", async () => {
  const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
  const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };
  await withConfiguredHarness("confirm", recoveryBranch(), {
    model: developer,
    availableModels: [developer, architect],
    roleModels: { "developer-test": { provider: developer.provider, model: developer.id, thinkingLevel: "max" } },
  }, async (harness) => {
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    await switchRole.execute("same", { role: "developer-test" }, undefined, undefined, harness.context);
    assert.equal(harness.branch.at(-1).data.status, "acknowledged");
  });

  await withConfiguredHarness("confirm", recoveryBranch(), {
    model: architect,
    availableModels: [architect, developer],
    select: async () => "采用建议",
  }, async (harness) => {
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    await switchRole.execute("accept", { role: "developer-test" }, undefined, undefined, harness.context);
    assert.equal(harness.branch.at(-1).data.status, "acknowledged");
  });

  await withConfiguredHarness("confirm", recoveryBranch(), {
    model: architect,
    availableModels: [architect, developer],
    select: async () => "取消",
  }, async (harness) => {
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    await assert.rejects(
      switchRole.execute("cancel", { role: "developer-test" }, undefined, undefined, harness.context),
      /已取消角色切换/,
    );
    assert.equal(harness.branch.at(-1).data.status, "pending");
  });

  await withConfiguredHarness("confirm", recoveryBranch(), {
    model: architect,
    availableModels: [architect, developer],
    roleModels: { "developer-test": { provider: developer.provider, model: developer.id, thinkingLevel: "max" } },
    select: async () => "采用建议",
    setModelResult: false,
  }, async (harness) => {
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    await assert.rejects(
      switchRole.execute("failed", { role: "developer-test" }, undefined, undefined, harness.context),
      /缺少可用凭据/,
    );
    assert.equal(harness.branch.at(-1).data.status, "pending");
  });
});

test("manual 模式只在验证当前角色或显式应用角色后解除恢复门", async () => {
  const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
  const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };
  await withConfiguredHarness("manual", recoveryBranch(), {
    model: developer,
    availableModels: [developer, architect],
    roleModels: { "developer-test": { provider: developer.provider, model: developer.id, thinkingLevel: "max" } },
  }, async (harness) => {
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    await switchRole.execute("verified", { role: "developer-test" }, undefined, undefined, harness.context);
    assert.equal(harness.branch.at(-1).data.status, "acknowledged");
  });

  await withConfiguredHarness("manual", recoveryBranch(), {
    model: architect,
    availableModels: [architect, developer],
  }, async (harness) => {
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    await assert.rejects(
      switchRole.execute("mismatch", { role: "developer-test" }, undefined, undefined, harness.context),
      /当前为手动模式/,
    );
    assert.equal(harness.branch.at(-1).data.status, "pending");
  });

  await withConfiguredHarness("manual", recoveryBranch(), {
    model: architect,
    availableModels: [architect, developer],
  }, async (harness) => {
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    await harness.commands.get("pi-init").handler("role developer-test", harness.context);
    assert.equal(harness.branch.at(-1).data.status, "acknowledged");
  });
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

  const toolCall = getHandler(harness, "tool_call");
  assert.equal(toolCall({ toolName: "edit", input: { path: "src/feature.js" } }, harness.context).block, true);
  assert.equal(harness.entries.at(-1).data.status, "pending");
});
