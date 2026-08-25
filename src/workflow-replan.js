import {
  WORKFLOW_MAX_TASKS,
  assertAcyclic,
  clonePlan,
  cloneState,
  cloneTask,
  normalizeRevisionId,
  normalizeTask,
  normalizeTaskIds,
  normalizeTextList,
  requireText,
} from "./workflow-model.js";

function normalizeReplanPlan(input) {
  if (!input || typeof input !== "object") throw new Error("工作流重规划格式无效");
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new Error("工作流重规划至少需要一个新增任务");
  }
  if (input.tasks.length > WORKFLOW_MAX_TASKS) {
    throw new Error(`工作流重规划最多支持 ${WORKFLOW_MAX_TASKS} 个新增任务`);
  }

  const tasks = input.tasks.map(normalizeTask);
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`工作流重规划任务 id 重复：${task.id}`);
    ids.add(task.id);
  }
  return {
    summary: requireText(input.summary, "工作流重规划摘要"),
    constraints: normalizeTextList(input.constraints, "工作流重规划约束"),
    tasks,
  };
}

function workflowHistoricalTaskIds(state) {
  const ids = new Set((state.tasks ?? []).map((task) => task.id));
  for (const revision of state.revisions ?? []) {
    for (const task of revision.previousTasks ?? []) ids.add(task.id);
    for (const task of revision.replacedTasks ?? []) ids.add(task.id);
    for (const task of revision.newPlan?.tasks ?? []) ids.add(task.id);
  }
  return ids;
}

export function requestWorkflowReplan(state, { revisionId, direction } = {}, now = Date.now()) {
  if (!state || state.status !== "running") {
    throw new Error("只有运行中的工作流才能请求重规划");
  }
  if (state.pendingRevision) throw new Error("工作流已有待处理的重规划请求");

  const id = normalizeRevisionId(
    revisionId ?? `revision-${now}-${(state.revisions ?? []).length + 1}`,
    "工作流重规划的 revisionId",
  );
  if ((state.revisions ?? []).some((revision) => revision.revisionId === id)) {
    throw new Error(`工作流重规划 revisionId 重复：${id}`);
  }

  const pendingRevision = {
    revisionId: id,
    direction: requireText(direction, "工作流重规划方向"),
    requestedAt: now,
    ...(state.currentTaskId ? { requestedFromTaskId: state.currentTaskId } : {}),
  };
  const result = cloneState(state, now);
  result.pendingRevision = pendingRevision;
  result.revisions.push({ ...pendingRevision, status: "requested" });
  if (!state.currentTaskId) {
    result.status = "replanning";
    result.pauseReason = "workflow-replan";
  }
  return result;
}

function mergeReplanDirections(directions) {
  return directions.map((item) => item.trim()).filter(Boolean).join("\n");
}

export function appendWorkflowReplanDirection(state, direction, now = Date.now()) {
  if (!state || !state.pendingRevision) {
    throw new Error("工作流没有待处理的重规划请求");
  }

  const text = requireText(direction, "工作流重规划方向");
  const result = cloneState(state, now);
  const pendingRevision = result.pendingRevision;
  const merged = mergeReplanDirections([pendingRevision.direction, text]);
  pendingRevision.direction = merged;
  const revision = result.revisions.find(
    (item) => item.revisionId === pendingRevision.revisionId && item.status === "requested",
  );
  if (!revision) throw new Error("工作流重规划 revisionId 已应用或不存在");
  revision.direction = merged;
  return result;
}

export function applyWorkflowReplan(
  state,
  { revisionId, summary, constraints, tasks, retainTaskIds, preserveTaskIds } = {},
  now = Date.now(),
) {
  if (!state || state.status !== "replanning") {
    throw new Error("工作流当前不在等待重规划状态");
  }
  if (state.currentTaskId) throw new Error("当前任务尚未结束，不能应用工作流重规划");

  const id = normalizeRevisionId(revisionId, "工作流重规划的 revisionId");
  const pendingRevision = state.pendingRevision;
  if (!pendingRevision || pendingRevision.revisionId !== id) {
    throw new Error(`工作流重规划 revisionId 已过期或不匹配：${id}`);
  }
  const plan = normalizeReplanPlan({ summary, constraints, tasks });
  const requestedRetainedIds = retainTaskIds !== undefined && preserveTaskIds !== undefined
    ? (() => { throw new Error("只能指定一种保留任务 ID 列表"); })()
    : retainTaskIds ?? preserveTaskIds;
  const retainedIds = normalizeTaskIds(requestedRetainedIds, "工作流重规划的 retainTaskIds");
  const retainedIdSet = new Set(retainedIds);
  const stateTaskMap = new Map(state.tasks.map((task) => [task.id, task]));

  for (const taskId of retainedIds) {
    const task = stateTaskMap.get(taskId);
    if (!task) throw new Error(`工作流重规划要求保留不存在的任务：${taskId}`);
    if (task.status !== "pending") {
      throw new Error(`工作流重规划只能保留未开始任务：${taskId}`);
    }
  }

  const historicalTaskIds = workflowHistoricalTaskIds(state);
  for (const task of plan.tasks) {
    if (historicalTaskIds.has(task.id)) {
      throw new Error(`工作流重规划不能复用历史任务 ID：${task.id}`);
    }
  }

  const completedTasks = state.tasks.filter((task) => task.status === "completed");
  const retainedTasks = state.tasks.filter((task) => retainedIdSet.has(task.id));
  const replacedTasks = state.tasks
    .filter((task) => task.status !== "completed" && !retainedIdSet.has(task.id))
    .map((task) => ({
      ...cloneTask(task),
      status: "superseded",
      supersededAt: now,
      supersededBy: id,
    }));
  const activeTasks = [
    ...completedTasks.map(cloneTask),
    ...retainedTasks.map(cloneTask),
    ...plan.tasks.map(cloneTask),
  ];
  if (activeTasks.length > WORKFLOW_MAX_TASKS) {
    throw new Error(`应用重规划后工作流最多支持 ${WORKFLOW_MAX_TASKS} 个活动任务`);
  }
  const activeIds = new Set();
  for (const task of activeTasks) {
    if (activeIds.has(task.id)) throw new Error(`应用重规划后任务 id 重复：${task.id}`);
    activeIds.add(task.id);
  }
  assertAcyclic(activeTasks);

  const result = cloneState(state, now);
  const revision = result.revisions.find((item) => item.revisionId === id);
  if (!revision || revision.status !== "requested") {
    throw new Error(`工作流重规划 revisionId 已应用或不存在：${id}`);
  }
  revision.status = "applied";
  revision.appliedAt = now;
  revision.previousPlan = clonePlan(state.plan);
  revision.previousTasks = state.tasks.map(cloneTask);
  revision.replacedTaskIds = replacedTasks.map((task) => task.id);
  revision.replacedTasks = replacedTasks;
  revision.retainedTaskIds = retainedTasks.map((task) => task.id);
  revision.addedTaskIds = plan.tasks.map((task) => task.id);
  revision.newPlan = {
    summary: plan.summary,
    constraints: [...plan.constraints],
    tasks: plan.tasks.map(cloneTask),
  };

  result.plan = {
    summary: plan.summary,
    constraints: [...plan.constraints],
  };
  result.tasks = activeTasks;
  result.currentTaskId = undefined;
  result.nudgeCount = 0;
  delete result.pendingRevision;
  delete result.pauseReason;
  delete result.taskPauseReason;
  if (result.tasks.every((task) => task.status === "completed")) {
    result.status = "completed";
    result.completedAt = now;
  } else {
    result.status = "running";
    delete result.completedAt;
  }
  return result;
}
