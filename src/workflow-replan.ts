import { randomUUID } from "node:crypto";
import {
  assertAcyclic,
  assertWorkflowExecutionRoles,
  clonePlan,
  cloneState,
  cloneTask,
  normalizeRevisionId,
  normalizeTask,
  normalizeTaskIds,
  normalizeTextList,
  requireText, assertWorkflowGoalReferences } from "./workflow-model.ts";
import type { WorkflowPlanSummary, WorkflowState, WorkflowTask } from "./workflow-types.ts";
type WorkflowReplanRequest = {
  revisionId?: unknown;
  direction?: unknown;
  kind?: "replan" | "goal";
  goalParentId?: string;
  childGoal?: unknown;
};
type WorkflowReplanApplication = {
  revisionId?: unknown;
  summary?: unknown;
  constraints?: unknown;
  tasks?: unknown;
  retainTaskIds?: unknown;
  preserveTaskIds?: unknown;
  confirmUnknownOutcome?: boolean;
  reason?: unknown;
};
type NormalizedReplanPlan = WorkflowPlanSummary & { tasks: WorkflowTask[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function normalizeReplanPlan(input: unknown): NormalizedReplanPlan {
  if (!isRecord(input)) throw new Error("工作流重规划格式无效");
  if (!isUnknownArray(input.tasks)) throw new Error("工作流重规划 tasks 必须是数组；仅保留或撤销任务时可为空");
  const tasks = input.tasks.map((task: unknown, index: number) => normalizeTask(task, index));
  const ids = new Set<string>();
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

function workflowHistoricalTaskIds(state: WorkflowState): Set<string> {
  const ids = new Set<string>((state.tasks ?? []).map((task) => task.id));
  for (const revision of state.revisions ?? []) {
    for (const task of revision.previousTasks ?? []) ids.add(task.id);
    for (const task of revision.replacedTasks ?? []) ids.add(task.id);
    for (const task of revision.newPlan?.tasks ?? []) ids.add(task.id);
  }
  return ids;
}

export function requestWorkflowReplan(
  state: WorkflowState,
  { revisionId, direction, kind = "replan", childGoal, goalParentId }: WorkflowReplanRequest = {},
  now = Date.now(),
): WorkflowState {
  const pausedBoundary = state?.status === "paused" && !state.currentTaskId && !state.handoff && ["task-blocked", "task-not-completed", "handoff-outcome-unknown", "legacy-execution-outcome-unknown", "dependency-blocked"].includes(state.pauseReason ?? "");
  const convertGoal = state?.pendingRevision?.kind === "goal" && kind === "replan" && (state.status === "replanning" || state.status === "running" || pausedBoundary);
  if (!state || (state.status !== "running" && !pausedBoundary && !convertGoal)) {
    throw new Error("只有运行中或在安全边界暂停的工作流才能请求重规划");
  }
  if (convertGoal) {
    const result = cloneState(state, now);
    const pending = result.pendingRevision!;
    const revision = result.revisions.find(revision => revision.revisionId === pending.revisionId && revision.status === "requested");
    if (!revision) throw new Error("目标插入缺少有效 revision");
    pending.kind = "replan"; revision.kind = "replan";
    delete pending.childGoal; delete pending.goalParentId;
    delete revision.childGoal; delete revision.goalParentId;
    return appendWorkflowReplanDirection(result, direction, now);
  }
  if (state.pendingRevision) throw new Error("工作流已有待处理的重规划请求");

  const id = normalizeRevisionId(
    revisionId ?? `revision-${now}-${(state.revisions ?? []).length + 1}`,
    "工作流重规划的 revisionId",
  );
  if ((state.revisions ?? []).some((revision) => revision.revisionId === id)) {
    throw new Error(`工作流重规划 revisionId 重复：${id}`);
  }

  const normalizedDirection = requireText(direction, "工作流重规划方向");
  const pendingRevision = {
    revisionId: id,
    direction: normalizedDirection,
    requestedAt: now,
    ...(state.currentTaskId ? { requestedFromTaskId: state.currentTaskId } : {}),
    ...(kind === "goal"
      ? { kind, childGoal: requireText(childGoal ?? normalizedDirection, "插入目标"), ...(goalParentId ? { goalParentId } : {}) }
      : {}),
  };
  const result = cloneState(state, now);
  result.pendingRevision = pendingRevision;
  result.revisions.push({ ...pendingRevision, status: "requested" });
  if (!state.currentTaskId) {
    result.status = "replanning";
    result.pauseReason = "workflow-replan";
    result.recoveryGeneration += 1;
    result.continuation = { kind: "replan", revisionId: id, phase: "pending", reason: "replan-requested" };
  }
  return result;

}

function mergeReplanDirections(directions: string[]): string {
  return directions.map((item) => item.trim()).filter(Boolean).join("\n");
}

export function appendWorkflowReplanDirection(state: WorkflowState, direction: unknown, now = Date.now()): WorkflowState {
  if (!state || !state.pendingRevision) {
    throw new Error("工作流没有待处理的重规划请求");
  }

  const text = requireText(direction, "工作流重规划方向");
  const result = cloneState(state, now);
  const pendingRevision = result.pendingRevision;
  if (!pendingRevision) throw new Error("工作流没有待处理的重规划请求");
  const merged = mergeReplanDirections([pendingRevision.direction, text]);
  pendingRevision.direction = merged;
  if (pendingRevision.kind === "goal") {
    pendingRevision.childGoal = mergeReplanDirections([pendingRevision.childGoal ?? pendingRevision.direction, text]);
  }
  if (result.status === "replanning") {
    result.recoveryGeneration += 1;
    result.continuation = {
      ...result.continuation,
      kind: "replan",
      revisionId: pendingRevision.revisionId,
      handoffId: randomUUID(),
      phase: "pending",
    };
  }
  const revision = result.revisions.find(
    (item) => item.revisionId === pendingRevision.revisionId && item.status === "requested",
  );
  if (!revision) throw new Error("工作流重规划 revisionId 已应用或不存在");
  revision.direction = merged;
  if (pendingRevision.kind === "goal") revision.childGoal = pendingRevision.childGoal;
  return result;
}

export function applyWorkflowReplan(
  state: WorkflowState,
  { revisionId, summary, constraints, tasks, retainTaskIds, preserveTaskIds, confirmUnknownOutcome = false, reason }: WorkflowReplanApplication = {},
  now = Date.now(),
): WorkflowState {
  if (!state || state.status !== "replanning") {
    throw new Error("工作流当前不在等待重规划状态");
  }
  if (state.currentTaskId) throw new Error("当前任务尚未结束，不能应用工作流重规划");

  const id = normalizeRevisionId(revisionId, "工作流重规划的 revisionId");
  const pendingRevision = state.pendingRevision;
  if ((pendingRevision?.kind === "goal")) {
    throw Object.assign(new Error("插入目标必须规划同一队列，不能覆盖原有未完成任务"), { code: "WORKFLOW_NESTED_REPLAN_FORBIDDEN" });
  }
  if (!pendingRevision || pendingRevision.revisionId !== id) {
    throw new Error(`工作流重规划 revisionId 已过期或不匹配：${id}`);
  }
  const plan = normalizeReplanPlan({ summary, constraints, tasks });
  const unknownWithoutClarification = state.tasks.some(task => task.outcomeUnknown);
  let outcomeResolution: string | undefined;
  if (unknownWithoutClarification && plan.tasks.length) {
    if (!confirmUnknownOutcome) throw Object.assign(new Error("旧任务结果未知；新方案可能重放副作用，核对后显式确认并提供 reason 才能替换任务"), { code: "WORKFLOW_UNKNOWN_OUTCOME_CONFIRMATION_REQUIRED" });
    outcomeResolution = requireText(reason, "未知结果核对与不重放处置说明");
  }
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
    .map((task): WorkflowTask => ({
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
  if (!activeTasks.length) throw new Error("重规划必须保留至少一个任务或已完成记录；终止整个目标请 cancel");
  assertWorkflowExecutionRoles(activeTasks, { unfinishedOnly: true });
  const activeIds = new Set<string>();
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
  if (outcomeResolution) revision.direction += "\n未知结果核对处置：" + outcomeResolution;
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
  result.planVersion += 1;
  result.recoveryGeneration += 1;
  result.tasks = activeTasks;
  assertWorkflowGoalReferences(result.goals, result.workflowId, result.tasks);
  result.currentTaskId = undefined;
  delete result.handoff;
  result.nudgeCount = 0;
  delete result.pendingRevision;
  delete result.pauseReason;
  delete result.taskPauseReason;
  if (result.tasks.every((task) => task.status === "completed")) {
    result.status = "completed";
    result.completedAt = now;
    delete result.continuation;
  } else {
    result.status = "running";
    delete result.completedAt;
    result.continuation = { kind: "schedule", phase: "pending", reason: "replan-applied" };
  }
  return result;
}
