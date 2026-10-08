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
  normalizeIdentityToken,
  normalizePlanVersion,
  normalizeWorkflowContinuation,
  normalizeWorkflowHandoff,
  requireTimestamp,
  requireText,
} from "./workflow-model.ts";
import type {
  HydratedWorkflowState,
  WorkflowHydrationResult,
  WorkflowRevision,
  WorkflowRevisionStatus,
  WorkflowState,
  WorkflowStateRecord,
  WorkflowStateVersion,
  WorkflowTask,
  WorkflowTaskNormalizationOptions,
  WorkflowTaskStatus,
  WorkflowStatus,
  WorkflowValidationFailure,
} from "./workflow-types.ts";

function isRecord(value: unknown): value is WorkflowStateRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isOneOf<const Values extends readonly (string | number)[]>(values: Values, value: unknown): value is Values[number] {
  return (typeof value === "string" || typeof value === "number") && values.some((candidate) => candidate === value);
}

function normalizeRevisionRecord(revision: unknown, index: number): WorkflowRevision {
  if (!isRecord(revision)) {
    throw new Error(`已保存的工作流 revision ${index + 1} 格式无效`);
  }
  const status = revision.status ?? "applied";
  if (!isOneOf(WORKFLOW_REVISION_STATUSES, status)) {
    throw new Error(`已保存的工作流 revision ${revision.revisionId ?? index + 1} 状态无效：${status}`);
  }

  const result: WorkflowRevision = {
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
  if (revision.retainedTaskIds !== undefined) {
    result.retainedTaskIds = normalizeTaskIds(revision.retainedTaskIds, `已保存的工作流 revision ${revision.revisionId} 的 retainedTaskIds`);
  }
  if (revision.replacedTaskIds !== undefined) {
    result.replacedTaskIds = normalizeTaskIds(revision.replacedTaskIds, `已保存的工作流 revision ${revision.revisionId} 的 replacedTaskIds`);
  }
  if (revision.addedTaskIds !== undefined) {
    result.addedTaskIds = normalizeTaskIds(revision.addedTaskIds, `已保存的工作流 revision ${revision.revisionId} 的 addedTaskIds`);
  }
  if (revision.previousPlan !== undefined) {
    result.previousPlan = normalizePlanSnapshot(
      revision.previousPlan,
      `已保存的工作流 revision ${revision.revisionId} 的 previousPlan`,
    );
  }
  if (revision.previousTasks !== undefined) {
    if (!isUnknownArray(revision.previousTasks)) {
      throw new Error(`已保存的工作流 revision ${revision.revisionId} 的 previousTasks 必须是数组`);
    }
    result.previousTasks = revision.previousTasks.map((task, taskIndex) =>
      normalizeHydratedTask(task, taskIndex, { allowSuperseded: true }),
    );
  }
  if (revision.replacedTasks !== undefined) {
    if (!isUnknownArray(revision.replacedTasks)) {
      throw new Error(`已保存的工作流 revision ${revision.revisionId} 的 replacedTasks 必须是数组`);
    }
    result.replacedTasks = revision.replacedTasks.map((task, taskIndex) =>
      normalizeHydratedTask(task, taskIndex, { allowSuperseded: true }),
    );
  }
  if (revision.newPlan !== undefined) {
    if (!isRecord(revision.newPlan)) {
      throw new Error(`已保存的工作流 revision ${revision.revisionId} 的 newPlan 格式无效`);
    }
    if (!isUnknownArray(revision.newPlan.tasks) || revision.newPlan.tasks.length === 0) {
      throw new Error(`已保存的工作流 revision ${revision.revisionId} 的 newPlan 缺少任务`);
    }
    result.newPlan = {
      ...normalizePlanSnapshot(
        revision.newPlan,
        `已保存的工作流 revision ${revision.revisionId} 的 newPlan`,
      ),
      tasks: revision.newPlan.tasks.map((task: unknown, taskIndex) =>
        normalizeHydratedTask(task, taskIndex),
      ),
    };
  }
  return result;
}

function normalizeHydratedTask(
  task: unknown,
  index: number,
  { allowSuperseded = false }: WorkflowTaskNormalizationOptions = {},
): WorkflowTask {
  if (!isRecord(task)) {
    throw new Error(`已保存的工作流任务 ${index + 1} 格式无效`);
  }
  const status = task.status ?? "pending";
  const allowedStatuses = allowSuperseded ? WORKFLOW_AUDIT_TASK_STATUSES : WORKFLOW_TASK_STATUSES;
  if (!isOneOf(allowedStatuses, status)) {
    throw new Error(`已保存的工作流任务 ${task.id ?? index + 1} 状态无效：${status}`);
  }
  const id = requireText(task.id, `已保存的工作流任务 ${index + 1} 的 id`).toLowerCase();
  if (typeof task.role !== "string") throw new Error(`已保存的工作流任务 ${task.id ?? index + 1} 的 role 必须是文本`);
  if (!TASK_ID_PATTERN.test(id)) {
    throw new Error(`已保存的工作流任务 ${id} 的 id 无效`);
  }
  const startedAt = normalizeTimestamp(task.startedAt, `已保存的工作流任务 ${task.id ?? index + 1} 的 startedAt`);
  const executionStartedAt = normalizeTimestamp(task.executionStartedAt, `已保存的工作流任务 ${task.id ?? index + 1} 的 executionStartedAt`);
  const completedAt = normalizeTimestamp(task.completedAt, `已保存的工作流任务 ${task.id ?? index + 1} 的 completedAt`);
  if (task.outcomeUnknown !== undefined && typeof task.outcomeUnknown !== "boolean") {
    throw new Error(`已保存的工作流任务 ${task.id} 的 outcomeUnknown 必须是布尔值`);
  }
  if (task.outcomeUnknown === true && status !== "blocked") {
    throw new Error(`已保存的工作流任务 ${task.id} outcomeUnknown=true 时必须处于 blocked 状态`);
  }
  const completionSummary = task.completionSummary === undefined
    ? undefined
    : requireText(task.completionSummary, `已保存的工作流任务 ${task.id ?? index + 1} 的 completionSummary`);
  const implementationRationale = task.implementationRationale === undefined
    ? undefined
    : requireText(task.implementationRationale, `已保存的工作流任务 ${task.id ?? index + 1} 的 implementationRationale`);
  const blockReason = task.blockReason === undefined
    ? undefined
    : requireText(task.blockReason, `已保存的工作流任务 ${task.id ?? index + 1} 的 blockReason`);
  const supersededAt = normalizeTimestamp(task.supersededAt, `已保存的工作流任务 ${task.id ?? index + 1} 的 supersededAt`);
  if (startedAt !== undefined && completedAt !== undefined && completedAt < startedAt) {
    throw new Error(`已保存的工作流任务 ${task.id ?? index + 1} 的 completedAt 早于 startedAt`);
  }
  return {
    ...task,
    id,
    role: task.role,
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
    ...(executionStartedAt !== undefined ? { executionStartedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(completionSummary !== undefined ? { completionSummary } : {}),
    ...(implementationRationale !== undefined ? { implementationRationale } : {}),
    ...(blockReason !== undefined ? { blockReason } : {}),
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

function hydrateWorkflowStateValue(state: WorkflowStateRecord): HydratedWorkflowState {
  const version = state.version ?? 1;
  const supportedVersions = [1, 2, 3, WORKFLOW_STATE_VERSION] as const satisfies readonly WorkflowStateVersion[];
  if (!isOneOf(supportedVersions, version)) {
    throw new Error(`不支持的工作流状态版本：${version}`);
  }
  if (!isUnknownArray(state.tasks) || state.tasks.length === 0) {
    throw new Error("已保存的工作流状态缺少任务");
  }
  const status = state.status ?? "running";
  if (!isOneOf(WORKFLOW_STATUSES, status)) {
    throw new Error(`已保存的工作流状态无效：${status}`);
  }
  const startedAt = normalizeTimestamp(state.startedAt, "已保存的工作流 startedAt");
  const completedAt = normalizeTimestamp(state.completedAt, "已保存的工作流 completedAt");
  if (startedAt !== undefined && completedAt !== undefined && completedAt < startedAt) {
    throw new Error("已保存的工作流 completedAt 早于 startedAt");
  }

  const tasks = state.tasks.map((task, index) => normalizeHydratedTask(task, index));
  const taskIds = new Set();
  for (const task of tasks) {
    if (taskIds.has(task.id)) throw new Error(`已保存的工作流任务 id 重复：${task.id}`);
    taskIds.add(task.id);
  }
  assertAcyclic(tasks);

  const revisions = state.revisions === undefined
    ? []
    : isUnknownArray(state.revisions)
      ? state.revisions.map((revision, index) => normalizeRevisionRecord(revision, index))
      : (() => { throw new Error("已保存的工作流 revisions 必须是数组"); })();
  const revisionIds = new Set<string>();
  for (const revision of revisions) {
    if (revisionIds.has(revision.revisionId)) {
      throw new Error(`已保存的工作流 revision id 重复：${revision.revisionId}`);
    }
    revisionIds.add(revision.revisionId);
  }
  const pendingRevision = state.pendingRevision === undefined
    ? undefined
    : normalizePendingRevision(state.pendingRevision);
  const legacy = version < WORKFLOW_STATE_VERSION;
  const workflowId = legacy ? undefined : normalizeIdentityToken(state.workflowId, "已保存的工作流 workflowId");
  const sessionId = legacy ? undefined : normalizeIdentityToken(state.sessionId, "已保存的工作流 sessionId");
  const planVersion = legacy ? undefined : normalizePlanVersion(state.planVersion, "已保存的工作流 planVersion");
  const recoveryGeneration = legacy ? 0 : normalizePlanVersion(state.recoveryGeneration, "已保存的工作流 recoveryGeneration");
  const handoff = legacy || state.handoff === undefined ? undefined : normalizeWorkflowHandoff(state.handoff);
  const continuation = legacy ? undefined : normalizeWorkflowContinuation(state.continuation);
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
  if (pendingRevision && status === "running" && state.currentTaskId === undefined
    && !tasks.some((task) => task.status === "pending")) {
    throw new Error("已保存的工作流运行状态缺少重规划边界任务");
  }
  const allowedPausedRevisionReasons: ReadonlySet<unknown> = new Set([
    "task-blocked",
    "task-not-completed",
    "handoff-outcome-unknown",
    "legacy-execution-outcome-unknown",
  ]);
  if (pendingRevision && (status === "completed" || status === "cancelled"
    || (status === "paused" && !allowedPausedRevisionReasons.has(state.pauseReason)))) {
    throw new Error(`已保存的工作流 ${status} 状态不能包含 pendingRevision`);
  }
  if (status === "replanning" && !pendingRevision) {
    throw new Error("已保存的工作流重规划状态缺少 pendingRevision");
  }
  if (state.currentTaskId !== undefined && typeof state.currentTaskId !== "string") {
    throw Object.assign(new Error("已保存的工作流 currentTaskId 与进行中任务不一致"), { code: "WORKFLOW_HANDOFF_STATE_MISMATCH" });
  }
  const currentTaskId = state.currentTaskId;
  const currentTask = currentTaskId === undefined
    ? undefined
    : tasks.find((task) => task.id === currentTaskId);
  if (currentTaskId !== undefined && (!currentTask || currentTask.status !== "in_progress")) {
    throw Object.assign(new Error("已保存的工作流 currentTaskId 与进行中任务不一致"), { code: "WORKFLOW_HANDOFF_STATE_MISMATCH" });
  }
  if (!legacy) {
    const inProgressTasks = tasks.filter((task) => task.status === "in_progress");
    if (Boolean(currentTask) !== Boolean(handoff) || inProgressTasks.length !== (currentTask ? 1 : 0)) {
      throw Object.assign(new Error("已保存的工作流 handoff 与进行中任务不一致"), { code: "WORKFLOW_HANDOFF_STATE_MISMATCH" });
    }
    if (handoff && (
      handoff.workflowId !== workflowId
      || handoff.planVersion !== planVersion
      || handoff.sessionId !== sessionId
      || handoff.recoveryGeneration !== recoveryGeneration
      || handoff.taskId !== currentTask?.id
    )) throw Object.assign(new Error("已保存的工作流 handoff 身份与当前状态不一致"), { code: "WORKFLOW_HANDOFF_IDENTITY_MISMATCH" });
  }

  const planSource = isRecord(state.plan) ? state.plan : {};
  const createdAt = normalizeTimestamp(state.createdAt, "已保存的工作流 createdAt");
  const updatedAt = normalizeTimestamp(state.updatedAt, "已保存的工作流 updatedAt");
  const nudgeCount = state.nudgeCount === undefined
    ? undefined
    : normalizePlanVersion(state.nudgeCount, "已保存的工作流 nudgeCount");
  const pauseReason = state.pauseReason === undefined ? undefined : requireText(state.pauseReason, "已保存的工作流 pauseReason");
  const taskPauseReason = state.taskPauseReason === undefined ? undefined : requireText(state.taskPauseReason, "已保存的工作流 taskPauseReason");
  const authority = state.authority === undefined ? undefined : normalizeExecutor(state.authority);
  const legacySourceVersion = state.legacySourceVersion;
  if (legacySourceVersion !== undefined && typeof legacySourceVersion !== "number") {
    throw new Error("已保存的工作流 legacySourceVersion 无效");
  }
  return {
    ...state,
    version: WORKFLOW_STATE_VERSION,
    ...(legacy
      ? { legacySourceVersion: version }
      : { workflowId, sessionId, planVersion, recoveryGeneration, ...(legacySourceVersion !== undefined ? { legacySourceVersion } : {}) }),
    ...(handoff ? { handoff } : {}),
    ...(continuation ? { continuation } : {}),
    ...(authority !== undefined ? { authority } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(nudgeCount !== undefined ? { nudgeCount } : {}),
    ...(pauseReason !== undefined ? { pauseReason } : {}),
    ...(taskPauseReason !== undefined ? { taskPauseReason } : {}),
    ...(currentTaskId !== undefined ? { currentTaskId } : {}),
    status,
    // Version 1 never delegated work; explicit executor/authority markers are checked by the Result boundary.
    executor: version === 1 ? "local" : normalizeExecutor(state.executor),
    plan: {
      summary: requireText(planSource.summary, "已保存的工作流规划摘要"),
      constraints: normalizeTextList(planSource.constraints, "已保存的工作流约束"),
    },
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    tasks,
    revisions,
    ...(pendingRevision ? { pendingRevision } : {}),
  };
}

function resultFailure(code: string, message: string): WorkflowValidationFailure {
  return { ok: false, code, message };
}

function hasRuntimeAuthorityMarker(state: WorkflowStateRecord): boolean {
  const authority = state.authority;
  return state.executor === "runtime"
    || authority === "runtime"
    || (isRecord(authority) && authority.kind === "runtime")
    || Object.prototype.hasOwnProperty.call(state, "runtimeAuthority");
}

export function hydrateWorkflowState(state: unknown): WorkflowHydrationResult {
  if (state === undefined) {
    return resultFailure("WORKFLOW_STATE_MISSING", "没有已保存的工作流状态");
  }
  if (!isRecord(state)) {
    return resultFailure("WORKFLOW_STATE_INVALID_TYPE", "已保存的工作流状态必须是对象");
  }
  if (hasRuntimeAuthorityMarker(state)) {
    return resultFailure("WORKFLOW_STATE_RUNTIME_RETIRED", "已保存的 Runtime 工作流已退役；不会恢复或改写原始记录");
  }
  try {
    if (Object.prototype.hasOwnProperty.call(state, "executor")) normalizeExecutor(state.executor);
    if (Object.prototype.hasOwnProperty.call(state, "authority")) normalizeExecutor(state.authority);
    return { ok: true, value: hydrateWorkflowStateValue(state) };
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "WORKFLOW_STATE_INVALID";
    return resultFailure(code, error instanceof Error ? error.message : String(error));
  }
}
