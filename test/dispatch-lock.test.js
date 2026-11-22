import assert from "node:assert/strict";
import test from "node:test";
import { acquireDispatchLock, releaseDispatchLock, resetDispatchLock } from "../extensions/workflow/dispatch-lock.ts";

const lockState = (workflowId = "workflow") => ({ workflowDispatchInFlight: false, workflowState: { workflowId } });

test("the lease that took the lock releases it", () => {
  const state = lockState();
  const lease = acquireDispatchLock(state);
  assert.equal(state.workflowDispatchInFlight, true);
  releaseDispatchLock(state, lease);
  assert.equal(state.workflowDispatchInFlight, false);
  assert.equal(state.workflowDispatchLease, undefined);
});

test("a lease superseded by a reset or a newer lease cannot clear the lock", () => {
  const state = lockState();
  const stale = acquireDispatchLock(state);
  resetDispatchLock(state);
  const current = acquireDispatchLock(state);
  releaseDispatchLock(state, stale);
  assert.equal(state.workflowDispatchInFlight, true);
  assert.equal(state.workflowDispatchLease, current);
  releaseDispatchLock(state, current);
  assert.equal(state.workflowDispatchInFlight, false);
});

test("a lease never clears the lock on behalf of another workflow", () => {
  const state = lockState("old");
  const lease = acquireDispatchLock(state);
  state.workflowState = { workflowId: "new" };
  releaseDispatchLock(state, lease);
  assert.equal(state.workflowDispatchInFlight, true);
  assert.equal(state.workflowDispatchLease, undefined);
});
