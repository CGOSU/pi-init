import {
  getWorkflowExecutionBounds,
  getWorkflowExecutionDuration,
  getWorkflowTaskDuration,
  workflowProgress,
} from "../src/workflow.ts";
import { formatWorkflowVerification } from "../src/workflow-verification.ts";
import type { WorkflowState, WorkflowTask } from "../src/workflow-types.ts";

export type CompletionDuration =
  | { kind: "available"; milliseconds: number }
  | { kind: "unavailable"; reason: "missing-or-invalid-time" };

export type WorkflowCompletionTaskView = {
  id: string;
  task: string;
  completionSummary?: string;
  implementationRationale?: string;
  status: WorkflowTask["status"];
  blockReason?: string;
  outcomeUnknown?: boolean;
  verification: string[];
  verificationEvidenceIds?: string[];
  verificationFailures: string[];
  verificationPending: string[];
  verificationUnclassified: string[];
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
  status: WorkflowState["status"];
  constraints: string[];
  tasks: WorkflowCompletionTaskView[];
  finalTask: WorkflowCompletionTaskView | undefined;
  startedAt: number | undefined;
  completedAt: number | undefined;
  duration: CompletionDuration;
};

function completionTaskView(task: WorkflowTask): WorkflowCompletionTaskView {
  return {
    id: task.id,
    task: task.task,
    ...(task.completionSummary !== undefined ? { completionSummary: task.completionSummary } : {}),
    ...(task.implementationRationale !== undefined ? { implementationRationale: task.implementationRationale } : {}),
    status: task.status,
    blockReason: task.blockReason,
    outcomeUnknown: task.outcomeUnknown,
    verification: (task.verification ?? []).map(formatWorkflowVerification),
    ...(task.verificationEvidenceIds ? { verificationEvidenceIds: [...task.verificationEvidenceIds] } : {}),
    verificationFailures: (task.verification ?? []).filter(item => typeof item !== "string" && item.status === "failed").map(formatWorkflowVerification),
    verificationPending: (task.verification ?? []).filter(item => typeof item !== "string" && item.status === "not-run").map(formatWorkflowVerification),
    verificationUnclassified: (task.verification ?? []).filter(item => typeof item === "string").map(formatWorkflowVerification),
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
    status: workflowState.status,
    constraints: workflowState.plan.constraints,
    tasks: workflowState.tasks.map(completionTaskView),
    finalTask: completedTask ? completionTaskView(completedTask) : undefined,
    startedAt: bounds.startedAt,
    completedAt: bounds.completedAt,
    duration: completionDuration(getWorkflowExecutionDuration(workflowState)),
  };
}
