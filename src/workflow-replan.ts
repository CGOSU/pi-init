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
  requireText,
} from "./workflow-model.ts";
import type { WorkflowPlanSummary, WorkflowResult, WorkflowState, WorkflowTask } from "./workflow-types.ts";
import { validateClarificationResolutionCoverage, type WorkflowTaskClarificationDraft } from "./workflow-clarification.ts";

type WorkflowReplanRequest = {
  revisionId?: unknown;
  direction?: unknown;
  kind?: "replan" | "nested";
  childGoal?: unknown;
};
type WorkflowReplanApplication = {
  revisionId?: unknown;
  summary?: unknown;
  constraints?: unknown;
  tasks?: unknown;
  retainTaskIds?: unknown;
  preserveTaskIds?: unknown;
};
type NormalizedReplanPlan = WorkflowPlanSummary & { tasks: WorkflowTask[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function normalizeReplanPlan(input: unknown): NormalizedReplanPlan {
  if (!isRecord(input)) throw new Error("工作流重规划格式无效");
  if (!isUnknownArray(input.tasks) || input.tasks.length === 0) {
    throw new Error("工作流重规划至少需要一个新增任务");
  }
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
  { revisionId, direction, kind = "replan", childGoal }: WorkflowReplanRequest = {},
  now = Date.now(),
): WorkflowState {
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

  const normalizedDirection = requireText(direction, "工作流重规划方向");
  const pendingRevision = {
    revisionId: id,
    direction: normalizedDirection,
    requestedAt: now,
    ...(state.currentTaskId ? { requestedFromTaskId: state.currentTaskId } : {}),
    ...(kind === "nested"
      ? { kind, childGoal: requireText(childGoal ?? normalizedDirection, "嵌套工作流目标") }
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

export function requestWorkflowNestedGoal(
  state: WorkflowState,
  { revisionId, direction }: Omit<WorkflowReplanRequest, "kind" | "childGoal"> = {},
  now = Date.now(),
): WorkflowState {
  return requestWorkflowReplan(state, { revisionId, direction, kind: "nested", childGoal: direction }, now);
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
  if (pendingRevision.kind === "nested") {
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
  if (pendingRevision.kind === "nested") revision.childGoal = pendingRevision.childGoal;
  return result;
}

export function requestWorkflowTaskClarification(
  state: WorkflowState,
  draft: WorkflowTaskClarificationDraft,
  now = Date.now(),
): WorkflowResult<WorkflowState> {
  const taskId = state?.currentTaskId;
  const task = taskId ? state.tasks.find((item) => item.id === taskId) : undefined;
  const handoff = state?.handoff;
  if (!state || state.status !== "running" || !taskId || !task || task.status !== "in_progress"
    || !handoff || handoff.taskId !== taskId || handoff.phase !== "executing") {
    return { ok: false, code: "WORKFLOW_CLARIFICATION_HANDOFF_STALE", message: "澄清必须由当前真实启动的任务 handoff 提交" };
  }
  if (!task.contract) {
    return { ok: false, code: "WORKFLOW_CLARIFICATION_CONTRACT_MISSING", message: "只有携带任务契约的协调任务可以提交结构化澄清" };
  }
  const issueId = `clarification-${randomUUID()}`;
  const direction = `开发任务 ${taskId} 退回澄清 ${issueId}（${draft.category}）：${draft.question}`;
  let requested: WorkflowState;
  try {
    requested = state.pendingRevision
      ? appendWorkflowReplanDirection(state, direction, now)
      : requestWorkflowReplan(state, { revisionId: issueId, direction }, now);
  } catch (error) {
    return {
      ok: false,
      code: "WORKFLOW_CLARIFICATION_REVISION_INVALID",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const result = cloneState(requested, now);
  const clarifiedTask = result.tasks.find((item) => item.id === taskId);
  if (!clarifiedTask || !result.pendingRevision) {
    return { ok: false, code: "WORKFLOW_CLARIFICATION_STATE_INVALID", message: "澄清状态缺少当前任务或 revision" };
  }
  clarifiedTask.status = "blocked";
  clarifiedTask.blockReason = `等待 architect 处理澄清：${draft.question}`;
  clarifiedTask.clarification = {
    ...draft,
    issueId,
    handoff: {
      workflowId: state.workflowId,
      planVersion: state.planVersion,
      sessionId: state.sessionId,
      recoveryGeneration: state.recoveryGeneration,
      taskId,
      attemptId: handoff.attemptId,
      handoffId: handoff.handoffId,
    },
    createdAt: now,
  };
  result.currentTaskId = undefined;
  delete result.handoff;
  result.status = "replanning";
  result.pauseReason = "workflow-replan";
  delete result.taskPauseReason;
  result.recoveryGeneration += 1;
  result.continuation = {
    kind: "replan",
    revisionId: result.pendingRevision.revisionId,
    handoffId: randomUUID(),
    phase: "pending",
    reason: "replan-requested",
  };
  result.pendingRevision.requestedFromTaskId ??= taskId;
  const revision = result.revisions.find((item) =>
    item.revisionId === result.pendingRevision?.revisionId && item.status === "requested",
  );
  if (!revision) {
    return { ok: false, code: "WORKFLOW_CLARIFICATION_REVISION_MISSING", message: "澄清无法关联到待处理 revision" };
  }
  revision.direction = result.pendingRevision.direction;
  result.nudgeCount = 0;
  return { ok: true, value: result };
}

export function applyWorkflowReplan(
  state: WorkflowState,
  { revisionId, summary, constraints, tasks, retainTaskIds, preserveTaskIds }: WorkflowReplanApplication = {},
  now = Date.now(),
): WorkflowState {
  if (!state || state.status !== "replanning") {
    throw new Error("工作流当前不在等待重规划状态");
  }
  if (state.currentTaskId) throw new Error("当前任务尚未结束，不能应用工作流重规划");

  const id = normalizeRevisionId(revisionId, "工作流重规划的 revisionId");
  const pendingRevision = state.pendingRevision;
  if (pendingRevision?.kind === "nested") {
    throw Object.assign(new Error("嵌套目标必须创建子工作流，不能覆盖父计划"), { code: "WORKFLOW_NESTED_REPLAN_FORBIDDEN" });
  }
  if (!pendingRevision || pendingRevision.revisionId !== id) {
    throw new Error(`工作流重规划 revisionId 已过期或不匹配：${id}`);
  }
  const plan = normalizeReplanPlan({ summary, constraints, tasks });
  const clarificationReadiness = validateClarificationResolutionCoverage(plan.tasks, state.tasks);
  if (!clarificationReadiness.ok) {
    throw Object.assign(new Error(clarificationReadiness.message), { code: clarificationReadiness.code });
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
