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
    type: "custom_message",
    customType: "pi-init-workflow-replan",
    details: identity,
  }];
  const ctx = {
    sessionManager: {
      getSessionId: () => state.sessionId,
      getBranch: () => branch,
    },
  };
  return { state, identity, branch, ctx };
}

test("replan identity rejects every incomplete handoff state with the same diagnostics", () => {
  const { state, identity, ctx } = fixture();
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
    const result = validateWorkflowReplanIdentity(incomplete, identity, ctx);
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
  const { state, identity, ctx } = fixture();
  const incomplete = { ...state, pendingRevision: undefined };
  assert.equal(validateWorkflowReplanIdentity(incomplete, undefined, ctx).code, "WORKFLOW_ACTION_IDENTITY_MISSING");
  assert.equal(validateWorkflowReplanIdentity(incomplete, {
    ...identity,
    sessionId: "different-session",
  }, ctx).code, "WORKFLOW_SESSION_MISMATCH");
});

test("replan validation still enforces current revision and branch ownership", () => {
  const { state, identity, branch, ctx } = fixture();
  assert.deepEqual(validateWorkflowReplanIdentity(state, identity, ctx), { ok: true, value: identity });
  assert.equal(validateWorkflowReplanIdentity(state, {
    ...identity,
    revisionId: "old-revision",
  }, ctx).code, "WORKFLOW_REPLAN_STALE");
  assert.equal(validateWorkflowReplanIdentity(state, {
    ...identity,
    handoffId: undefined,
  }, ctx).code, "WORKFLOW_ACTION_IDENTITY_MISSING");
  branch.length = 0;
  assert.equal(validateWorkflowReplanIdentity(state, identity, ctx).code, "WORKFLOW_REPLAN_BRANCH_MISMATCH");
});
