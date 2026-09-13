import { normalizeRoleId } from "./roles.js";

export const WORKFLOW_STATE_VERSION = 3;
export const WORKFLOW_MAX_TASKS = 12;
export const WORKFLOW_MAX_NUDGES = 2;
export const WORKFLOW_EXECUTORS = ["local", "subtask", "collaboration", "runtime"];
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

export function normalizeExecutor(value) {
  // Legacy "subagents" (pi-subagents RPC) maps to the "subtask" executor.
  const executor = value === "subagents" ? "subtask" : value ?? "local";
  if (!WORKFLOW_EXECUTORS.includes(executor)) {
    throw new Error(`工作流执行器无效：${executor}`);
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

export function normalizeTask(task, index) {
  if (!task || typeof task !== "object") {
    throw new Error(`工作流任务 ${index + 1} 格式无效`);
  }

  const id = requireText(task.id, `工作流任务 ${index + 1} 的 id`).toLowerCase();
  if (!TASK_ID_PATTERN.test(id)) {
    throw new Error(`工作流任务 ${id} 的 id 必须是小写字母、数字、点、下划线或连字符`);
  }

  const role = normalizeRoleId(task.role ?? "developer-test", `工作流任务 ${id} 的 role `);

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

function runtimeProjectionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function eventIdOf(event) {
  const value = event?.payload?.header?.event_id ?? event?.event_id;
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function eventGraphRevisionOf(event) {
  return event?.payload?.header?.graph_revision;
}

export function eventResults(events) {
  const results = new Map();
  for (const event of events) {
    if (event?.event === "result_accepted" && event.payload?.result?.task_id) {
      results.set(event.payload.result.task_id, event.payload.result);
    }
  }
  return results;
}

export function projectRuntimeState(workflow, remote, events) {
  const authority = workflow?.runtimeAuthority;
  const revision = remote?.graph_revision;
  if (!authority || authority.kind !== "runtime") {
    throw runtimeProjectionError("state_mismatch", "Runtime workflow authority is missing");
  }
  if (revision?.graph_id !== authority.graphRevision.graphId || revision?.revision !== authority.graphRevision.revision) {
    throw runtimeProjectionError("revision_mismatch", "Runtime returned a different graph revision");
  }
  if (!Array.isArray(remote.tasks) || remote.tasks.length !== workflow.tasks.length) {
    throw runtimeProjectionError("state_mismatch", "Runtime task set does not match the frozen workflow plan");
  }
  const remoteTasks = new Map(remote.tasks.map((task) => [task.task_id, task.state]));
  const results = eventResults(events);
  const next = cloneState(workflow);
  let runningTaskId;
  let failed = false;
  let cancelled = false;
  for (const task of next.tasks) {
    const remoteState = remoteTasks.get(task.id);
    if (!remoteState) throw runtimeProjectionError("state_mismatch", `Runtime task ${task.id} is missing`);
    if (task.status === "completed" && remoteState !== "succeeded") {
      throw runtimeProjectionError("state_regression", `Runtime task ${task.id} regressed after completion`);
    }
    if (["pending", "ready"].includes(remoteState)) {
      task.status = "pending";
      delete task.currentTaskId;
    } else if (remoteState === "running") {
      task.status = "in_progress";
      runningTaskId = task.id;
    } else if (remoteState === "succeeded") {
      const result = results.get(task.id);
      task.status = "completed";
      task.completionSummary = result?.output || "Runtime acceptance gate accepted the task result";
      task.implementationRationale = "Runtime is the sole workflow authority; completion came from ResultAccepted";
      task.verification = ["Runtime ResultAccepted event observed"];
      delete task.blockReason;
      task.completedAt = Date.now();
    } else if (["failed", "blocked"].includes(remoteState)) {
      task.status = "blocked";
      task.blockReason = results.get(task.id)?.diagnostics || `Runtime task entered ${remoteState}`;
      failed = true;
    } else if (["cancelled", "timed_out"].includes(remoteState)) {
      task.status = "blocked";
      task.blockReason = `Runtime task entered ${remoteState}`;
      cancelled = true;
    } else {
      throw runtimeProjectionError("state_mismatch", `Runtime returned unknown task state ${remoteState}`);
    }
  }
  next.currentTaskId = runningTaskId;
  if (cancelled) {
    next.status = "cancelled";
    next.pauseReason = "runtime-cancelled";
    delete next.currentTaskId;
  } else if (failed) {
    next.status = "paused";
    next.pauseReason = "runtime-task-failed";
    delete next.currentTaskId;
  } else if (next.tasks.every((task) => task.status === "completed")) {
    next.status = "completed";
    next.completedAt = Date.now();
    delete next.currentTaskId;
  } else {
    next.status = "running";
    delete next.pauseReason;
  }
  next.runtimeAuthority.status = next.status === "completed" ? "completed" : next.status === "running" ? "running" : next.status;
  return next;
}

export function eventCursor(events, current, authority) {
  let cursor = current;
  for (const event of events) {
    const revision = eventGraphRevisionOf(event);
    if (revision && (revision.graph_id !== authority.graphRevision.graphId || revision.revision !== authority.graphRevision.revision)) {
      throw runtimeProjectionError("revision_mismatch", "Runtime event belongs to another graph revision");
    }
    const id = eventIdOf(event);
    if (id === undefined) throw runtimeProjectionError("invalid_event", "Runtime event has no positive event_id");
    if (id <= cursor) continue;
    cursor = id;
  }
  return cursor;
}

export function createWorkflowState(input, now = Date.now()) {
  const plan = validateWorkflowPlan(input);
  const executor = normalizeExecutor(input.executor);
  return {
    version: WORKFLOW_STATE_VERSION,
    executor,
    authority: executor,
    status: plan.reviewRequired ? "paused" : "running",
    pauseReason: plan.reviewRequired ? "architecture-review" : undefined,
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

export function cloneRuntimeAuthority(authority) {
  if (!authority || typeof authority !== "object") return undefined;
  return {
    ...authority,
    ...(authority.graphRevision ? { graphRevision: { ...authority.graphRevision } } : {}),
    ...(authority.graph
      ? {
          graph: {
            ...authority.graph,
            graph_revision: authority.graph.graph_revision
              ? { ...authority.graph.graph_revision }
              : authority.graph.graph_revision,
            profile_snapshot: authority.graph.profile_snapshot
              ? { ...authority.graph.profile_snapshot }
              : authority.graph.profile_snapshot,
            tasks: Array.isArray(authority.graph.tasks)
              ? authority.graph.tasks.map((task) => ({
                  ...task,
                  dependencies: [...(task.dependencies ?? [])],
                  acceptance_criteria: [...(task.acceptance_criteria ?? [])],
                  ...(task.profile_snapshot
                    ? { profile_snapshot: { ...task.profile_snapshot } }
                    : {}),
                }))
              : authority.graph.tasks,
          },
        }
      : {}),
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
  const executor = normalizeExecutor(state.executor);
  const authority = normalizeExecutor(state.authority ?? executor);
  if (authority !== executor) throw new Error("工作流 authority 不允许在创建后切换");
  return {
    ...state,
    version: WORKFLOW_STATE_VERSION,
    executor,
    authority,
    ...(state.runtimeAuthority
      ? { runtimeAuthority: cloneRuntimeAuthority(state.runtimeAuthority) }
      : {}),
    plan: clonePlan(state.plan),
    tasks: state.tasks.map(cloneTask),
    revisions: (state.revisions ?? []).map(cloneRevision),
    ...(state.pendingRevision ? { pendingRevision: { ...state.pendingRevision } } : {}),
    updatedAt: now,
  };
}
