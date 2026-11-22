import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowDispatch } from "../extensions/workflow/workflow-dispatch.ts";
import { createWorkflowState, ensureWorkflowReplanHandoff, requestWorkflowReplan, setWorkflowHandoffPhase, startWorkflowTask } from "../src/workflow.ts";

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
    store: {
      persistWorkflowState(next) { state.workflowState = next; },
      restoreSnapshot(next) { state.workflowState = next; },
    },
    report: {
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
  assert.equal(h.state.workflowDispatchInFlight, false);
});

test("continuing after a stop during role selection dispatches the task exactly once", async () => {
  let resolveRole;
  let calls = 0;
  const selection = new Promise(resolve => { resolveRole = resolve; });
  const h = fixture(() => calls++ === 0 ? selection : Promise.resolve({ result: { role: "developer-test" } }));
  h.state.workflowDispatchInFlight = false;
  const scheduling = h.dispatch.scheduleWorkflow(h.ctx);
  h.state.userStopRequested = true;
  resolveRole({ result: { role: "developer-test" } });
  await scheduling;
  assert.deepEqual(h.deliveries, []);
  assert.equal(h.state.workflowDispatchInFlight, false);

  h.state.userStopRequested = false; // “继续”只解除停止标记
  await h.dispatch.scheduleWorkflow(h.ctx); // agent_settled 触发的自动调度
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.state.workflowState.handoff.phase, "queued");
  assert.equal(h.state.workflowDispatchInFlight, false);
});

test("a stop during architect selection releases the replan dispatch lock", async () => {
  const state = createExtensionRuntimeState();
  state.workflowState = ensureWorkflowReplanHandoff(requestWorkflowReplan(createWorkflowState({
    summary: "重规划停止",
    sessionId: "session",
    executor: "local",
    tasks: [{ id: "task", role: "developer-test", task: "实现", files: ["src"], acceptanceCriteria: ["完成"] }],
  }), { direction: "调整计划" }));
  let resolveRole;
  const sent = [];
  const dispatch = createWorkflowDispatch(state, {
    roleRuntime: { automaticRole: () => new Promise(resolve => { resolveRole = resolve; }) },
    messages: {
      sendWorkflowReplanMessage(_ctx, identity) {
        if (state.userStopRequested) return false; // 与真实实现一致：停止时在 try 之前早退
        sent.push(identity);
        return true;
      },
    },
    store: {
      persistWorkflowState(next) { state.workflowState = next; },
      restoreSnapshot(next) { state.workflowState = next; },
    },
    report: { updateWorkflowStatus() { }, formatWorkflowPauseSummary: () => "" },
    setCurrentContext() { },
  });
  const ctx = { ui: { notify() { } } };
  const scheduling = dispatch.scheduleWorkflow(ctx);
  state.userStopRequested = true;
  resolveRole({ result: { role: "architect" } });
  await scheduling;
  assert.deepEqual(sent, []);
  assert.equal(state.workflowDispatchInFlight, false);
});
