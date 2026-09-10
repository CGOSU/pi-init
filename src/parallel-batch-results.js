import {
  PARALLEL_BATCH_VERSION,
  PARALLEL_BATCH_STATUSES,
  PARALLEL_INTEGRATION_STATUSES,
  PARALLEL_RESULT_MAX_BYTES,
  PARALLEL_RESULT_MAX_FILES,
  PARALLEL_RESULT_MAX_VERIFICATION_ITEMS,
  PARALLEL_RESULT_PROTOCOL,
  PARALLEL_TASK_STATUSES,
  RESULT_FIELDS,
  assertChangedFilesInScope,
  assertNonOverlappingScopes,
  cloneBatch,
  findAttempt,
  findTask,
  normalizeAbsolutePath,
  normalizeAttemptId,
  normalizeCommit,
  normalizeId,
  normalizePathList,
  normalizeTaskInput,
  normalizeWorktree,
  rejectUnknownFields,
  requireObject,
  requireText,
} from "./parallel-batch-utils.js";
import { validateParallelBatchInput } from "./parallel-batch-core.js";

function parseResultJson(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > PARALLEL_RESULT_MAX_BYTES) {
    throw new Error("并行 worker 结果必须是限定大小的 JSON 字符串");
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`并行 worker 结果不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeVerification(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label}必须是非空数组`);
  if (value.length > PARALLEL_RESULT_MAX_VERIFICATION_ITEMS) throw new Error(`${label}过多`);
  return [...new Set(value.map((item, index) => requireText(item, `${label}[${index}]`, 2048)))];
}

function resultObject(value, expected) {
  const result = requireObject(value, "并行 worker 结果");
  rejectUnknownFields(result, RESULT_FIELDS, "并行 worker 结果");
  if (result.protocol !== PARALLEL_RESULT_PROTOCOL) throw new Error(`并行 worker 结果协议无效：${result.protocol ?? "（缺失）"}`);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (result[key] !== expectedValue) throw new Error(`并行 worker 结果 ${key}与当前任务不一致`);
  }
  if (result.outcome === "blocked") {
    const allowed = new Set(["protocol", "outcome", "batchId", "taskId", "attemptId", "baseCommit", "reason"]);
    if (Object.keys(result).some((key) => !allowed.has(key))) throw new Error("blocked 结果包含不支持的字段");
    return {
      protocol: PARALLEL_RESULT_PROTOCOL,
      outcome: "blocked",
      batchId: expected.batchId,
      taskId: expected.taskId,
      attemptId: expected.attemptId,
      baseCommit: expected.baseCommit,
      reason: requireText(result.reason, "并行 worker 阻塞原因"),
    };
  }
  if (result.outcome !== "complete") throw new Error(`并行 worker outcome无效：${result.outcome ?? "（缺失）"}`);
  return {
    protocol: PARALLEL_RESULT_PROTOCOL,
    outcome: "complete",
    batchId: expected.batchId,
    taskId: expected.taskId,
    attemptId: expected.attemptId,
    baseCommit: expected.baseCommit,
    completionSummary: requireText(result.completionSummary, "completionSummary"),
    implementationRationale: requireText(result.implementationRationale, "implementationRationale"),
    verification: normalizeVerification(result.verification, "verification"),
    changedFiles: normalizePathList(result.changedFiles, "changedFiles"),
  };
}

export function parseParallelWorkerResult(raw, expected) {
  const value = parseResultJson(raw);
  const normalizedExpected = {
    batchId: normalizeId(expected.batchId, "expected.batchId"),
    taskId: normalizeId(expected.taskId, "expected.taskId"),
    attemptId: normalizeAttemptId(expected.attemptId, "expected.attemptId"),
    baseCommit: normalizeCommit(expected.baseCommit, "expected.baseCommit"),
  };
  const result = resultObject(value, normalizedExpected);
  if (result.outcome === "complete" && Array.isArray(expected.files)) {
    assertChangedFilesInScope(
      { id: normalizedExpected.taskId, files: normalizePathList(expected.files, "expected.files", { required: true }) },
      result.changedFiles,
    );
  }
  return result;
}

export function recordParallelWorkerResult(state, raw, now = Date.now()) {
  if (!state || state.status !== "running") throw new Error("并行批次当前不接收 worker 结果");
  const value = typeof raw === "string" ? parseResultJson(raw) : requireObject(raw, "并行 worker 结果");
  const taskId = normalizeId(value.taskId, "结果 taskId");
  const task = findTask(state, taskId);
  if (task.status !== "running" || !task.attemptId) throw new Error(`并行任务 ${task.id} 没有可接收的活动 attempt`);
  const expected = { batchId: state.batchId, taskId, attemptId: task.attemptId, baseCommit: state.baseCommit };
  const parsed = typeof raw === "string"
    ? parseParallelWorkerResult(raw, { ...expected, files: task.files })
    : resultObject(value, expected);
  if (parsed.outcome === "complete") assertChangedFilesInScope(task, parsed.changedFiles);

  const result = cloneBatch(state, now);
  const nextTask = findTask(result, task.id);
  const attempt = findAttempt(nextTask, nextTask.attemptId);
  if (!attempt) throw new Error(`并行任务 ${task.id} 的 attempt 记录缺失`);
  attempt.status = parsed.outcome === "complete" ? "completed" : "failed";
  attempt.completedAt = now;
  if (parsed.outcome === "blocked") attempt.reason = parsed.reason;
  if (parsed.outcome === "complete") {
    nextTask.status = "completed";
    nextTask.result = parsed;
  } else {
    nextTask.status = "failed";
    nextTask.failureReason = parsed.reason;
    result.blockReason = `worker ${task.id} 被阻塞：${parsed.reason}`;
  }
  nextTask.completedAt = now;
  delete nextTask.attemptId;
  if (result.tasks.every((item) => item.status === "completed")) {
    result.status = "awaiting-integration";
    result.integration.status = "pending";
  } else if (parsed.outcome === "blocked") {
    result.status = "blocked";
  }
  return result;
}

export function recordParallelWorkerFailure(state, { taskId, attemptId, reason }, now = Date.now()) {
  if (!state || state.status !== "running") throw new Error("并行批次当前不接收 worker 失败");
  const task = findTask(state, normalizeId(taskId, "taskId"));
  const id = normalizeAttemptId(attemptId);
  if (task.status !== "running" || task.attemptId !== id) throw new Error(`并行任务 ${task.id} 的失败结果已过期或重复`);
  const result = cloneBatch(state, now);
  const nextTask = findTask(result, task.id);
  const attempt = findAttempt(nextTask, id);
  if (!attempt) throw new Error(`并行任务 ${task.id} 的 attempt 记录缺失`);
  attempt.status = "failed";
  attempt.completedAt = now;
  attempt.reason = requireText(reason, "worker 失败原因");
  nextTask.status = "failed";
  nextTask.failureReason = attempt.reason;
  nextTask.completedAt = now;
  delete nextTask.attemptId;
  result.status = "blocked";
  result.blockReason = `worker ${task.id} 失败：${attempt.reason}`;
  return result;
}

export function retryParallelWorker(state, taskId, now = Date.now()) {
  if (!state || state.status !== "blocked") throw new Error("只有阻塞的并行批次才能重试 worker");
  const task = findTask(state, normalizeId(taskId, "taskId"));
  if (task.status !== "failed") throw new Error(`并行任务 ${task.id} 当前不可重试`);
  const result = cloneBatch(state, now);
  const nextTask = findTask(result, task.id);
  nextTask.status = "pending";
  delete nextTask.failureReason;
  delete nextTask.completedAt;
  delete result.blockReason;
  result.status = "running";
  return result;
}

export function blockParallelBatchForRecovery(state, reason, now = Date.now()) {
  if (!state || ["completed", "cancelled"].includes(state.status)) return state;
  const result = cloneBatch(state, now);
  const blockReason = requireText(reason, "恢复阻塞原因");
  for (const task of result.tasks) {
    if (!["running", "cancel-requested"].includes(task.status)) continue;
    const attempt = findAttempt(task, task.attemptId);
    if (attempt) {
      attempt.status = "failed";
      attempt.completedAt = now;
      attempt.reason = blockReason;
    }
    task.status = "failed";
    task.failureReason = blockReason;
    task.completedAt = now;
    delete task.attemptId;
  }
  result.status = "blocked";
  result.blockReason = blockReason;
  return result;
}

export function cancelParallelBatch(state, reason = "用户取消", now = Date.now()) {
  if (!state || ["completed", "cancelled"].includes(state.status)) throw new Error("并行批次已经结束");
  const result = cloneBatch(state, now);
  result.status = "cancelled";
  result.cancelReason = requireText(reason, "取消原因");
  for (const task of result.tasks) {
    if (task.status === "pending") task.status = "cancelled";
    if (task.status === "running") {
      task.status = "cancel-requested";
      const attempt = findAttempt(task, task.attemptId);
      if (attempt) {
        attempt.status = "cancel-requested";
        attempt.cancelRequestedAt = now;
      }
    }
  }
  return result;
}

export function beginParallelIntegration(state, now = Date.now()) {
  if (!state || state.status !== "awaiting-integration") throw new Error("并行批次当前不可集成");
  if (!state.integration) throw new Error("并行批次缺少集成工作区");
  const result = cloneBatch(state, now);
  result.status = "integrating";
  result.integration.status = "running";
  result.integration.startedAt = now;
  return result;
}

function integrationChangedFilesInScope(state, changedFiles) {
  const allowed = state.tasks.flatMap((task) => task.files);
  for (const file of changedFiles) {
    if (!allowed.some((scope) => file === scope || file.startsWith(`${scope}/`))) {
      throw new Error(`集成修改了并行范围外文件：${file}`);
    }
  }
}

export function recordParallelIntegrationResult(state, input, now = Date.now()) {
  if (!state || state.status !== "integrating" || !state.integration) throw new Error("并行批次当前不接收集成结果");
  const value = requireObject(input, "并行集成结果");
  rejectUnknownFields(value, new Set(["outcome", "verification", "changedFiles", "reason"]), "并行集成结果");
  if (value.outcome !== "complete" && value.outcome !== "blocked") throw new Error("并行集成结果 outcome无效");
  const verification = normalizeVerification(value.verification, "集成 verification");
  const changedFiles = normalizePathList(value.changedFiles, "集成 changedFiles");
  integrationChangedFilesInScope(state, changedFiles);
  const result = cloneBatch(state, now);
  result.integration.status = value.outcome === "complete" ? "completed" : "failed";
  result.integration.verification = verification;
  result.integration.changedFiles = changedFiles;
  result.integration.completedAt = now;
  if (value.outcome === "blocked") {
    result.integration.reason = requireText(value.reason, "集成阻塞原因");
    result.status = "blocked";
    result.blockReason = result.integration.reason;
  } else {
    result.status = "completed";
    result.completedAt = now;
  }
  return result;
}

export function parallelBatchProgress(state) {
  const tasks = state?.tasks ?? [];
  return {
    completed: tasks.filter((task) => task.status === "completed").length,
    total: tasks.length,
    running: tasks.filter((task) => ["running", "cancel-requested"].includes(task.status)).length,
    failed: tasks.filter((task) => task.status === "failed").length,
    status: state?.status,
  };
}

const HYDRATED_TASK_FIELDS = new Set([
  "id", "task", "files", "acceptanceCriteria", "role", "model", "thinkingLevel", "status", "worktree",
  "attempts", "attemptId", "startedAt", "completedAt", "failureReason", "result",
]);

function finiteField(value, label) {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) throw new Error(`${label}无效`);
  return value;
}

function normalizeHydratedTask(task, index, batchId, baseCommit, parentPath, seenPaths) {
  const value = requireObject(task, `已保存的并行任务 ${index + 1}`);
  rejectUnknownFields(value, HYDRATED_TASK_FIELDS, `已保存的并行任务 ${index + 1}`);
  const plan = normalizeTaskInput({
    id: value.id,
    task: value.task,
    files: value.files,
    acceptanceCriteria: value.acceptanceCriteria,
    ...(value.role !== undefined ? { role: value.role } : {}),
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.thinkingLevel !== undefined ? { thinkingLevel: value.thinkingLevel } : {}),
  }, index);
  if (!PARALLEL_TASK_STATUSES.includes(value.status)) throw new Error(`已保存的并行任务 ${plan.id} 状态无效`);
  const normalized = { ...plan, status: value.status };
  if (value.worktree) {
    normalized.worktree = normalizeWorktree(value.worktree, `已保存的并行任务 ${plan.id} 工作区`, baseCommit, parentPath, seenPaths);
    seenPaths.push(normalized.worktree.path);
  }
  if (value.attempts !== undefined) {
    if (!Array.isArray(value.attempts)) throw new Error(`已保存的并行任务 ${plan.id} attempts格式无效`);
    normalized.attempts = value.attempts.map((attempt) => {
      const item = requireObject(attempt, `已保存的并行任务 ${plan.id} attempt`);
      rejectUnknownFields(item, new Set(["attemptId", "status", "startedAt", "completedAt", "reason", "cancelRequestedAt"]), "attempt");
      const attemptId = normalizeAttemptId(item.attemptId);
      if (!["running", "completed", "failed", "cancel-requested"].includes(item.status)) throw new Error("attempt状态无效");
      return {
        attemptId,
        status: item.status,
        startedAt: finiteField(item.startedAt, "attempt startedAt"),
        completedAt: finiteField(item.completedAt, "attempt completedAt"),
        ...(item.reason !== undefined ? { reason: requireText(item.reason, "attempt reason") } : {}),
        ...(item.cancelRequestedAt !== undefined ? { cancelRequestedAt: finiteField(item.cancelRequestedAt, "attempt cancelRequestedAt") } : {}),
      };
    });
  }
  normalized.startedAt = finiteField(value.startedAt, `已保存的并行任务 ${plan.id} startedAt`);
  normalized.completedAt = finiteField(value.completedAt, `已保存的并行任务 ${plan.id} completedAt`);
  if (value.attemptId !== undefined) normalized.attemptId = normalizeAttemptId(value.attemptId);
  if (value.failureReason !== undefined) normalized.failureReason = requireText(value.failureReason, "failureReason");
  if (value.result !== undefined) {
    const parsed = resultObject(value.result, {
      batchId,
      taskId: plan.id,
      attemptId: value.result.attemptId,
      baseCommit,
    });
    if (parsed.outcome !== "complete") throw new Error("已保存的 completed 任务 result必须为 complete");
    assertChangedFilesInScope(plan, parsed.changedFiles);
    normalized.result = parsed;
  }
  if (["running", "cancel-requested"].includes(normalized.status) && !normalized.attemptId) {
    throw new Error(`已保存的并行任务 ${plan.id} 缺少活动 attempt`);
  }
  if (normalized.status === "completed" && !normalized.result) throw new Error(`已保存的 completed 任务 ${plan.id} 缺少 result`);
  if (normalized.status === "failed" && !normalized.failureReason) throw new Error(`已保存的 failed 任务 ${plan.id} 缺少 failureReason`);
  if (normalized.status === "pending" && normalized.attemptId) throw new Error(`已保存的 pending 任务 ${plan.id} 不能有活动 attempt`);
  return normalized;
}

export function hydrateParallelBatch(state) {
  const value = requireObject(state, "已保存的并行批次");
  if (value.version !== PARALLEL_BATCH_VERSION) throw new Error(`不支持的并行批次状态版本：${value.version}`);
  if (!PARALLEL_BATCH_STATUSES.includes(value.status)) throw new Error("已保存的并行批次 status无效");
  if (!Array.isArray(value.tasks)) throw new Error("已保存的并行批次缺少 tasks");
  const input = validateParallelBatchInput({
    batchId: value.batchId,
    parentPath: value.parentPath,
    baseCommit: value.baseCommit,
    ...(value.baseBranch !== undefined ? { baseBranch: value.baseBranch } : {}),
    ...(value.workflowTaskId !== undefined ? { workflowTaskId: value.workflowTaskId } : {}),
    tasks: value.tasks.map((task) => ({
      id: task.id,
      task: task.task,
      files: task.files,
      acceptanceCriteria: task.acceptanceCriteria,
      ...(task.role !== undefined ? { role: task.role } : {}),
      ...(task.model !== undefined ? { model: task.model } : {}),
      ...(task.thinkingLevel !== undefined ? { thinkingLevel: task.thinkingLevel } : {}),
    })),
  });
  const seenPaths = [];
  const tasks = value.tasks.map((task, index) => normalizeHydratedTask(task, index, input.batchId, input.baseCommit, input.parentPath, seenPaths));
  assertNonOverlappingScopes(tasks);
  const attemptIds = new Set();
  for (const task of tasks) {
    for (const attempt of task.attempts ?? []) {
      if (attemptIds.has(attempt.attemptId)) throw new Error(`已保存的 attemptId重复：${attempt.attemptId}`);
      attemptIds.add(attempt.attemptId);
    }
    if (task.attemptId && !findAttempt(task, task.attemptId)) throw new Error(`已保存的并行任务 ${task.id} 活动 attempt不存在`);
  }
  const result = {
    version: PARALLEL_BATCH_VERSION,
    batchId: input.batchId,
    parentPath: input.parentPath,
    baseCommit: input.baseCommit,
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
    ...(input.workflowTaskId ? { workflowTaskId: input.workflowTaskId } : {}),
    status: value.status,
    tasks,
    createdAt: finiteField(value.createdAt, "createdAt"),
    updatedAt: finiteField(value.updatedAt, "updatedAt"),
    startedAt: finiteField(value.startedAt, "startedAt"),
    completedAt: finiteField(value.completedAt, "completedAt"),
    ...(value.blockReason !== undefined ? { blockReason: requireText(value.blockReason, "blockReason") } : {}),
    ...(value.cancelReason !== undefined ? { cancelReason: requireText(value.cancelReason, "cancelReason") } : {}),
  };
  if (value.integration !== undefined) {
    const integration = requireObject(value.integration, "已保存的并行集成");
    rejectUnknownFields(integration, new Set([
      "name", "path", "branch", "commit", "status", "startedAt", "completedAt", "verification", "changedFiles", "reason",
    ]), "已保存的并行集成");
    if (!PARALLEL_INTEGRATION_STATUSES.includes(integration.status)) throw new Error("已保存的并行集成 status无效");
    const worktree = normalizeWorktree(integration, "已保存的并行集成工作区", input.baseCommit, input.parentPath, seenPaths);
    result.integration = {
      ...worktree,
      status: integration.status,
      ...(integration.startedAt !== undefined ? { startedAt: finiteField(integration.startedAt, "集成 startedAt") } : {}),
      ...(integration.completedAt !== undefined ? { completedAt: finiteField(integration.completedAt, "集成 completedAt") } : {}),
      ...(integration.verification !== undefined ? { verification: normalizeVerification(integration.verification, "集成 verification") } : {}),
      ...(integration.changedFiles !== undefined ? { changedFiles: normalizePathList(integration.changedFiles, "集成 changedFiles") } : {}),
      ...(integration.reason !== undefined ? { reason: requireText(integration.reason, "集成 reason") } : {}),
    };
    seenPaths.push(worktree.path);
  }
  if (["running", "awaiting-integration", "integrating", "completed"].includes(result.status) && !result.integration) {
    throw new Error("已保存的并行批次缺少集成工作区");
  }
  return result;
}
