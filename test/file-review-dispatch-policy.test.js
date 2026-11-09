import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFileReviewDispatch } from "../extensions/file-review-dispatch-policy.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";

test("审阅派发保持恢复、活动工作流、派发和忙碌检查的优先级", () => {
  const state = createExtensionRuntimeState();
  Object.assign(state, {
    roleRecoveryPersistenceFailed: true,
    workflowRestoreError: { code: "RESTORE_ERROR", message: "restore failed" },
    pendingWorkflowRecovery: {},
    workflowState: { status: "running" },
    workflowDispatchInFlight: true,
  });
  const notReached = { isIdle() { assert.fail("阻断时不应继续检查 Agent 状态"); } };
  const blockers = [
    ["roleRecoveryPersistenceFailed", false, "ROLE_RECOVERY_PERSIST_FAILED"],
    ["workflowRestoreError", undefined, "WORKFLOW_RESTORE_FAILED"],
    ["pendingWorkflowRecovery", undefined, "WORKFLOW_RECOVERY_PENDING"],
    ["workflowState", undefined, "WORKFLOW_ACTIVE"],
    ["workflowDispatchInFlight", false, "WORKFLOW_DISPATCH_IN_FLIGHT"],
  ];
  for (const [field, cleared, code] of blockers) {
    const decision = evaluateFileReviewDispatch(state, notReached);
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, code);
    state[field] = cleared;
  }
  const busy = evaluateFileReviewDispatch(state, { isIdle: () => false });
  assert.equal(busy.allowed, false);
  assert.equal(busy.code, "AGENT_BUSY");
  assert.deepEqual(evaluateFileReviewDispatch(state, { isIdle: () => true }), { allowed: true });
});

test("仅终态工作流不阻止审阅派发，暂停和重规划仍阻断", () => {
  const state = createExtensionRuntimeState();
  const ctx = { isIdle: () => true };
  for (const status of ["completed", "cancelled"]) {
    state.workflowState = { status };
    assert.equal(evaluateFileReviewDispatch(state, ctx).allowed, true);
  }
  for (const status of ["running", "paused", "replanning"]) {
    state.workflowState = { status };
    assert.equal(evaluateFileReviewDispatch(state, ctx).code, "WORKFLOW_ACTIVE");
  }
});
