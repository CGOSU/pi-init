import { randomUUID } from "node:crypto";
import { isValidRoleId, normalizeRoleId, unwrapRoleResult } from "./roles.ts";
import type {
  WorkflowContinuation, WorkflowContinuationPhase, WorkflowContinuationReason, WorkflowExecutionBounds,
  WorkflowExecutor, WorkflowHandoff, WorkflowHandoffPhase, WorkflowModelError,
  WorkflowPendingRevision, WorkflowPlan, WorkflowPlanSnapshot, WorkflowPlanSummary, WorkflowRevision,
  WorkflowRevisionStatus, WorkflowRoleValidationOptions, WorkflowRoleValidationResult, WorkflowState,
  WorkflowStatus, WorkflowTask, WorkflowTaskDelegation, WorkflowTaskStatus, WorkflowTaskTimestampField,
  WorkflowTaskTimestampReducer, WorkflowTextListOptions,
} from "./workflow-types.ts";

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
] as const satisfies readonly WorkflowHandoffPhase[];
export const WORKFLOW_CONTINUATION_KINDS = ["schedule", "replan", "review"] as const;
export const WORKFLOW_MAX_NUDGES = 2;
export const WORKFLOW_EXECUTORS = ["local"] as const satisfies readonly WorkflowExecutor[];
export const WORKFLOW_DELEGATION_STATUSES = [
  "spawning",
  "running",
  "stop-requested",
  "completed",
  "failed",
] as const satisfies readonly WorkflowTaskDelegation["status"][];

export const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const WORKFLOW_STATUSES = ["running", "paused", "replanning", "completed", "cancelled"] as const satisfies readonly WorkflowStatus[];
export const WORKFLOW_TASK_STATUSES = ["pending", "in_progress", "completed", "blocked"] as const satisfies readonly WorkflowTaskStatus[];
export const WORKFLOW_AUDIT_TASK_STATUSES = [...WORKFLOW_TASK_STATUSES, "superseded"] as const satisfies readonly WorkflowTaskStatus[];
export const WORKFLOW_REVISION_STATUSES = ["requested", "applied"] as const satisfies readonly WorkflowRevisionStatus[];

function isOneOf<const Values extends readonly string[]>(values: Values, value: unknown): value is Values[number] {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}不能为空`);
  }
  return value.trim();
}

function workflowError(code: string, message: string): WorkflowModelError {
  return Object.assign(new Error(message), { code });
}

export function normalizeExecutor(value: unknown): WorkflowExecutor {
  const executor = value === undefined ? "local" : value;
  if (executor === "runtime") {
    throw workflowError("WORKFLOW_EXECUTOR_RETIRED", "Runtime 工作流执行器已退役；不能恢复或执行旧工作流");
  }
  if (!isOneOf(WORKFLOW_EXECUTORS, executor)) {
    throw workflowError("WORKFLOW_EXECUTOR_INVALID", `工作流执行器无效：${executor}`);
  }
  return executor;
}

export function normalizeDelegation(delegation: unknown): WorkflowTaskDelegation | undefined {
  if (delegation === undefined) return undefined;
  const source = requireRecord(delegation, "工作流 delegation 格式无效");
  if (!isOneOf(WORKFLOW_DELEGATION_STATUSES, source.status)) {
    throw new Error(`工作流 delegation 状态无效：${source.status}`);
  }

  const result: WorkflowTaskDelegation = { status: source.status };
  for (const field of ["requestId", "agentId", "type", "reason"] as const) {
    const value = source[field];
    if (value !== undefined) result[field] = requireText(value, `工作流 delegation 的 ${field}`);
  }
  for (const field of ["createdAt", "startedAt", "stopRequestedAt", "completedAt"] as const) {
    const value = source[field];
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`工作流 delegation 的 ${field} 无效`);
      result[field] = value;
    }
  }
  return result;
}

export function normalizeTextList(value: unknown, label: string, { required = false }: WorkflowTextListOptions = {}): string[] {
  if (value === undefined) {
    if (required) throw new Error(`${label}不能为空`);
    return [];
  }
  if (!isUnknownArray(value)) throw new Error(`${label}必须是字符串数组`);

  const result = value.map((item, index) => requireText(item, `${label}[${index}]`));
  if (required && result.length === 0) throw new Error(`${label}不能为空`);
  return [...new Set(result)];
}

export function normalizeTimestamp(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}无效`);
  return value;
}

export function requireTimestamp(value: unknown, label: string): number {
  const timestamp = normalizeTimestamp(value, label);
  if (timestamp === undefined) throw new Error(`${label}不能为空`);
  return timestamp;
}

export function normalizeRevisionId(value: unknown, label: string): string {
  const id = requireText(value, label);
  if (id.length > 128) throw new Error(`${label}过长`);
  return id;
}

export function normalizeIdentityToken(value: unknown, label: string): string {
  const token = requireText(value, label);
  if (token.length > 128) throw new Error(`${label}过长`);
  return token;
}

export function normalizePlanVersion(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必须是非负安全整数`);
  return value;
}

export function normalizeWorkflowHandoff(value: unknown): WorkflowHandoff {
  const source = requireRecord(value, "已保存的工作流 handoff 格式无效");
  if (!isOneOf(WORKFLOW_HANDOFF_PHASES, source.phase)) {
    throw new Error(`已保存的工作流 handoff 阶段无效：${source.phase}`);
  }
  return {
    workflowId: normalizeIdentityToken(source.workflowId, "工作流 handoff 的 workflowId"),
    planVersion: normalizePlanVersion(source.planVersion, "工作流 handoff 的 planVersion"),
    taskId: requireText(source.taskId, "工作流 handoff 的 taskId").toLowerCase(),
    attemptId: normalizeIdentityToken(source.attemptId, "工作流 handoff 的 attemptId"),
    handoffId: normalizeIdentityToken(source.handoffId, "工作流 handoff 的 handoffId"),
    sessionId: normalizeIdentityToken(source.sessionId, "工作流 handoff 的 sessionId"),
    recoveryGeneration: normalizePlanVersion(source.recoveryGeneration, "工作流 handoff 的 recoveryGeneration"),
    phase: source.phase,
    createdAt: requireTimestamp(source.createdAt, "工作流 handoff 的 createdAt"),
    ...(source.startedAt !== undefined ? { startedAt: requireTimestamp(source.startedAt, "工作流 handoff 的 startedAt") } : {}),
  };
}

export function normalizeWorkflowContinuation(value: unknown): WorkflowContinuation | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isOneOf(WORKFLOW_CONTINUATION_KINDS, value.kind)) {
    throw new Error("已保存的工作流 continuation 格式无效");
  }
  if (value.kind === "review") return { kind: "review" };
  const reasons = ["plan-created", "task-completed", "replan-applied", "retry", "resume", "replan-requested"] as const satisfies readonly WorkflowContinuationReason[];
  const reason = value.reason;
  if (reason !== undefined && !isOneOf(reasons, reason)) {
    throw new Error(`已保存的工作流 continuation reason 无效：${reason}`);
  }
  const phases = ["pending", "compacting", "dispatching", "queued"] as const satisfies readonly WorkflowContinuationPhase[];
  const phase = value.phase ?? "pending";
  if (!(isOneOf(phases, phase))) {
    throw new Error(`已保存的工作流 continuation 阶段无效：${phase}`);
  }
  if (value.kind === "schedule") return { kind: "schedule", phase, ...(reason !== undefined ? { reason } : {}) };
  return {
    kind: "replan",
    revisionId: normalizeRevisionId(value.revisionId, "工作流 continuation 的 revisionId"),
    ...(value.handoffId !== undefined
      ? { handoffId: normalizeIdentityToken(value.handoffId, "工作流 continuation 的 handoffId") }
      : {}),
    phase,
    ...(reason !== undefined ? { reason } : {}),
  };
}

export function normalizeTaskIds(value: unknown, label: string): string[] {
  return normalizeTextList(value, label).map((taskId) => {
    const id = taskId.toLowerCase();
    if (!TASK_ID_PATTERN.test(id)) {
      throw new Error(`${label}中的任务 ID 无效：${taskId}`);
    }
    return id;
  });
}

export function cloneTask(task: WorkflowTask): WorkflowTask {
  return {
    ...task,
    files: [...task.files],
    acceptanceCriteria: [...task.acceptanceCriteria],
    dependsOn: [...task.dependsOn],
    ...(task.verification ? { verification: [...task.verification] } : {}),
    ...(task.delegation ? { delegation: { ...task.delegation } } : {}),
  };
}

export function validateWorkflowExecutionRoles(
  tasks: unknown,
  { unfinishedOnly = false }: WorkflowRoleValidationOptions = {},
): WorkflowRoleValidationResult {
  if (!isUnknownArray(tasks)) {
    return { ok: false, code: "WORKFLOW_TASK_ROLE_LIST_INVALID", message: "工作流任务角色列表必须是数组" };
  }
  for (const task of tasks) {
    const source = isRecord(task) ? task : {};
    if (unfinishedOnly && (source.status === "completed" || source.status === "superseded")) continue;
    const taskId = typeof source.id === "string" ? source.id.slice(0, 64) : "未知任务";
    const role = typeof source.role === "string" ? source.role.slice(0, 64) : undefined;
    if (!isValidRoleId(source.role)) {
      return {
        ok: false,
        code: "WORKFLOW_TASK_ROLE_INVALID",
        message: `工作流任务 ${taskId} 的执行角色无效；不会自动猜测或替换角色`,
        taskId,
        role,
      };
    }
    if (source.role === "architect") {
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

export function assertWorkflowExecutionRoles(tasks: unknown, options?: WorkflowRoleValidationOptions): void {
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

export function normalizeTask(task: unknown, index = 0): WorkflowTask {
  const source = requireRecord(task, `工作流任务 ${index + 1} 格式无效`);
  const id = requireText(source.id, `工作流任务 ${index + 1} 的 id`).toLowerCase();
  if (!TASK_ID_PATTERN.test(id)) {
    throw new Error(`工作流任务 ${id} 的 id 必须是小写字母、数字、点、下划线或连字符`);
  }

  const role = unwrapRoleResult(normalizeRoleId(source.role ?? "developer-test", `工作流任务 ${id} 的 role `));
  assertWorkflowExecutionRoles([{ id, role, status: "pending" }]);

  const files = normalizeTextList(source.files, `工作流任务 ${id} 的 files`, { required: true });
  const acceptanceCriteria = normalizeTextList(
    source.acceptanceCriteria ?? source.acceptance,
    `工作流任务 ${id} 的 acceptanceCriteria`,
    { required: true },
  );
  const dependsOn = normalizeTextList(source.dependsOn, `工作流任务 ${id} 的 dependsOn`);

  return {
    id,
    task: requireText(source.task, `工作流任务 ${id} 的 task`),
    role,
    files,
    acceptanceCriteria,
    dependsOn,
    status: "pending",
  };
}

export function assertAcyclic(tasks: WorkflowTask[]): void {
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
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) throw new Error(`工作流任务依赖存在循环：${taskId}`);

    visiting.add(taskId);
    const task = taskMap.get(taskId);
    if (!task) return;
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const task of tasks) visit(task.id);
}

export function validateWorkflowPlan(input: unknown): WorkflowPlan {
  const source = requireRecord(input, "工作流规划格式无效");
  const rawTasks = source.tasks;
  if (!isUnknownArray(rawTasks) || rawTasks.length === 0) {
    throw new Error("工作流至少需要一个任务");
  }
  if (rawTasks.length > WORKFLOW_MAX_TASKS) {
    throw new Error(`工作流最多支持 ${WORKFLOW_MAX_TASKS} 个任务`);
  }

  const tasks = rawTasks.map((task, index) => normalizeTask(task, index));
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`工作流任务 id 重复：${task.id}`);
    ids.add(task.id);
  }
  assertAcyclic(tasks);

  return {
    summary: requireText(source.summary, "工作流规划摘要"),
    constraints: normalizeTextList(source.constraints, "工作流约束"),
    tasks,
    reviewRequired: source.reviewRequired === true,
  };
}

export function clonePlan(plan: WorkflowPlanSummary | WorkflowPlanSnapshot): WorkflowPlanSummary {
  return {
    summary: plan.summary,
    constraints: [...(plan.constraints ?? [])],
  };
}

export function cloneRevision(revision: WorkflowRevision): WorkflowRevision {
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

export function normalizePlanSnapshot(value: unknown, label: string): WorkflowPlanSummary {
  const source = requireRecord(value, `${label}格式无效`);
  return {
    summary: requireText(source.summary, `${label}摘要`),
    constraints: normalizeTextList(source.constraints, `${label}约束`),
  };
}

export function normalizePendingRevision(revision: unknown): WorkflowPendingRevision {
  const source = requireRecord(revision, "已保存的工作流 pendingRevision 格式无效");
  const result: WorkflowPendingRevision = {
    revisionId: normalizeRevisionId(source.revisionId, "已保存的工作流 pendingRevision 的 revisionId"),
    direction: requireText(source.direction, "已保存的工作流 pendingRevision 的 direction"),
    requestedAt: requireTimestamp(source.requestedAt, "已保存的工作流 pendingRevision 的 requestedAt"),
  };
  if (source.requestedFromTaskId !== undefined) {
    result.requestedFromTaskId = requireText(
      source.requestedFromTaskId,
      "已保存的工作流 pendingRevision 的 requestedFromTaskId",
    ).toLowerCase();
  }
  return result;
}

export function createWorkflowState(input: unknown, now = Date.now()): WorkflowState {
  const plan = validateWorkflowPlan(input);
  const source = requireRecord(input, "工作流规划格式无效");
  const executor = normalizeExecutor(source.executor);
  const workflowId = normalizeIdentityToken(source.workflowId ?? randomUUID(), "工作流 workflowId");
  const sessionId = normalizeIdentityToken(source.sessionId, "工作流 sessionId");
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

export function getWorkflowTask(state: WorkflowState | null | undefined, taskId: string): WorkflowTask | undefined {
  return state?.tasks?.find((task) => task.id === taskId);
}

function taskTimestampRange(
  state: WorkflowState,
  field: WorkflowTaskTimestampField,
  reducer: WorkflowTaskTimestampReducer,
  initialValue: number,
): number {
  return (state?.tasks ?? [])
    .map((task) => task[field])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .reduce(reducer, initialValue);
}

export function getWorkflowExecutionBounds(state: WorkflowState | null | undefined): WorkflowExecutionBounds {
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

export function getWorkflowExecutionDuration(state: WorkflowState | null | undefined): number | undefined {
  const { startedAt, completedAt } = getWorkflowExecutionBounds(state);
  if (startedAt === undefined || completedAt === undefined || completedAt < startedAt) return undefined;
  return completedAt - startedAt;
}

export function cloneState(state: WorkflowState, now = Date.now()): WorkflowState {
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
