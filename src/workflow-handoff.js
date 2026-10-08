import { randomUUID } from "node:crypto";
import { cloneState } from "./workflow-model.js";

const TASK_MESSAGE_TYPE = "pi-init-workflow-task";
const REPLAN_MESSAGE_TYPE = "pi-init-workflow-replan";
const BASE_IDENTITY_FIELDS = ["workflowId", "planVersion", "sessionId", "recoveryGeneration"];

function failure(code, message, details = {}) {
  return { ok: false, code, message, ...details };
}

function safeIdentityValues(source, fields) {
  const result = {};
  for (const field of fields) {
    if (!source || !Object.prototype.hasOwnProperty.call(source, field)) continue;
    const value = source[field];
    if (typeof value === "string") result[field] = value.length <= 256 ? value : `${value.slice(0, 256)}…`;
    else if (typeof value === "number" && Number.isFinite(value)) result[field] = value;
    else if (value === null) result[field] = null;
    else result[field] = `<${typeof value}>`;
  }
  return result;
}

function identityFailure(code, message, mismatchedFields, expected, received, nextAction) {
  return failure(code, message, {
    mismatchedFields,
    expected: safeIdentityValues(expected, [...new Set([...mismatchedFields, ...BASE_IDENTITY_FIELDS])]),
    received: safeIdentityValues(received, [...new Set([...mismatchedFields, ...BASE_IDENTITY_FIELDS])]),
    nextAction,
  });
}

function differingIdentityFields(actual, expected, fields) {
  return fields.filter((field) => actual?.[field] !== expected?.[field]);
}

function sameIdentity(actual, expected, fields) {
  return Boolean(actual && typeof actual === "object" && fields.every((field) => actual[field] === expected[field]));
}

function validateBaseIdentity(state, input, ctx) {
  if (!input || typeof input !== "object") {
    return failure("WORKFLOW_ACTION_IDENTITY_MISSING", "工作流操作缺少执行身份", {
      mismatchedFields: BASE_IDENTITY_FIELDS,
      expected: safeIdentityValues(state, BASE_IDENTITY_FIELDS),
      received: {},
      nextAction: "读取当前工作流状态；不要从旧任务文本或记忆中补造身份。",
    });
  }
  for (const field of BASE_IDENTITY_FIELDS) {
    if (input[field] === undefined || input[field] === null || input[field] === "") {
      return identityFailure(
        "WORKFLOW_ACTION_IDENTITY_MISSING",
        `工作流操作缺少 ${field}`,
        [field], state, input,
        "读取当前工作流状态，并只补齐当前动作实际需要的身份字段。",
      );
    }
  }
  for (const field of ["workflowId", "sessionId"]) {
    if (typeof input[field] !== "string") {
      return identityFailure(
        "WORKFLOW_ACTION_IDENTITY_INVALID",
        `工作流 ${field} 必须是非空字符串`,
        [field], state, input,
        "读取当前工作流状态，使用该字段的正确类型和值；不要转换或猜测身份。",
      );
    }
  }
  for (const field of ["planVersion", "recoveryGeneration"]) {
    if (!Number.isSafeInteger(input[field]) || input[field] < 0) {
      return identityFailure(
        "WORKFLOW_ACTION_IDENTITY_INVALID",
        `工作流 ${field} 必须是非负安全整数`,
        [field], state, input,
        "读取当前工作流状态，并使用原样数值；不要将无效值强制转换。",
      );
    }
  }
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  if (typeof sessionId !== "string" || !sessionId) {
    return failure("WORKFLOW_SESSION_ID_UNAVAILABLE", "无法从 Pi 公共 SessionManager 读取当前 sessionId", {
      mismatchedFields: ["sessionId"],
      received: safeIdentityValues(input, BASE_IDENTITY_FIELDS),
      nextAction: "停止提交，不得猜测 sessionId；等待当前 Pi session 提供有效身份。",
    });
  }
  if (input.sessionId !== sessionId || state?.sessionId !== sessionId) {
    return failure("WORKFLOW_SESSION_MISMATCH", "当前 Pi session 与工作流身份不匹配；不会应用旧 session 的结果", {
      mismatchedFields: [
        ...(input.sessionId !== sessionId ? ["sessionId"] : []),
        ...(state?.sessionId !== sessionId ? ["workflowSessionId"] : []),
      ],
      expected: { sessionId, workflowSessionId: safeIdentityValues(state, ["sessionId"]).sessionId },
      received: { sessionId: safeIdentityValues(input, ["sessionId"]).sessionId },
      nextAction: "不要将旧 session 的结果迁移到当前工作流；在拥有该工作流的 session 中处理，或重新规划。",
    });
  }
  const mismatchedFields = differingIdentityFields(input, state, BASE_IDENTITY_FIELDS);
  if (mismatchedFields.length > 0) {
    return identityFailure(
      "WORKFLOW_ACTION_IDENTITY_STALE",
      `工作流基础身份已变化：${mismatchedFields.join(", ")}`,
      mismatchedFields, state, input,
      "只读查询当前状态一次。仅当同一活动 handoff 仍有效且确认只是提交字段抄录错误时更正；attempt、handoff、branch 或 session 已变化时不得用新身份提交旧结果。未知结果先核对副作用，再显式授权 retry。",
    );
  }
  return { ok: true, value: workflowActionIdentity(state) };
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

/** @returns {import("./workflow-types.js").WorkflowActionIdentity | undefined} */
export function workflowActionIdentity(state) {
  if (!state) return undefined;
  return {
    workflowId: state.workflowId,
    planVersion: state.planVersion,
    sessionId: state.sessionId,
    recoveryGeneration: state.recoveryGeneration,
  };
}

/** @returns {import("./workflow-types.js").WorkflowHandoffIdentity | undefined} */
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

/** @returns {import("./workflow-types.js").WorkflowReplanIdentity | undefined} */
export function workflowReplanIdentity(state) {
  const continuation = state?.continuation;
  const revision = state?.pendingRevision;
  if (state?.status !== "replanning" || !revision || continuation?.kind !== "replan" || !continuation.handoffId) {
    return undefined;
  }
  const actionIdentity = workflowActionIdentity(state);
  if (!actionIdentity) return undefined;
  return {
    ...actionIdentity,
    revisionId: revision.revisionId,
    handoffId: continuation.handoffId,
  };
}

/** @returns {import("./workflow-types.js").WorkflowIdentityValidationResult<import("./workflow-types.js").WorkflowActionIdentity>} */
export function validateWorkflowMutationIdentity(state, input, ctx) {
  return validateBaseIdentity(state, input, ctx);
}

/** @returns {import("./workflow-types.js").WorkflowIdentityValidationResult<import("./workflow-types.js").WorkflowHandoffIdentity>} */
export function validateWorkflowHandoffIdentity(state, input, ctx, { allowQueued = false } = {}) {
  const base = validateBaseIdentity(state, input, ctx);
  if (!base.ok) return base;
  const handoff = state?.handoff;
  if (!handoff || !state.currentTaskId) {
    return failure("WORKFLOW_HANDOFF_MISSING", "当前工作流没有可验收的任务交接", {
      mismatchedFields: ["handoff"],
      expected: safeIdentityValues(state, BASE_IDENTITY_FIELDS),
      received: safeIdentityValues(input, BASE_IDENTITY_FIELDS),
      nextAction: "查询当前状态；若没有当前任务和 handoff，不得提交 complete/block。旧结果不能绑定到后续任务。",
    });
  }
  const fields = [...BASE_IDENTITY_FIELDS, "taskId", "attemptId", "handoffId"];
  for (const field of ["taskId", "attemptId", "handoffId"]) {
    if (input[field] === undefined || input[field] === null || input[field] === "") {
      return identityFailure(
        "WORKFLOW_ACTION_IDENTITY_MISSING",
        `工作流任务结果缺少 ${field}`,
        [field], workflowHandoffIdentity(state), input,
        "从当前任务交接消息或状态中的 JSON 身份原样提供该字段；不要从旧 attempt 补齐。",
      );
    }
    if (typeof input[field] !== "string") {
      return identityFailure(
        "WORKFLOW_ACTION_IDENTITY_INVALID",
        `工作流任务结果的 ${field} 必须是非空字符串`,
        [field], workflowHandoffIdentity(state), input,
        "从当前任务交接消息复制该字段的原始字符串值；不要转换或猜测。",
      );
    }
  }
  const expected = workflowHandoffIdentity(state);
  if (!expected) {
    return failure("WORKFLOW_HANDOFF_MISSING", "当前工作流没有可验收的任务交接", {
      mismatchedFields: ["handoff"],
      nextAction: "查询当前状态；不得将旧任务结果绑定到后续任务。",
    });
  }
  const mismatchedFields = differingIdentityFields(input, expected, fields);
  if (mismatchedFields.length > 0) {
    return identityFailure(
      "WORKFLOW_HANDOFF_STALE",
      `任务 handoff 身份已变化：${mismatchedFields.join(", ")}`,
      mismatchedFields, expected, input,
      "拒绝旧 attempt 的结果。查询当前状态一次；若 attempt/handoff/branch 已变化，不得把旧结果换成最新身份提交。结果未知时先核对副作用并显式授权 retry。",
    );
  }
  if (handoff.phase !== "executing" && !(allowQueued && handoff.phase === "queued")) {
    return failure("WORKFLOW_HANDOFF_NOT_EXECUTING", `任务尚未处于可验收的实际执行阶段（${handoff.phase}）`, {
      mismatchedFields: ["handoff.phase"],
      expected: { phase: allowQueued ? "executing or queued" : "executing" },
      received: { phase: handoff.phase },
      nextAction: "不要重复 complete/block。等待当前任务真实启动；若状态已恢复为结果未知，核对潜在副作用后显式 retry。",
    });
  }
  if (!activeBranchContains(ctx, TASK_MESSAGE_TYPE, expected, fields)) {
    return identityFailure(
      "WORKFLOW_HANDOFF_BRANCH_MISMATCH",
      "当前 session branch 不包含匹配的任务交接消息；拒绝旧分支回调",
      ["branch.handoff"], expected, input,
      "不要从旧 branch 提交结果；仅在匹配 handoff 消息所在的当前 session branch 中处理该任务。",
    );
  }
  return { ok: true, value: expected };
}

/** @returns {import("./workflow-types.js").WorkflowIdentityValidationResult<import("./workflow-types.js").WorkflowReplanIdentity>} */
export function validateWorkflowReplanIdentity(state, input, ctx) {
  const base = validateBaseIdentity(state, input, ctx);
  if (!base.ok) return base;
  const continuation = state?.continuation;
  const revision = state?.pendingRevision;
  if (state?.status !== "replanning" || !revision || continuation?.kind !== "replan") {
    return failure("WORKFLOW_REPLAN_HANDOFF_MISSING", "当前没有可应用的重规划交接", {
      mismatchedFields: ["replan.handoff"],
      expected: safeIdentityValues(state, BASE_IDENTITY_FIELDS),
      received: safeIdentityValues(input, BASE_IDENTITY_FIELDS),
      nextAction: "查询当前状态；没有 pending revision 与 replan handoff 时，不得提交旧重规划结果。",
    });
  }
  const fields = [...BASE_IDENTITY_FIELDS, "revisionId", "handoffId"];
  const expected = workflowReplanIdentity(state);
  if (!expected) {
    return failure("WORKFLOW_REPLAN_HANDOFF_MISSING", "当前工作流没有有效的重规划身份", {
      mismatchedFields: ["replan.handoff"],
      nextAction: "查询当前状态；没有有效的 pending revision/handoff 时不得应用旧重规划结果。",
    });
  }
  for (const field of ["revisionId", "handoffId"]) {
    if (input[field] === undefined || input[field] === null || input[field] === "") {
      return identityFailure(
        "WORKFLOW_ACTION_IDENTITY_MISSING",
        `工作流重规划结果缺少 ${field}`,
        [field], expected, input,
        "从当前 replan handoff 消息原样提供 revisionId 和 handoffId；不要使用旧 revision。",
      );
    }
    if (typeof input[field] !== "string") {
      return identityFailure(
        "WORKFLOW_ACTION_IDENTITY_INVALID",
        `工作流重规划结果的 ${field} 必须是非空字符串`,
        [field], expected, input,
        "从当前 replan handoff 消息复制原始字符串值；不要转换或猜测。",
      );
    }
  }
  const mismatchedFields = differingIdentityFields(input, expected, fields);
  if (mismatchedFields.length > 0) {
    return identityFailure(
      "WORKFLOW_REPLAN_STALE",
      `工作流重规划身份已变化：${mismatchedFields.join(", ")}`,
      mismatchedFields, expected, input,
      "拒绝旧 revision 的重规划结果。读取当前状态并由 architect 处理当前 revision；不得将旧计划改贴新 handoff 身份。",
    );
  }
  if (!activeBranchContains(ctx, REPLAN_MESSAGE_TYPE, expected, fields)) {
    return identityFailure(
      "WORKFLOW_REPLAN_BRANCH_MISMATCH",
      "当前 session branch 不包含匹配的重规划消息",
      ["branch.handoff"], expected, input,
      "仅在包含当前 replan handoff 消息的活动 branch 中应用计划；不要从旧 branch 提交。",
    );
  }
  return { ok: true, value: expected };
}

/** @returns {import("./workflow-types.js").WorkflowRecoveryResult} */
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

/** @returns {import("./workflow-types.js").WorkflowState | undefined} */
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