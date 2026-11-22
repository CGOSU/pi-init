import type { DispatchLease, ExtensionRuntimeState } from "../runtime-state.ts";

type LockState = Pick<ExtensionRuntimeState, "workflowDispatchInFlight" | "workflowDispatchLease" | "workflowState">;

/*
 * workflowDispatchInFlight is written only through these functions.
 * A scheduling call takes a lease before awaiting role selection or sending a handoff and releases it in
 * finally, so every exit (stop during an await, early return, thrown error, unknown outcome) frees the lock.
 * Only the active lease can release the lock; a reset or a newer lease supersedes an older lease so a
 * late-resolving scheduler never clears another workflow's lock, and releasing the active lease always
 * restores the invariant workflowDispatchInFlight === (workflowDispatchLease !== undefined).
 */
export function acquireDispatchLock(state: LockState): DispatchLease {
  const lease: DispatchLease = { workflowId: state.workflowState?.workflowId };
  state.workflowDispatchLease = lease;
  state.workflowDispatchInFlight = true;
  return lease;
}

export function releaseDispatchLock(state: LockState, lease: DispatchLease) {
  if (state.workflowDispatchLease !== lease) return;
  state.workflowDispatchLease = undefined;
  state.workflowDispatchInFlight = false;
}

/** Lifecycle boundary with no dispatch in flight: restore, explicit resume, committed result, unschedulable plan. */
export function resetDispatchLock(state: Pick<ExtensionRuntimeState, "workflowDispatchInFlight" | "workflowDispatchLease">) {
  state.workflowDispatchLease = undefined;
  state.workflowDispatchInFlight = false;
}
