import { randomUUID } from "node:crypto";
import { isValidRoleId, normalizeRoleId } from "./roles.js";

export const WORKFLOW_STATE_VERSION = 4;
export const WORKFLOW_MAX_TASKS = 12;
export const WORKFLOW_HANDOFF_PHASES = [
  "prepared",
  "waiting-role",
  "compacting",
  "dispatching",
  "queued",
  "executing",
  "uncertain",
];
export const WORKFLOW_CONTINUATION_KINDS = ["schedule", "replan", "review"];
export const WORKFLOW_MAX_NUDGES = 2;
export const WORKFLOW_EXECUTORS = ["local"];
export const WORKFLOW_DELEGATION_STATUSES = [
  "spawning",
  "running",
  "stop-requested",
  "completed",
  "failed",
];

export const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const WORKFLOW_STATUSES = ["running", "paused", "replanning", "completed", "cancelled"];
export const WORKFLOW_TASK_STATUSES = ["pending", "in_progress", "completed", "blocked"];
export const WORKFLOW_AUDIT_TASK_STATUSES = [...WORKFLOW_TASK_STATUSES, "superseded"];
export const WORKFLOW_REVISION_STATUSES = ["requested", "applied"];

export function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}不能为空`);
  }
  return value.trim();
}

function workflowError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function normalizeExecutor(value) {
  const executor = value === undefined ? "local" : value;
  if (executor === "runtime") {
    throw workflowError("WORKFLOW_EXECUTOR_RETIRED", "Runtime 工作流执行器已退役；不能恢复或执行旧工作流");
  }
  if (!WORKFLOW_EXECUTORS.includes(executor)) {
    throw workflowError("WORKFLOW_EXECUTOR_INVALID", `工作流执行器无效：${executor}`);
  }
  return executor;
}

export function normalizeDelegation(delegation) {
  if (delegation === undefined) return undefined;
  if (!delegation || typeof delegation !== "object") {
    throw new Error("工作流 delegation 格式无效");
  }
  if (!WORKFLOW_DELEGATION_STATUSES.includes(delegation.status)) {
    throw new Error(`工作流 delegation 状态无效：${delegation.status}`);
  }

  const result = { status: delegation.status };
  for (const field of ["requestId", "agentId", "type", "reason"]) {
    if (delegation[field] !== undefined) {
      result[field] = requireText(delegation[field], `工作流 delegation 的 ${field}`);
    }
  }
  for (const field of ["createdAt", "startedAt", "stopRequestedAt", "completedAt"]) {
    if (delegation[field] !== undefined) {
      if (!Number.isFinite(delegation[field])) {
        throw new Error(`工作流 delegation 的 ${field} 无效`);
      }
      result[field] = delegation[field];
    }
  }
  return result;
}

export function normalizeTextList(value, label, { required = false } = {}) {
  if (value === undefined) {
    if (required) throw new Error(`${label}不能为空`);
    return [];
  }
  if (!Array.isArray(value)) throw new Error(`${label}必须是字符串数组`);

  const result = value.map((item, index) => requireText(item, `${label}[${index}]`));
  if (required && result.length === 0) throw new Error(`${label}不能为空`);
  return [...new Set(result)];
}

export function normalizeTimestamp(value, label) {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) throw new Error(`${label}无效`);
  return value;
}

export function requireTimestamp(value, label) {
  const timestamp = normalizeTimestamp(value, label);
  if (timestamp === undefined) throw new Error(`${label}不能为空`);
  return timestamp;
}

export function normalizeRevisionId(value, label) {
  const id = requireText(value, label);
  if (id.length > 128) throw new Error(`${label}过长`);
  return id;
}

export function normalizeIdentityToken(value, label) {
  const token = requireText(value, label);
  if (token.length > 128) throw new Error(`${label}过长`);
  return token;
}

export function normalizePlanVersion(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必须是非负安全整数`);
  return value;
}

export function normalizeWorkflowHandoff(value) {
  if (!value || typeof value !== "object") throw new Error("已保存的工作流 handoff 格式无效");
  if (!WORKFLOW_HANDOFF_PHASES.includes(value.phase)) {
    throw new Error(`已保存的工作流 handoff 阶段无效：${value.phase}`);
  }
  return {
    workflowId: normalizeIdentityToken(value.workflowId, "工作流 handoff 的 workflowId"),
    planVersion: normalizePlanVersion(value.planVersion, "工作流 handoff 的 planVersion"),
    taskId: requireText(value.taskId, "工作流 handoff 的 taskId").toLowerCase(),
    attemptId: normalizeIdentityToken(value.attemptId, "工作流 handoff 的 attemptId"),
    handoffId: normalizeIdentityToken(value.handoffId, "工作流 handoff 的 handoffId"),
    sessionId: normalizeIdentityToken(value.sessionId, "工作流 handoff 的 sessionId"),
    recoveryGeneration: normalizePlanVersion(value.recoveryGeneration, "工作流 handoff 的 recoveryGeneration"),
    phase: value.phase,
    createdAt: requireTimestamp(value.createdAt, "工作流 handoff 的 createdAt"),
    ...(value.startedAt !== undefined ? { startedAt: requireTimestamp(value.startedAt, "工作流 handoff 的 startedAt") } : {}),
  };
}

export function normalizeWorkflowContinuation(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || !WORKFLOW_CONTINUATION_KINDS.includes(value.kind)) {
    throw new Error("已保存的工作流 continuation 格式无效");
  }
  if (value.kind === "review") return { kind: "review" };
  const result = { kind: value.kind };
  if (value.reason !== undefined) {
    if (!["plan-created", "task-completed", "replan-applied", "retry", "resume", "replan-requested"].includes(value.reason)) {
      throw new Error(`已保存的工作流 continuation reason 无效：${value.reason}`);
    }
    result.reason = value.reason;
  }
  if (value.kind === "replan") {
    result.revisionId = normalizeRevisionId(value.revisionId, "工作流 continuation 的 revisionId");
    if (value.handoffId !== undefined) {
      result.handoffId = normalizeIdentityToken(value.handoffId, "工作流 continuation 的 handoffId");
    }
  }
  const phase = value.phase ?? "pending";
  if (!(["pending", "compacting", "dispatching", "queued"].includes(phase))) {
    throw new Error(`已保存的工作流 continuation 阶段无效：${phase}`);
  }
  result.phase = phase;
  return result;
}

export function normalizeTaskIds(value, label) {
  return normalizeTextList(value, label).map((taskId) => {
    const id = taskId.toLowerCase();
    if (!TASK_ID_PATTERN.test(id)) {
      throw new Error(`${label}中的任务 ID 无效：${taskId}`);
    }
    return id;
  });
}

export function cloneTask(task) {
  return {
    ...task,
    files: [...task.files],
    acceptanceCriteria: [...task.acceptanceCriteria],
    dependsOn: [...task.dependsOn],
    ...(task.verification ? { verification: [...task.verification] } : {}),
    ...(task.delegation ? { delegation: { ...task.delegation } } : {}),
  };
}

export function validateWorkflowExecutionRoles(tasks, { unfinishedOnly = false } = {}) {
  if (!Array.isArray(tasks)) {
    return { ok: false, code: "WORKFLOW_TASK_ROLE_LIST_INVALID", message: "工作流任务角色列表必须是数组" };
  }
  for (const task of tasks) {
    if (unfinishedOnly && ["completed", "superseded"].includes(task?.status)) continue;
    const taskId = typeof task?.id === "string" ? task.id.slice(0, 64) : "未知任务";
    const role = typeof task?.role === "string" ? task.role.slice(0, 64) : undefined;
    if (!isValidRoleId(task?.role)) {
      return {
        ok: false,
        code: "WORKFLOW_TASK_ROLE_INVALID",
        message: `工作流任务 ${taskId} 的执行角色无效；不会自动猜测或替换角色`,
        taskId,
        role,
      };
    }
    if (task.role === "architect") {
      return {
        ok: false,
        code: "WORKFLOW_EXECUTION_ROLE_FORBIDDEN",
        message: `工作流任务 ${taskId} 将 architect 分配为执行角色；architect 只负责规划，不得执行或验收任务`,
        taskId,
        role,
      };
    }
  }
  return { ok: true };
}

export function assertWorkflowExecutionRoles(tasks, options) {
  const result = validateWorkflowExecutionRoles(tasks, options);
  if (!result.ok) {
    const diagnostic = {
      code: result.code,
      message: result.message,
      taskId: result.taskId,
      role: result.role,
      nextAction: "改用 developer-test 或 docs-commit 作为执行角色；不要自动重命名已有任务",
    };
    throw Object.assign(new Error(`[PI-INIT_WORKFLOW_ERROR] ${JSON.stringify(diagnostic)}`), {
      code: result.code,
      details: diagnostic,
    });
  }
}

export function normalizeTask(task, index) {
  if (!task || typeof task !== "object") {
    throw new Error(`工作流任务 ${index + 1} 格式无效`);
  }

  const id = requireText(task.id, `工作流任务 ${index + 1} 的 id`).toLowerCase();
  if (!TASK_ID_PATTERN.test(id)) {
    throw new Error(`工作流任务 ${id} 的 id 必须是小写字母、数字、点、下划线或连字符`);
  }

  const role = normalizeRoleId(task.role ?? "developer-test", `工作流任务 ${id} 的 role `);
  assertWorkflowExecutionRoles([{ id, role, status: "pending" }]);

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

export function assertAcyclic(tasks) {
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

export function clonePlan(plan) {
  return {
    summary: plan.summary,
    constraints: [...(plan.constraints ?? [])],
  };
}

export function cloneRevision(revision) {
  return {
    ...revision,
    ...(revision.retainedTaskIds ? { retainedTaskIds: [...revision.retainedTaskIds] } : {}),
    ...(revision.replacedTaskIds ? { replacedTaskIds: [...revision.replacedTaskIds] } : {}),
    ...(revision.addedTaskIds ? { addedTaskIds: [...revision.addedTaskIds] } : {}),
    ...(revision.previousPlan ? { previousPlan: clonePlan(revision.previousPlan) } : {}),
    ...(revision.previousTasks ? { previousTasks: revision.previousTasks.map(cloneTask) } : {}),
    ...(revision.replacedTasks ? { replacedTasks: revision.replacedTasks.map(cloneTask) } : {}),
    ...(revision.newPlan
      ? {
          newPlan: {
            ...clonePlan(revision.newPlan),
            tasks: revision.newPlan.tasks.map(cloneTask),
          },
        }
      : {}),
  };
}

export function normalizePlanSnapshot(value, label) {
  if (!value || typeof value !== "object") throw new Error(`${label}格式无效`);
  return {
    summary: requireText(value.summary, `${label}摘要`),
    constraints: normalizeTextList(value.constraints, `${label}约束`),
  };
}

export function normalizePendingRevision(revision) {
  if (!revision || typeof revision !== "object") {
    throw new Error("已保存的工作流 pendingRevision 格式无效");
  }
  const result = {
    revisionId: normalizeRevisionId(revision.revisionId, "已保存的工作流 pendingRevision 的 revisionId"),
    direction: requireText(revision.direction, "已保存的工作流 pendingRevision 的 direction"),
    requestedAt: requireTimestamp(revision.requestedAt, "已保存的工作流 pendingRevision 的 requestedAt"),
  };
  if (revision.requestedFromTaskId !== undefined) {
    result.requestedFromTaskId = requireText(
      revision.requestedFromTaskId,
      "已保存的工作流 pendingRevision 的 requestedFromTaskId",
    ).toLowerCase();
  }
  return result;
}

export function createWorkflowState(input, now = Date.now()) {
  const plan = validateWorkflowPlan(input);
  const executor = normalizeExecutor(input.executor);
  const workflowId = normalizeIdentityToken(input.workflowId ?? randomUUID(), "工作流 workflowId");
  const sessionId = normalizeIdentityToken(input.sessionId, "工作流 sessionId");
  return {
    version: WORKFLOW_STATE_VERSION,
    workflowId,
    sessionId,
    planVersion: 0,
    recoveryGeneration: 0,
    executor,
    authority: executor,
    status: plan.reviewRequired ? "paused" : "running",
    pauseReason: plan.reviewRequired ? "architecture-review" : undefined,
    continuation: plan.reviewRequired ? { kind: "review" } : { kind: "schedule", phase: "pending", reason: "plan-created" },
    plan: {
      summary: plan.summary,
      constraints: plan.constraints,
    },
    tasks: plan.tasks,
    currentTaskId: undefined,
    nudgeCount: 0,
    revisions: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function getWorkflowTask(state, taskId) {
  return state?.tasks?.find((task) => task.id === taskId);
}

function taskTimestampRange(state, field, reducer, initialValue) {
  return (state?.tasks ?? [])
    .map((task) => task[field])
    .filter((value) => Number.isFinite(value))
    .reduce(reducer, initialValue);
}

export function getWorkflowExecutionBounds(state) {
  if (!state || typeof state !== "object") {
    return { startedAt: undefined, completedAt: undefined };
  }

  const startedAt = state.startedAt === undefined
    ? taskTimestampRange(state, "startedAt", (earliest, value) => Math.min(earliest, value), Infinity)
    : Number.isFinite(state.startedAt)
      ? state.startedAt
      : undefined;
  const completedAt = state.completedAt === undefined
    ? taskTimestampRange(state, "completedAt", (latest, value) => Math.max(latest, value), -Infinity)
    : Number.isFinite(state.completedAt)
      ? state.completedAt
      : undefined;

  return {
    startedAt: Number.isFinite(startedAt) ? startedAt : undefined,
    completedAt: Number.isFinite(completedAt) ? completedAt : undefined,
  };
}

export function getWorkflowExecutionDuration(state) {
  const { startedAt, completedAt } = getWorkflowExecutionBounds(state);
  if (startedAt === undefined || completedAt === undefined || completedAt < startedAt) return undefined;
  return completedAt - startedAt;
}

export function cloneState(state, now = Date.now()) {
  if (Object.prototype.hasOwnProperty.call(state, "runtimeAuthority")) {
    throw workflowError("WORKFLOW_STATE_RUNTIME_RETIRED", "旧 Runtime 工作流 authority 已退役；不能克隆或本地执行");
  }
  const executor = normalizeExecutor(state.executor);
  const authority = normalizeExecutor(
    Object.prototype.hasOwnProperty.call(state, "authority") ? state.authority : executor,
  );
  if (authority !== executor) throw new Error("工作流 authority 不允许在创建后切换");
  return {
    ...state,
    version: WORKFLOW_STATE_VERSION,
    planVersion: state.planVersion ?? 0,
    recoveryGeneration: state.recoveryGeneration ?? 0,
    executor,
    authority,
    plan: clonePlan(state.plan),
    tasks: state.tasks.map(cloneTask),
    revisions: (state.revisions ?? []).map(cloneRevision),
    ...(state.pendingRevision ? { pendingRevision: { ...state.pendingRevision } } : {}),
    ...(state.handoff ? { handoff: { ...state.handoff } } : {}),
    ...(state.continuation ? { continuation: { ...state.continuation } } : {}),
    updatedAt: now,
  };
}
