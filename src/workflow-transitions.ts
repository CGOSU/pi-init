import { randomUUID } from "node:crypto";
import {
  WORKFLOW_MAX_NUDGES,
  cloneState,
  getWorkflowExecutionBounds,
  getWorkflowTask,
  normalizeTextList,
  requireText,
} from "./workflow-model.ts";
import type { WorkflowHandoffPhase, WorkflowState, WorkflowTask } from "./workflow-types.ts";

type CompleteTaskInput = {
  taskId: string;
  completionSummary: unknown;
  implementationRationale: unknown;
  verification: unknown;
};
type TaskReasonInput = { taskId: string; reason: unknown };

function dependenciesCompleted(state: WorkflowState, task: WorkflowTask): boolean {
  return task.dependsOn.every((dependency) => getWorkflowTask(state, dependency)?.status === "completed");
}

export function getNextWorkflowTask(state: WorkflowState | null | undefined): WorkflowTask | undefined {
  if (!state || state.status !== "running" || state.currentTaskId) return undefined;
  return state.tasks.find((task) => task.status === "pending" && dependenciesCompleted(state, task));
}

export function startWorkflowTask(state: WorkflowState, taskId?: string, now = Date.now()): WorkflowState {
  if (!state || state.status !== "running") throw new Error("工作流当前不可启动任务");
  if (state.currentTaskId) throw new Error(`工作流已有进行中的任务：${state.currentTaskId}`);

  const next = getNextWorkflowTask(state);
  if (!next) throw new Error("工作流没有可启动的下一个任务");
  if (taskId !== undefined && next.id !== taskId) {
    throw new Error(`任务 ${taskId} 尚未满足依赖，当前应先执行 ${next.id}`);
  }

  const result = cloneState(state, now);
  const task = getWorkflowTask(result, next.id);
  if (!task) throw new Error("工作流没有可启动的下一个任务");
  task.status = "in_progress";
  delete task.startedAt;
  delete task.executionStartedAt;
  result.currentTaskId = task.id;
  result.handoff = {
    workflowId: result.workflowId,
    planVersion: result.planVersion,
    taskId: task.id,
    attemptId: randomUUID(),
    handoffId: randomUUID(),
    sessionId: result.sessionId,
    recoveryGeneration: result.recoveryGeneration,
    phase: "prepared",
    createdAt: now,
  };
  delete result.continuation;
  result.nudgeCount = 0;
  return result;
}

export function setWorkflowHandoffPhase(state: WorkflowState, phase: WorkflowHandoffPhase, now = Date.now()): WorkflowState {
  if (!state?.handoff) throw new Error("工作流没有活动 handoff");
  const result = cloneState(state, now);
  if (!result.handoff) throw new Error("工作流没有活动 handoff");
  result.handoff.phase = phase;
  if (phase === "executing" && result.handoff.startedAt === undefined) result.handoff.startedAt = now;
  return result;
}

export function markWorkflowTaskStarted(state: WorkflowState, taskId: string, now = Date.now()): WorkflowState {
  if (!state || state.status !== "running") throw new Error("工作流当前不可记录任务开始时间");
  if (state.currentTaskId !== taskId) {
    throw new Error(`只能记录当前任务 ${state.currentTaskId ?? "（无）"} 的开始时间`);
  }

  const task = getWorkflowTask(state, taskId);
  if (!task || task.status !== "in_progress") {
    throw new Error(`任务 ${taskId} 当前不在执行中`);
  }
  if (!state.handoff || state.handoff.taskId !== taskId) {
    throw new Error("当前任务缺少可验证的 handoff 身份");
  }
  if (!["dispatching", "queued", "executing"].includes(state.handoff.phase)) {
    throw new Error(`工作流 handoff 尚未派发：${state.handoff.phase}`);
  }
  if (state.handoff.phase === "executing" && task.executionStartedAt !== undefined) return state;

  const result = cloneState(state, now);
  if (!result.handoff) throw new Error("当前任务缺少可验证的 handoff 身份");
  result.handoff.phase = "executing";
  result.handoff.startedAt ??= now;
  const startedTask = getWorkflowTask(result, taskId);
  if (!startedTask) throw new Error(`任务 ${taskId} 当前不在执行中`);
  startedTask.startedAt = now;
  startedTask.executionStartedAt = now;
  if (result.startedAt === undefined) {
    result.startedAt = getWorkflowExecutionBounds(state).startedAt ?? now;
  }
  return result;
}

export function getWorkflowTaskDuration(task: WorkflowTask | null | undefined): number | undefined {
  if (!task || typeof task.startedAt !== "number" || typeof task.completedAt !== "number"
    || !Number.isFinite(task.startedAt) || !Number.isFinite(task.completedAt)) return undefined;
  if (task.completedAt < task.startedAt) return undefined;
  return task.completedAt - task.startedAt;
}

export function completeWorkflowTask(
  state: WorkflowState,
  { taskId, completionSummary, implementationRationale, verification }: CompleteTaskInput,
  now = Date.now(),
): WorkflowState {
  if (!state || state.status !== "running") throw new Error("工作流当前不在执行中");
  if (state.currentTaskId !== taskId) {
    throw new Error(`只能完成当前任务 ${state.currentTaskId ?? "（无）"}`);
  }

  const summary = requireText(completionSummary, "任务完成摘要");
  const rationale = requireText(implementationRationale, "实现原因");
  const checks = normalizeTextList(verification, "任务验证结果", { required: true });
  const result = cloneState(state, now);
  const task = getWorkflowTask(result, taskId);
  if (!task) throw new Error(`只能完成当前任务 ${state.currentTaskId ?? "（无）"}`);
  task.status = "completed";
  task.completionSummary = summary;
  task.implementationRationale = rationale;
  task.verification = checks;
  task.completedAt = now;
  result.currentTaskId = undefined;
  delete result.handoff;
  result.recoveryGeneration += 1;
  result.nudgeCount = 0;
  if (result.pendingRevision) {
    result.status = "replanning";
    result.pauseReason = "workflow-replan";
    result.continuation = { kind: "replan", revisionId: result.pendingRevision.revisionId, phase: "pending", reason: "task-completed" };
    delete result.completedAt;
  } else if (result.tasks.every((item) => item.status === "completed")) {
    result.status = "completed";
    result.completedAt = now;
    delete result.continuation;
  } else {
    delete result.completedAt;
    result.continuation = { kind: "schedule", phase: "pending", reason: "task-completed" };
  }
  return result;
}

export function markWorkflowTaskOutcomeUnknown(state: WorkflowState, { taskId, reason }: TaskReasonInput, now = Date.now()): WorkflowState {
  if (!state || state.status !== "running" || state.currentTaskId !== taskId) {
    throw new Error(`只能暂停当前任务 ${state?.currentTaskId ?? "（无）"} 的未知交接结果`);
  }
  const result = cloneState(state, now);
  const task = getWorkflowTask(result, taskId);
  if (!task) throw new Error(`只能暂停当前任务 ${state.currentTaskId ?? "（无）"} 的未知交接结果`);
  task.status = "blocked";
  task.outcomeUnknown = true;
  task.blockReason = requireText(reason, "未知执行结果原因");
  result.currentTaskId = undefined;
  delete result.handoff;
  delete result.continuation;
  result.recoveryGeneration += 1;
  result.status = "paused";
  result.pauseReason = "handoff-outcome-unknown";
  result.taskPauseReason = `任务 ${taskId} 的交接结果未知`;
  result.nudgeCount = 0;
  return result;
}

export function blockWorkflowTask(state: WorkflowState, { taskId, reason }: TaskReasonInput, now = Date.now()): WorkflowState {
  if (!state || state.status !== "running") throw new Error("工作流当前不在执行中");
  if (state.currentTaskId !== taskId) {
    throw new Error(`只能阻塞当前任务 ${state.currentTaskId ?? "（无）"}`);
  }

  const result = cloneState(state, now);
  const task = getWorkflowTask(result, taskId);
  if (!task) throw new Error(`只能阻塞当前任务 ${state.currentTaskId ?? "（无）"}`);
  task.status = "blocked";
  task.blockReason = requireText(reason, "任务阻塞原因");
  result.currentTaskId = undefined;
  delete result.handoff;
  delete result.continuation;
  result.recoveryGeneration += 1;
  result.status = "paused";
  result.pauseReason = task.outcomeUnknown ? "handoff-outcome-unknown" : "task-blocked";
  result.nudgeCount = 0;
  return result;
}

export function retryWorkflowTask(
  state: WorkflowState,
  taskId?: string,
  now = Date.now(),
  { confirmUnknownOutcome = false }: { confirmUnknownOutcome?: boolean } = {},
): WorkflowState {
  if (!state || state.status !== "paused") throw new Error("只有暂停的工作流才能重试任务");
  const result = cloneState(state, now);
  const blockedTaskId = taskId ?? result.tasks.find((item) => item.status === "blocked")?.id;
  const task = blockedTaskId === undefined ? undefined : getWorkflowTask(result, blockedTaskId);
  if (!task || task.status !== "blocked") throw new Error("没有可重试的阻塞任务");
  if (task.outcomeUnknown && !confirmUnknownOutcome) {
    throw Object.assign(
      new Error(`任务 ${task.id} 的旧执行结果未知；核对外部副作用后显式确认 retry`),
      { code: "WORKFLOW_UNKNOWN_OUTCOME_CONFIRMATION_REQUIRED" },
    );
  }

  task.status = "pending";
  delete task.outcomeUnknown;
  delete task.blockReason;
  delete task.completionSummary;
  delete task.implementationRationale;
  delete task.verification;
  delete task.startedAt;
  delete task.executionStartedAt;
  delete task.completedAt;
  delete task.delegation;
  result.status = "running";
  delete result.pauseReason;
  delete result.taskPauseReason;
  result.currentTaskId = undefined;
  delete result.handoff;
  result.recoveryGeneration += 1;
  result.continuation = { kind: "schedule", phase: "pending", reason: "retry" };
  result.nudgeCount = 0;
  return result;
}

export function resumeWorkflow(state: WorkflowState, now = Date.now()): WorkflowState {
  if (!state || state.status !== "paused") throw new Error("工作流当前不在暂停状态");
  if (state.pauseReason !== "architecture-review") {
    throw new Error("任务因阻塞或未完成暂停，请先使用 retry 重试任务或重新规划");
  }

  const result = cloneState(state, now);
  result.status = "running";
  delete result.pauseReason;
  delete result.taskPauseReason;
  result.currentTaskId = undefined;
  delete result.handoff;
  result.recoveryGeneration += 1;
  result.continuation = { kind: "schedule", phase: "pending", reason: "resume" };
  result.nudgeCount = 0;
  return result;
}

export function cancelWorkflow(state: WorkflowState, now = Date.now()): WorkflowState {
  if (!state || state.status === "completed" || state.status === "cancelled") {
    throw new Error("工作流已经结束");
  }
  const result = cloneState(state, now);
  result.status = "cancelled";
  result.currentTaskId = undefined;
  result.recoveryGeneration += 1;
  delete result.handoff;
  delete result.continuation;
  result.nudgeCount = 0;
  return result;
}

export function recordWorkflowNudge(state: WorkflowState, now?: number): WorkflowState;
export function recordWorkflowNudge(state: WorkflowState | undefined, now?: number): WorkflowState | undefined;
export function recordWorkflowNudge(state: null, now?: number): null;
export function recordWorkflowNudge(
  state: WorkflowState | null | undefined,
  now = Date.now(),
): WorkflowState | null | undefined {
  if (!state || state.status !== "running" || !state.currentTaskId) return state;
  const result = cloneState(state, now);
  result.nudgeCount = (result.nudgeCount ?? 0) + 1;
  if (result.nudgeCount >= WORKFLOW_MAX_NUDGES) {
    const task = getWorkflowTask(result, state.currentTaskId);
    if (!task) throw new Error(`工作流当前任务不存在：${state.currentTaskId}`);
    task.status = "blocked";
    task.outcomeUnknown = true;
    task.blockReason = `连续 ${WORKFLOW_MAX_NUDGES} 次回合未提交完成或阻塞结果；执行结果未知，核对副作用后再 retry`;
    delete result.handoff;
    delete result.continuation;
    result.recoveryGeneration += 1;
    result.status = "paused";
    result.pauseReason = "handoff-outcome-unknown";
    result.currentTaskId = undefined;
    result.taskPauseReason = `任务 ${state.currentTaskId} 连续 ${WORKFLOW_MAX_NUDGES} 次回合未提交完成或阻塞结果`;
  }
  return result;
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

export function isWorkflowActive(state: WorkflowState | null | undefined): boolean {
  return state?.status === "running";
}
