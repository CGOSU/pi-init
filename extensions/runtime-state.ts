import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { createWorkflowState } from "../src/workflow.js";

export type ActiveRole = {
  role: string;
  provider: string;
  model: string;
  thinkingLevel: string;
};

export type RoleCompactionContinuation =
  | { kind: "workflow-task"; taskId: string }
  | { kind: "workflow-schedule" }
  | { kind: "workflow-review" }
  | { kind: "workflow-replan" };

export type PendingRoleCompaction = {
  fromRole: string;
  toRole: string;
  continuation?: RoleCompactionContinuation;
};

export type ExtensionRuntimeState = {
  activeRole?: ActiveRole;
  sessionModeOverride?: string;
  sessionRoleConfigOverrides: Record<string, unknown>;
  configuredRoleNames: string[];
  controlCenterGuideShown: boolean;
  roleModeStatus: string;
  workflowModeStatus: string;
  workflowExecutorStatus: string;
  roleRecoveryPending: boolean;
  pendingRoleCompaction?: PendingRoleCompaction;
  workflowTaskCompactionPending: boolean;
  roleCompactionInFlight: boolean;
  workflowState?: WorkflowState;
  workflowDispatchInFlight: boolean;
  internalContinuationPending: boolean;
  currentContext?: ExtensionContext;
  runtimeDisposed: boolean;
};

export type WorkflowState = ReturnType<typeof createWorkflowState>;

export function createExtensionRuntimeState(): ExtensionRuntimeState {
  return {
    sessionRoleConfigOverrides: {},
    configuredRoleNames: [],
    controlCenterGuideShown: false,
    roleModeStatus: "auto",
    workflowModeStatus: "auto",
    workflowExecutorStatus: "local",
    roleRecoveryPending: false,
    workflowTaskCompactionPending: false,
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
