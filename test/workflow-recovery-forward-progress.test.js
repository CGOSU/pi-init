import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowState, requestWorkflowReplan } from "../src/workflow.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createRoleRecovery } from "../extensions/role-recovery.ts";
import { createRoleHandoff } from "../extensions/role-handoff.ts";
import { nextWorkflowAction } from "../extensions/workflow-action-policy.ts";
import { workflowStatusToolSummary } from "../extensions/workflow-status-tool-text.ts";
import { createExtensionHarness, emitExtensionEvent } from "./support/extension-harness.js";

function waitingWorkflow() {
  const workflow = createWorkflowState({ sessionId: "test-session", summary: "Continue the confirmed work", tasks: [
    { id: "next-task", role: "developer-test", task: "Implement", files: ["src"], acceptanceCriteria: ["tested"] },
  ] });
  workflow.continuation = { kind: "schedule", phase: "pending", reason: "retry" };
  return workflow;
}

test("queued recovery provides the same concrete role before and after status without another status prerequisite", () => {
  const state = { ...createExtensionRuntimeState(), workflowState: waitingWorkflow(), roleRecoveryPending: true };
  const recovery = createRoleRecovery({ on() {}, appendEntry() { assert.fail("context must not persist"); } }, state);
  const step = nextWorkflowAction(state);
  assert.equal(step.requiredRole, "developer-test");
  assert.equal(step.taskId, "next-task");
  const status = workflowStatusToolSummary(state);
  assert.match(status, /next-task/);
  assert.match(status, /switch_role\(role="developer-test"\)/);
  for (const messages of [[], [{ role: "user", content: status, timestamp: 0 }]]) {
    const result = recovery.context({ messages }, { model: { contextWindow: 500000 } });
    const prompt = result.messages.find(message => message.customType === "pi-init-role-recovery").content;
    assert.match(prompt, /switch_role\(role="developer-test"\)/);
    assert.doesNotMatch(prompt, /先调用 task_workflow|尚未获取时只读一次/);
  }
  assert.equal(state.roleRecoveryPending, true, "routing guidance cannot confirm recovery");
  assert.equal(state.workflowState.currentTaskId, undefined);
});

test("same-role recovery yields to the existing pending workflow scheduler exactly once", async () => {
  const harness = createExtensionHarness();
  const role = harness.tools.find(tool => tool.name === "switch_role");
  const status = harness.tools.find(tool => tool.name === "task_workflow");
  await emitExtensionEvent(harness, "session_start");
  await role.execute("initial-role", { role: "developer-test" }, undefined, undefined, harness.context);
  harness.branch.push({ type: "custom", id: "waiting-state", customType: "pi-init-workflow", data: waitingWorkflow() });
  await emitExtensionEvent(harness, "session_tree", { oldLeafId: "old", newLeafId: "waiting-state" });
  await role.execute("establish-role", { role: "developer-test" }, undefined, undefined, harness.context);
  await emitExtensionEvent(harness, "session_compact", { reason: "threshold" });
  await emitExtensionEvent(harness, "agent_start");
  const observed = await status.execute("status-once", { action: "status" }, undefined, undefined, harness.context);
  assert.notEqual(observed.terminate, true);
  const confirmed = await role.execute("confirm-role", { role: "developer-test" }, undefined, undefined, harness.context);
  assert.match(confirmed.content[0].text, /已重新确认当前职责/);
  assert.equal(confirmed.terminate, true, "confirmation must reach agent_settled before any task execution");
  assert.match(confirmed.content[0].text, /调度/);
  assert.equal(harness.sentMessages.length, 0);
  await emitExtensionEvent(harness, "agent_end");
  assert.equal(harness.sentMessages.length, 0, "agent_end is not the dispatch boundary");
  await emitExtensionEvent(harness, "agent_settled");
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1);
  assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-role-handoff").length, 0);
  await emitExtensionEvent(harness, "session_shutdown");
});

test("same-role confirmation does not create a role turn or bypass paused, stale, stopped and failed recovery boundaries", async () => {
  for (const boundary of ["already-confirmed", "executing", "paused", "persist-failed", "stopped", "stale"]) {
    const state = { ...createExtensionRuntimeState(), workflowState: waitingWorkflow(), agentRunActive: true,
      roleRecoveryPending: boundary !== "already-confirmed",
      activeRole: { role: "developer-test", provider: "test", model: "test", thinkingLevel: "high" } };
    if (boundary === "executing") {
      state.workflowState.currentTaskId = "next-task";
      state.workflowState.tasks[0].status = "in_progress";
    }
    if (boundary === "paused") {
      state.workflowState.status = "paused";
      state.workflowState.tasks[0].status = "blocked";
      state.workflowState.tasks[0].outcomeUnknown = true;
    }
    const ctx = { sessionManager: { getSessionId: () => "test-session", getBranch: () => [] } };
    const handoff = createRoleHandoff({ appendEntry() { assert.fail("no new handoff"); }, sendMessage() { assert.fail("no role turn"); } }, state,
      { getActiveRole: () => state.activeRole, requireRecovery() { assert.fail("no new recovery state"); } });
    const scope = handoff.capture(ctx);
    state.roleRecoveryPending = false;
    if (boundary === "persist-failed") state.roleRecoveryPersistenceFailed = true;
    if (boundary === "stopped") state.userStopRequested = true;
    if (boundary === "stale") state.roleContextGeneration++;
    const before = structuredClone(state);
    const result = handoff.finishSwitch(ctx, scope, state.activeRole);
    assert.equal(result.terminate, ["stopped", "stale"].includes(boundary), boundary);
    assert.deepEqual(state, before, boundary);
    assert.equal(await handoff.schedule(ctx), false, boundary);
  }
});

test("replanning preserves oversized protected history under SDK budgeting without suspending task memory", () => {
  for (const recoveryPending of [false, true]) {
    const workflow = requestWorkflowReplan(waitingWorkflow(), { direction: "Adjust the remaining tasks" });
    workflow.continuation.phase = "queued";
    const state = { ...createExtensionRuntimeState(), workflowState: workflow, roleRecoveryPending: recoveryPending };
    const observations = [];
    state.traceHandoff = (_ctx, event, data) => observations.push({ event, data });
    const messages = [
      { role: "user", content: "Keep the confirmed constraints. ".repeat(30000), timestamp: 0 },
      { role: "custom", customType: "pi-init-task-memory-view", content: "Saved observations are historical", timestamp: 0 },
      { role: "assistant", content: [{ type: "toolCall", id: "failed-call", name: "bash", arguments: {} }], timestamp: 1 },
      { role: "toolResult", toolCallId: "failed-call", toolName: "bash", isError: true, content: [{ type: "text", text: "Unresolved failure; do not replay" }], timestamp: 1 },
      { role: "custom", customType: "unknown-side-effect", content: "Do not infer success", timestamp: 2 },
    ];
    const before = structuredClone(state.workflowState);
    const recovery = createRoleRecovery({ on() {}, appendEntry() { assert.fail("must not persist"); } }, state,
      event => ({ messages: event.messages }), undefined, { suspend() { assert.fail("byte size must not stop replanning"); } });
    const result = recovery.context({ messages }, { model: { contextWindow: 500000 } });
    for (const message of messages) assert.ok(result.messages.includes(message));
    assert.equal(observations.at(-1).data.budgetBytes, null);
    assert.equal(observations.at(-1).data.overBudget, false);
    assert.equal(observations.at(-1).data.reason, "sdk-token-budget");
    assert.deepEqual(state.workflowState, before);
    assert.equal(state.roleRecoveryPending, recoveryPending);
  }
});
