import { workflowProgress } from "../src/workflow.ts";
import type { WorkflowState } from "./runtime-state.ts";
import { workflowPauseReasonLabel } from "./workflow-pause-labels.ts";

export type WorkflowPauseAction =
  | { kind: "verify-external-effects" }
  | { kind: "retry-task"; taskId: string; confirmUnknownOutcome: boolean }
  | { kind: "replan"; route: "architect" | "task_workflow" }
  | { kind: "resume" };

export type WorkflowPauseBlock = {
  taskId: string;
  reason: string;
  reasonRecorded: boolean;
  recoverySteps: WorkflowPauseAction[];
};

export type WorkflowPauseReason = {
  kind: "architecture-review" | "handoff-outcome-unknown" | "legacy-execution-outcome-unknown" | "task-blocked" | "workflow-replan" | "task-pause-reason" | "unrecognized" | "unrecorded";
  text: string;
  code?: string;
};

export type WorkflowPauseView = {
  progress: { completed: number; total: number; currentTaskId?: string };
  reason: WorkflowPauseReason;
  blockedTasks: WorkflowPauseBlock[];
  recoverySteps: WorkflowPauseAction[];
};

const PAUSE_REASON_KINDS: Record<string, Exclude<WorkflowPauseReason["kind"], "task-pause-reason" | "unrecognized" | "unrecorded">> = {
  "architecture-review": "architecture-review",
  "handoff-outcome-unknown": "handoff-outcome-unknown",
  "legacy-execution-outcome-unknown": "legacy-execution-outcome-unknown",
  "task-blocked": "task-blocked",
  "workflow-replan": "workflow-replan",
};

function describePauseReason(state: WorkflowState): WorkflowPauseReason {
  const code = state.pauseReason?.trim();
  const detail = state.taskPauseReason?.trim();
  const kind = code
    ? PAUSE_REASON_KINDS[code] ?? "unrecognized"
    : detail ? "task-pause-reason" : "unrecorded";
  return {
    kind,
    text: detail || workflowPauseReasonLabel(code || undefined),
    ...(code ? { code } : {}),
  };
}

function recoveryStepsForTask(task: WorkflowState["tasks"][number]): WorkflowPauseAction[] {
  return task.outcomeUnknown
    ? [
        { kind: "verify-external-effects" },
        { kind: "retry-task", taskId: task.id, confirmUnknownOutcome: true },
        { kind: "replan", route: "architect" },
      ]
    : [
        { kind: "retry-task", taskId: task.id, confirmUnknownOutcome: false },
        { kind: "replan", route: "task_workflow" },
      ];
}

export function createWorkflowPauseView(state: WorkflowState): WorkflowPauseView {
  const blockedTasks = state.tasks
    .filter((task) => task.status === "blocked")
    .map((task) => ({
      taskId: task.id,
      reason: task.blockReason ?? "未记录（历史状态未保存阻塞原因）",
      reasonRecorded: task.blockReason !== undefined,
      recoverySteps: recoveryStepsForTask(task),
    }));
  const reason = describePauseReason(state);
  const recoverySteps: WorkflowPauseAction[] = blockedTasks.length > 0
    ? []
    : reason.kind === "architecture-review"
      ? [{ kind: "resume" }]
      : reason.kind === "handoff-outcome-unknown" || reason.kind === "legacy-execution-outcome-unknown"
        ? [{ kind: "verify-external-effects" }]
        : [];
  const progress = workflowProgress(state);
  return {
    progress: {
      completed: progress.completed,
      total: progress.total,
      ...(progress.currentTaskId ? { currentTaskId: progress.currentTaskId } : {}),
    },
    reason,
    blockedTasks,
    recoverySteps,
  };
}
