import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RoleMode, ThinkingLevel, WorkflowMode } from "../src/role-types.ts";
import type {
  CoordinationHandoffIdentity,
  CoordinationRestoreError,
  CoordinationRuntimeState,
} from "../src/coordination-runtime-types.ts";
import type {
  WorkflowActionIdentity,
  WorkflowHandoffIdentity,
  WorkflowReplanIdentity,
  WorkflowState,
} from "../src/workflow-types.ts";
export type { CoordinationHandoffIdentity, CoordinationRuntimeState } from "../src/coordination-runtime-types.ts";
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

export type RoleCompactionContinuation =
  | { kind: "workflow-boundary"; identity: WorkflowActionIdentity }
  | { kind: "coordination-boundary"; identity: CoordinationHandoffIdentity }
  | { kind: "workflow-task"; taskId: string; identity: WorkflowHandoffIdentity }
  | { kind: "workflow-schedule"; identity: WorkflowActionIdentity }
  | { kind: "workflow-review"; identity: WorkflowActionIdentity }
  | { kind: "workflow-replan"; identity: WorkflowReplanIdentity }
  | { kind: "coordination-evidence"; identity: CoordinationHandoffIdentity };

export type PendingRoleCompaction = {
  fromRole: string;
  toRole: string;
  sessionId: string;
  contextGeneration: number;
  roleTransitionGeneration: number;
  targetRole: ActiveRole;
  continuation?: RoleCompactionContinuation;
};

export type RoleCompactionPhase = "idle" | "compacting";

export type ExtensionRuntimeState = {
  traceHandoff?: (ctx: ExtensionContext, event: string, data?: Record<string, unknown>) => void;
  agentRunActive: boolean;
  activeRole?: ActiveRole;
  sessionModeOverride?: RoleMode;
  sessionRoleConfigOverrides: Record<string, unknown>;
  configuredRoleNames: string[];
  controlCenterGuideShown: boolean;
  roleModeStatus: RoleMode;
  workflowModeStatus: WorkflowMode;
  workflowRestoreError?: { code: string; message: string; sourceEntryId?: string };
  coordinationRuntimeState?: CoordinationRuntimeState;
  coordinationRestoreError?: CoordinationRestoreError;
  workflowNoticeAcknowledgement?: { sessionId: string; contextGeneration: number; sourceKey: string };
  pendingWorkflowRecovery?: WorkflowState;
  roleRecoveryPending: boolean;
  roleRecoveryPersistenceFailed: boolean;
  roleContextGeneration: number;
  roleTransitionGeneration: number;
  pendingRoleCompaction?: PendingRoleCompaction;
  activeRoleCompaction?: { operationId: string; transition: PendingRoleCompaction };
  roleCompactionPhase: RoleCompactionPhase;
  roleCompactionOperationId?: string;
  roleCompactionStartedAt?: number;
  roleCompactionInFlight: boolean;
  workflowState?: WorkflowState;
  workflowDispatchInFlight: boolean;
  internalContinuationPending: boolean;
  currentContext?: ExtensionContext;
  runtimeDisposed: boolean;
};

export function createExtensionRuntimeState(): ExtensionRuntimeState {
  return {
    agentRunActive: false,
    sessionRoleConfigOverrides: {},
    configuredRoleNames: [],
    controlCenterGuideShown: false,
    roleModeStatus: "auto",
    workflowModeStatus: "auto",
    roleRecoveryPending: false,
    roleRecoveryPersistenceFailed: false,
    roleContextGeneration: 0,
    roleTransitionGeneration: 0,
    roleCompactionPhase: "idle",
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
