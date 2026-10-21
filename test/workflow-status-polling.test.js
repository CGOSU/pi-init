import assert from "node:assert/strict";
import test from "node:test";
import { createPausedStatusGuard } from "../extensions/workflow-status-polling.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowState } from "../src/workflow.ts";
import { createExtensionHarness, emitExtensionEvent } from "./helpers.js";

function fixture() {
  const state = createExtensionRuntimeState();
  state.workflowState = createWorkflowState({ sessionId: "test-session", summary: "Await review", reviewRequired: true,
    tasks: [{ id: "task", task: "Implement", files: ["src"], acceptanceCriteria: ["done"] }] });
  const handlers = new Map();
  const guard = createPausedStatusGuard({ on(name, handler) { handlers.set(name, handler); } }, state);
  return { state, guard, handlers, ctx: { sessionManager: { getSessionId: () => "test-session" } } };
}

test("only consecutive unchanged paused status observations stop, without mutating workflow", () => {
  const { state, guard, ctx, handlers } = fixture();
  const before = structuredClone(state.workflowState);
  assert.equal(guard.observe("first", ctx).stop, false);
  assert.equal(guard.observe("second", ctx).stop, true);
  assert.deepEqual(state.workflowState, before);
  state.workflowState.updatedAt++;
  assert.equal(guard.observe("changed", ctx).stop, false);
  handlers.get("input")({ source: "extension" });
  assert.equal(guard.observe("unchanged", ctx).stop, true);
  handlers.get("input")({ source: "interactive" });
  assert.equal(guard.observe("new-user", ctx).stop, false);
  handlers.get("session_tree")({});
  assert.equal(guard.observe("new-branch", ctx).stop, false);
  state.workflowState.status = "running";
  assert.equal(guard.observe("running-1", ctx).stop, false);
  assert.equal(guard.observe("running-2", ctx).stop, false);
});

test("public status tool terminates polling but never resumes, replans or completes the paused workflow", async () => {
  const initial = fixture().state.workflowState;
  const harness = createExtensionHarness([{ type: "custom", id: "paused-state", customType: "pi-init-workflow", data: initial }]);
  await emitExtensionEvent(harness, "session_start");
  await emitExtensionEvent(harness, "agent_start");
  const tool = harness.tools.find(tool => tool.name === "task_workflow");
  const before = structuredClone(harness.entries);
  const first = await tool.execute("status-1", { action: "status" }, undefined, undefined, harness.context);
  await emitExtensionEvent(harness, "tool_result", { toolName: "bash", toolCallId: "shell-1", isError: false });
  const second = await tool.execute("status-2", { action: "status" }, undefined, undefined, harness.context);
  assert.notEqual(first.terminate, true);
  assert.equal(second.terminate, true);
  assert.equal(second.details.statusPolling.code, "WORKFLOW_STATUS_NO_PROGRESS");
  assert.equal(second.details.status, "paused");
  assert.deepEqual(harness.entries, before);
  await emitExtensionEvent(harness, "agent_end");
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(harness.sentMessages.length, 0);
  assert.ok(harness.notifications.some(item => item.message.includes("重复状态轮询")));
  await emitExtensionEvent(harness, "agent_start");
  const next = await tool.execute("status-new-run", { action: "status" }, undefined, undefined, harness.context);
  assert.notEqual(next.terminate, true);
  await emitExtensionEvent(harness, "session_shutdown");
});
