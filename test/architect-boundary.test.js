import assert from "node:assert/strict";
import test from "node:test";

import {
  createExtensionHarness,
  emitExtensionEvent,
} from "./helpers.js";

const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };

async function callToolCall(harness, toolName, input = {}) {
  let blocked;
  for (const handler of harness.handlers.get("tool_call") ?? []) {
    const result = await handler({ toolName, input }, harness.context);
    if (result?.block) blocked = result;
  }
  return blocked;
}

function architectHarness() {
  return createExtensionHarness([], {
    model: architect,
    availableModels: [architect, developer],
  });
}

test("architect 可直接只读定位，但拒绝写入、执行和未知工具", async () => {
  const harness = architectHarness();
  await emitExtensionEvent(harness, "session_start");

  for (const toolName of ["switch_role", "task_workflow", "read", "grep", "find", "ls", "ffgrep", "fffind"]) {
    assert.equal(await callToolCall(harness, toolName), undefined, toolName);
  }

  for (const toolName of [
    "bash",
    "powershell",
    "mcp",
    "mcp__penpot_execute_code",
    "edit",
    "write",
    "init_project",
    "subtask",
    "future-exploration-tool",
  ]) {
    const result = await callToolCall(harness, toolName);
    assert.equal(result?.block, true, toolName);
    assert.match(result?.reason ?? "", /architect-boundary/);
    assert.match(result?.reason ?? "", /switch_role/);
  }
});

test("architect 只允许安全的 browser 观察命令", async () => {
  const harness = architectHarness();
  await emitExtensionEvent(harness, "session_start");

  for (const command of [
    "open https://example.com",
    "snapshot -i",
    "get text",
    "get title @e1",
    "get url",
    "wait 100",
    "wait @e1",
    "scroll down 200",
    "screenshot --full",
  ]) {
    assert.equal(await callToolCall(harness, "browser", { command }), undefined, command);
  }

  for (const command of [
    "click @e1",
    "fill @e1 password",
    "type @e1 text",
    "select @e1 value",
    "press Enter",
    "persist on work",
    "close",
    "eval document.title",
    "open file:///secret.txt",
    "open https://example.com && get text",
    "snapshot -i; get text",
    "open https://example.com\nget text",
  ]) {
    const result = await callToolCall(harness, "browser", { command });
    assert.equal(result?.block, true, command);
    assert.match(result?.reason ?? "", /browser/);
  }

  const malformed = await callToolCall(harness, "browser", { command: "get cookies" });
  assert.equal(malformed?.block, true);
});

test("非 architect 角色和未知角色不触发 architect 守卫", async () => {
  const developerHarness = createExtensionHarness([], {
    model: developer,
    availableModels: [developer, architect],
  });
  await emitExtensionEvent(developerHarness, "session_start");
  assert.equal(await callToolCall(developerHarness, "read"), undefined);
  assert.equal(await callToolCall(developerHarness, "write"), undefined);

  const unknownModel = { provider: "custom", id: "unknown-model" };
  const unknownHarness = createExtensionHarness([], {
    model: unknownModel,
    availableModels: [unknownModel],
  });
  await emitExtensionEvent(unknownHarness, "session_start");
  assert.equal(await callToolCall(unknownHarness, "read"), undefined);
  assert.equal(await callToolCall(unknownHarness, "unknown-tool"), undefined);
});

test("architect 切换到 docs-commit 后恢复探索能力", async () => {
  const harness = architectHarness();
  await emitExtensionEvent(harness, "session_start");
  const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
  assert.ok(switchRole);

  await switchRole.execute("docs", { role: "docs-commit" }, undefined, undefined, harness.context);
  assert.equal(await callToolCall(harness, "read"), undefined);
  assert.equal(await callToolCall(harness, "grep"), undefined);
  assert.equal(await callToolCall(harness, "browser"), undefined);
});
