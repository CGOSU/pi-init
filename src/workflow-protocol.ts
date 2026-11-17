import type {
  WorkflowExecutor, WorkflowHandoffPhase, WorkflowRevisionStatus, WorkflowStatus,
  WorkflowTaskDelegation, WorkflowTaskStatus,
} from "./workflow-types.ts";

// Shared wire identifiers; keep stable for persisted session compatibility.
export const WORKFLOW_TASK_MESSAGE_TYPE = "pi-init-workflow-task";
export const WORKFLOW_REPLAN_MESSAGE_TYPE = "pi-init-workflow-replan";

export const WORKFLOW_STATE_VERSION = 7;
export const WORKFLOW_IDENTITY_STATE_VERSION = 4;
// 规划规模建议：仅用于工具描述和规划提示，不参与任务数量校验。
export const WORKFLOW_RECOMMENDED_TASKS = 12;
export const WORKFLOW_HANDOFF_PHASES = [
  "prepared",
  "waiting-role",
  "compacting",
  "dispatching",
  "queued",
  "executing",
  "uncertain",
] as const satisfies readonly WorkflowHandoffPhase[];
export const WORKFLOW_CONTINUATION_KINDS = ["schedule", "replan", "review"] as const;
export const WORKFLOW_MAX_NUDGES = 3;
export const WORKFLOW_EXECUTORS = ["local"] as const satisfies readonly WorkflowExecutor[];
export const WORKFLOW_DELEGATION_STATUSES = [
  "spawning",
  "running",
  "stop-requested",
  "completed",
  "failed",
] as const satisfies readonly WorkflowTaskDelegation["status"][];

export const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const WORKFLOW_STATUSES = ["running", "paused", "replanning", "completed", "cancelled"] as const satisfies readonly WorkflowStatus[];
export const WORKFLOW_TASK_STATUSES = ["pending", "in_progress", "completed", "blocked"] as const satisfies readonly WorkflowTaskStatus[];
export const WORKFLOW_AUDIT_TASK_STATUSES = [...WORKFLOW_TASK_STATUSES, "superseded"] as const satisfies readonly WorkflowTaskStatus[];
export const WORKFLOW_REVISION_STATUSES = ["requested", "applied"] as const satisfies readonly WorkflowRevisionStatus[];
