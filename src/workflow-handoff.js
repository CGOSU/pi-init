import { randomUUID } from "node:crypto";
import { cloneState } from "./workflow-model.js";

const TASK_MESSAGE_TYPE = "pi-init-workflow-task";
const REPLAN_MESSAGE_TYPE = "pi-init-workflow-replan";
const BASE_IDENTITY_FIELDS = ["workflowId", "planVersion", "sessionId", "recoveryGeneration"];

function failure(code, message) {
  return { ok: false, code, message };
}

function sameIdentity(actual, expected, fields) {
  return Boolean(actual && typeof actual === "object" && fields.every((field) => actual[field] === expected[field]));
}

function validateBaseIdentity(state, input, ctx) {
  if (!input || typeof input !== "object") return failure("WORKFLOW_ACTION_IDENTITY_MISSING", "工作流操作缺少执行身份");
  for (const field of BASE_IDENTITY_FIELDS) {
    if (input[field] === undefined || input[field] === null || input[field] === "") {
      return failure("WORKFLOW_ACTION_IDENTITY_MISSING", `工作流操作缺少 ${field}`);
    }
  }
  if (!Number.isSafeInteger(input.planVersion) || input.planVersion < 0
    || !Number.isSafeInteger(input.recoveryGeneration) || input.recoveryGeneration < 0) {
    return failure("WORKFLOW_ACTION_IDENTITY_INVALID", "工作流 planVersion 或 recoveryGeneration 格式无效");
  }
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  if (typeof sessionId !== "string" || !sessionId) {
    return failure("WORKFLOW_SESSION_ID_UNAVAILABLE", "无法从 Pi 公共 SessionManager 读取当前 sessionId");
  }
  if (input.sessionId !== sessionId || state?.sessionId !== sessionId) {
    return failure("WORKFLOW_SESSION_MISMATCH", "当前 Pi session 与工作流身份不匹配；不会应用旧 session 的结果");
  }
  if (!sameIdentity(input, state, BASE_IDENTITY_FIELDS)) {
    return failure("WORKFLOW_ACTION_IDENTITY_STALE", "工作流 workflowId、planVersion 或恢复代次已变化；请读取当前状态后重试");
  }
  return { ok: true, value: { workflowId: input.workflowId, planVersion: input.planVersion, sessionId, recoveryGeneration: input.recoveryGeneration } };
}

function activeBranchContains(ctx, customType, expected, fields) {
  const branch = ctx?.sessionManager?.getBranch?.();
  if (!Array.isArray(branch)) return false;
  return branch.some((entry) => entry.type === "custom_message"
    && entry.customType === customType
    && sameIdentity(entry.details, expected, fields));
}

export function workflowHandoffMessageOnBranch(ctx, identity) {
  return activeBranchContains(
    ctx,
    TASK_MESSAGE_TYPE,
    identity,
    [...BASE_IDENTITY_FIELDS, "taskId", "attemptId", "handoffId"],
  );
}

export function workflowHandoffIdentity(state) {
  if (!state?.handoff) return undefined;
  return {
    workflowId: state.handoff.workflowId,
    planVersion: state.handoff.planVersion,
    taskId: state.handoff.taskId,
    attemptId: state.handoff.attemptId,
    handoffId: state.handoff.handoffId,
    sessionId: state.handoff.sessionId,
    recoveryGeneration: state.handoff.recoveryGeneration,
  };
}

export function validateWorkflowMutationIdentity(state, input, ctx) {
  return validateBaseIdentity(state, input, ctx);
}

export function validateWorkflowHandoffIdentity(state, input, ctx) {
  const base = validateBaseIdentity(state, input, ctx);
  if (!base.ok) return base;
  const handoff = state?.handoff;
  if (!handoff || !state.currentTaskId) {
    return failure("WORKFLOW_HANDOFF_MISSING", "当前工作流没有可验收的任务交接");
  }
  const fields = [...BASE_IDENTITY_FIELDS, "taskId", "attemptId", "handoffId"];
  for (const field of ["taskId", "attemptId", "handoffId"]) {
    if (typeof input[field] !== "string" || !input[field].trim()) {
      return failure("WORKFLOW_ACTION_IDENTITY_MISSING", `工作流任务结果缺少 ${field}`);
    }
  }
  const expected = workflowHandoffIdentity(state);
  if (!sameIdentity(input, expected, fields)) {
    return failure("WORKFLOW_HANDOFF_STALE", "任务 attempt/handoff 身份已变化；拒绝旧任务结果");
  }
  if (handoff.phase !== "executing") {
    return failure("WORKFLOW_HANDOFF_NOT_EXECUTING", `任务尚未处于可验收的实际执行阶段（${handoff.phase}）`);
  }
  if (!activeBranchContains(ctx, TASK_MESSAGE_TYPE, expected, fields)) {
    return failure("WORKFLOW_HANDOFF_BRANCH_MISMATCH", "当前 session branch 不包含匹配的任务交接消息；拒绝旧分支回调");
  }
  return { ok: true, value: expected };
}

export function validateWorkflowReplanIdentity(state, input, ctx) {
  const base = validateBaseIdentity(state, input, ctx);
  if (!base.ok) return base;
  const continuation = state?.continuation;
  const revision = state?.pendingRevision;
  if (state?.status !== "replanning" || !revision || continuation?.kind !== "replan") {
    return failure("WORKFLOW_REPLAN_HANDOFF_MISSING", "当前没有可应用的重规划交接");
  }
  const fields = [...BASE_IDENTITY_FIELDS, "revisionId", "handoffId"];
  const expected = {
    ...base.value,
    revisionId: revision.revisionId,
    handoffId: continuation.handoffId,
  };
  for (const field of ["revisionId", "handoffId"]) {
    if (typeof input[field] !== "string" || !input[field].trim()) {
      return failure("WORKFLOW_ACTION_IDENTITY_MISSING", `工作流重规划结果缺少 ${field}`);
    }
  }
  if (!sameIdentity(input, expected, fields)) {
    return failure("WORKFLOW_REPLAN_STALE", "工作流 revision 或重规划交接身份已变化；拒绝旧结果");
  }
  if (!activeBranchContains(ctx, REPLAN_MESSAGE_TYPE, expected, fields)) {
    return failure("WORKFLOW_REPLAN_BRANCH_MISMATCH", "当前 session branch 不包含匹配的重规划消息");
  }
  return { ok: true, value: expected };
}

export function recoverWorkflowState(state, currentSessionId) {
  if (typeof currentSessionId !== "string" || !currentSessionId) {
    return failure("WORKFLOW_SESSION_ID_UNAVAILABLE", "无法从 Pi 公共 SessionManager 读取当前 sessionId");
  }
  const legacy = Number.isInteger(state?.legacySourceVersion);
  if (!legacy && state.sessionId !== currentSessionId) {
    return failure("WORKFLOW_SESSION_MISMATCH", "已保存的工作流属于其他 Pi session；不会恢复或重放");
  }

  if (!legacy && ["completed", "cancelled"].includes(state.status) && !state.handoff) {
    return { ok: true, value: state, changed: false };
  }

  const migrated = {
    ...state,
    workflowId: legacy ? randomUUID() : state.workflowId,
    sessionId: legacy ? currentSessionId : state.sessionId,
    planVersion: legacy
      ? (state.revisions ?? []).filter((revision) => revision.status === "applied").length
      : state.planVersion,
    recoveryGeneration: (state.recoveryGeneration ?? 0) + 1,
    version: 4,
  };
  delete migrated.legacySourceVersion;
  const currentTask = migrated.currentTaskId
    ? migrated.tasks.find((task) => task.id === migrated.currentTaskId)
    : undefined;
  const legacyInProgressTasks = legacy
    ? migrated.tasks.filter((task) => task.status === "in_progress")
    : [];

  if (legacy && legacyInProgressTasks.length > 0) {
    for (const task of legacyInProgressTasks) {
      task.status = "blocked";
      task.outcomeUnknown = true;
      task.blockReason = "旧工作流缺少 attempt/handoff 身份，无法确认任务是否产生副作用；核对后显式 retry";
    }
    migrated.status = "paused";
    migrated.pauseReason = "legacy-execution-outcome-unknown";
    migrated.taskPauseReason = `任务 ${legacyInProgressTasks.map((task) => task.id).join(", ")} 的旧执行结果未知`;
    migrated.currentTaskId = undefined;
    delete migrated.handoff;
    delete migrated.continuation;
  } else if (migrated.handoff) {
    const previousHandoff = migrated.handoff;
    const hasExecutionEvidence = currentTask?.outcomeUnknown === true
      || currentTask?.executionStartedAt !== undefined
      || currentTask?.startedAt !== undefined
      || previousHandoff.startedAt !== undefined;
    if (!hasExecutionEvidence && ["prepared", "waiting-role", "compacting"].includes(previousHandoff.phase)) {
      migrated.handoff = {
        ...previousHandoff,
        attemptId: randomUUID(),
        handoffId: randomUUID(),
        recoveryGeneration: migrated.recoveryGeneration,
        phase: "prepared",
        createdAt: Date.now(),
      };
    } else {
      if (!currentTask) return failure("WORKFLOW_HANDOFF_STATE_MISMATCH", "已保存 handoff 找不到当前任务");
      currentTask.status = "blocked";
      currentTask.outcomeUnknown = true;
      currentTask.blockReason = "任务交接已进入派发/执行阶段但没有业务验收结果；核对可能的副作用后显式 retry";
      migrated.status = "paused";
      migrated.pauseReason = "handoff-outcome-unknown";
      migrated.taskPauseReason = `任务 ${currentTask.id} 的执行结果未知`;
      migrated.currentTaskId = undefined;
      delete migrated.handoff;
      delete migrated.continuation;
      migrated.nudgeCount = 0;
    }
  } else if (migrated.continuation?.kind === "replan") {
    migrated.continuation = {
      ...migrated.continuation,
      phase: "pending",
      handoffId: randomUUID(),
    };
  }

  if (migrated.status === "running" && !migrated.currentTaskId && !migrated.continuation) {
    migrated.continuation = { kind: "schedule", phase: "pending" };
  }
  if (migrated.status === "paused" && migrated.pauseReason === "architecture-review") {
    migrated.continuation = { kind: "review" };
  }
  if (migrated.status === "replanning" && migrated.pendingRevision && !migrated.continuation) {
    migrated.continuation = {
      kind: "replan",
      revisionId: migrated.pendingRevision.revisionId,
      phase: "pending",
      handoffId: randomUUID(),
    };
  }

  return { ok: true, value: cloneState(migrated), changed: true };
}

export function ensureWorkflowReplanHandoff(state) {
  if (state?.status !== "replanning" || !state.pendingRevision) return undefined;
  if (state.continuation?.kind === "replan" && state.continuation.handoffId) return state;
  const next = cloneState(state);
  next.continuation = {
    kind: "replan",
    revisionId: state.pendingRevision.revisionId,
    handoffId: randomUUID(),
    phase: "pending",
  };
  return next;
}