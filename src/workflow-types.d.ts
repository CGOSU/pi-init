export type WorkflowStatus = "running" | "paused" | "replanning" | "completed" | "cancelled";
export type WorkflowTaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "superseded";
export type WorkflowRevisionStatus = "requested" | "applied";
export type WorkflowHandoffPhase = "prepared" | "waiting-role" | "compacting" | "dispatching" | "queued" | "executing" | "uncertain";
export type WorkflowContinuationPhase = "pending" | "compacting" | "dispatching" | "queued";

export type WorkflowTaskDelegation = {
  status: "spawning" | "running" | "stop-requested" | "completed" | "failed";
  requestId?: string;
  agentId?: string;
  type?: string;
  reason?: string;
  createdAt?: number;
  startedAt?: number;
  stopRequestedAt?: number;
  completedAt?: number;
};

export type WorkflowTask = {
  id: string;
  task: string;
  role: string;
  files: string[];
  acceptanceCriteria: string[];
  dependsOn: string[];
  status: WorkflowTaskStatus;
  startedAt?: number;
  executionStartedAt?: number;
  completedAt?: number;
  completionSummary?: string;
  implementationRationale?: string;
  verification?: string[];
  blockReason?: string;
  outcomeUnknown?: boolean;
  delegation?: WorkflowTaskDelegation;
  supersededAt?: number;
  supersededBy?: string;
};

export type WorkflowPlanSummary = {
  summary: string;
  constraints: string[];
};

export type WorkflowPlanSnapshot = WorkflowPlanSummary & {
  tasks: WorkflowTask[];
};

export type WorkflowPlan = WorkflowPlanSnapshot & {
  reviewRequired: boolean;
};

export type WorkflowPendingRevision = {
  revisionId: string;
  direction: string;
  requestedAt: number;
  requestedFromTaskId?: string;
};

export type WorkflowRevision = WorkflowPendingRevision & {
  status: WorkflowRevisionStatus;
  appliedAt?: number;
  retainedTaskIds?: string[];
  replacedTaskIds?: string[];
  addedTaskIds?: string[];
  previousPlan?: WorkflowPlanSummary;
  previousTasks?: WorkflowTask[];
  replacedTasks?: WorkflowTask[];
  newPlan?: WorkflowPlanSnapshot;
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
  phase: WorkflowHandoffPhase;
  createdAt: number;
  startedAt?: number;
};

export type WorkflowContinuation =
  | { kind: "schedule"; phase: WorkflowContinuationPhase; reason?: "plan-created" | "task-completed" | "replan-applied" | "retry" | "resume" }
  | { kind: "replan"; revisionId: string; handoffId?: string; phase: WorkflowContinuationPhase; reason?: "task-completed" | "replan-requested" }
  | { kind: "review" };

export type WorkflowState = {
  version: number;
  workflowId: string;
  sessionId: string;
  planVersion: number;
  recoveryGeneration: number;
  executor: "local";
  authority?: "local";
  status: WorkflowStatus;
  pauseReason?: string;
  taskPauseReason?: string;
  plan: WorkflowPlanSummary;
  tasks: WorkflowTask[];
  currentTaskId?: string;
  nudgeCount: number;
  revisions: WorkflowRevision[];
  pendingRevision?: WorkflowPendingRevision;
  handoff?: WorkflowHandoff;
  continuation?: WorkflowContinuation;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  legacySourceVersion?: number;
};

export type HydratedWorkflowState = Omit<WorkflowState, "workflowId" | "sessionId" | "planVersion" | "recoveryGeneration"> &
  Partial<Pick<WorkflowState, "workflowId" | "sessionId" | "planVersion" | "recoveryGeneration">>;

export type WorkflowValidationFailure = {
  ok: false;
  code: string;
  message: string;
  mismatchedFields?: string[];
  expected?: Record<string, unknown>;
  received?: Record<string, unknown>;
  nextAction?: string;
  taskId?: string;
  role?: string;
};

export type WorkflowResult<T> = { ok: true; value: T } | WorkflowValidationFailure;
export type WorkflowRecoveryResult =
  | { ok: true; value: WorkflowState; changed: boolean }
  | WorkflowValidationFailure;
export type WorkflowRoleValidationResult = { ok: true } | WorkflowValidationFailure;

export type WorkflowIdentityValidationResult<T extends WorkflowActionIdentity> = WorkflowResult<T>;
export type WorkflowHydrationResult = WorkflowResult<HydratedWorkflowState>;

export type WorkflowPlanInput = object;
export type WorkflowStateInput = object;
