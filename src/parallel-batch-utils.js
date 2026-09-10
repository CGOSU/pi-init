import path from "node:path";

export const PARALLEL_BATCH_VERSION = 1;
export const PARALLEL_BATCH_MAX_WORKERS = 2;
export const PARALLEL_RESULT_PROTOCOL = "pi-init/parallel-task@1";
export const PARALLEL_RESULT_MAX_BYTES = 16 * 1024;
export const PARALLEL_RESULT_MAX_VERIFICATION_ITEMS = 32;
export const PARALLEL_RESULT_MAX_FILES = 256;

export const PARALLEL_BATCH_STATUSES = [
  "planned", "running", "awaiting-integration", "integrating", "completed", "blocked", "cancelled",
];
export const PARALLEL_TASK_STATUSES = [
  "pending", "running", "completed", "failed", "cancel-requested", "cancelled",
];
export const PARALLEL_INTEGRATION_STATUSES = ["pending", "running", "completed", "failed"];

export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const COMMIT_PATTERN = /^[0-9a-f]{7,128}$/i;
export const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const BATCH_FIELDS = new Set(["batchId", "parentPath", "baseCommit", "baseBranch", "workflowTaskId", "tasks"]);
export const TASK_FIELDS = new Set(["id", "task", "files", "acceptanceCriteria", "role", "model", "thinkingLevel"]);
export const RESULT_FIELDS = new Set([
  "protocol", "outcome", "batchId", "taskId", "attemptId", "baseCommit",
  "completionSummary", "implementationRationale", "verification", "changedFiles", "reason",
]);

export function requireText(value, label, maxLength = 4096) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`${label}过长`);
  return text;
}

export function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value;
}

export function rejectUnknownFields(value, fields, label) {
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) throw new Error(`${label}包含不支持的字段：${key}`);
  }
}

export function isAbsolutePath(value) {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

export function normalizeRelativePath(value, label = "文件路径") {
  const text = requireText(value, label, 1024).replaceAll("\\", "/");
  if (text.includes("\0") || isAbsolutePath(text) || text.startsWith("/")) {
    throw new Error(`${label}必须是相对路径`);
  }
  const segments = text.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label}不能包含空路径段、. 或 ..`);
  }
  return text;
}

export function normalizePathList(value, label, { required = false } = {}) {
  if (!Array.isArray(value) || (required && value.length === 0)) throw new Error(`${label}必须是非空数组`);
  const result = value.map((item, index) => normalizeRelativePath(item, `${label}[${index}]`));
  const unique = [...new Set(result)];
  if (unique.length !== result.length) throw new Error(`${label}不能包含重复路径`);
  if (unique.length > PARALLEL_RESULT_MAX_FILES) throw new Error(`${label}过多`);
  return unique;
}

export function normalizeCommit(value, label = "commit") {
  const result = requireText(value, label, 128);
  if (!COMMIT_PATTERN.test(result)) throw new Error(`${label}必须是 commit 哈希`);
  return result.toLowerCase();
}

export function normalizeId(value, label) {
  const id = requireText(value, label, 64).toLowerCase();
  if (!ID_PATTERN.test(id)) throw new Error(`${label}格式无效`);
  return id;
}

export function normalizeAttemptId(value, label = "attemptId") {
  const id = requireText(value, label, 128);
  if (!ATTEMPT_ID_PATTERN.test(id)) throw new Error(`${label}格式无效`);
  return id;
}

export function normalizeAbsolutePath(value, label) {
  const result = requireText(value, label, 4096);
  if (!isAbsolutePath(result)) throw new Error(`${label}必须是绝对路径`);
  return path.normalize(result);
}

export function samePath(left, right) {
  const normalize = (value) => {
    const result = path.normalize(value);
    return process.platform === "win32" ? result.toLowerCase() : result;
  };
  return normalize(left) === normalize(right);
}

export function assertIndependentPath(parentPath, candidatePath, label) {
  const relative = path.relative(parentPath, candidatePath);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error(`${label}不能位于主工作区内：${candidatePath}`);
  }
}

function scopesOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function assertNonOverlappingScopes(tasks) {
  for (let left = 0; left < tasks.length; left += 1) {
    for (let right = left + 1; right < tasks.length; right += 1) {
      for (const leftFile of tasks[left].files) {
        for (const rightFile of tasks[right].files) {
          if (scopesOverlap(leftFile, rightFile)) {
            throw new Error(`并行任务文件范围重叠：${tasks[left].id} 与 ${tasks[right].id}`);
          }
        }
      }
    }
  }
}

export function normalizeTaskInput(task, index) {
  const value = requireObject(task, `并行任务 ${index + 1}`);
  rejectUnknownFields(value, TASK_FIELDS, `并行任务 ${index + 1}`);
  const id = normalizeId(value.id, `并行任务 ${index + 1} 的 id`);
  const acceptanceCriteria = Array.isArray(value.acceptanceCriteria) && value.acceptanceCriteria.length > 0
    ? value.acceptanceCriteria.map((item, itemIndex) => requireText(item, `并行任务 ${id} 的 acceptanceCriteria[${itemIndex}]`))
    : (() => { throw new Error(`并行任务 ${id} 的 acceptanceCriteria必须是非空数组`); })();
  const result = {
    id,
    task: requireText(value.task, `并行任务 ${id} 的 task`),
    files: normalizePathList(value.files, `并行任务 ${id} 的 files`, { required: true }),
    acceptanceCriteria,
    status: "pending",
  };
  if (value.role !== undefined) {
    const role = requireText(value.role, `并行任务 ${id} 的 role`, 128).toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(role)) throw new Error(`并行任务 ${id} 的 role格式无效`);
    result.role = role;
  }
  if (value.model !== undefined) {
    const model = requireText(value.model, `并行任务 ${id} 的 model`, 512);
    if (!model.includes("/")) throw new Error(`并行任务 ${id} 的 model必须包含 provider/前缀`);
    result.model = model;
  }
  if (value.thinkingLevel !== undefined) {
    const level = requireText(value.thinkingLevel, `并行任务 ${id} 的 thinkingLevel`, 16);
    if (!THINKING_LEVELS.has(level)) throw new Error(`并行任务 ${id} 的 thinkingLevel无效`);
    result.thinkingLevel = level;
  }
  return result;
}

export function normalizeWorktree(value, label, baseCommit, parentPath, existingPaths = []) {
  const item = requireObject(value, label);
  const name = requireText(item.name, `${label} name`, 256);
  const worktreePath = normalizeAbsolutePath(item.path, `${label} path`);
  const branch = requireText(item.branch, `${label} branch`, 256);
  const commit = normalizeCommit(item.commit, `${label} commit`);
  if (commit !== baseCommit) throw new Error(`${label} commit与固定基线不一致`);
  assertIndependentPath(parentPath, worktreePath, label);
  if (existingPaths.some((candidate) => samePath(candidate, worktreePath))) {
    throw new Error(`${label} path与其他工作区重复`);
  }
  return { name, path: worktreePath, branch, commit };
}

export function cloneTask(task) {
  return {
    ...task,
    files: [...task.files],
    acceptanceCriteria: [...task.acceptanceCriteria],
    ...(task.worktree ? { worktree: { ...task.worktree } } : {}),
    ...(task.attempts ? { attempts: task.attempts.map((attempt) => ({
      ...attempt,
      ...(attempt.result ? {
        result: { ...attempt.result, verification: [...attempt.result.verification], changedFiles: [...attempt.result.changedFiles] },
      } : {}),
    })) } : {}),
    ...(task.result ? {
      result: { ...task.result, verification: [...task.result.verification], changedFiles: [...task.result.changedFiles] },
    } : {}),
  };
}

export function cloneBatch(state, now = Date.now()) {
  return {
    ...state,
    tasks: state.tasks.map(cloneTask),
    ...(state.integration ? {
      integration: {
        ...state.integration,
        ...(state.integration.verification ? { verification: [...state.integration.verification] } : {}),
        ...(state.integration.changedFiles ? { changedFiles: [...state.integration.changedFiles] } : {}),
      },
    } : {}),
    updatedAt: now,
  };
}

export function activeTaskCount(state) {
  return state.tasks.filter((task) => ["running", "cancel-requested"].includes(task.status)).length;
}

export function findTask(state, taskId) {
  const task = state?.tasks?.find((item) => item.id === taskId);
  if (!task) throw new Error(`并行任务不存在：${taskId}`);
  return task;
}

export function findAttempt(task, attemptId) {
  return task.attempts?.find((attempt) => attempt.attemptId === attemptId);
}

export function ensureAttemptUnused(state, attemptId) {
  for (const task of state.tasks) {
    if ((task.attempts ?? []).some((attempt) => attempt.attemptId === attemptId)) {
      throw new Error(`attemptId已使用：${attemptId}`);
    }
  }
}

export function assertChangedFilesInScope(task, changedFiles) {
  for (const changedFile of changedFiles) {
    if (!task.files.some((scope) => changedFile === scope || changedFile.startsWith(`${scope}/`))) {
      throw new Error(`worker ${task.id} 修改了范围外文件：${changedFile}`);
    }
  }
}
