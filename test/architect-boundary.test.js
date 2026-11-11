import assert from "node:assert/strict";
import test from "node:test";

import { createExtensionHarness, emitExtensionEvent, callToolCall } from "./support/extension-harness.js";
import { withTempDirectory } from "./support/temp-directory.js";
import {
  ARCHITECT_ALLOWED_ACTIONS_TEXT,
  ARCHITECT_ALLOWED_TASK_WORKFLOW_ACTIONS,
} from "../extensions/architect-boundary.ts";

const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };

function architectHarness(options = {}) {
  return createExtensionHarness([], {
    model: architect,
    availableModels: [architect, developer],
    ...options,
  });
}

function assertArchitectBlocked(result, toolName) {
  assert.equal(result?.block, true, toolName);
}

test("architect 允许职责切换与扁平队列规划但拒绝执行动作", async () => {
  const harness = architectHarness();
  await emitExtensionEvent(harness, "session_start");
  await harness.tools.find((tool) => tool.name === "switch_role").execute(
    "architect", { role: "architect" }, undefined, undefined, harness.context,
  );

  assert.equal(await callToolCall(harness, "switch_role", { role: "docs-commit" }), undefined);
  for (const action of ["plan", "replan", "status", "request-replan", "request-goal"]) {
    assert.equal(await callToolCall(harness, "task_workflow", { action }), undefined, action);
  }

  for (const action of ["complete", "block", "resume", "retry", "cancel", "request-evidence", "review-evidence", "report-evidence", "clarify", "request-child", "review-child", "unknown", ""]) {
    assertArchitectBlocked(await callToolCall(harness, "task_workflow", { action }), `task_workflow:${action}`);
  }
  assertArchitectBlocked(await callToolCall(harness, "task_workflow"), "task_workflow:missing-action");
  assertArchitectBlocked(await callToolCall(harness, "task_workflow", null), "task_workflow:null-input");
});

test("architect 只允许明确的本地只读工具，对执行、MCP、协作和未知工具 fail-closed", async () => {
  const harness = architectHarness();
  await emitExtensionEvent(harness, "session_start");
  await harness.tools.find((tool) => tool.name === "switch_role").execute(
    "architect", { role: "architect" }, undefined, undefined, harness.context,
  );

  for (const [toolName, input] of [
    ["read", { path: "src/roles.ts" }],
    ["grep", { pattern: "role", path: "src" }],
    ["find", { pattern: "*.ts", path: "src" }],
    ["ls", { path: "src" }],
    ["ffgrep", { pattern: "role", path: "src/" }],
    ["fffind", { pattern: "role", path: "src/" }],
    ["graph_locate", { query: "role configuration", scope: "src" }],
    ["graph_inspect", { id: "known-local-symbol" }],
    ["obs_recall", { id: "known-observation" }],
  ]) {
    assert.equal(await callToolCall(harness, toolName, input), undefined, toolName);
  }

  for (const toolName of [
    "browser",
    "codemode",
    "file_review",
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
    "read_file",
    "mcp__read",
    "functions.read",
  ]) {
    assertArchitectBlocked(await callToolCall(harness, toolName), toolName);
  }

  assertArchitectBlocked(
    await callToolCall(harness, "browser", { command: "open https://example.com" }),
    "browser-command",
  );
  assertArchitectBlocked(
    await callToolCall(harness, "codemode", { code: 'await tools.read({ path: "src/roles.ts" })' }),
    "codemode-read-wrapper",
  );
  assertArchitectBlocked(
    await callToolCall(harness, "file_review", { action: "complete", path: "src/roles.ts" }),
    "review-registration",
  );
});

test("architect 本地只读白名单不绕过用户停止，恢复后才可继续规划", async () => {
  await withTempDirectory(async (cwd) => {
    const harness = architectHarness({ cwd, trusted: true });
    await emitExtensionEvent(harness, "session_start");
    await harness.tools.find((tool) => tool.name === "switch_role").execute(
      "architect", { role: "architect" }, undefined, undefined, harness.context,
    );
    await emitExtensionEvent(harness, "input", { source: "interactive", text: "停止工作" });
    assert.equal(await callToolCall(harness, "read", { path: "src/roles.ts" }), undefined);
    assertArchitectBlocked(await callToolCall(harness, "task_workflow", { action: "plan" }), "stopped-plan");
    assertArchitectBlocked(await callToolCall(harness, "graph_locate", { query: "roles" }), "stopped-graph");
    await emitExtensionEvent(harness, "input", { source: "interactive", text: "继续" });
    assert.equal(await callToolCall(harness, "task_workflow", { action: "plan" }), undefined);
    assert.equal(await callToolCall(harness, "graph_locate", { query: "roles" }), undefined);
  });
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
    "plan", "replan", "status", "request-replan", "request-goal",
  ]);

  const blocked = await callToolCall(harness, "task_workflow", { action: "report-evidence" });
  assert.match(blocked.reason, new RegExp(ARCHITECT_ALLOWED_ACTIONS_TEXT));

  const workflowTool = harness.tools.find((tool) => tool.name === "task_workflow");
  const guidance = [workflowTool.description, ...workflowTool.promptGuidelines];
  for (const action of ARCHITECT_ALLOWED_TASK_WORKFLOW_ACTIONS) {
    assert.ok(guidance.some((line) => line.includes(action)), `工具指导缺少 ${action}`);
  }
  assert.ok(guidance.some((line) => line.includes(ARCHITECT_ALLOWED_ACTIONS_TEXT)), "工具指导必须复用同一份允许动作说明");
  assert.equal(workflowTool.parameters.properties.tasks.items.properties.contract, undefined);
  assert.equal(workflowTool.parameters.properties.coordinationHandoffId, undefined);
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
