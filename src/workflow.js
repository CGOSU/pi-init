export const WORKFLOW_MAX_TASKS = 12;
export const WORKFLOW_MAX_NUDGES = 2;
export const WORKFLOW_TASK_ROLES = ["developer-test", "docs-commit"];

const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}不能为空`);
  }
  return value.trim();
}

function normalizeTextList(value, label, { required = false } = {}) {
  if (value === undefined) {
    if (required) throw new Error(`${label}不能为空`);
    return [];
  }
  if (!Array.isArray(value)) throw new Error(`${label}必须是字符串数组`);

  const result = value.map((item, index) => requireText(item, `${label}[${index}]`));
  if (required && result.length === 0) throw new Error(`${label}不能为空`);
  return [...new Set(result)];
}

function normalizeTask(task, index) {
  if (!task || typeof task !== "object") {
    throw new Error(`工作流任务 ${index + 1} 格式无效`);
  }

  const id = requireText(task.id, `工作流任务 ${index + 1} 的 id`).toLowerCase();
  if (!TASK_ID_PATTERN.test(id)) {
    throw new Error(`工作流任务 ${id} 的 id 必须是小写字母、数字、点、下划线或连字符`);
  }

  const role = task.role ?? "developer-test";
  if (!WORKFLOW_TASK_ROLES.includes(role)) {
    throw new Error(`工作流任务 ${id} 的 role 无效：${role}`);
  }

  const files = normalizeTextList(task.files, `工作流任务 ${id} 的 files`, { required: true });
  const acceptanceCriteria = normalizeTextList(
    task.acceptanceCriteria ?? task.acceptance,
    `工作流任务 ${id} 的 acceptanceCriteria`,
    { required: true },
  );
  const dependsOn = normalizeTextList(task.dependsOn, `工作流任务 ${id} 的 dependsOn`);

  return {
    id,
    task: requireText(task.task, `工作流任务 ${id} 的 task`),
    role,
    files,
    acceptanceCriteria,
    dependsOn,
    status: "pending",
  };
}

function assertAcyclic(tasks) {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    if (task.dependsOn.includes(task.id)) {
      throw new Error(`工作流任务 ${task.id} 不能依赖自身`);
    }
    for (const dependency of task.dependsOn) {
      if (!taskMap.has(dependency)) {
        throw new Error(`工作流任务 ${task.id} 依赖不存在的任务：${dependency}`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (taskId) => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) throw new Error(`工作流任务依赖存在循环：${taskId}`);

    visiting.add(taskId);
    for (const dependency of taskMap.get(taskId).dependsOn) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const task of tasks) visit(task.id);
}

export function validateWorkflowPlan(input) {
  if (!input || typeof input !== "object") throw new Error("工作流规划格式无效");

  const rawTasks = input.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    throw new Error("工作流至少需要一个任务");
  }
  if (rawTasks.length > WORKFLOW_MAX_TASKS) {
    throw new Error(`工作流最多支持 ${WORKFLOW_MAX_TASKS} 个任务`);
  }

  const tasks = rawTasks.map(normalizeTask);
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`工作流任务 id 重复：${task.id}`);
    ids.add(task.id);
  }
  assertAcyclic(tasks);

  return {
    summary: requireText(input.summary, "工作流规划摘要"),
    constraints: normalizeTextList(input.constraints, "工作流约束"),
    tasks,
    reviewRequired: input.reviewRequired === true,
  };
}

export function createWorkflowState(input, now = Date.now()) {
  const plan = validateWorkflowPlan(input);
  return {
    version: 1,
    status: plan.reviewRequired ? "paused" : "running",
    pauseReason: plan.reviewRequired ? "architecture-review" : undefined,
    plan: {
      summary: plan.summary,
      constraints: plan.constraints,
    },
    tasks: plan.tasks,
    currentTaskId: undefined,
    nudgeCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function getWorkflowTask(state, taskId) {
  return state?.tasks?.find((task) => task.id === taskId);
}

function cloneState(state, now = Date.now()) {
  return {
    ...state,
    plan: { ...state.plan, constraints: [...state.plan.constraints] },
    tasks: state.tasks.map((task) => ({
      ...task,
      files: [...task.files],
      acceptanceCriteria: [...task.acceptanceCriteria],
      dependsOn: [...task.dependsOn],
      ...(task.verification ? { verification: [...task.verification] } : {}),
    })),
    updatedAt: now,
  };
}

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
  result.currentTaskId = task.id;
  result.nudgeCount = 0;
  return result;
}

export function completeWorkflowTask(state, { taskId, completionSummary, verification }, now = Date.now()) {
  if (!state || state.status !== "running") throw new Error("工作流当前不在执行中");
  if (state.currentTaskId !== taskId) {
    throw new Error(`只能完成当前任务 ${state.currentTaskId ?? "（无）"}`);
  }

  const summary = requireText(completionSummary, "任务完成摘要");
  const checks = normalizeTextList(verification, "任务验证结果", { required: true });
  const result = cloneState(state, now);
  const task = getWorkflowTask(result, taskId);
  task.status = "completed";
  task.completionSummary = summary;
  task.verification = checks;
  task.completedAt = now;
  result.currentTaskId = undefined;
  result.nudgeCount = 0;
  if (result.tasks.every((item) => item.status === "completed")) {
    result.status = "completed";
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
  const result = cloneState(state, now);
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
