import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { createWorkflowState } from "../src/workflow.js";
export type ActiveRole = {
  role: string;
  provider: string;
  model: string;
  thinkingLevel: string;
};

export type WorkflowActionIdentity = {
  workflowId: string;
  planVersion: number;
  sessionId: string;
  recoveryGeneration: number;
};

export type WorkflowHandoffIdentity = WorkflowActionIdentity & {
  taskId: string;
  attemptId: string;
  handoffId: string;
};

export type WorkflowReplanIdentity = WorkflowActionIdentity & {
  revisionId: string;
  handoffId: string;
};

export type WorkflowHandoff = WorkflowHandoffIdentity & {
  phase: "prepared" | "waiting-role" | "compacting" | "dispatching" | "queued" | "executing" | "uncertain";
  createdAt: number;
  startedAt?: number;
};

export type WorkflowContinuation =
  | { kind: "schedule"; phase: "pending" | "compacting"; reason?: "plan-created" | "task-completed" | "replan-applied" | "retry" | "resume" }
  | { kind: "replan"; revisionId: string; handoffId?: string; phase: "pending" | "compacting" | "dispatching" | "queued"; reason?: "task-completed" | "replan-requested" }
  | { kind: "review" };

export type RoleCompactionContinuation =
  | { kind: "workflow-task"; taskId: string; identity: WorkflowHandoffIdentity }
  | { kind: "workflow-schedule"; identity: WorkflowActionIdentity }
  | { kind: "workflow-review"; identity: WorkflowActionIdentity }
  | { kind: "workflow-replan"; identity: WorkflowReplanIdentity };

export type PendingRoleCompaction = {
  fromRole: string;
  toRole: string;
  continuation?: RoleCompactionContinuation;
};

export type RoleCompactionPhase = "idle" | "compacting" | "stalled";

export type ExtensionRuntimeState = {
  activeRole?: ActiveRole;
  sessionModeOverride?: string;
  sessionRoleConfigOverrides: Record<string, unknown>;
  configuredRoleNames: string[];
  controlCenterGuideShown: boolean;
  roleModeStatus: string;
  workflowModeStatus: string;
  workflowRestoreError?: { code: string; message: string };
  pendingWorkflowRecovery?: WorkflowState;
  roleRecoveryPending: boolean;
  pendingRoleCompaction?: PendingRoleCompaction;
  roleCompactionPhase: RoleCompactionPhase;
  roleCompactionStalled: boolean;
  roleCompactionOperationId?: string;
  roleCompactionStartedAt?: number;
  roleCompactionInFlight: boolean;
  workflowState?: WorkflowState;
  workflowDispatchInFlight: boolean;
  internalContinuationPending: boolean;
  currentContext?: ExtensionContext;
  runtimeDisposed: boolean;
};

type BaseWorkflowState = ReturnType<typeof createWorkflowState>;
export type WorkflowState = Omit<BaseWorkflowState, "workflowId" | "sessionId" | "planVersion" | "recoveryGeneration" | "handoff" | "continuation"> & {
  workflowId: string;
  sessionId: string;
  planVersion: number;
  recoveryGeneration: number;
  handoff?: WorkflowHandoff;
  continuation?: WorkflowContinuation;
};

export function createExtensionRuntimeState(): ExtensionRuntimeState {
  return {
    sessionRoleConfigOverrides: {},
    configuredRoleNames: [],
    controlCenterGuideShown: false,
    roleModeStatus: "auto",
    workflowModeStatus: "auto",
    roleRecoveryPending: false,
    roleCompactionPhase: "idle",
    roleCompactionStalled: false,
    roleCompactionInFlight: false,
    workflowDispatchInFlight: false,
    internalContinuationPending: false,
    runtimeDisposed: false,
  };
}

export function textOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function activeRoleMatches(
  state: ExtensionRuntimeState,
  ctx: ExtensionContext,
  thinkingLevel: string,
) {
  const role = state.activeRole;
  if (!role || !ctx.model) return false;
  return role.provider === ctx.model.provider
    && role.model === ctx.model.id
    && role.thinkingLevel === thinkingLevel;
}
