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

test("architect 只允许职责切换和工作流编排工具", async () => {
  const harness = architectHarness();
  await emitExtensionEvent(harness, "session_start");

  for (const toolName of ["switch_role", "task_workflow"]) {
    assert.equal(await callToolCall(harness, toolName), undefined, toolName);
  }

  for (const toolName of [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "powershell",
    "browser",
    "mcp",
    "edit",
    "write",
    "init_project",
    "future-exploration-tool",
  ]) {
    const result = await callToolCall(harness, toolName);
    assert.equal(result?.block, true, toolName);
    assert.match(result?.reason ?? "", /architect-boundary/);
    assert.match(result?.reason ?? "", /switch_role.*docs-commit/);
  }
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
