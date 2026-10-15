import { cloneState, getWorkflowTask } from "./workflow-model.ts";
import { workflowActionIdentity, workflowHandoffIdentity, workflowReplanIdentity } from "./workflow-handoff.ts";
import { getNextWorkflowTask, markWorkflowTaskStarted, setWorkflowHandoffPhase, blockWorkflowTask, cancelWorkflow, completeWorkflowTask, resumeWorkflow, retryWorkflowTask } from "./workflow-transitions.ts";
import type { WorkflowHandoffIdentity, WorkflowReplanIdentity, WorkflowState, WorkflowActionIdentity } from "./workflow-types.ts";
import { returnFromNestedWorkflow, cancelWorkflowTree } from "./workflow-nesting.ts";
import { reviewReturnedSubworkflow } from "./workflow-subworkflow.ts";

export type WorkflowDispatchEvent =
  | { type: "task-dispatch-requested"; identity: WorkflowHandoffIdentity }
  | { type: "task-reminder-requested"; identity: WorkflowHandoffIdentity }
  | { type: "task-queued"; identity: WorkflowHandoffIdentity }
  | { type: "task-started"; identity: WorkflowHandoffIdentity }
  | { type: "replan-dispatch-requested"; identity: WorkflowReplanIdentity }
  | { type: "replan-queued"; identity: WorkflowReplanIdentity };

export type WorkflowDispatchEffect =
  | { kind: "send-task"; identity: WorkflowHandoffIdentity }
  | { kind: "send-replan"; identity: WorkflowReplanIdentity };

export type WorkflowDispatchTransition = { state: WorkflowState; effects: WorkflowDispatchEffect[] };
export type WorkflowScheduleEffect =
  | { kind: "replan" }
  | { kind: "start-task" | "dispatch-task" | "nudge-task"; taskId: string };

function sameIdentity<T extends object>(actual: T | undefined, expected: T): boolean {
  return actual !== undefined && (Object.keys(actual) as (keyof T)[]).every((key) => actual[key] === expected[key]);
}

export function selectWorkflowScheduleEffect(state: WorkflowState): WorkflowScheduleEffect | undefined {
  if (state.continuation?.kind !== "review" && state.continuation?.phase === "compacting") return;
  if (state.status === "replanning") {
    const continuation = state.continuation;
    if (state.pendingRevision && (!continuation || (continuation.kind === "replan" && continuation.phase === "pending"))) {
      return { kind: "replan" };
    }
    return;
  }
  if (state.status !== "running") return;
  if (!state.currentTaskId) {
    const next = getNextWorkflowTask(state);
    return next ? { kind: "start-task", taskId: next.id } : undefined;
  }
  const identity = workflowHandoffIdentity(state);
  const task = getWorkflowTask(state, state.currentTaskId);
  if (!identity || identity.taskId !== state.currentTaskId || task?.status !== "in_progress"
    || !sameIdentity(workflowActionIdentity(state), identity)) return;
  if (["prepared", "waiting-role", "compacting"].includes(state.handoff!.phase)) {
    return { kind: "dispatch-task", taskId: task.id };
  }
  if (state.handoff!.phase === "executing") return { kind: "nudge-task", taskId: task.id };
}

export function transitionWorkflowDispatch(
  state: WorkflowState,
  event: WorkflowDispatchEvent,
  now: number,
): WorkflowDispatchTransition {
  const unchanged: WorkflowDispatchTransition = { state, effects: [] };
  if (!sameIdentity(workflowActionIdentity(state), event.identity)) return unchanged;
  if (event.type === "replan-dispatch-requested" || event.type === "replan-queued") {
    if (!sameIdentity(workflowReplanIdentity(state), event.identity) || state.continuation?.kind !== "replan") return unchanged;
    const expectedPhase = event.type === "replan-dispatch-requested" ? "pending" : "dispatching";
    if (state.continuation.phase !== expectedPhase) return unchanged;
    const next = cloneState(state, now);
    next.continuation = { ...state.continuation, phase: event.type === "replan-queued" ? "queued" : "dispatching" };
    return { state: next, effects: event.type === "replan-dispatch-requested" ? [{ kind: "send-replan", identity: event.identity }] : [] };
  }
  if (state.status !== "running" || state.currentTaskId !== event.identity.taskId
    || getWorkflowTask(state, event.identity.taskId)?.status !== "in_progress"
    || !sameIdentity(workflowHandoffIdentity(state), event.identity)) return unchanged;
  const phase = state.handoff!.phase;
  if (event.type === "task-started") {
    if (!["dispatching", "queued"].includes(phase)) return unchanged;
    return { state: markWorkflowTaskStarted(state, event.identity.taskId, now), effects: [] };
  }
  if (event.type === "task-queued") {
    return phase === "dispatching" ? { state: setWorkflowHandoffPhase(state, "queued", now), effects: [] } : unchanged;
  }
  if (event.type === "task-reminder-requested") {
    return phase === "executing" ? { state, effects: [{ kind: "send-task", identity: event.identity }] } : unchanged;
  }
  if (!["prepared", "waiting-role", "compacting"].includes(phase)) return unchanged;
  return {
    state: setWorkflowHandoffPhase(state, "dispatching", now),
    effects: [{ kind: "send-task", identity: event.identity }],
  };
}

export type WorkflowLifecycleEvent =
  | { type: "task-completed"; identity: WorkflowHandoffIdentity; completionSummary: unknown; implementationRationale: unknown; verification: unknown }
  | { type: "task-blocked"; identity: WorkflowHandoffIdentity; reason: unknown }
  | { type: "child-reviewed"; identity: WorkflowReplanIdentity; review: unknown }
  | { type: "workflow-resumed"; identity: WorkflowActionIdentity }
  | { type: "task-retried"; identity: WorkflowActionIdentity; taskId?: string; confirmUnknownOutcome: boolean }
  | { type: "workflow-cancelled"; identity: WorkflowActionIdentity; returnToParent: boolean };

export type WorkflowLifecycleEffect = { kind: "retire-continuation"; identity: WorkflowActionIdentity };
export type WorkflowLifecycleTransition = {
  state: WorkflowState;
  taskState: WorkflowState;
  returnedToParent: boolean;
  effects: WorkflowLifecycleEffect[];
};

export function transitionWorkflowLifecycle(
  state: WorkflowState,
  event: WorkflowLifecycleEvent,
  now: number,
): WorkflowLifecycleTransition {
  if (!sameIdentity(workflowActionIdentity(state), event.identity)) {
    throw Object.assign(new Error("工作流生命周期事件身份已过期；请读取当前状态"), { code: "WORKFLOW_ACTION_IDENTITY_STALE" });
  }
  let next: WorkflowState;
  switch (event.type) {
    case "task-completed":
    case "task-blocked": {
      if (!sameIdentity(workflowHandoffIdentity(state), event.identity) || state.currentTaskId !== event.identity.taskId) {
        throw Object.assign(new Error("任务生命周期事件与当前 handoff 不匹配"), { code: "WORKFLOW_ACTION_IDENTITY_STALE" });
      }
      if (state.handoff?.phase !== "executing") {
        throw Object.assign(new Error("任务尚未确认实际启动，不能验收结果"), { code: "WORKFLOW_TASK_NOT_STARTED" });
      }
      next = event.type === "task-completed"
        ? completeWorkflowTask(state, { taskId: event.identity.taskId, completionSummary: event.completionSummary, implementationRationale: event.implementationRationale, verification: event.verification }, now)
        : blockWorkflowTask(state, { taskId: event.identity.taskId, reason: event.reason }, now);
      break;
    }
    case "child-reviewed":
      if (!sameIdentity(workflowReplanIdentity(state), event.identity)) throw Object.assign(new Error("子流程审阅 handoff 已过期"), { code: "WORKFLOW_ACTION_IDENTITY_STALE" });
      next = reviewReturnedSubworkflow(state, event.review, now);
      break;
    case "workflow-resumed":
      next = resumeWorkflow(state, now);
      break;
    case "task-retried":
      next = retryWorkflowTask(state, event.taskId, now, { confirmUnknownOutcome: event.confirmUnknownOutcome });
      break;
    case "workflow-cancelled":
      next = event.returnToParent ? cancelWorkflow(state, now) : cancelWorkflowTree(state, now);
      break;
  }
  const terminal = next.status === "completed" || next.status === "cancelled";
  const parent = terminal && (event.type === "task-completed" || event.type === "child-reviewed" || (event.type === "workflow-cancelled" && event.returnToParent))
    ? returnFromNestedWorkflow(next, next.status === "completed" ? "completed" : "cancelled", now)
    : undefined;
  return {
    state: parent ?? next,
    taskState: next,
    returnedToParent: parent !== undefined,
    effects: terminal ? [{ kind: "retire-continuation", identity: workflowActionIdentity(state) }] : [],
  };
}
