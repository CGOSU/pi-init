export { textOf } from "../src/error-utils.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { isExternalRunSource } from "../src/run-timing.ts";
import type { ThinkingLevel, WorkflowMode } from "../src/role-types.ts";
import type { WorkflowProgressObservation } from "../src/workflow-progress.ts";
import type { WorkflowState } from "../src/workflow-types.ts";
export type {
  WorkflowActionIdentity,
  WorkflowContinuation,
  WorkflowHandoff,
  WorkflowHandoffIdentity,
  WorkflowReplanIdentity,
  WorkflowState,
} from "../src/workflow-types.ts";
export type ActiveRole = {
  role: string;
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
};

/** Held by the one scheduling call that set workflowDispatchInFlight; see workflow/dispatch-lock.ts. */
export type DispatchLease = { readonly workflowId: string | undefined };

export type ExtensionRuntimeState = {
  traceHandoff?: (ctx: ExtensionContext, event: string, data?: Record<string, unknown>) => void;
  agentRunActive: boolean;
  userStopRequested: boolean;
  userStopGeneration: number;
  activeRole?: ActiveRole;
  sessionRoleConfigOverrides: Record<string, unknown>;
  configuredRoleNames: string[];
  controlCenterGuideShown: boolean;
  workflowModeStatus: WorkflowMode;
  workflowRestoreError?: { code: string; message: string; sourceEntryId?: string };
  workflowNoticeAcknowledgement?: { sessionId: string; contextGeneration: number; sourceKey: string };
  pendingWorkflowRecovery?: WorkflowState;
  roleRecoveryPending: boolean;
  roleRecoveryPersistenceFailed: boolean;
  roleContextGeneration: number;
  roleTransitionGeneration: number;
  workflowState?: WorkflowState;
  workflowProgressObservation?: WorkflowProgressObservation;
  workflowDispatchInFlight: boolean;
  workflowDispatchLease?: DispatchLease;
  internalContinuationPending: boolean;
  currentContext?: ExtensionContext;
  runtimeDisposed: boolean;
};

// Live views are shallow: workflow snapshots are replaced via pure domain
// transitions. Each owner declares the runtime fields it may replace.
export type RuntimeStateView = Readonly<ExtensionRuntimeState>;
export type RuntimeStateAccess<Writable extends keyof ExtensionRuntimeState> =
  Omit<RuntimeStateView, Writable> & Pick<ExtensionRuntimeState, Writable>;

export function createExtensionRuntimeState(): ExtensionRuntimeState {
  return {
    agentRunActive: false,
    userStopRequested: false,
    userStopGeneration: 0,
    sessionRoleConfigOverrides: {},
    configuredRoleNames: [],
    controlCenterGuideShown: false,
    workflowModeStatus: "auto",
    roleRecoveryPending: false,
    roleRecoveryPersistenceFailed: false,
    roleContextGeneration: 0,
    roleTransitionGeneration: 0,
    workflowDispatchInFlight: false,
    internalContinuationPending: false,
    runtimeDisposed: false,
  };
}

export function activeRoleMatches(
  state: Pick<RuntimeStateView, "activeRole">,
  ctx: ExtensionContext,
  thinkingLevel: string,
) {
  const role = state.activeRole;
  if (!role || !ctx.model) return false;
  return role.provider === ctx.model.provider
    && role.model === ctx.model.id
    && role.thinkingLevel === thinkingLevel;
}

export function firstPolicyMatch<T>(rules: ReadonlyArray<readonly [unknown, T]>): T | undefined {
  return rules.find(([matched]) => Boolean(matched))?.[1];
}

export function matchPolicy<T>(rules: ReadonlyArray<readonly [() => unknown, T | (() => T)]>): T | undefined {
  for (const [when, result] of rules) {
    if (when()) return typeof result === "function" ? (result as () => T)() : result;
  }
  return undefined;
}

export function hasRecoveryGate(
  state: Pick<ExtensionRuntimeState, "roleRecoveryPending" | "roleRecoveryPersistenceFailed" | "pendingWorkflowRecovery" | "workflowRestoreError">,
) {
  return Boolean(state.roleRecoveryPending || state.roleRecoveryPersistenceFailed || state.pendingWorkflowRecovery || state.workflowRestoreError);
}

export function isExecutionBlockedState(
  state: Pick<ExtensionRuntimeState, "runtimeDisposed" | "userStopRequested" | "roleRecoveryPending" | "roleRecoveryPersistenceFailed" | "pendingWorkflowRecovery" | "workflowRestoreError">,
) {
  return Boolean(state.runtimeDisposed || state.userStopRequested || hasRecoveryGate(state));
}

export function isWorkflowUnfinished(workflow: WorkflowState | undefined): workflow is WorkflowState {
  return Boolean(workflow && !["completed", "cancelled"].includes(workflow.status));
}

export function executingWorkflowTask(state: Pick<RuntimeStateView, "workflowState" | "activeRole">, sessionId?: string) {
  const workflow = state.workflowState;
  const handoff = workflow?.handoff;
  const task = workflow?.tasks.find((item) => item.id === workflow.currentTaskId);
  if (!workflow || !handoff || !task || workflow.status !== "running" || handoff.phase !== "executing"
    || task.status !== "in_progress" || task.outcomeUnknown || state.activeRole?.role !== task.role
    || !workflow.workflowId || !handoff.attemptId || !handoff.handoffId || handoff.taskId !== task.id
    || handoff.workflowId !== workflow.workflowId || handoff.planVersion !== workflow.planVersion
    || handoff.recoveryGeneration !== workflow.recoveryGeneration || handoff.sessionId !== workflow.sessionId
    || (sessionId !== undefined && workflow.sessionId !== sessionId)) return undefined;
  return { workflow, task, handoff };
}

export function onEvents(
  pi: { on?: ExtensionAPI["on"] },
  events: readonly ExtensionEvent["type"][],
  handler: (event: any, ctx: ExtensionContext) => unknown,
) {
  for (const event of events) pi.on?.(event as never, handler as never);
}

export function onLifecycleReset(
  pi: { on?: ExtensionAPI["on"] },
  reset: () => void,
  options: {
    agentStart?: boolean;
    modelSelect?: boolean;
    compact?: boolean;
    externalInput?: boolean | (() => void);
    nonExtensionInput?: boolean;
    branchMove?: "always" | "changed-or-undefined" | "changed-only";
    onUnchangedBranch?: () => void;
  } = {},
) {
  onEvents(pi, [
    "session_start",
    "session_shutdown",
    ...(options.agentStart ? (["agent_start"] as const) : []),
    ...(options.modelSelect ? (["model_select"] as const) : []),
    ...(options.compact ? (["session_compact"] as const) : []),
  ], () => reset());
  pi.on?.("session_tree", (event) => {
    const mode = options.branchMove ?? "always";
    const changed = mode === "changed-only"
      ? event?.oldLeafId !== event?.newLeafId
      : mode === "changed-or-undefined"
        ? event?.oldLeafId === undefined || event.oldLeafId !== event.newLeafId
        : true;
    if (changed) reset();
    else options.onUnchangedBranch?.();
  });
  if (options.externalInput || options.nonExtensionInput) {
    pi.on?.("input", (event) => {
      if (options.externalInput ? isExternalRunSource(event?.source) : event?.source !== "extension") {
        if (typeof options.externalInput === "function") options.externalInput();
        else reset();
      }
    });
  }
}
