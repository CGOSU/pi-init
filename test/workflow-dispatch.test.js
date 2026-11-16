import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowDispatch } from "../extensions/workflow-dispatch.ts";
import { createWorkflowState, setWorkflowHandoffPhase, startWorkflowTask } from "../src/workflow.ts";

function fixture(automaticRole = async role => ({ result: { role } })) {
  const state = createExtensionRuntimeState();
  state.workflowState = startWorkflowTask(createWorkflowState({
    summary: "安全恢复派发",
    sessionId: "session",
    executor: "local",
    tasks: [{ id: "task", role: "developer-test", task: "实现", files: ["src"], acceptanceCriteria: ["完成"] }],
  }), "task");
  state.workflowDispatchInFlight = true;
  const deliveries = [];
  const dispatch = createWorkflowDispatch(state, {
    roleRuntime: { automaticRole },
    messages: {
      sendWorkflowTaskMessage(_ctx, taskId, _note, identity) {
        deliveries.push({ taskId, identity });
        state.workflowState = setWorkflowHandoffPhase(state.workflowState, "queued");
      },
    },
    report: {
      persistWorkflowState(next) { state.workflowState = next; },
      updateWorkflowStatus() { },
      formatWorkflowPauseSummary: () => "暂停",
    },
    setCurrentContext() { },
  });
  const ctx = { ui: { notify() { } } };
  return { state, dispatch, deliveries, ctx };
}

test("resume preserves dispatch state for pending, queued and executing work", async () => {
  const cases = [
    { patch: { internalContinuationPending: true }, phase: "prepared", result: "continuation-pending" },
    { patch: {}, phase: "dispatching", result: "continuation-pending" },
    { patch: {}, phase: "queued", result: "continuation-pending" },
    { patch: {}, phase: "executing", result: "already-started" },
  ];
  for (const { patch, phase, result } of cases) {
    const h = fixture();
    Object.assign(h.state, patch);
    h.state.workflowState = setWorkflowHandoffPhase(h.state.workflowState, phase);
    const before = h.state.workflowState;
    assert.equal(await h.dispatch.resumeLocalWorkflow(h.ctx), result);
    assert.equal(h.state.workflowState, before);
    assert.equal(h.state.workflowDispatchInFlight, true);
    assert.deepEqual(h.deliveries, []);
  }
});

test("resume clears only a stale dispatch marker and does not resend queued work", async () => {
  const h = fixture();
  const identity = h.state.workflowState.handoff;
  assert.equal(await h.dispatch.resumeLocalWorkflow(h.ctx), "scheduled");
  assert.equal(h.state.workflowState.handoff.phase, "queued");
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0].identity.handoffId, identity.handoffId);
  const delivered = [...h.deliveries];
  assert.equal(await h.dispatch.resumeLocalWorkflow(h.ctx), "continuation-pending");
  assert.deepEqual(h.deliveries, delivered);
});

test("resume cannot reset the scheduling lock while role selection is pending", async () => {
  let resolveRole;
  const selection = new Promise(resolve => { resolveRole = resolve; });
  const h = fixture(() => selection);
  h.state.workflowDispatchInFlight = false;
  const scheduling = h.dispatch.scheduleWorkflow(h.ctx);
  try {
    assert.equal(h.state.workflowState.handoff.phase, "waiting-role");
    assert.equal(await h.dispatch.resumeLocalWorkflow(h.ctx), "dispatch-in-flight");
    assert.equal(h.state.workflowDispatchInFlight, true);
    assert.deepEqual(h.deliveries, []);
  } finally {
    resolveRole({ result: { role: "developer-test" } });
    await scheduling;
  }
  assert.equal(h.state.workflowState.handoff.phase, "queued");
  assert.equal(h.deliveries.length, 1);
});

test("a stop during role selection still prevents dispatch after the await", async () => {
  let resolveRole;
  const selection = new Promise(resolve => { resolveRole = resolve; });
  const h = fixture(() => selection);
  h.state.workflowDispatchInFlight = false;
  const scheduling = h.dispatch.scheduleWorkflow(h.ctx);
  h.state.userStopRequested = true;
  resolveRole({ result: { role: "developer-test" } });
  await scheduling;
  assert.deepEqual(h.deliveries, []);
  assert.equal(h.state.workflowState.handoff.phase, "waiting-role");
});
