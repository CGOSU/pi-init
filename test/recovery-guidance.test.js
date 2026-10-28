import assert from "node:assert/strict";
import test from "node:test";
import { nextWorkflowAction } from "../extensions/workflow-action-policy.ts";
import { buildHandoffSnapshot } from "../extensions/handoff-snapshot.ts";
import { createRuntimeRoutingContext } from "../extensions/runtime-routing-context.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowState } from "../src/workflow.ts";
import { createExtensionHarness } from "./helpers.js";

function workflow() {
  return createWorkflowState({ summary: "Recovery", sessionId: "recovery", tasks: [
    { id: "task", task: "Implement", role: "developer-test", files: ["src/"], acceptanceCriteria: ["Verified"] },
  ] }, 1);
}

const scenarios = [
  ["role only", s => { s.roleRecoveryPending = true; }, "role"],
  ["manual role", s => { s.roleRecoveryPending = true; s.roleModeStatus = "manual"; }, "role"],
  ["finished workflow", s => { s.roleRecoveryPending = true; s.workflowState = workflow(); s.workflowState.status = "completed"; }, "role"],
  ["active role recovery", s => { s.roleRecoveryPending = true; s.workflowState = workflow(); }, "workflow"],
  ["paused workflow", s => { s.workflowState = workflow(); s.workflowState.status = "paused"; }, "workflow"],
  ["persistence failure", s => { s.roleRecoveryPersistenceFailed = true; }, "workflow"],
  ["restore failure", s => { s.workflowRestoreError = { code: "READ_FAILED", message: "Failed" }; }, "workflow"],
  ["pending workflow", s => { s.pendingWorkflowRecovery = workflow(); }, "workflow"],
  ["unknown outcome", s => { s.workflowState = workflow(); s.workflowState.currentTaskId = "task"; s.workflowState.tasks[0].outcomeUnknown = true; }, "workflow"],
  ["session review", s => { s.workflowState = workflow(); s.workflowState.status = "paused"; s.workflowState.pauseReason = "session-handoff-review"; }, "wait"],
  ["user stop", s => { s.userStopRequested = true; s.roleRecoveryPending = true; s.workflowState = workflow(); }, "stop"],
];

for (const [name, setup, recovery] of scenarios) test(`recovery consumers agree: ${name}`, () => {
  const state = createExtensionRuntimeState();
  setup(state);
  const before = structuredClone(state);
  const decision = nextWorkflowAction(state);
  assert.equal(decision.action, "recover");
  assert.equal(decision.recovery, recovery);
  assert.equal(buildHandoffSnapshot(state, "developer-test").nextAction, decision.nextAction);
  const h = createExtensionHarness();
  const event = { systemPromptOptions: { sections: {} } };
  createRuntimeRoutingContext(state, { getActiveRole: () => undefined, getThinkingLevel: () => "high" }).beforeAgentStart(event, h.context);
  const section = event.systemPromptOptions.sections.pi_init_runtime;
  assert.ok(section.includes(decision.nextAction));
  if (recovery === "role") {
    assert.doesNotMatch(section, /task_workflow\(action="status"\)/);
    assert.match(decision.nextAction, /switch_role/);
  }
  if (recovery === "workflow") {
    assert.match(decision.nextAction, /task_workflow\(action="status"\)/);
    assert.doesNotMatch(section, /不要调用 task_workflow\(status\)/);
  }
  assert.deepEqual(state, before, "advice must not authorize recovery or change state");
});
