import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowActions } from "../extensions/workflow-actions.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowState } from "../src/workflow.ts";
import { formatWorkflowStatusText } from "../extensions/workflow-status-renderer.ts";
import { createCurrentWorkflowStatusView } from "../extensions/workflow-status-view.ts";

test("status defaults to actionable summary while full history remains explicit and UI details survive", async () => {
  const state = createExtensionRuntimeState();
  state.workflowState = createWorkflowState({ sessionId: "status-session", summary: "Keep current goal", tasks: Array.from({ length: 40 }, (_, i) => ({ id: `task-${i}`, task: `Task ${i}`, files: ["src"], acceptanceCriteria: ["done"] })) }, 1);
  for (const task of state.workflowState.tasks.slice(0, 39)) { task.status = "completed"; task.completionSummary = "HISTORICAL_RESULT_".repeat(500); }
  const actions = createWorkflowActions(state, { report: { formatWorkflowState: () => formatWorkflowStatusText(createCurrentWorkflowStatusView(state)) }, roleRuntime: {} });
  const compact = await actions.runTaskWorkflowAction({ action: "status" }, undefined, {});
  assert.ok(compact.content[0].text.length < 2500);
  assert.doesNotMatch(compact.content[0].text, /HISTORICAL_RESULT/);
  assert.match(compact.content[0].text, /39\/40/);
  assert.match(compact.content[0].text, /detail="full"/);
  assert.match(compact.content[0].text, /等待调度/);
  assert.equal(compact.details.workflowPresentation.view.tasks.length, 40);
  const full = await actions.runTaskWorkflowAction({ action: "status", detail: "full" }, undefined, {});
  assert.match(full.content[0].text, /HISTORICAL_RESULT/);
  assert.deepEqual(full.details.tasks, compact.details.tasks);
});

test("summary keeps recovery and unknown-outcome warnings and checkpoint revision without expanding observations", async () => {
  const state = createExtensionRuntimeState();
  state.workflowState = createWorkflowState({ sessionId: "status-session", summary: "Goal", reviewRequired: true, tasks: [{ id: "task", task: "Task", files: ["src"], acceptanceCriteria: ["done"] }] }, 1);
  state.workflowState.tasks[0].outcomeUnknown = true;
  state.roleRecoveryPending = true;
  const memory = { status: "available", memory: { revision: 7, identity: { taskId: "task" }, checkpoint: { step: "Saved progress", nextStep: "Check contract" }, observations: [{ summary: "PRIVATE_OBSERVATION".repeat(1000) }] } };
  const actions = createWorkflowActions(state, { report: { formatWorkflowState: () => formatWorkflowStatusText(createCurrentWorkflowStatusView(state)) }, roleRuntime: {}, taskMemory: { read: () => memory } });
  const result = await actions.runTaskWorkflowAction({ action: "status" }, undefined, {});
  assert.match(result.content[0].text, /结果未知/);
  assert.match(result.content[0].text, /ROLE_RECOVERY_PENDING|恢复/);
  assert.match(result.content[0].text, /expectedMemoryRevision=7/);
  assert.doesNotMatch(result.content[0].text, /PRIVATE_OBSERVATION/);
  const full = await actions.runTaskWorkflowAction({ action: "status", detail: "full" }, undefined, {});
  assert.match(full.content[0].text, /PRIVATE_OBSERVATION/);
});
