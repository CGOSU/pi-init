import {
  PARALLEL_BATCH_MAX_WORKERS,
  PARALLEL_BATCH_VERSION,
  assertNonOverlappingScopes,
  activeTaskCount,
  cloneBatch,
  ensureAttemptUnused,
  findTask,
  normalizeAbsolutePath,
  normalizeAttemptId,
  normalizeCommit,
  normalizeId,
  normalizeTaskInput,
  normalizeWorktree,
  requireText,
  samePath,
  BATCH_FIELDS,
  ID_PATTERN,
  rejectUnknownFields,
  requireObject,
} from "./parallel-batch-utils.js";

export {
  PARALLEL_BATCH_MAX_WORKERS,
  PARALLEL_BATCH_VERSION,
  PARALLEL_RESULT_PROTOCOL,
  PARALLEL_RESULT_MAX_BYTES,
  PARALLEL_RESULT_MAX_VERIFICATION_ITEMS,
  PARALLEL_RESULT_MAX_FILES,
  PARALLEL_BATCH_STATUSES,
  PARALLEL_TASK_STATUSES,
  PARALLEL_INTEGRATION_STATUSES,
  normalizeRelativePath,
  normalizePathList,
  normalizeCommit,
  normalizeId,
  normalizeAttemptId,
  normalizeAbsolutePath,
} from "./parallel-batch-utils.js";

export function validateParallelBatchInput(input) {
  const value = requireObject(input, "并行批次");
  rejectUnknownFields(value, BATCH_FIELDS, "并行批次");
  if (!Array.isArray(value.tasks) || value.tasks.length === 0 || value.tasks.length > PARALLEL_BATCH_MAX_WORKERS) {
    throw new Error(`并行批次任务数必须在 1-${PARALLEL_BATCH_MAX_WORKERS} 之间`);
  }
  const tasks = value.tasks.map(normalizeTaskInput);
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`并行任务 id 重复：${task.id}`);
    ids.add(task.id);
  }
  assertNonOverlappingScopes(tasks);
  return {
    batchId: normalizeId(value.batchId, "并行批次 batchId"),
    parentPath: normalizeAbsolutePath(value.parentPath, "并行批次 parentPath"),
    baseCommit: normalizeCommit(value.baseCommit, "并行批次 baseCommit"),
    ...(value.baseBranch !== undefined ? { baseBranch: requireText(value.baseBranch, "并行批次 baseBranch", 256) } : {}),
    ...(value.workflowTaskId !== undefined ? { workflowTaskId: normalizeId(value.workflowTaskId, "并行批次 workflowTaskId") } : {}),
    tasks,
  };
}

export function createParallelBatch(input, now = Date.now()) {
  const plan = validateParallelBatchInput(input);
  return {
    version: PARALLEL_BATCH_VERSION,
    batchId: plan.batchId,
    parentPath: plan.parentPath,
    baseCommit: plan.baseCommit,
    ...(plan.baseBranch ? { baseBranch: plan.baseBranch } : {}),
    ...(plan.workflowTaskId ? { workflowTaskId: plan.workflowTaskId } : {}),
    status: "planned",
    tasks: plan.tasks,
    integration: undefined,
    createdAt: now,
    updatedAt: now,
  };
}

export function attachParallelWorkerWorktree(state, { taskId, worktree }, now = Date.now()) {
  if (!state || state.status !== "planned") throw new Error("并行批次当前不可绑定工作区");
  const result = cloneBatch(state, now);
  const task = findTask(result, normalizeId(taskId, "taskId"));
  if (task.worktree) throw new Error(`并行任务 ${task.id} 已绑定工作区`);
  const paths = result.tasks.flatMap((item) => item.worktree?.path ? [item.worktree.path] : []);
  if (result.integration?.path) paths.push(result.integration.path);
  task.worktree = normalizeWorktree(worktree, `并行任务 ${task.id} 工作区`, result.baseCommit, result.parentPath, paths);
  return result;
}

export function attachParallelIntegrationWorktree(state, { worktree }, now = Date.now()) {
  if (!state || state.status !== "planned") throw new Error("并行批次当前不可绑定集成工作区");
  const result = cloneBatch(state, now);
  if (result.integration) throw new Error("并行批次已绑定集成工作区");
  const paths = result.tasks.flatMap((item) => item.worktree?.path ? [item.worktree.path] : []);
  result.integration = {
    ...normalizeWorktree(worktree, "并行批次集成工作区", result.baseCommit, result.parentPath, paths),
    status: "pending",
  };
  return result;
}

export function startParallelBatch(state, now = Date.now()) {
  if (!state || state.status !== "planned") throw new Error("并行批次当前不可启动");
  if (!state.integration || state.tasks.some((task) => !task.worktree)) {
    throw new Error("并行批次缺少已校验的 worker 或集成工作区");
  }
  const result = cloneBatch(state, now);
  result.status = "running";
  result.startedAt = now;
  return result;
}

export function getNextParallelTask(state) {
  if (!state || state.status !== "running" || activeTaskCount(state) >= PARALLEL_BATCH_MAX_WORKERS) return undefined;
  return state.tasks.find((task) => task.status === "pending" && task.worktree);
}

export function startParallelWorker(state, { taskId, attemptId }, now = Date.now()) {
  if (!state || state.status !== "running") throw new Error("并行批次当前不可启动 worker");
  if (activeTaskCount(state) >= PARALLEL_BATCH_MAX_WORKERS) throw new Error("并行 worker 不可启动：数量已达到上限");
  const task = findTask(state, normalizeId(taskId, "taskId"));
  if (task.status !== "pending") throw new Error(`并行任务 ${task.id} 当前不可启动：${task.status}`);
  if (!task.worktree) throw new Error(`并行任务 ${task.id} 缺少工作区`);
  const id = normalizeAttemptId(attemptId);
  ensureAttemptUnused(state, id);
  const result = cloneBatch(state, now);
  const nextTask = findTask(result, task.id);
  nextTask.status = "running";
  nextTask.attemptId = id;
  nextTask.startedAt = now;
  nextTask.attempts = [...(nextTask.attempts ?? []), { attemptId: id, status: "running", startedAt: now }];
  return result;
}
