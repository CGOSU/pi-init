import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { createWorkflowState } from "../src/workflow.js";
import type { RuntimeClient } from "./runtime-client.ts";

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

export type RoleCompactionPhase = "idle" | "compacting" | "stalled";

export type RuntimeBackendHooks = {
  initialize: (workflow: WorkflowState, config: unknown, ctx: ExtensionContext) => Promise<WorkflowState>;
  schedule: (ctx: ExtensionContext) => Promise<void>;
  cancel: (ctx: ExtensionContext, reason: string) => Promise<void>;
  retry: (ctx: ExtensionContext, taskId?: string) => Promise<void>;
  dispose: () => void;
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
  roleCompactionPhase: RoleCompactionPhase;
  roleCompactionStalled: boolean;
  roleCompactionOperationId?: string;
  roleCompactionStartedAt?: number;
  workflowTaskCompactionPending: boolean;
  roleCompactionInFlight: boolean;
  workflowState?: WorkflowState;
  workflowDispatchInFlight: boolean;
  internalContinuationPending: boolean;
  currentContext?: ExtensionContext;
  runtimeDisposed: boolean;
  runtimeClient?: RuntimeClient;
  runtimeBackend?: RuntimeBackendHooks;
  runtimePollTimer?: ReturnType<typeof setTimeout>;
  runtimeDispatchInFlight: boolean;
  runtimeError?: { code: string; message: string };
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
    roleCompactionPhase: "idle",
    roleCompactionStalled: false,
    workflowTaskCompactionPending: false,
    roleCompactionInFlight: false,
    workflowDispatchInFlight: false,
    internalContinuationPending: false,
    runtimeDisposed: false,
    runtimeDispatchInFlight: false,
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
