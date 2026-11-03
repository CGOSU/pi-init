import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowStatusPollingGuard } from "../extensions/workflow-status-polling.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowState, startWorkflowTask, setWorkflowHandoffPhase, markWorkflowTaskStarted } from "../src/workflow.ts";
import { createExtensionHarness, emitExtensionEvent } from "./support/extension-harness.js";

function fixture(reviewRequired = true) {
  const state = createExtensionRuntimeState();
  state.workflowState = createWorkflowState({ sessionId: "test-session", summary: "Await review", reviewRequired,
    tasks: [{ id: "task", task: "Implement", files: ["src"], acceptanceCriteria: ["done"] }] });
  const handlers = new Map();
  const guard = createWorkflowStatusPollingGuard({ on(name, handler) { handlers.set(name, handler); } }, state);
  return { state, guard, handlers, ctx: { sessionManager: { getSessionId: () => "test-session" } } };
}

test("only consecutive unchanged waiting status observations stop, without mutating workflow", () => {
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
  assert.equal(guard.observe("running-2", ctx).stop, true);
});

test("unchanged recovery and dispatch waits stop polling without confirming recovery", () => {
  const { state, guard, ctx, handlers } = fixture(false);
  state.roleRecoveryPending = true;
  const before = structuredClone(state.workflowState);
  assert.equal(guard.observe("recovery-1", ctx).stop, false);
  assert.equal(guard.observe("recovery-2", ctx).stop, true);
  assert.equal(state.roleRecoveryPending, true);
  assert.deepEqual(state.workflowState, before);
  state.roleRecoveryPersistenceFailed = true;
  assert.equal(guard.observe("failed-save", ctx).stop, false);
  assert.equal(guard.observe("failed-save-again", ctx).stop, true);
  state.roleRecoveryPersistenceFailed = false;
  state.roleRecoveryPending = false;
  assert.equal(guard.observe("dispatch-1", ctx).stop, false);
  assert.equal(guard.observe("dispatch-2", ctx).stop, true);
  handlers.get("input")({ source: "interactive" });
  assert.equal(guard.observe("new-input", ctx).stop, false);
  handlers.get("session_tree")({});
  assert.equal(guard.observe("new-branch", ctx).stop, false);
  const foreign = { sessionManager: { getSessionId: () => "other-session" } };
  assert.equal(guard.observe("foreign-1", foreign).stop, false);
  assert.equal(guard.observe("foreign-2", foreign).stop, false);
});

test("unrestorable workflow status stops repeated polling without a guessed task identity", () => {
  const { state, guard, ctx } = fixture(false);
  state.workflowState = undefined;
  state.workflowRestoreError = { code: "RESTORE_FAILED", message: "invalid state" };
  assert.equal(guard.observe("restore-1", ctx).stop, false);
  assert.equal(guard.observe("restore-2", ctx).stop, true);
  state.workflowRestoreError = undefined;
  assert.equal(guard.observe("no-workflow-1", ctx).stop, false);
  assert.equal(guard.observe("no-workflow-2", ctx).stop, false);
});

test("executing tasks and actual dispatch transitions invalidate waiting observations", () => {
  const { state, guard, ctx } = fixture(false);
  assert.equal(guard.observe("waiting", ctx).stop, false);
  state.workflowState = setWorkflowHandoffPhase(startWorkflowTask(state.workflowState, "task"), "dispatching");
  assert.equal(guard.observe("dispatching-1", ctx).stop, false);
  assert.equal(guard.observe("dispatching-2", ctx).stop, false);
  state.workflowState = markWorkflowTaskStarted(setWorkflowHandoffPhase(state.workflowState, "queued"), "task");
  assert.equal(guard.observe("executing-1", ctx).stop, false);
  assert.equal(guard.observe("executing-2", ctx).stop, false);
  state.roleRecoveryPending = true;
  assert.equal(guard.observe("compressed-1", ctx).stop, false);
  assert.equal(guard.observe("compressed-2", ctx).stop, true);
  state.roleContextGeneration++;
  assert.equal(guard.observe("new-generation", ctx).stop, false);
});

test("failed recovery persistence cannot be acknowledged or scheduled by ending status polling", async () => {
  let rejectAcknowledgement = false;
  const harness = createExtensionHarness([], { appendEntry(type, data) {
    if (rejectAcknowledgement && type === "pi-init-role-recovery" && data.status === "acknowledged") throw new Error("disk unavailable");
  } });
  await emitExtensionEvent(harness, "session_start");
  harness.branch.push({ type: "custom", id: "waiting-state", customType: "pi-init-workflow", data: fixture(false).state.workflowState });
  await emitExtensionEvent(harness, "session_tree", { oldLeafId: "same", newLeafId: "same" });
  await emitExtensionEvent(harness, "session_compact", { reason: "threshold" });
  rejectAcknowledgement = true;
  const role = harness.tools.find(tool => tool.name === "switch_role");
  await assert.rejects(role.execute("confirm", { role: "developer-test" }, undefined, undefined, harness.context), { code: "ROLE_RECOVERY_PERSIST_FAILED" });
  const tool = harness.tools.find(tool => tool.name === "task_workflow");
  await tool.execute("failed-1", { action: "status" }, undefined, undefined, harness.context);
  const last = await tool.execute("failed-2", { action: "status" }, undefined, undefined, harness.context);
  assert.equal(last.terminate, true);
  assert.equal(last.details.workflowPresentation.view.recovery.code, "ROLE_RECOVERY_PERSIST_FAILED");
  await emitExtensionEvent(harness, "agent_end");
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.entries.filter(entry => entry.type === "pi-init-role-recovery").at(-1).data.status, "pending");
  await emitExtensionEvent(harness, "session_shutdown");
});

test("compressed role handoff stops status polling until explicit role confirmation, then dispatches once", async () => {
  const harness = createExtensionHarness();
  const role = harness.tools.find(tool => tool.name === "switch_role");
  const status = harness.tools.find(tool => tool.name === "task_workflow");
  await emitExtensionEvent(harness, "session_start");
  await role.execute("architect", { role: "architect" }, undefined, undefined, harness.context);
  const workflow = fixture(false).state.workflowState;
  harness.branch.push({ type: "custom", id: "waiting-state", customType: "pi-init-workflow", data: workflow });
  await emitExtensionEvent(harness, "session_tree", { oldLeafId: "same", newLeafId: "same" });
  await emitExtensionEvent(harness, "agent_start");
  const switched = await role.execute("developer", { role: "developer-test" }, undefined, undefined, harness.context);
  assert.equal(switched.terminate, true);
  await emitExtensionEvent(harness, "session_compact", { reason: "threshold" });
  await emitExtensionEvent(harness, "agent_end");
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(harness.sentMessages.length, 0);
  await emitExtensionEvent(harness, "agent_start");
  const before = structuredClone(harness.entries);
  const first = await status.execute("wait-1", { action: "status" }, undefined, undefined, harness.context);
  const second = await status.execute("wait-2", { action: "status" }, undefined, undefined, harness.context);
  assert.notEqual(first.terminate, true);
  assert.equal(second.terminate, true);
  assert.equal(second.details.status, "running");
  assert.equal(second.details.workflowPresentation.view.activity, "execution-blocked");
  assert.deepEqual(harness.entries, before);
  await emitExtensionEvent(harness, "agent_end");
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.entries.filter(entry => entry.type === "pi-init-role-recovery").at(-1).data.status, "pending");
  await role.execute("confirm-developer", { role: "developer-test" }, undefined, undefined, harness.context);
  await emitExtensionEvent(harness, "agent_settled");
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1);
  assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-role-handoff").length, 0);
  await emitExtensionEvent(harness, "session_shutdown");
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
