import assert from "node:assert/strict";
import test from "node:test";
import { createRoleContextView, ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE } from "../extensions/role-context-view.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowState, requestWorkflowReplan, ensureWorkflowReplanHandoff, workflowReplanIdentity, applyWorkflowReplan } from "../src/workflow.ts";
import { hasCompleteToolPairs } from "../extensions/role-context-protocol.ts";
import { createRoleRecovery } from "../extensions/role-recovery.ts";
import { isWaitingWorkflowBoundary } from "../extensions/role-context-waiting.ts";

function fixture() {
  let workflow = createWorkflowState({ sessionId: "waiting-session", summary: "Original plan", constraints: ["Never change production"], tasks: [{ id: "old", task: "Old task", files: ["src"], acceptanceCriteria: ["checked"] }] }, 1);
  workflow = requestWorkflowReplan(workflow, { direction: "Replan safely" }, 2);
  workflow = ensureWorkflowReplanHandoff(workflow, 3);
  workflow.continuation.phase = "queued";
  const identity = workflowReplanIdentity(workflow);
  const anchor = { role: "custom", customType: "pi-init-workflow-replan", details: identity, content: "Historical replan handoff", timestamp: 3 };
  workflow = applyWorkflowReplan(workflow, { revisionId: workflow.pendingRevision.revisionId, summary: "New plan", constraints: ["Never change production"], tasks: [{ id: "new", task: "New task", files: ["src"], acceptanceCriteria: ["checked"] }], retainTaskIds: [] }, 4);
  const state = createExtensionRuntimeState();
  state.workflowState = workflow;
  state.activeRole = { role: "architect", provider: "test", model: "test" };
  const branch = [{ type: "custom_message", id: "anchor", customType: anchor.customType, details: identity }, { type: "custom", id: "saved", customType: "pi-init-workflow", data: structuredClone(workflow) }];
  const pair = (id, failed = false) => [{ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: {} }], timestamp: 1 }, { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: id }], isError: failed, timestamp: 2 }];
  const messages = [{ role: "user", content: "Original constraint", timestamp: 0 }, ...pair("ancient-success"), ...pair("prior-failure", true), { role: "custom", customType: "unknown-side-effect", content: "Outcome not confirmed", timestamp: 2 }, anchor, ...pair("replan-result"), { role: "user", content: "Continue as suggested", timestamp: 5 }];
  const ctx = { sessionManager: { getSessionId: () => "waiting-session", getBranch: () => branch } };
  return { state, branch, messages, ctx };
}

test("queued user input after replan retains the trusted waiting window instead of restoring old successful history", () => {
  const f = fixture();
  const original = structuredClone({ state: f.state.workflowState, branch: f.branch, messages: f.messages });
  const project = () => createRoleContextView(f.state).context({ messages: f.messages }, f.ctx).messages;
  const result = project();
  assert.ok(!result.some(message => message.toolCallId === "ancient-success"));
  assert.ok(result.some(message => message.toolCallId === "prior-failure"));
  assert.ok(result.some(message => message.customType === "unknown-side-effect"));
  assert.ok(result.some(message => message.toolCallId === "replan-result"));
  assert.equal(result.filter(message => message.role === "user").length, 2);
  assert.ok(!result.some(message => message.customType === "pi-init-workflow-replan"));
  assert.ok(hasCompleteToolPairs(result));
  const snapshot = result.find(message => message.customType === "pi-init-workflow-waiting-context");
  assert.match(snapshot.content, /Never change production/);
  assert.match(snapshot.content, /不是.*执行授权/);
  assert.equal(snapshot.details.sourceEntryId, "saved");
  assert.deepEqual(project(), result);
  assert.deepEqual({ state: f.state.workflowState, branch: f.branch, messages: f.messages }, original);
});

test("waiting projection preserves full input when snapshot, branch, identity or pairing cannot be verified", () => {
  for (const failure of ["missing-source", "stale-source", "duplicate-source", "wrong-session", "missing-anchor", "duplicate-anchor", "future-anchor", "missing-result", "system", "recovery"]) {
    const f = fixture();
    if (failure === "missing-source") f.branch.pop();
    if (failure === "stale-source") f.branch[1].data.plan.summary = "stale";
    if (failure === "duplicate-source") f.branch.push(structuredClone(f.branch[1]));
    if (failure === "wrong-session") f.state.workflowState.sessionId = "foreign";
    if (failure === "missing-anchor") f.branch.shift();
    if (failure === "duplicate-anchor") f.branch.unshift(structuredClone(f.branch[0]));
    if (failure === "future-anchor") f.branch[0].details.planVersion = 99;
    if (failure === "missing-result") f.messages = f.messages.filter(message => message.toolCallId !== "ancient-success");
    if (failure === "system") f.messages.unshift({ role: "system", content: "host state", timestamp: 0 });
    if (failure === "recovery") f.state.roleRecoveryPending = true;
    const before = structuredClone(f.messages);
    const result = createRoleContextView(f.state).context({ messages: f.messages }, f.ctx)?.messages ?? f.messages;
    assert.deepEqual(result.filter(message => message.customType !== ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE), before, failure);
    assert.ok(!result.some(message => message.customType === "pi-init-workflow-waiting-context"), failure);
  }
});

test("verified waiting views retain unknown records and transition results through the downstream budget", () => {
  const f = fixture();
  f.ctx.model = { contextWindow: 1000 };
  f.messages.find(message => message.customType === "unknown-side-effect").content = "Unknown result ".repeat(10000);
  f.messages.find(message => message.toolCallId === "replan-result").content[0].text = "Verified transition ".repeat(10000);
  const view = createRoleContextView(f.state);
  assert.equal(isWaitingWorkflowBoundary(f.state), true);
  assert.equal(isWaitingWorkflowBoundary({ workflowState: undefined, customType: "pi-init-workflow-waiting-context" }), false, "a custom marker cannot bypass budget checks");
  const recovery = createRoleRecovery({ on() {}, appendEntry() { assert.fail("context must remain read-only"); } }, f.state, view.context);
  const result = recovery.context({ messages: f.messages }, f.ctx);
  assert.ok(result.messages.includes(f.messages.find(message => message.customType === "unknown-side-effect")));
  assert.ok(result.messages.includes(f.messages.find(message => message.toolCallId === "replan-result")));
  assert.equal(f.state.workflowState.continuation.phase, "pending");
  assert.equal(f.state.workflowState.currentTaskId, undefined);
  assert.ok(hasCompleteToolPairs(result.messages));
});

test("waiting snapshot failures preserve large unknown outcomes through the complete recovery callback", () => {
  for (const failure of ["missing-source", "stale-source", "system", "session", "compaction", "recovery", "recovery-persistence"]) {
    const f = fixture();
    f.ctx.model = { contextWindow: 1000 };
    const unknown = f.messages.find(message => message.customType === "unknown-side-effect");
    unknown.content = "unknown-result ".repeat(16000);
    if (failure === "missing-source") f.branch.length = 0;
    if (failure === "stale-source") f.branch[1].data.plan.summary = "stale plan";
    if (failure === "system") f.messages.unshift({ role: "system", content: "host state", timestamp: 0 });
    if (failure === "session") f.ctx.sessionManager.getSessionId = () => "foreign-session";
    if (failure === "compaction") f.state.roleCompactionInFlight = true;
    if (failure === "recovery") f.state.roleRecoveryPending = true;
    if (failure === "recovery-persistence") f.state.roleRecoveryPersistenceFailed = true;
    const before = structuredClone(f.messages);
    const recovery = createRoleRecovery({ on() {}, appendEntry() { assert.fail("failure must remain read-only"); } }, f.state, createRoleContextView(f.state).context);
    const result = recovery.context({ messages: f.messages }, f.ctx);
    const messages = result?.messages ?? f.messages;
    assert.ok(messages.includes(unknown), failure);
    assert.deepEqual(messages.filter(message => ![ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE, "pi-init-role-recovery"].includes(message.customType)), before, failure);
    assert.equal(messages.some(message => message.customType === "pi-init-context-checkpoint"), false, failure);
  }
});
