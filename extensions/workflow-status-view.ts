import {
  getWorkflowExecutionBounds,
  getWorkflowTask,
  getWorkflowTaskDuration,
  workflowActionIdentity,
  workflowHandoffIdentity,
  workflowProgress,
  workflowReplanIdentity,
} from "../src/workflow.ts";
import type {
  WorkflowActionIdentity,
  WorkflowHandoffIdentity,
  WorkflowHandoffPhase,
  WorkflowReplanIdentity,
  WorkflowState,
  WorkflowTaskStatus,
} from "../src/workflow-types.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { createWorkflowPauseView, type WorkflowPauseView } from "./workflow-pause-view.ts";

export type WorkflowStatusActivity =
  | "awaiting-replan"
  | "paused"
  | "completed"
  | "cancelled"
  | "waiting-dispatch"
  | "compaction-stalled"
  | "compacting"
  | "dispatching"
  | "waiting-task"
  | "executing";

export type WorkflowStatusTaskView = {
  id: string;
  role: string;
  task: string;
  status: WorkflowTaskStatus;
  completionSummary?: string;
  duration: { kind: "available"; milliseconds: number } | { kind: "unavailable" };
};

export type WorkflowStatusView =
  | { kind: "no-workflow" }
  | { kind: "restore-error"; code: string; message: string; sourceEntryId?: string }
  | {
      kind: "workflow";
      status: WorkflowState["status"];
      activity: WorkflowStatusActivity;
      progress: { completed: number; total: number; currentTaskId?: string };
      startedAt?: number;
      elapsed: { kind: "available"; milliseconds: number } | { kind: "unavailable" };
      planSummary: string;
      identity: {
        action: WorkflowActionIdentity;
        handoff?: WorkflowHandoffIdentity;
        handoffPhase?: WorkflowHandoffPhase;
        replan?: WorkflowReplanIdentity;
        handoffUnavailable: boolean;
      };
      pause: WorkflowPauseView;
      pauseCode?: string;
      taskPauseReason?: string;
      pendingRevision?: { revisionId: string; direction: string };
      tasks: WorkflowStatusTaskView[];
    };

export type WorkflowStatusRuntime = Pick<
  ExtensionRuntimeState,
  "workflowRestoreError" | "roleCompactionPhase" | "pendingRoleCompaction" | "workflowDispatchInFlight"
>;

function activityFor(
  state: WorkflowState,
  runtime: WorkflowStatusRuntime,
): WorkflowStatusActivity {
  if (state.status === "replanning") return "awaiting-replan";
  if (state.status === "paused") return "paused";
  if (state.status === "completed") return "completed";
  if (state.status === "cancelled") return "cancelled";

  const task = state.currentTaskId ? getWorkflowTask(state, state.currentTaskId) : undefined;
  if (!task) return "waiting-dispatch";
  if (task.executionStartedAt === undefined) {
    if (runtime.roleCompactionPhase === "stalled") return "compaction-stalled";
    if (runtime.roleCompactionPhase === "compacting" || runtime.pendingRoleCompaction) return "compacting";
    if (runtime.workflowDispatchInFlight) return "dispatching";
    return "waiting-task";
  }
  return "executing";
}

function elapsedFor(state: WorkflowState, now: number) {
  const { startedAt, completedAt } = getWorkflowExecutionBounds(state);
  const endAt = state.status === "completed"
    ? completedAt
    : state.status === "running"
      ? now
      : state.updatedAt;
  if (
    typeof startedAt !== "number"
    || typeof endAt !== "number"
    || !Number.isFinite(startedAt)
    || !Number.isFinite(endAt)
    || endAt < startedAt
  ) return { kind: "unavailable" as const };
  return { kind: "available" as const, milliseconds: endAt - startedAt };
}

export function createWorkflowStatusView(
  workflowState: WorkflowState | undefined,
  runtime: WorkflowStatusRuntime,
  now = Date.now(),
): WorkflowStatusView {
  if (!workflowState) {
    return runtime.workflowRestoreError
      ? { kind: "restore-error", ...runtime.workflowRestoreError }
      : { kind: "no-workflow" };
  }

  const progress = workflowProgress(workflowState);
  const handoff = workflowHandoffIdentity(workflowState);
  const handoffPhase = workflowState.handoff?.phase;
  const replan = workflowReplanIdentity(workflowState);
  const pause = createWorkflowPauseView(workflowState);
  return {
    kind: "workflow",
    status: workflowState.status,
    activity: activityFor(workflowState, runtime),
    progress: {
      completed: progress.completed,
      total: progress.total,
      ...(progress.currentTaskId ? { currentTaskId: progress.currentTaskId } : {}),
    },
    startedAt: getWorkflowExecutionBounds(workflowState).startedAt,
    elapsed: elapsedFor(workflowState, now),
    planSummary: workflowState.plan.summary,
    identity: {
      action: workflowActionIdentity(workflowState),
      ...(handoff ? { handoff } : {}),
      ...(handoffPhase ? { handoffPhase } : {}),
      ...(replan ? { replan } : {}),
      handoffUnavailable: Boolean(workflowState.currentTaskId && !workflowState.handoff),
    },
    pause,
    ...(workflowState.pauseReason ? { pauseCode: workflowState.pauseReason } : {}),
    ...(workflowState.taskPauseReason ? { taskPauseReason: workflowState.taskPauseReason } : {}),
    ...(workflowState.pendingRevision ? {
      pendingRevision: {
        revisionId: workflowState.pendingRevision.revisionId,
        direction: workflowState.pendingRevision.direction,
      },
    } : {}),
    tasks: workflowState.tasks.map((task) => {
      const duration = task.status === "completed" ? getWorkflowTaskDuration(task) : undefined;
      return {
        id: task.id,
        role: task.role,
        task: task.task,
        status: task.status,
        ...(task.completionSummary ? { completionSummary: task.completionSummary } : {}),
        duration: duration === undefined
          ? { kind: "unavailable" }
          : { kind: "available", milliseconds: duration },
      };
    }),
  };
}

export function workflowStatusRuntimeFromState(state: ExtensionRuntimeState): WorkflowStatusRuntime {
  return {
    workflowRestoreError: state.workflowRestoreError,
    roleCompactionPhase: state.roleCompactionPhase,
    pendingRoleCompaction: state.pendingRoleCompaction,
    workflowDispatchInFlight: state.workflowDispatchInFlight,
  };
}

export function createCurrentWorkflowStatusView(
  state: ExtensionRuntimeState,
  workflowState = state.workflowState,
  now = Date.now(),
) {
  return createWorkflowStatusView(workflowState, workflowStatusRuntimeFromState(state), now);
}