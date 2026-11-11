import assert from "node:assert/strict";
import test from "node:test";
import {
  blockWorkflowTask, cloneState, completeWorkflowTask, createWorkflowState, getWorkflowExecutionDuration,
  hydrateWorkflowState, markWorkflowTaskStarted, recoverWorkflowState, resumeWorkflow, retryWorkflowTask,
  setWorkflowHandoffPhase, startWorkflowTask,
} from "../src/workflow.ts";
import { createWorkflowStatusView } from "../extensions/workflow-status-view.ts";
import { createWorkflowCompletionView } from "../extensions/workflow-completion-view.ts";

function plan(now) {
  return createWorkflowState({
    sessionId: "timing", summary: "Exclude pauses", tasks: [
      { id: "task", task: "Run", files: ["src"], acceptanceCriteria: ["Done"] },
    ]
  }, now);
}

function start(state, now) {
  return markWorkflowTaskStarted(setWorkflowHandoffPhase(startWorkflowTask(state, "task", now), "queued", now), "task", now);
}

function finish(state, now) {
  return completeWorkflowTask(state, {
    taskId: "task", completionSummary: "Done", implementationRationale: "Measured",
    verification: [{ check: "result", status: "passed", details: "Done" }]
  }, now);
}

test("workflow active time freezes across repeated pauses and survives hydration", () => {
  let state = start(plan(100), 200);
  state = blockWorkflowTask(state, { taskId: "task", reason: "Wait" }, 300);
  assert.equal(getWorkflowExecutionDuration(state, 900), 100);
  assert.deepEqual(createWorkflowStatusView(state, {}, 900).elapsed, { kind: "available", milliseconds: 100 });
  state = cloneState(state, 900);
  assert.equal(getWorkflowExecutionDuration(state, 1200), 100);
  state = retryWorkflowTask(state, "task", 1300);
  assert.equal(state.pausedMilliseconds, 1000);
  state = start(state, 1300);
  state = blockWorkflowTask(state, { taskId: "task", reason: "Wait again" }, 1400);
  const restored = hydrateWorkflowState(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.ok, true);
  state = start(retryWorkflowTask(restored.value, "task", 2400), 2400);
  const completed = finish(state, 2500);
  assert.equal(getWorkflowExecutionDuration(completed), 300);
  assert.equal(getWorkflowExecutionDuration(completed, 10000), 300);
  assert.equal(completed.startedAt, 200);
  assert.equal(completed.completedAt, 2500);
  assert.deepEqual(createWorkflowCompletionView(completed).duration, { kind: "available", milliseconds: 300 });
});

test("a pause before the first task does not exceed the measured workflow interval", () => {
  const review = createWorkflowState({
    sessionId: "timing", summary: "Review first", reviewRequired: true, tasks: [
      { id: "task", task: "Run", files: ["src"], acceptanceCriteria: ["Done"] },
    ]
  }, 100);
  const resumed = resumeWorkflow(review, 1000);
  assert.equal(resumed.pausedMilliseconds, 0);
  const completed = finish(start(resumed, 1100), 1200);
  assert.equal(completed.startedAt, 1100);
  assert.equal(getWorkflowExecutionDuration(completed), 100);
});

test("recovery excludes unobserved downtime and cannot turn it into running time", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100 });
  const running = start(plan(100), 200);
  t.mock.timers.setTime(5000);
  const recovered = recoverWorkflowState(running, "timing");
  assert.equal(recovered.ok, true);
  assert.equal(recovered.value.status, "paused");
  assert.equal(recovered.value.tasks[0].outcomeUnknown, true);
  assert.equal(getWorkflowExecutionDuration(recovered.value, 8000), 0);
  assert.throws(() => retryWorkflowTask(recovered.value, "task", 6000), /未知/);
  const resumed = start(retryWorkflowTask(recovered.value, "task", 6000, { confirmUnknownOutcome: true }), 6000);
  assert.equal(getWorkflowExecutionDuration(finish(resumed, 6100)), 100);
});

test("legacy workflows do not fabricate pause accounting and malformed counters are rejected", () => {
  const old = finish(start(plan(100), 100), 200);
  delete old.pausedMilliseconds;
  assert.equal(hydrateWorkflowState(old).ok, true);
  assert.equal(getWorkflowExecutionDuration(old), undefined);
  for (const pausedMilliseconds of [-1, NaN, Infinity, "100"]) {
    assert.equal(hydrateWorkflowState({ ...old, pausedMilliseconds }).ok, false);
  }
  assert.equal(getWorkflowExecutionDuration({ ...old, pausedMilliseconds: 150 }), undefined);
});
