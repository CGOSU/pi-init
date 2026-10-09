import {
  getWorkflowExecutionBounds,
  getWorkflowExecutionDuration,
  getWorkflowTaskDuration,
  workflowProgress,
} from "../src/workflow.ts";
import type { WorkflowState, WorkflowTask } from "../src/workflow-types.ts";

const VERIFICATION_FAILURE_PATTERN = /(?:失败|未通过|不通过|报错|异常|[✗✕❌]|\b(?:fail(?:ed|ure)?s?|errors?|exceptions?)\b|timed?\s*out|timeout|non[-\s]?zero|(?:exit(?:ed)?|退出)[^\d\n]{0,20}(?:[1-9]\d*|non[-\s]?zero))/iu;
const VERIFICATION_NO_FAILURE_PATTERN = /(?:\b0\s+(?:fail(?:ed|ure)?s?|errors?|exceptions?)\b|\bno\s+(?:fail(?:ed|ure)?s?|errors?|exceptions?)\b|(?:未(?:发生|发现|出现)?|没有|无)(?:任何)?(?:错误|失败))/iu;

export type CompletionDuration =
  | { kind: "available"; milliseconds: number }
  | { kind: "unavailable"; reason: "missing-or-invalid-time" };

export type WorkflowCompletionTaskView = {
  id: string;
  task: string;
  completionSummary?: string;
  implementationRationale?: string;
  verificationFailures: string[];
};

export type WorkflowTaskCompletionView = {
  kind: "task-completion";
  task: WorkflowCompletionTaskView;
  duration: CompletionDuration;
};

export type WorkflowCompletionView = {
  kind: "workflow-completion";
  summary: string;
  progress: { completed: number; total: number };
  finalTask: WorkflowCompletionTaskView | undefined;
  startedAt: number | undefined;
  completedAt: number | undefined;
  duration: CompletionDuration;
};

function isVerificationFailure(value: string) {
  return VERIFICATION_FAILURE_PATTERN.test(value) && !VERIFICATION_NO_FAILURE_PATTERN.test(value);
}

function completionTaskView(task: WorkflowTask): WorkflowCompletionTaskView {
  return {
    id: task.id,
    task: task.task,
    ...(task.completionSummary !== undefined ? { completionSummary: task.completionSummary } : {}),
    ...(task.implementationRationale !== undefined ? { implementationRationale: task.implementationRationale } : {}),
    verificationFailures: task.verification?.filter(isVerificationFailure) ?? [],
  };
}

function completionDuration(milliseconds: number | undefined): CompletionDuration {
  return milliseconds === undefined
    ? { kind: "unavailable", reason: "missing-or-invalid-time" }
    : { kind: "available", milliseconds };
}

export function createWorkflowTaskCompletionView(task: WorkflowTask | undefined): WorkflowTaskCompletionView {
  if (!task) throw new Error("无法生成不存在的工作流任务完成报告");
  return {
    kind: "task-completion",
    task: completionTaskView(task),
    duration: completionDuration(getWorkflowTaskDuration(task)),
  };
}

export function createWorkflowCompletionView(
  workflowState: WorkflowState,
  finalTask?: WorkflowTask,
): WorkflowCompletionView {
  const bounds = getWorkflowExecutionBounds(workflowState);
  const completedTask = finalTask ?? [...workflowState.tasks].reverse().find((task) => task.status === "completed");
  const progress = workflowProgress(workflowState);
  return {
    kind: "workflow-completion",
    summary: workflowState.plan.summary,
    progress: { completed: progress.completed, total: progress.total },
    finalTask: completedTask ? completionTaskView(completedTask) : undefined,
    startedAt: bounds.startedAt,
    completedAt: bounds.completedAt,
    duration: completionDuration(getWorkflowExecutionDuration(workflowState)),
  };
}
