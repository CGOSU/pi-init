import type {
  WorkflowExecutionBounds, WorkflowState, WorkflowTask,
  WorkflowTaskTimestampField, WorkflowTaskTimestampReducer,
} from "./workflow-types.ts";

export function getWorkflowTask(state: WorkflowState | null | undefined, taskId: string): WorkflowTask | undefined {
  return state?.tasks?.find((task) => task.id === taskId);
}

function taskTimestampRange(
  state: WorkflowState,
  field: WorkflowTaskTimestampField,
  reducer: WorkflowTaskTimestampReducer,
  initialValue: number,
): number {
  return (state?.tasks ?? [])
    .map((task) => task[field])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .reduce(reducer, initialValue);
}

export function getWorkflowExecutionBounds(state: WorkflowState | null | undefined): WorkflowExecutionBounds {
  if (!state || typeof state !== "object") {
    return { startedAt: undefined, completedAt: undefined };
  }

  const startedAt = state.startedAt === undefined
    ? taskTimestampRange(state, "startedAt", (earliest, value) => Math.min(earliest, value), Infinity)
    : Number.isFinite(state.startedAt)
      ? state.startedAt
      : undefined;
  const completedAt = state.completedAt === undefined
    ? taskTimestampRange(state, "completedAt", (latest, value) => Math.max(latest, value), -Infinity)
    : Number.isFinite(state.completedAt)
      ? state.completedAt
      : undefined;

  return {
    startedAt: Number.isFinite(startedAt) ? startedAt : undefined,
    completedAt: Number.isFinite(completedAt) ? completedAt : undefined,
  };
}

export function getWorkflowExecutionDuration(state: WorkflowState | null | undefined, now?: number): number | undefined {
  if (!state || typeof state.pausedMilliseconds !== "number"
    || !Number.isFinite(state.pausedMilliseconds) || state.pausedMilliseconds < 0) return undefined;
  const { startedAt, completedAt } = getWorkflowExecutionBounds(state);
  const endAt = state.status === "completed" ? completedAt
    : state.status === "paused" || state.status === "cancelled" || state.stoppedAt !== undefined ? state.updatedAt : now ?? completedAt;
  if (startedAt === undefined || endAt === undefined || !Number.isFinite(endAt) || endAt < startedAt) return undefined;
  const duration = endAt - startedAt - state.pausedMilliseconds;
  return duration >= 0 ? duration : undefined;
}

function dependenciesCompleted(state: WorkflowState, task: WorkflowTask): boolean {
  return task.dependsOn.every((dependency) => getWorkflowTask(state, dependency)?.status === "completed");
}

export function getNextWorkflowTask(state: WorkflowState | null | undefined): WorkflowTask | undefined {
  if (!state || state.status !== "running" || state.currentTaskId) return undefined;
  return state.tasks.reduce<WorkflowTask | undefined>((next, task) => {
    if (task.status !== "pending" || !dependenciesCompleted(state, task)) return next;
    return !next || (task.priority ?? 0) > (next.priority ?? 0) ? task : next;
  }, undefined);
}

export function getWorkflowTaskDuration(task: WorkflowTask | null | undefined): number | undefined {
  if (!task || typeof task.startedAt !== "number" || typeof task.completedAt !== "number"
    || !Number.isFinite(task.startedAt) || !Number.isFinite(task.completedAt)) return undefined;
  if (task.completedAt < task.startedAt) return undefined;
  return task.completedAt - task.startedAt;
}

export function workflowProgress(state: WorkflowState | null | undefined): {
  completed: number;
  total: number;
  blocked: number;
  currentTaskId: string | undefined;
} {
  const total = state?.tasks?.length ?? 0;
  const completed = state?.tasks?.filter((task) => task.status === "completed").length ?? 0;
  const blocked = state?.tasks?.filter((task) => task.status === "blocked").length ?? 0;
  return { completed, total, blocked, currentTaskId: state?.currentTaskId };
}

export function isWorkflowRunning(state: WorkflowState | null | undefined): boolean {
  return state?.status === "running";
}
