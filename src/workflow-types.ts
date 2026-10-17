import type { WorkflowTaskContract } from "./coordination-types.ts";
import type { WorkflowExecutor } from "./role-types.ts";
export type WorkflowGoal = { id: string; parentId: string; summary: string; constraints: string[]; createdAt: number };

export type WorkflowSubworkflowContract = { inputs: string[]; expectedOutputs: string[]; acceptanceCriteria: string[]; allowedFiles: string[] };
export type WorkflowSubworkflowReview = { childWorkflowId: string; decision: "continue" | "replan" | "block"; reason: string; parentPlanValid: boolean; acceptedOutputs: string[]; verification: string[]; reviewedAt: number };

export type { WorkflowExecutor } from "./role-types.ts";

export type WorkflowStatus = "running" | "paused" | "replanning" | "completed" | "cancelled";
export type WorkflowTaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "superseded";
export type WorkflowRevisionStatus = "requested" | "applied";
export type WorkflowHandoffPhase = "prepared" | "waiting-role" | "compacting" | "dispatching" | "queued" | "executing" | "uncertain";
export type WorkflowContinuationPhase = "pending" | "compacting" | "dispatching" | "queued";
export type WorkflowContinuationReason = "plan-created" | "task-completed" | "replan-applied" | "retry" | "resume" | "replan-requested" | "child-completed" | "child-cancelled";

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

export type WorkflowClarificationCategory = "missing-fact" | "contract-conflict" | "business-decision";
export type WorkflowSideEffectStatus = "none" | "occurred" | "unknown";

export type WorkflowTaskClarification = {
  issueId: string;
  category: WorkflowClarificationCategory;
  question: string;
  impact: string;
  checkedFacts: string[];
  completedWork: string[];
  verification: string[];
  sideEffects: { status: WorkflowSideEffectStatus; details: string[] };
  handoff: WorkflowHandoffIdentity;
  createdAt: number;
};

export type WorkflowTask = {
  id: string;
  task: string;
  role: string;
  files: string[];
  acceptanceCriteria: string[];
  dependsOn: string[];
  goalId?: string;
  priority?: number;
  contract?: WorkflowTaskContract;
  clarification?: WorkflowTaskClarification;
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
  kind?: "replan" | "nested" | "goal";
  goalParentId?: string;
  childGoal?: string;
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
  | { kind: "schedule"; phase: WorkflowContinuationPhase; reason?: WorkflowContinuationReason }
  | { kind: "replan"; revisionId: string; handoffId?: string; phase: WorkflowContinuationPhase; reason?: WorkflowContinuationReason }
  | { kind: "review" };

export type WorkflowSubworkflowTaskSummary = {
  id: string;
  task: string;
  status: WorkflowTaskStatus;
  completionSummary?: string;
  verification?: string[];
  outcomeUnknown?: boolean;
};

export type WorkflowSubworkflowSummary = {
  workflowId: string;
  parentWorkflowId: string;
  parentTaskId?: string;
  planVersion: number;
  summary: string;
  status: "completed" | "cancelled";
  tasks: WorkflowSubworkflowTaskSummary[];
  contract?: WorkflowSubworkflowContract;
  reviews?: WorkflowSubworkflowReview[];
  startedAt?: number;
  completedAt?: number;
};

export type WorkflowStateCore = {
  version: number;
  workflowId: string;
  sessionId: string;
  planVersion: number;
  recoveryGeneration: number;
  executor: WorkflowExecutor;
  authority?: WorkflowExecutor;
  status: WorkflowStatus;
  pauseReason?: string;
  taskPauseReason?: string;
  plan: WorkflowPlanSummary;
  tasks: WorkflowTask[];
  goals?: WorkflowGoal[];
  currentTaskId?: string;
  nudgeCount?: number;
  revisions: WorkflowRevision[];
  pendingRevision?: WorkflowPendingRevision;
  handoff?: WorkflowHandoff;
  continuation?: WorkflowContinuation;
  subworkflowHistory?: WorkflowSubworkflowSummary[];
  subworkflowContract?: WorkflowSubworkflowContract;
  createdAt?: number;
  updatedAt?: number;
  startedAt?: number;
  completedAt?: number;
  legacySourceVersion?: number;
};

export type WorkflowParentFrame = {
  parentTaskId?: string;
  state: WorkflowStateCore;
};

export type WorkflowState = WorkflowStateCore & {
  parentStack?: WorkflowParentFrame[];
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
  branchMatched?: boolean;
};

export type WorkflowResult<T> = { ok: true; value: T } | WorkflowValidationFailure;
export type WorkflowRecoveryResult =
  | { ok: true; value: WorkflowState; changed: boolean }
  | WorkflowValidationFailure;
export type WorkflowRoleValidationResult = { ok: true } | WorkflowValidationFailure;

export type WorkflowIdentityValidationResult<T extends WorkflowActionIdentity> = WorkflowResult<T>;
export type WorkflowHydrationResult = WorkflowResult<HydratedWorkflowState>;

export type WorkflowPlanInput = unknown;
export type WorkflowStateInput = unknown;
export type WorkflowTaskInput = unknown;
export type WorkflowExecutionBounds = { startedAt: number | undefined; completedAt: number | undefined };
export type WorkflowTaskTimestampField = "startedAt" | "completedAt";
export type WorkflowTaskTimestampReducer = (accumulator: number, value: number) => number;
export type WorkflowRoleValidationOptions = { unfinishedOnly?: boolean };
export type WorkflowTextListOptions = { required?: boolean };
export type WorkflowTaskNormalizationOptions = { allowSuperseded?: boolean };
export type WorkflowModelError = Error & { code?: string; details?: unknown };
export type WorkflowStateVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type WorkflowStateRecord = Record<string, unknown>;
export type WorkflowLegacyState = Partial<WorkflowState> & Record<string, unknown>;
export type WorkflowRevisionRecord = Record<string, unknown>;
export type WorkflowTaskRecord = Record<string, unknown>;
export type WorkflowIdentityValues = Record<string, unknown>;
export type WorkflowContinuationKind = WorkflowContinuation["kind"];
