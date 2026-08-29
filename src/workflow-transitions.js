import {
  WORKFLOW_MAX_NUDGES,
  cloneState,
  getWorkflowExecutionBounds,
  getWorkflowTask,
  normalizeTextList,
  requireText,
} from "./workflow-model.js";

function dependenciesCompleted(state, task) {
  return task.dependsOn.every((dependency) => getWorkflowTask(state, dependency)?.status === "completed");
}

export function getNextWorkflowTask(state) {
  if (!state || state.status !== "running" || state.currentTaskId) return undefined;
  return state.tasks.find((task) => task.status === "pending" && dependenciesCompleted(state, task));
}

export function startWorkflowTask(state, taskId, now = Date.now()) {
  if (!state || state.status !== "running") throw new Error("工作流当前不可启动任务");
  if (state.currentTaskId) throw new Error(`工作流已有进行中的任务：${state.currentTaskId}`);

  const next = getNextWorkflowTask(state);
  if (!next) throw new Error("工作流没有可启动的下一个任务");
  if (taskId !== undefined && next.id !== taskId) {
    throw new Error(`任务 ${taskId} 尚未满足依赖，当前应先执行 ${next.id}`);
  }

  const result = cloneState(state, now);
  const task = getWorkflowTask(result, next.id);
  task.status = "in_progress";
  delete task.startedAt;
  delete task.executionStartedAt;
  result.currentTaskId = task.id;
  result.nudgeCount = 0;
  return result;
}

export function markWorkflowTaskStarted(state, taskId, now = Date.now()) {
  if (!state || state.status !== "running") throw new Error("工作流当前不可记录任务开始时间");
  if (state.currentTaskId !== taskId) {
    throw new Error(`只能记录当前任务 ${state.currentTaskId ?? "（无）"} 的开始时间`);
  }

  const task = getWorkflowTask(state, taskId);
  if (!task || task.status !== "in_progress") {
    throw new Error(`任务 ${taskId} 当前不在执行中`);
  }
  if (task.executionStartedAt !== undefined) return state;

  const result = cloneState(state, now);
  const startedTask = getWorkflowTask(result, taskId);
  startedTask.startedAt = now;
  startedTask.executionStartedAt = now;
  if (result.startedAt === undefined) {
    result.startedAt = getWorkflowExecutionBounds(state).startedAt ?? now;
  }
  return result;
}

export function beginWorkflowDelegation(state, { taskId, requestId, type }, now = Date.now()) {
  if (!state || state.status !== "running") throw new Error("工作流当前不可委派任务");
  if (state.executor !== "subtask") throw new Error("当前工作流未使用 subtask 执行器");
  if (state.currentTaskId !== taskId) {
    throw new Error(`只能委派当前任务 ${state.currentTaskId ?? "（无）"}`);
  }

  const result = cloneState(state, now);
  const task = getWorkflowTask(result, taskId);
  if (task.delegation && ["spawning", "running", "stop-requested"].includes(task.delegation.status)) {
    throw new Error(`任务 ${taskId} 已有进行中的子代理委派`);
  }
  task.delegation = {
    requestId: requireText(requestId, "子代理请求 ID"),
    type: requireText(type, "子代理类型"),
    status: "spawning",
    createdAt: now,
  };
  return result;
}

export function requestWorkflowDelegationStop(state, now = Date.now()) {
  if (!state || ["completed", "cancelled"].includes(state.status)) return state;
  const result = cloneState(state, now);
  for (const task of result.tasks) {
    if (task.delegation && ["spawning", "running"].includes(task.delegation.status)) {
      task.delegation.status = "stop-requested";
      task.delegation.stopRequestedAt = now;
    }
  }
  return result;
}

export function getWorkflowTaskDuration(task) {
  if (!task || !Number.isFinite(task.startedAt) || !Number.isFinite(task.completedAt)) return undefined;
  if (task.completedAt < task.startedAt) return undefined;
  return task.completedAt - task.startedAt;
}

export function completeWorkflowTask(
  state,
  { taskId, completionSummary, implementationRationale, verification },
  now = Date.now(),
) {
  if (!state || state.status !== "running") throw new Error("工作流当前不在执行中");
  if (state.currentTaskId !== taskId) {
    throw new Error(`只能完成当前任务 ${state.currentTaskId ?? "（无）"}`);
  }

  const summary = requireText(completionSummary, "任务完成摘要");
  const rationale = requireText(implementationRationale, "实现原因");
  const checks = normalizeTextList(verification, "任务验证结果", { required: true });
  const result = cloneState(state, now);
  const task = getWorkflowTask(result, taskId);
  if (task.delegation) {
    task.delegation.status = "completed";
    task.delegation.completedAt = now;
  }
  task.status = "completed";
  task.completionSummary = summary;
  task.implementationRationale = rationale;
  task.verification = checks;
  task.completedAt = now;
  result.currentTaskId = undefined;
  result.nudgeCount = 0;
  if (result.pendingRevision) {
    result.status = "replanning";
    result.pauseReason = "workflow-replan";
    delete result.completedAt;
  } else if (result.tasks.every((item) => item.status === "completed")) {
    result.status = "completed";
    result.completedAt = now;
  } else {
    delete result.completedAt;
  }
  return result;
}

export function blockWorkflowTask(state, { taskId, reason }, now = Date.now()) {
  if (!state || state.status !== "running") throw new Error("工作流当前不在执行中");
  if (state.currentTaskId !== taskId) {
    throw new Error(`只能阻塞当前任务 ${state.currentTaskId ?? "（无）"}`);
  }

  const result = cloneState(state, now);
  const task = getWorkflowTask(result, taskId);
  if (task.delegation && task.delegation.status !== "completed") {
    task.delegation.status = "failed";
    task.delegation.reason = requireText(reason, "任务阻塞原因");
    task.delegation.completedAt = now;
  }
  task.status = "blocked";
  task.blockReason = requireText(reason, "任务阻塞原因");
  result.currentTaskId = undefined;
  result.status = "paused";
  result.pauseReason = "task-blocked";
  result.nudgeCount = 0;
  return result;
}

export function retryWorkflowTask(state, taskId, now = Date.now()) {
  if (!state || state.status !== "paused") throw new Error("只有暂停的工作流才能重试任务");
  const result = cloneState(state, now);
  const task = getWorkflowTask(result, taskId ?? result.tasks.find((item) => item.status === "blocked")?.id);
  if (!task || task.status !== "blocked") throw new Error("没有可重试的阻塞任务");

  task.status = "pending";
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
  result.currentTaskId = undefined;
  result.nudgeCount = 0;
  return result;
}

export function resumeWorkflow(state, now = Date.now()) {
  if (!state || state.status !== "paused") throw new Error("工作流当前不在暂停状态");
  if (state.pauseReason !== "architecture-review") {
    throw new Error("任务因阻塞或未完成暂停，请先使用 retry 重试任务或重新规划");
  }

  const result = cloneState(state, now);
  result.status = "running";
  delete result.pauseReason;
  result.currentTaskId = undefined;
  result.nudgeCount = 0;
  return result;
}

export function cancelWorkflow(state, now = Date.now()) {
  if (!state || ["completed", "cancelled"].includes(state.status)) {
    throw new Error("工作流已经结束");
  }
  const result = requestWorkflowDelegationStop(cloneState(state, now), now);
  result.status = "cancelled";
  result.currentTaskId = undefined;
  result.nudgeCount = 0;
  return result;
}

export function recordWorkflowNudge(state, now = Date.now()) {
  if (!state || state.status !== "running" || !state.currentTaskId) return state;
  const result = cloneState(state, now);
  result.nudgeCount += 1;
  if (result.nudgeCount >= WORKFLOW_MAX_NUDGES) {
    const task = getWorkflowTask(result, state.currentTaskId);
    task.status = "blocked";
    task.blockReason = `连续 ${WORKFLOW_MAX_NUDGES} 次回合未提交完成或阻塞结果`;
    result.status = "paused";
    result.pauseReason = "task-not-completed";
    result.currentTaskId = undefined;
    result.taskPauseReason = `任务 ${state.currentTaskId} 连续 ${WORKFLOW_MAX_NUDGES} 次回合未提交完成或阻塞结果`;
  }
  return result;
}

export function workflowProgress(state) {
  const total = state?.tasks?.length ?? 0;
  const completed = state?.tasks?.filter((task) => task.status === "completed").length ?? 0;
  const blocked = state?.tasks?.filter((task) => task.status === "blocked").length ?? 0;
  return { completed, total, blocked, currentTaskId: state?.currentTaskId };
}

export function isWorkflowActive(state) {
  return state?.status === "running";
}
