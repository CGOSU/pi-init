import assert from "node:assert/strict";
import test from "node:test";

import {
  createExtensionHarness,
  emitExtensionEvent,
} from "./helpers.js";
import {
  ARCHITECT_ALLOWED_ACTIONS_TEXT,
  ARCHITECT_ALLOWED_TASK_WORKFLOW_ACTIONS,
} from "../extensions/architect-boundary.ts";

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

test("architect 仅允许职责切换、规划及纯协调控制", async () => {
  const harness = architectHarness();
  await emitExtensionEvent(harness, "session_start");
  await harness.tools.find((tool) => tool.name === "switch_role").execute(
    "architect", { role: "architect" }, undefined, undefined, harness.context,
  );

  assert.equal(await callToolCall(harness, "switch_role", { role: "docs-commit" }), undefined);
  for (const action of ["plan", "replan", "status", "request-evidence", "review-evidence"]) {
    assert.equal(await callToolCall(harness, "task_workflow", { action }), undefined, action);
  }

  for (const action of ["complete", "block", "resume", "retry", "cancel", "report-evidence", "clarify", "unknown", ""]) {
    assertArchitectBlocked(await callToolCall(harness, "task_workflow", { action }), `task_workflow:${action}`);
  }
  assertArchitectBlocked(await callToolCall(harness, "task_workflow"), "task_workflow:missing-action");
  assertArchitectBlocked(await callToolCall(harness, "task_workflow", null), "task_workflow:null-input");
});

test("architect 对取证、执行、MCP、协作和未知工具全部 fail-closed", async () => {
  const harness = architectHarness();
  await emitExtensionEvent(harness, "session_start");
  await harness.tools.find((tool) => tool.name === "switch_role").execute(
    "architect", { role: "architect" }, undefined, undefined, harness.context,
  );

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

test("architect 允许动作单一定义同时驱动运行时边界与工具/契约指导", async () => {
  const harness = architectHarness();
  await emitExtensionEvent(harness, "session_start");
  await harness.tools.find((tool) => tool.name === "switch_role").execute(
    "architect", { role: "architect" }, undefined, undefined, harness.context,
  );

  for (const action of ARCHITECT_ALLOWED_TASK_WORKFLOW_ACTIONS) {
    assert.equal(await callToolCall(harness, "task_workflow", { action }), undefined, action);
  }
  assert.deepEqual([...ARCHITECT_ALLOWED_TASK_WORKFLOW_ACTIONS], [
    "plan", "replan", "status", "request-replan", "request-child", "review-child", "request-evidence", "review-evidence",
  ]);

  const blocked = await callToolCall(harness, "task_workflow", { action: "report-evidence" });
  assert.match(blocked.reason, new RegExp(ARCHITECT_ALLOWED_ACTIONS_TEXT));

  const workflowTool = harness.tools.find((tool) => tool.name === "task_workflow");
  const guidance = [workflowTool.description, ...workflowTool.promptGuidelines];
  for (const action of ARCHITECT_ALLOWED_TASK_WORKFLOW_ACTIONS) {
    assert.ok(guidance.some((line) => line.includes(action)), `工具指导缺少 ${action}`);
  }
  assert.ok(guidance.some((line) => line.includes(ARCHITECT_ALLOWED_ACTIONS_TEXT)), "工具指导必须复用同一份允许动作说明");
  assert.ok(guidance.some((line) => /task contract 与协调状态是双向门控/.test(line) && /普通计划不要附带 contract/.test(line)), "工具指导必须说明契约与协调状态的前置条件");
  assert.ok(guidance.some((line) => /Task contracts are optional for ordinary plans/.test(line)), "工具描述必须说明普通任务无契约路径");
  const contractDescription = workflowTool.parameters.properties.tasks.items.properties.contract.description;
  assert.match(contractDescription, /普通任务保持无 contract 路径/);
  assert.match(workflowTool.parameters.properties.coordinationHandoffId.description, /handoff 短引用/);
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

  await switchRole.execute("architect", { role: "architect" }, undefined, undefined, harness.context);
  await switchRole.execute("docs", { role: "docs-commit" }, undefined, undefined, harness.context);
  assert.equal(await callToolCall(harness, "read"), undefined);
  assert.equal(await callToolCall(harness, "grep"), undefined);
  assert.equal(await callToolCall(harness, "browser"), undefined);
});
