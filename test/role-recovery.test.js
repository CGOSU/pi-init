import assert from "node:assert/strict";
import test from "node:test";
import { ROLE_RECOVERY_ENTRY_TYPE } from "../extensions/role-recovery.ts";
import {
  DEFAULT_ROLE_CONFIG,
  createExtensionHarness,
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

async function withConfiguredHarness(mode, branch, options, run) {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, ".pi"), { recursive: true });
    const roleModels = Object.fromEntries(
      Object.entries(DEFAULT_ROLE_CONFIG.roleModels).map(([role, model]) => [role, { ...model }]),
    );
    Object.assign(roleModels, options.roleModels ?? {});
    await writeFile(
      path.join(directory, ".pi", "role-models.json"),
      `${JSON.stringify({ ...DEFAULT_ROLE_CONFIG, mode, roleModels })}\n`,
    );
    await run(createExtensionHarness(branch, { ...options, cwd: directory, trusted: true }));
  });
}

test("上下文压缩后必须恢复职责才能执行写入工具", async () => {
  const harness = createExtensionHarness();
  await emitExtensionEvent(harness, "session_start");
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
  assert.match(recoveryMessage.content, /task_workflow\(action="status"\)/);
  assert.match(recoveryMessage.content, /switch_role\(role=\.\.\.\)/);
  const repeated = context(recoveryContext, harness.context);
  assert.equal(
    repeated.messages.filter((message) => message.customType === ROLE_RECOVERY_ENTRY_TYPE).length,
    1,
  );

  const toolCall = getHandler(harness, "tool_call");
  const blocked = toolCall({ toolName: "edit", input: { path: "src/feature.js" } }, harness.context);
  assert.equal(blocked.block, true);
  assert.equal(blocked.terminate, undefined);
  assert.match(blocked.reason, /职责尚未重新确认/);
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

test("session_tree 只按目标 branch 的最新职责恢复记录解锁", async () => {
  const branch = recoveryBranch();
  const harness = createExtensionHarness(branch);
  await emitExtensionEvent(harness, "session_start", { reason: "new" });
  const toolCall = getHandler(harness, "tool_call");
  assert.equal(toolCall({ toolName: "write", input: { path: "README.md" } }, harness.context).block, true);

  branch.splice(0, branch.length, ...recoveryBranch("acknowledged"));
  await emitExtensionEvent(harness, "session_tree");
  assert.equal(toolCall({ toolName: "write", input: { path: "README.md" } }, harness.context), undefined);

  branch.splice(0, branch.length, ...recoveryBranch());
  await emitExtensionEvent(harness, "session_tree");
  assert.equal(toolCall({ toolName: "write", input: { path: "README.md" } }, harness.context).block, true);
});

test("auto 模式只有角色应用成功才解除恢复门", async () => {
  await withConfiguredHarness("auto", recoveryBranch(), {}, async (harness) => {
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    await assert.rejects(
      switchRole.execute("unknown", { role: "unknown" }, undefined, undefined, harness.context),
      /未配置模型/,
    );
    assert.equal(harness.branch.at(-1).data.status, "pending");
    await switchRole.execute("developer-test", { role: "developer-test" }, undefined, undefined, harness.context);
    assert.equal(harness.branch.at(-1).data.status, "acknowledged");
  });

  await withConfiguredHarness("auto", recoveryBranch(), {
    roleModels: {
      "developer-test": { ...DEFAULT_ROLE_CONFIG.roleModels["developer-test"], model: "missing-model" },
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

  await withConfiguredHarness("auto", recoveryBranch(), { setModelResult: false }, async (harness) => {
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    await assert.rejects(
      switchRole.execute("credentials", { role: "developer-test" }, undefined, undefined, harness.context),
      /缺少可用凭据/,
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
