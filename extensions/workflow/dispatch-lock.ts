import type { DispatchLease, ExtensionRuntimeState } from "../runtime-state.ts";

type LockState = Pick<ExtensionRuntimeState, "workflowDispatchInFlight" | "workflowDispatchLease" | "workflowState">;

/*
 * workflowDispatchInFlight is written only through these functions.
 * A scheduling call takes a lease before awaiting role selection or sending a handoff and releases it in
 * finally, so every exit (stop during an await, early return, thrown error, unknown outcome) frees the lock.
 * A reset or a newer lease supersedes an older one: a scheduler that resolves late cannot clear a lock it
 * no longer holds, and a lease never clears the lock on behalf of a different workflow.
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
  if (state.workflowState?.workflowId === lease.workflowId) state.workflowDispatchInFlight = false;
}

/** Lifecycle boundary with no dispatch in flight: restore, explicit resume, committed result, unschedulable plan. */
export function resetDispatchLock(state: Pick<ExtensionRuntimeState, "workflowDispatchInFlight" | "workflowDispatchLease">) {
  state.workflowDispatchLease = undefined;
  state.workflowDispatchInFlight = false;
}
