import {
  WORKFLOW_STATE_VERSION,
  WORKFLOW_STATUSES,
  WORKFLOW_TASK_STATUSES,
  WORKFLOW_AUDIT_TASK_STATUSES,
  TASK_ID_PATTERN,
  assertAcyclic,
  normalizeDelegation,
  normalizeExecutor,
  normalizePendingRevision,
  normalizePlanSnapshot,
  normalizeTaskIds,
  WORKFLOW_REVISION_STATUSES,
  normalizeTextList,
  normalizeTimestamp,
  normalizeRevisionId,
  requireTimestamp,
  requireText,
} from "./workflow-model.js";

function normalizeRevisionRecord(revision, index) {
  if (!revision || typeof revision !== "object") {
    throw new Error(`已保存的工作流 revision ${index + 1} 格式无效`);
  }
  const status = revision.status ?? "applied";
  if (!WORKFLOW_REVISION_STATUSES.includes(status)) {
    throw new Error(`已保存的工作流 revision ${revision.revisionId ?? index + 1} 状态无效：${status}`);
  }

  const result = {
    revisionId: normalizeRevisionId(revision.revisionId, `已保存的工作流 revision ${index + 1} 的 revisionId`),
    direction: requireText(revision.direction, `已保存的工作流 revision ${index + 1} 的 direction`),
    status,
    requestedAt: requireTimestamp(
      revision.requestedAt,
      `已保存的工作流 revision ${revision.revisionId ?? index + 1} 的 requestedAt`,
    ),
  };
  if (revision.requestedFromTaskId !== undefined) {
    result.requestedFromTaskId = requireText(
      revision.requestedFromTaskId,
      `已保存的工作流 revision ${revision.revisionId} 的 requestedFromTaskId`,
    ).toLowerCase();
  }
  if (revision.appliedAt !== undefined) {
    result.appliedAt = requireTimestamp(
      revision.appliedAt,
      `已保存的工作流 revision ${revision.revisionId} 的 appliedAt`,
    );
  }
  for (const field of ["retainedTaskIds", "replacedTaskIds", "addedTaskIds"]) {
    if (revision[field] !== undefined) {
      result[field] = normalizeTaskIds(
        revision[field],
        `已保存的工作流 revision ${revision.revisionId} 的 ${field}`,
      );
    }
  }
  if (revision.previousPlan !== undefined) {
    result.previousPlan = normalizePlanSnapshot(
      revision.previousPlan,
      `已保存的工作流 revision ${revision.revisionId} 的 previousPlan`,
    );
  }
  if (revision.previousTasks !== undefined) {
    if (!Array.isArray(revision.previousTasks)) {
      throw new Error(`已保存的工作流 revision ${revision.revisionId} 的 previousTasks 必须是数组`);
    }
    result.previousTasks = revision.previousTasks.map((task, taskIndex) =>
      normalizeHydratedTask(task, taskIndex, { allowSuperseded: true }),
    );
  }
  if (revision.replacedTasks !== undefined) {
    if (!Array.isArray(revision.replacedTasks)) {
      throw new Error(`已保存的工作流 revision ${revision.revisionId} 的 replacedTasks 必须是数组`);
    }
    result.replacedTasks = revision.replacedTasks.map((task, taskIndex) =>
      normalizeHydratedTask(task, taskIndex, { allowSuperseded: true }),
    );
  }
  if (revision.newPlan !== undefined) {
    if (!revision.newPlan || typeof revision.newPlan !== "object") {
      throw new Error(`已保存的工作流 revision ${revision.revisionId} 的 newPlan 格式无效`);
    }
    if (!Array.isArray(revision.newPlan.tasks) || revision.newPlan.tasks.length === 0) {
      throw new Error(`已保存的工作流 revision ${revision.revisionId} 的 newPlan 缺少任务`);
    }
    result.newPlan = {
      ...normalizePlanSnapshot(
        revision.newPlan,
        `已保存的工作流 revision ${revision.revisionId} 的 newPlan`,
      ),
      tasks: revision.newPlan.tasks.map((task, taskIndex) =>
        normalizeHydratedTask(task, taskIndex),
      ),
    };
  }
  return result;
}

function normalizeHydratedTask(task, index, { allowSuperseded = false } = {}) {
  if (!task || typeof task !== "object") {
    throw new Error(`已保存的工作流任务 ${index + 1} 格式无效`);
  }
  const status = task.status ?? "pending";
  const allowedStatuses = allowSuperseded ? WORKFLOW_AUDIT_TASK_STATUSES : WORKFLOW_TASK_STATUSES;
  if (!allowedStatuses.includes(status)) {
    throw new Error(`已保存的工作流任务 ${task.id ?? index + 1} 状态无效：${status}`);
  }
  const id = requireText(task.id, `已保存的工作流任务 ${index + 1} 的 id`).toLowerCase();
  if (!TASK_ID_PATTERN.test(id)) {
    throw new Error(`已保存的工作流任务 ${id} 的 id 无效`);
  }
  const startedAt = normalizeTimestamp(task.startedAt, `已保存的工作流任务 ${task.id ?? index + 1} 的 startedAt`);
  const completedAt = normalizeTimestamp(task.completedAt, `已保存的工作流任务 ${task.id ?? index + 1} 的 completedAt`);
  const implementationRationale = task.implementationRationale === undefined
    ? undefined
    : requireText(task.implementationRationale, `已保存的工作流任务 ${task.id ?? index + 1} 的 implementationRationale`);
  const supersededAt = normalizeTimestamp(task.supersededAt, `已保存的工作流任务 ${task.id ?? index + 1} 的 supersededAt`);
  if (startedAt !== undefined && completedAt !== undefined && completedAt < startedAt) {
    throw new Error(`已保存的工作流任务 ${task.id ?? index + 1} 的 completedAt 早于 startedAt`);
  }
  return {
    ...task,
    id,
    task: requireText(task.task, `已保存的工作流任务 ${index + 1} 的 task`),
    files: normalizeTextList(task.files, `已保存的工作流任务 ${task.id} 的 files`, { required: true }),
    acceptanceCriteria: normalizeTextList(
      task.acceptanceCriteria,
      `已保存的工作流任务 ${task.id} 的 acceptanceCriteria`,
      { required: true },
    ),
    dependsOn: normalizeTextList(task.dependsOn, `已保存的工作流任务 ${task.id} 的 dependsOn`),
    status,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(implementationRationale !== undefined ? { implementationRationale } : {}),
    ...(supersededAt !== undefined ? { supersededAt } : {}),
    ...(task.supersededBy !== undefined
      ? { supersededBy: normalizeRevisionId(task.supersededBy, `已保存的工作流任务 ${task.id} 的 supersededBy`) }
      : {}),
    ...(task.verification
      ? { verification: normalizeTextList(task.verification, `已保存的工作流任务 ${task.id} 的 verification`) }
      : {}),
    ...(task.delegation ? { delegation: normalizeDelegation(task.delegation) } : {}),
  };
}

export function hydrateWorkflowState(state) {
  if (!state || typeof state !== "object") return undefined;
  const version = state.version ?? 1;
  if (version !== 1 && version !== 2 && version !== WORKFLOW_STATE_VERSION) {
    throw new Error(`不支持的工作流状态版本：${version}`);
  }
  if (!Array.isArray(state.tasks) || state.tasks.length === 0) {
    throw new Error("已保存的工作流状态缺少任务");
  }
  const status = state.status ?? "running";
  if (!WORKFLOW_STATUSES.includes(status)) {
    throw new Error(`已保存的工作流状态无效：${status}`);
  }
  const startedAt = normalizeTimestamp(state.startedAt, "已保存的工作流 startedAt");
  const completedAt = normalizeTimestamp(state.completedAt, "已保存的工作流 completedAt");
  if (startedAt !== undefined && completedAt !== undefined && completedAt < startedAt) {
    throw new Error("已保存的工作流 completedAt 早于 startedAt");
  }

  const tasks = state.tasks.map(normalizeHydratedTask);
  const taskIds = new Set();
  for (const task of tasks) {
    if (taskIds.has(task.id)) throw new Error(`已保存的工作流任务 id 重复：${task.id}`);
    taskIds.add(task.id);
  }
  assertAcyclic(tasks);

  const revisions = state.revisions === undefined
    ? []
    : Array.isArray(state.revisions)
      ? state.revisions.map(normalizeRevisionRecord)
      : (() => { throw new Error("已保存的工作流 revisions 必须是数组"); })();
  const revisionIds = new Set();
  for (const revision of revisions) {
    if (revisionIds.has(revision.revisionId)) {
      throw new Error(`已保存的工作流 revision id 重复：${revision.revisionId}`);
    }
    revisionIds.add(revision.revisionId);
  }
  const pendingRevision = state.pendingRevision === undefined
    ? undefined
    : normalizePendingRevision(state.pendingRevision);
  const requestedRevisions = revisions.filter((revision) => revision.status === "requested");
  if (requestedRevisions.length > 1) {
    throw new Error("已保存的工作流包含多个待处理的 revision");
  }
  if (pendingRevision && !revisionIds.has(pendingRevision.revisionId)) {
    throw new Error(`已保存的工作流 pendingRevision 不存在：${pendingRevision.revisionId}`);
  }
  if (pendingRevision && requestedRevisions[0]?.revisionId !== pendingRevision.revisionId) {
    throw new Error("已保存的工作流 pendingRevision 与 revision 审计记录不一致");
  }
  if (!pendingRevision && requestedRevisions.length > 0) {
    throw new Error("已保存的工作流存在未关联的 revision 请求");
  }
  if (pendingRevision && status === "replanning" && state.currentTaskId !== undefined) {
    throw new Error("已保存的工作流重规划状态不能包含进行中的任务");
  }
  if (pendingRevision && status === "running" && state.currentTaskId === undefined) {
    throw new Error("已保存的工作流运行状态缺少重规划边界任务");
  }
  if (pendingRevision && ["paused", "completed", "cancelled"].includes(status)) {
    throw new Error(`已保存的工作流 ${status} 状态不能包含 pendingRevision`);
  }
  if (status === "replanning" && !pendingRevision) {
    throw new Error("已保存的工作流重规划状态缺少 pendingRevision");
  }

  return {
    ...state,
    version: WORKFLOW_STATE_VERSION,
    status,
    // Version 1 never delegated work, so it is always safe to resume locally.
    executor: version === 1 ? "local" : normalizeExecutor(state.executor),
    plan: {
      ...(state.plan ?? {}),
      summary: requireText(state.plan?.summary, "已保存的工作流规划摘要"),
      constraints: normalizeTextList(state.plan?.constraints, "已保存的工作流约束"),
    },
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    tasks,
    revisions,
    ...(pendingRevision ? { pendingRevision } : {}),
  };
}
