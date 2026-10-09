import {
  getWorkflowExecutionBounds,
  getWorkflowTaskDuration,
  workflowActionIdentity,
  workflowHandoffIdentity,
  workflowProgress,
  workflowReplanIdentity,
} from "../src/workflow.ts";
import type {
  WorkflowActionIdentity,
  WorkflowHandoff,
  WorkflowHandoffIdentity,
  WorkflowHandoffPhase,
  WorkflowReplanIdentity,
  WorkflowState,
  WorkflowTask,
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
      progress: { completed: number; total: number; currentTaskId?: string; currentTaskPosition?: number };
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
> & Partial<Pick<
  ExtensionRuntimeState,
  "roleCompactionOperationId" | "roleContextGeneration" | "roleTransitionGeneration" | "activeRoleCompaction"
>>;

function currentTask(state: WorkflowState): { task: WorkflowTask; index: number } | undefined {
  if (state.status !== "running" || !state.currentTaskId) return undefined;
  const index = state.tasks.findIndex((task) => task.id === state.currentTaskId && task.status === "in_progress");
  return index < 0 ? undefined : { task: state.tasks[index], index };
}

function currentHandoff(state: WorkflowState, task: WorkflowTask): WorkflowHandoff | undefined {
  const handoff = state.handoff;
  if (!handoff || task.status !== "in_progress" || state.currentTaskId !== task.id) return undefined;
  if (handoff.workflowId !== state.workflowId
    || handoff.planVersion !== state.planVersion
    || handoff.sessionId !== state.sessionId
    || handoff.recoveryGeneration !== state.recoveryGeneration
    || handoff.taskId !== task.id
    || !handoff.attemptId.trim()
    || !handoff.handoffId.trim()) return undefined;
  return handoff;
}

function hasExecutionEvidence(task: WorkflowTask, handoff: WorkflowHandoff) {
  const startedAt = task.startedAt;
  const executionStartedAt = task.executionStartedAt;
  return handoff.phase === "executing"
    && typeof startedAt === "number" && Number.isFinite(startedAt)
    && typeof executionStartedAt === "number" && Number.isFinite(executionStartedAt)
    && typeof handoff.startedAt === "number" && Number.isFinite(handoff.startedAt)
    && startedAt === executionStartedAt
    && executionStartedAt === handoff.startedAt;
}

function sameHandoff(left: WorkflowHandoff, right: WorkflowHandoffIdentity) {
  return left.workflowId === right.workflowId
    && left.planVersion === right.planVersion
    && left.taskId === right.taskId
    && left.attemptId === right.attemptId
    && left.handoffId === right.handoffId
    && left.sessionId === right.sessionId
    && left.recoveryGeneration === right.recoveryGeneration;
}

function compactionMatchesCurrentHandoff(
  state: WorkflowState,
  task: WorkflowTask,
  handoff: WorkflowHandoff,
  runtime: WorkflowStatusRuntime,
) {
  const active = runtime.activeRoleCompaction;
  const transition = active?.transition ?? runtime.pendingRoleCompaction;
  if (!transition
    || transition.sessionId !== state.sessionId
    || transition.contextGeneration !== runtime.roleContextGeneration
    || transition.roleTransitionGeneration !== runtime.roleTransitionGeneration) return false;
  if (active && active.operationId !== runtime.roleCompactionOperationId) return false;
  const continuation = transition.continuation;
  return continuation?.kind === "workflow-task"
    && continuation.taskId === task.id
    && sameHandoff(handoff, continuation.identity);
}

function activityFor(
  state: WorkflowState,
  runtime: WorkflowStatusRuntime,
  activeTask: WorkflowTask | undefined,
  handoff: WorkflowHandoff | undefined,
): WorkflowStatusActivity {
  if (state.status === "replanning") return "awaiting-replan";
  if (state.status === "paused") return "paused";
  if (state.status === "completed") return "completed";
  if (state.status === "cancelled") return "cancelled";

  if (!state.currentTaskId || !activeTask) return "waiting-dispatch";
  if (!handoff) return "waiting-task";
  if (hasExecutionEvidence(activeTask, handoff)) return "executing";
  if (handoff.phase === "compacting" && compactionMatchesCurrentHandoff(state, activeTask, handoff, runtime)) {
    if (runtime.roleCompactionPhase === "compacting" || runtime.pendingRoleCompaction || runtime.activeRoleCompaction) {
      return "compacting";
    }
  }
  if (handoff.phase === "dispatching"
    || (runtime.workflowDispatchInFlight && (handoff.phase === "prepared" || handoff.phase === "waiting-role"))) {
    return "dispatching";
  }
  return "waiting-task";
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
  const active = currentTask(workflowState);
  const currentTaskHandoff = active ? currentHandoff(workflowState, active.task) : undefined;
  const handoff = currentTaskHandoff ? workflowHandoffIdentity(workflowState) : undefined;
  const handoffPhase = handoff ? currentTaskHandoff?.phase : undefined;
  const replan = workflowReplanIdentity(workflowState);
  const pause = createWorkflowPauseView(workflowState);
  return {
    kind: "workflow",
    status: workflowState.status,
    activity: activityFor(workflowState, runtime, active?.task, currentTaskHandoff),
    progress: {
      completed: progress.completed,
      total: progress.total,
      ...(active ? { currentTaskId: active.task.id, currentTaskPosition: active.index + 1 } : {}),
    },
    startedAt: getWorkflowExecutionBounds(workflowState).startedAt,
    elapsed: elapsedFor(workflowState, now),
    planSummary: workflowState.plan.summary,
    identity: {
      action: workflowActionIdentity(workflowState),
      ...(handoff ? { handoff } : {}),
      ...(handoffPhase ? { handoffPhase } : {}),
      ...(replan ? { replan } : {}),
      handoffUnavailable: Boolean(workflowState.status === "running" && workflowState.currentTaskId && !currentTaskHandoff),
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
    activeRoleCompaction: state.activeRoleCompaction,
    roleCompactionOperationId: state.roleCompactionOperationId,
    roleContextGeneration: state.roleContextGeneration,
    roleTransitionGeneration: state.roleTransitionGeneration,
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