import assert from "node:assert/strict";
import test from "node:test";
import { sameWorkflowActionIdentity, sameWorkflowHandoffIdentity, sameWorkflowReplanIdentity } from "../src/workflow.ts";

const action = { workflowId: "w", planVersion: 1, sessionId: "s", recoveryGeneration: 2 };
const handoff = { ...action, taskId: "t", attemptId: "a", handoffId: "h" };
const replan = { ...action, revisionId: "r", handoffId: "h" };

test("identity comparison uses exactly the declared fields of each identity", () => {
  assert.equal(sameWorkflowHandoffIdentity(handoff, { ...handoff, phase: "executing", createdAt: 1 }), true);
  assert.equal(sameWorkflowActionIdentity(action, handoff), true, "an action identity matches the base fields of a handoff");
  for (const field of Object.keys(handoff)) {
    assert.equal(sameWorkflowHandoffIdentity(handoff, { ...handoff, [field]: "changed" }), false, field);
  }
  for (const field of Object.keys(replan)) {
    assert.equal(sameWorkflowReplanIdentity(replan, { ...replan, [field]: "changed" }), false, field);
  }
  assert.equal(sameWorkflowActionIdentity(action, { ...action, recoveryGeneration: 3 }), false);
});

test("a missing identity never matches", () => {
  assert.equal(sameWorkflowHandoffIdentity(undefined, handoff), false);
  assert.equal(sameWorkflowHandoffIdentity(handoff, undefined), false);
  assert.equal(sameWorkflowReplanIdentity(undefined, undefined), false);
});
