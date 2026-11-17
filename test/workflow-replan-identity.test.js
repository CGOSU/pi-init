import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowState } from "./support/workflow-fixtures.js";
import {
  ensureWorkflowReplanHandoff,
  requestWorkflowReplan,
  validateWorkflowReplanIdentity,
  workflowReplanIdentity,
} from "../src/workflow.ts";

function fixture() {
  const initial = createWorkflowState({
    summary: "重规划身份校验",
    tasks: [{
      id: "implementation",
      task: "实现目标",
      files: ["src/"],
      acceptanceCriteria: ["保持已确认行为"],
    }],
  });
  const state = ensureWorkflowReplanHandoff(requestWorkflowReplan(initial, {
    direction: "调整后续任务",
  }));
  const identity = workflowReplanIdentity(state);
  const branch = [{
    messageType: "pi-init-workflow-replan",
    identity,
  }];
  const context = { sessionId: state.sessionId, anchors: branch };
  return { state, identity, branch, context };
}

test("replan identity rejects every incomplete handoff state with the same diagnostics", () => {
  const { state, identity, context } = fixture();
  const incompleteStates = [
    { ...state, status: "running" },
    { ...state, pendingRevision: undefined },
    { ...state, continuation: undefined },
    { ...state, continuation: { ...state.continuation, kind: "task" } },
    { ...state, continuation: { ...state.continuation, handoffId: undefined } },
    { ...state, continuation: { ...state.continuation, handoffId: "" } },
  ];
  for (const incomplete of incompleteStates) {
    assert.equal(workflowReplanIdentity(incomplete), undefined);
    const result = validateWorkflowReplanIdentity(incomplete, identity, context);
    assert.equal(result.ok, false);
    assert.equal(result.code, "WORKFLOW_REPLAN_HANDOFF_MISSING");
    assert.deepEqual(result.mismatchedFields, ["replan.handoff"]);
    assert.deepEqual(result.received, {
      workflowId: identity.workflowId,
      planVersion: identity.planVersion,
      sessionId: identity.sessionId,
      recoveryGeneration: identity.recoveryGeneration,
    });
    assert.deepEqual(result.expected, result.received);
  }
});

test("replan validation preserves base identity error precedence", () => {
  const { state, identity, context } = fixture();
  const incomplete = { ...state, pendingRevision: undefined };
  assert.equal(validateWorkflowReplanIdentity(incomplete, undefined, context).code, "WORKFLOW_ACTION_IDENTITY_MISSING");
  assert.equal(validateWorkflowReplanIdentity(incomplete, {
    ...identity,
    sessionId: "different-session",
  }, context).code, "WORKFLOW_SESSION_MISMATCH");
});

test("replan validation still enforces current revision and branch ownership", () => {
  const { state, identity, branch, context } = fixture();
  assert.deepEqual(validateWorkflowReplanIdentity(state, identity, context), { ok: true, value: identity });
  assert.equal(validateWorkflowReplanIdentity(state, {
    ...identity,
    revisionId: "old-revision",
  }, context).code, "WORKFLOW_REPLAN_STALE");
  assert.equal(validateWorkflowReplanIdentity(state, {
    ...identity,
    handoffId: undefined,
  }, context).code, "WORKFLOW_ACTION_IDENTITY_MISSING");
  branch.length = 0;
  assert.equal(validateWorkflowReplanIdentity(state, identity, context).code, "WORKFLOW_REPLAN_BRANCH_MISMATCH");
});
