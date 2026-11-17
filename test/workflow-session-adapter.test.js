import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowState, markWorkflowTaskStarted } from "./support/workflow-fixtures.js";
import {
  ensureWorkflowReplanHandoff,
  requestWorkflowReplan,
  startWorkflowTask,
  validateWorkflowHandoffIdentity,
  validateWorkflowMutationIdentity,
  validateWorkflowReplanIdentity,
  workflowHandoffAnchorMatches,
  workflowHandoffIdentity,
  workflowReplanIdentity,
} from "../src/workflow.ts";
import { readWorkflowIdentityContext, workflowHandoffMessageOnBranch } from "../extensions/workflow/workflow-session-adapter.ts";

function fixture() {
  const initial = createWorkflowState({
    summary: "session identity boundary",
    tasks: [{ id: "task", task: "implement", files: ["src/"], acceptanceCriteria: ["verified"] }],
  }, 100);
  const state = markWorkflowTaskStarted(startWorkflowTask(initial, "task", 101), "task", 102);
  const identity = workflowHandoffIdentity(state);
  let branch = [{ type: "custom_message", customType: "pi-init-workflow-task", details: identity }];
  let sessionId = state.sessionId;
  const ctx = { sessionManager: { getSessionId: () => sessionId, getBranch: () => branch } };
  return {
    initial, state, identity, ctx,
    setBranch(value) { branch = value; },
    setSessionId(value) { sessionId = value; },
  };
}

const staleFields = {
  workflowId: "other-workflow",
  planVersion: 99,
  sessionId: "other-session",
  recoveryGeneration: 99,
  taskId: "other-task",
  attemptId: "old-attempt",
  handoffId: "old-handoff",
};

test("domain identity validation accepts data-only session and anchor inputs", () => {
  const { state, identity } = fixture();
  const context = {
    sessionId: state.sessionId,
    anchors: [{ messageType: "pi-init-workflow-task", identity }],
  };
  assert.equal(validateWorkflowMutationIdentity(state, identity, context).ok, true);
  assert.deepEqual(validateWorkflowHandoffIdentity(state, identity, context), { ok: true, value: identity });
  assert.equal(workflowHandoffAnchorMatches(context.anchors, identity), true);

  for (const [field, value] of Object.entries(staleFields)) {
    const result = validateWorkflowHandoffIdentity(state, { ...identity, [field]: value }, context);
    const code = field === "sessionId" ? "WORKFLOW_SESSION_MISMATCH"
      : ["taskId", "attemptId", "handoffId"].includes(field) ? "WORKFLOW_HANDOFF_STALE"
        : "WORKFLOW_ACTION_IDENTITY_STALE";
    assert.equal(result.code, code, field);
  }
});

test("session adapter preserves full task/attempt/handoff anchor ownership", () => {
  const f = fixture();
  assert.equal(workflowHandoffMessageOnBranch(f.ctx, f.identity), true);
  for (const [field, value] of Object.entries(staleFields)) {
    f.setBranch([{ type: "custom_message", customType: "pi-init-workflow-task", details: { ...f.identity, [field]: value } }]);
    assert.equal(workflowHandoffMessageOnBranch(f.ctx, f.identity), false, field);
  }
});

test("missing or non-task branch records cannot authorize a handoff result", () => {
  const f = fixture();
  const branches = [
    undefined,
    null,
    {},
    [],
    [null, "not-an-entry"],
    [{ type: "custom", customType: "pi-init-workflow-task", details: f.identity }],
    [{ type: "custom_message", customType: "pi-init-workflow-replan", details: f.identity }],
    [{ type: "custom_message", customType: "pi-init-workflow-task", details: null }],
  ];
  for (const branch of branches) {
    f.setBranch(branch);
    const context = readWorkflowIdentityContext(f.ctx);
    assert.equal(validateWorkflowMutationIdentity(f.state, f.identity, context).ok, true);
    assert.equal(workflowHandoffMessageOnBranch(f.ctx, f.identity), false);
    assert.equal(validateWorkflowHandoffIdentity(f.state, f.identity, context).code, "WORKFLOW_HANDOFF_BRANCH_MISMATCH");
  }
});

test("unavailable and foreign session IDs are never replaced with the saved workflow identity", () => {
  const f = fixture();
  for (const sessionId of [undefined, null, 0, "", "another-session"]) {
    f.setSessionId(sessionId);
    const context = readWorkflowIdentityContext(f.ctx);
    const result = validateWorkflowMutationIdentity(f.state, f.identity, context);
    assert.equal(result.code, sessionId === "another-session" ? "WORKFLOW_SESSION_MISMATCH" : "WORKFLOW_SESSION_ID_UNAVAILABLE");
    assert.equal(validateWorkflowMutationIdentity(f.state, undefined, context).code, "WORKFLOW_ACTION_IDENTITY_MISSING");
  }
});

test("replan adapter keeps revision validation separate from task anchors", () => {
  const f = fixture();
  const state = ensureWorkflowReplanHandoff(requestWorkflowReplan(f.initial, { direction: "adjust remaining work" }));
  const identity = workflowReplanIdentity(state);
  f.setBranch([{ type: "custom_message", customType: "pi-init-workflow-replan", details: identity }]);
  const context = readWorkflowIdentityContext(f.ctx);
  assert.deepEqual(validateWorkflowReplanIdentity(state, identity, context), { ok: true, value: identity });
  assert.equal(validateWorkflowReplanIdentity(state, { ...identity, revisionId: "old-revision" }, context).code, "WORKFLOW_REPLAN_STALE");
  assert.equal(validateWorkflowReplanIdentity(state, { ...identity, handoffId: "old-handoff" }, context).code, "WORKFLOW_REPLAN_STALE");

  f.setBranch([{ type: "custom_message", customType: "pi-init-workflow-task", details: identity }]);
  assert.equal(validateWorkflowReplanIdentity(state, identity, readWorkflowIdentityContext(f.ctx)).code, "WORKFLOW_REPLAN_BRANCH_MISMATCH");
});
