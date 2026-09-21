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

function assertArchitectBlocked(result, toolName) {
  assert.equal(result?.block, true, toolName);
}

test("architect 仅允许职责切换和 task_workflow 规划控制", async () => {
  const harness = architectHarness();
  await emitExtensionEvent(harness, "session_start");

  assert.equal(await callToolCall(harness, "switch_role", { role: "docs-commit" }), undefined);
  for (const action of ["plan", "replan", "status"]) {
    assert.equal(await callToolCall(harness, "task_workflow", { action }), undefined, action);
  }

  for (const action of ["complete", "block", "resume", "retry", "cancel", "unknown", ""]) {
    assertArchitectBlocked(await callToolCall(harness, "task_workflow", { action }), `task_workflow:${action}`);
  }
  assertArchitectBlocked(await callToolCall(harness, "task_workflow"), "task_workflow:missing-action");
  assertArchitectBlocked(await callToolCall(harness, "task_workflow", null), "task_workflow:null-input");
});

test("architect 对取证、执行、MCP、协作和未知工具全部 fail-closed", async () => {
  const harness = architectHarness();
  await emitExtensionEvent(harness, "session_start");

  for (const toolName of [
    "read",
    "grep",
    "find",
    "ffgrep",
    "fffind",
    "browser",
    "ls",
    "shell",
    "bash",
    "powershell",
    "edit",
    "write",
    "init_project",
    "mcp",
    "mcpScript",
    "mcp__penpot_execute_code",
    "direct-mcp",
    "subtask",
    "agent_message",
    "future-exploration-tool",
  ]) {
    assertArchitectBlocked(await callToolCall(harness, toolName), toolName);
  }

  assertArchitectBlocked(
    await callToolCall(harness, "browser", { command: "open https://example.com" }),
    "browser-command",
  );
});

test("非 architect 角色和未知角色不触发 architect 守卫", async () => {
  const developerHarness = createExtensionHarness([], {
    model: developer,
    availableModels: [developer, architect],
  });
  await emitExtensionEvent(developerHarness, "session_start");
  assert.equal(await callToolCall(developerHarness, "read"), undefined);
  assert.equal(await callToolCall(developerHarness, "write"), undefined);
  assert.equal(await callToolCall(developerHarness, "unknown-tool"), undefined);

  const unknownModel = { provider: "custom", id: "unknown-model" };
  const unknownHarness = createExtensionHarness([], {
    model: unknownModel,
    availableModels: [unknownModel],
  });
  await emitExtensionEvent(unknownHarness, "session_start");
  assert.equal(await callToolCall(unknownHarness, "read"), undefined);
  assert.equal(await callToolCall(unknownHarness, "unknown-tool"), undefined);
});

test("非 architect 角色在工具调用入口阻断工作流规划", async () => {
  const harness = createExtensionHarness([], {
    model: developer,
    availableModels: [developer, architect],
  });
  await emitExtensionEvent(harness, "session_start");

  for (const action of ["plan", "replan"]) {
    const result = await callToolCall(harness, "task_workflow", { action });
    assert.equal(result?.block, true, action);
    }
  assert.equal(await callToolCall(harness, "task_workflow", { action: "complete" }), undefined);
});

test("architect 切换到 docs-commit 后恢复探索能力", async () => {
  const harness = architectHarness();
  await emitExtensionEvent(harness, "session_start");
  const switchRole = harness.tools.find((tool) => tool.name === "switch_role");

  await switchRole.execute("docs", { role: "docs-commit" }, undefined, undefined, harness.context);
  assert.equal(await callToolCall(harness, "read"), undefined);
  assert.equal(await callToolCall(harness, "grep"), undefined);
  assert.equal(await callToolCall(harness, "browser"), undefined);
});
