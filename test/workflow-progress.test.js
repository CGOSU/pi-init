import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowProgressTracker } from "../src/workflow-progress.ts";
import { createWorkflowProgressObserver } from "../extensions/workflow-status-polling.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowState } from "../src/workflow.ts";

function workflow() {
  const state = createWorkflowState({
    sessionId: "session-a",
    workflowId: "workflow-a",
    summary: "Implement feature",
    tasks: [{ id: "task-a", task: "Implement the feature", files: ["src"], acceptanceCriteria: ["feature works"] }],
  }, 1);
  state.status = "running";
  state.currentTaskId = "task-a";
  state.tasks[0].status = "in_progress";
  return state;
}

test("runtime metadata and activity are not semantic progress", () => {
  const tracker = createWorkflowProgressTracker();
  const state = workflow();
  tracker.observe(state);
  state.updatedAt = 99;
  state.planVersion++;
  state.recoveryGeneration++;
  state.handoff = { phase: "executing", createdAt: 2, handoffId: "handoff-2", sessionId: state.sessionId,
    workflowId: state.workflowId, planVersion: state.planVersion, taskId: "task-a", role: "developer-test" };
  const observation = tracker.observe(state);
  assert.equal(observation.status, "observing");
  assert.equal(observation.lastVerifiedProgress, undefined);
  assert.equal(observation.windowSize, 1);
});

test("repeated status observations detect an unchanged semantic state without treating other tools as progress", () => {
  const state = createExtensionRuntimeState();
  state.workflowState = workflow();
  const handlers = new Map();
  createWorkflowProgressObserver({ on(name, handler) { handlers.set(name, handler); } }, state);
  handlers.get("session_start")();
  state.workflowState = workflow();
  handlers.get("session_tree")({ oldLeafId: "leaf", newLeafId: "leaf" });
  const call = (toolCallId, toolName, input = {}) => handlers.get("tool_call")({ toolCallId, toolName, input });
  const result = (toolCallId, toolName, isError = false) => handlers.get("tool_result")({ toolCallId, toolName, isError });
  call("unrelated", "read_file");
  result("unrelated", "read_file");
  for (let index = 0; index < 3; index++) {
    call(`status-${index}`, "task_workflow", { action: "status" });
    result(`status-${index}`, "task_workflow");
  }
  assert.equal(state.workflowProgressObservation.status, "suspected-loop");
  assert.equal(state.workflowProgressObservation.suspicion.kind, "repeated-state");
  assert.match(state.workflowProgressObservation.suspicion.evidence.join(" "), /显式状态查询/);
});

test("repeated automatic turns detect unchanged workflow state without requiring status polling", () => {
  const state = createExtensionRuntimeState();
  state.workflowState = workflow();
  const handlers = new Map();
  createWorkflowProgressObserver({ on(name, handler) { handlers.set(name, handler); } }, state);
  handlers.get("session_start")();
  state.workflowState = workflow();
  handlers.get("session_tree")({ oldLeafId: "leaf", newLeafId: "leaf" });

  for (let index = 0; index < 3; index++) handlers.get("agent_settled")();

  assert.equal(state.workflowProgressObservation.status, "suspected-loop");
  assert.equal(state.workflowProgressObservation.suspicion.kind, "repeated-state");
  assert.match(state.workflowProgressObservation.suspicion.evidence.join(" "), /自动回合边界/);
});

test("external input resets suspicion while internal continuation input preserves it", () => {
  const state = createExtensionRuntimeState();
  state.workflowState = workflow();
  const handlers = new Map();
  createWorkflowProgressObserver({ on(name, handler) { handlers.set(name, handler); } }, state);
  handlers.get("session_start")();
  let statusIndex = 0;
  const observeStatus = () => {
    const id = `status-${statusIndex++}`;
    handlers.get("tool_call")({ toolCallId: id, toolName: "task_workflow", input: { action: "status" } });
    handlers.get("tool_result")({ toolCallId: id, toolName: "task_workflow", isError: false });
  };
  for (let index = 0; index < 4; index++) observeStatus();
  assert.equal(state.workflowProgressObservation.status, "suspected-loop");

  handlers.get("input")({ source: "extension" });
  assert.equal(state.workflowProgressObservation.status, "suspected-loop");
  handlers.get("input")({ source: "interactive" });
  assert.equal(state.workflowProgressObservation.status, "observing");
  assert.equal(state.workflowProgressObservation.windowSize, 1);
});

test("semantic A to B to A paths are reported with bounded evidence", () => {
  const tracker = createWorkflowProgressTracker(3);
  const state = workflow();
  tracker.observe(state);
  state.tasks[0].status = "pending";
  tracker.observe(state);
  state.tasks[0].status = "in_progress";
  const observation = tracker.observe(state);
  assert.equal(observation.status, "suspected-loop");
  assert.equal(observation.suspicion.kind, "state-cycle");
  assert.equal(observation.windowSize, 3);
  assert.match(observation.suspicion.evidence[0], /running · task-a · in_progress → running · task-a · pending → running · task-a · in_progress/);
});

test("verified task completion resets the suspicion window and records real progress", () => {
  const tracker = createWorkflowProgressTracker();
  const state = workflow();
  tracker.observe(state);
  state.tasks[0].status = "completed";
  state.tasks[0].completionSummary = "Feature implemented";
  state.tasks[0].verification = ["npm test -- test/workflow-progress.test.js: passed"];
  const completed = tracker.observe(state);
  assert.equal(completed.status, "observing");
  assert.deepEqual(completed.lastVerifiedProgress, { kind: "task-completion", taskId: "task-a", summary: "Feature implemented" });
  assert.equal(completed.windowSize, 1);
  state.tasks[0].verification = [...state.tasks[0].verification];
  assert.equal(tracker.observe(state).lastVerifiedProgress.summary, "Feature implemented");
});

test("only an applied revision with changed declared plan content is verified convergence", () => {
  const tracker = createWorkflowProgressTracker();
  const state = workflow();
  tracker.observe(state);
  state.pendingRevision = { revisionId: "revision-1", direction: "Improve plan", requestedAt: 2 };
  tracker.observe(state);
  state.pendingRevision = undefined;
  state.revisions.push({ revisionId: "revision-1", direction: "Improve plan", requestedAt: 2,
    status: "applied", appliedAt: 3, newPlan: { summary: "Implement improved feature", constraints: [], tasks: state.tasks } });
  state.plan = { summary: "Implement improved feature", constraints: [] };
  const applied = tracker.observe(state);
  assert.equal(applied.lastVerifiedProgress.kind, "plan-convergence");

  const repeatedRequest = workflow();
  const repeatedTracker = createWorkflowProgressTracker();
  repeatedTracker.observe(repeatedRequest);
  repeatedRequest.pendingRevision = { revisionId: "r1", direction: "Same direction", requestedAt: 1 };
  repeatedTracker.observe(repeatedRequest);
  repeatedRequest.pendingRevision = undefined;
  repeatedTracker.observe(repeatedRequest);
  repeatedRequest.pendingRevision = { revisionId: "r2", direction: "Same direction", requestedAt: 2 };
  const duplicate = repeatedTracker.observe(repeatedRequest);
  assert.equal(duplicate.lastVerifiedProgress, undefined);
  assert.equal(duplicate.suspicion.kind, "repeated-revision");
});

test("snapshot storage stays within its configured history bound", () => {
  const tracker = createWorkflowProgressTracker(3);
  const state = workflow();
  tracker.observe(state);
  for (let index = 0; index < 8; index++) {
    state.tasks[0].task = `Implement feature revision ${index}`;
    tracker.observe(state);
  }
  assert.equal(tracker.observe(state).historyLimit, 3);
  assert.ok(tracker.observe(state).windowSize <= 3);
});
