import { hasOwn, isRecord } from "./value-guards.ts";
import { randomUUID } from "node:crypto";
import { cloneState } from "./workflow-state.ts";
import { WORKFLOW_TASK_MESSAGE_TYPE, WORKFLOW_REPLAN_MESSAGE_TYPE } from "./workflow-protocol.ts";
import type {
  WorkflowActionIdentity,
  WorkflowHandoffIdentity,
  WorkflowIdentityValidationResult,
  WorkflowIdentityContext,
  WorkflowMessageAnchor,
  WorkflowReplanIdentity,
  WorkflowState,
  WorkflowValidationFailure,
} from "./workflow-types.ts";

const BASE_IDENTITY_FIELDS = ["workflowId", "planVersion", "sessionId", "recoveryGeneration"] as const;
const HANDOFF_IDENTITY_FIELDS = [...BASE_IDENTITY_FIELDS, "taskId", "attemptId", "handoffId"] as const;
const REPLAN_IDENTITY_FIELDS = [...BASE_IDENTITY_FIELDS, "revisionId", "handoffId"] as const;

function sameIdentityFields<T extends object>(fields: readonly (keyof T)[], left: T | undefined, right: T | undefined) {
  return left !== undefined && right !== undefined && fields.every((field) => left[field] === right[field]);
}

/*
 * The one way to compare workflow identities. Each compares exactly its declared fields, so extra
 * properties on either side (a full handoff record, tool parameters) never affect the result.
 */
export function sameWorkflowActionIdentity(left: WorkflowActionIdentity | undefined, right: WorkflowActionIdentity | undefined) {
  return sameIdentityFields(BASE_IDENTITY_FIELDS, left, right);
}
export function sameWorkflowHandoffIdentity(left: WorkflowHandoffIdentity | undefined, right: WorkflowHandoffIdentity | undefined) {
  return sameIdentityFields(HANDOFF_IDENTITY_FIELDS, left, right);
}
export function sameWorkflowReplanIdentity(left: WorkflowReplanIdentity | undefined, right: WorkflowReplanIdentity | undefined) {
  return sameIdentityFields(REPLAN_IDENTITY_FIELDS, left, right);
}

function failure(
  code: string,
  message: string,
  details: Partial<Omit<WorkflowValidationFailure, "ok" | "code" | "message">> = {},
): WorkflowValidationFailure {
  return { ok: false, code, message, ...details };
}

function safeIdentityValues(source: unknown, fields: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const values = isRecord(source) ? source : undefined;
  for (const field of fields) {
    if (!values || !hasOwn(values, field)) continue;
    const value = values[field];
    if (typeof value === "string") result[field] = value.length <= 256 ? value : `${value.slice(0, 256)}…`;
    else if (typeof value === "number" && Number.isFinite(value)) result[field] = value;
    else if (value === null) result[field] = null;
    else result[field] = `<${typeof value}>`;
  }
  return result;
}

function identityFailure(
  code: string,
  message: string,
  mismatchedFields: string[],
  expected: unknown,
  received: unknown,
  nextAction: string,
): WorkflowValidationFailure {
  return failure(code, message, {
    mismatchedFields,
    expected: safeIdentityValues(expected, [...new Set([...mismatchedFields, ...BASE_IDENTITY_FIELDS])]),
    received: safeIdentityValues(received, [...new Set([...mismatchedFields, ...BASE_IDENTITY_FIELDS])]),
    nextAction,
  });
}

function differingIdentityFields(actual: unknown, expected: unknown, fields: readonly string[]): string[] {
  const actualValues = isRecord(actual) ? actual : undefined;
  const expectedValues = isRecord(expected) ? expected : undefined;
  return fields.filter((field) => actualValues?.[field] !== expectedValues?.[field]);
}

function identityFieldsMatch(actual: unknown, expected: unknown, fields: readonly string[]): boolean {
  if (!isRecord(actual) || !isRecord(expected)) return false;
  return fields.every((field) => actual[field] === expected[field]);
}

export function workflowHandoffNotExecutingFailure(
  phase: string,
  { branchMatched = false }: { branchMatched?: boolean } = {},
): WorkflowValidationFailure {
  return failure("WORKFLOW_HANDOFF_NOT_EXECUTING", `任务尚未处于可验收的实际执行阶段（${phase}）`, {
    mismatchedFields: ["handoff.phase"],
    expected: { phase: "executing" },
    received: { phase },
    nextAction: "不要重复 complete/block。等待当前任务真实启动；若状态已恢复为结果未知，核对潜在副作用后显式 retry。",
    branchMatched,
  });
}

const notExecuting = workflowHandoffNotExecutingFailure;

function validateBaseIdentity(
  state: WorkflowState | undefined,
  input: unknown,
  context: WorkflowIdentityContext,
): WorkflowIdentityValidationResult<WorkflowActionIdentity> {
  if (!isRecord(input)) {
    return failure("WORKFLOW_ACTION_IDENTITY_MISSING", "工作流操作缺少执行身份", {
      mismatchedFields: [...BASE_IDENTITY_FIELDS],
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
    if (typeof input[field] !== "number" || !Number.isSafeInteger(input[field]) || input[field] < 0) {
      return identityFailure(
        "WORKFLOW_ACTION_IDENTITY_INVALID",
        `工作流 ${field} 必须是非负安全整数`,
        [field], state, input,
        "读取当前工作流状态，并使用原样数值；不要将无效值强制转换。",
      );
    }
  }
  const sessionId = context.sessionId;
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

function containsWorkflowAnchor(
  anchors: readonly WorkflowMessageAnchor[],
  customType: string,
  expected: unknown,
  fields: readonly string[],
): boolean {
  return anchors.some((anchor) => anchor.messageType === customType
    && identityFieldsMatch(anchor.identity, expected, fields));
}

// Startup and tool-settlement evidence require the full task/attempt/handoff identity.
// Result validation below intentionally keeps its separate base-identity branch scope.
export function workflowHandoffAnchorMatches(
  anchors: readonly WorkflowMessageAnchor[],
  identity: WorkflowHandoffIdentity,
): boolean {
  return containsWorkflowAnchor(
    anchors,
    WORKFLOW_TASK_MESSAGE_TYPE,
    identity,
    HANDOFF_IDENTITY_FIELDS,
  );
}

export function workflowActionIdentity(state: WorkflowState): WorkflowActionIdentity;
export function workflowActionIdentity(state: undefined): undefined;
export function workflowActionIdentity(state: WorkflowState | undefined): WorkflowActionIdentity | undefined;
export function workflowActionIdentity(state: WorkflowState | undefined): WorkflowActionIdentity | undefined {
  if (!state) return undefined;
  return {
    workflowId: state.workflowId,
    planVersion: state.planVersion,
    sessionId: state.sessionId,
    recoveryGeneration: state.recoveryGeneration,
  };
}

export function workflowHandoffIdentity(state: WorkflowState | undefined): WorkflowHandoffIdentity | undefined {
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

export function workflowReplanIdentity(state: WorkflowState | undefined): WorkflowReplanIdentity | undefined {
  const continuation = state?.continuation;
  const revision = state?.pendingRevision;
  if (state?.status !== "replanning" || !revision || continuation?.kind !== "replan" || !continuation.handoffId) {
    return undefined;
  }
  const actionIdentity = workflowActionIdentity(state);
  return {
    ...actionIdentity,
    revisionId: revision.revisionId,
    handoffId: continuation.handoffId,
  };
}

export function validateWorkflowMutationIdentity(
  state: WorkflowState | undefined,
  input: unknown,
  context: WorkflowIdentityContext,
): WorkflowIdentityValidationResult<WorkflowActionIdentity> {
  return validateBaseIdentity(state, input, context);
}

export function validateWorkflowHandoffIdentity(
  state: WorkflowState | undefined,
  input: unknown,
  context: WorkflowIdentityContext,
): WorkflowIdentityValidationResult<WorkflowHandoffIdentity> {
  const base = validateBaseIdentity(state, input, context);
  if (!base.ok) return base;
  if (!isRecord(input)) {
    return failure("WORKFLOW_ACTION_IDENTITY_MISSING", "工作流操作缺少执行身份");
  }
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
  const expected = workflowHandoffIdentity(state) ?? handoff;
  const differs = !identityFieldsMatch(input, expected, fields);
  if (differs) {
    const mismatchedFields = differingIdentityFields(input, expected, fields);
    return identityFailure(
      "WORKFLOW_HANDOFF_STALE",
      `任务 handoff 身份已变化：${mismatchedFields.join(", ")}`,
      mismatchedFields, expected, input,
      "拒绝旧 attempt 的结果。查询当前状态一次；若 attempt/handoff/branch 已变化，不得把旧结果换成最新身份提交。结果未知时先核对副作用并显式授权 retry。",
    );
  }
  const branchMatched = containsWorkflowAnchor(context.anchors, WORKFLOW_TASK_MESSAGE_TYPE, expected, BASE_IDENTITY_FIELDS);
  if (handoff.phase !== "executing" && handoff.phase !== "queued") return notExecuting(handoff.phase, { branchMatched });
  if (!branchMatched) {
    return identityFailure(
      "WORKFLOW_HANDOFF_BRANCH_MISMATCH",
      "当前 session branch 不包含匹配的任务交接消息；拒绝旧分支回调",
      ["branch.handoff"], expected, input,
      "不要从旧 branch 提交结果；仅在匹配 handoff 消息所在的当前 session branch 中处理该任务。",
    );
  }
  return { ok: true, value: expected };
}

export function validateWorkflowReplanIdentity(
  state: WorkflowState | undefined,
  input: unknown,
  context: WorkflowIdentityContext,
): WorkflowIdentityValidationResult<WorkflowReplanIdentity> {
  const base = validateBaseIdentity(state, input, context);
  if (!base.ok) return base;
  if (!isRecord(input)) {
    return failure("WORKFLOW_ACTION_IDENTITY_MISSING", "工作流操作缺少执行身份");
  }
  const fields = [...BASE_IDENTITY_FIELDS, "revisionId", "handoffId"];
  const expected = workflowReplanIdentity(state);
  if (!expected) {
    return failure("WORKFLOW_REPLAN_HANDOFF_MISSING", "当前没有可应用的重规划交接", {
      mismatchedFields: ["replan.handoff"],
      expected: safeIdentityValues(state, BASE_IDENTITY_FIELDS),
      received: safeIdentityValues(input, BASE_IDENTITY_FIELDS),
      nextAction: "查询当前状态；没有 pending revision 与 replan handoff 时，不得提交旧重规划结果。",
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
  const differs = !identityFieldsMatch(input, expected, fields);
  if (differs) {
    const mismatchedFields = differingIdentityFields(input, expected, fields);
    return identityFailure(
      "WORKFLOW_REPLAN_STALE",
      `工作流重规划身份已变化：${mismatchedFields.join(", ")}`,
      mismatchedFields, expected, input,
      "拒绝旧 revision 的重规划结果。读取当前状态并由 architect 处理当前 revision；不得将旧计划改贴新 handoff 身份。",
    );
  }
  if (!containsWorkflowAnchor(context.anchors, WORKFLOW_REPLAN_MESSAGE_TYPE, expected, BASE_IDENTITY_FIELDS)) {
    return identityFailure(
      "WORKFLOW_REPLAN_BRANCH_MISMATCH",
      "当前 session branch 不包含匹配的重规划消息",
      ["branch.handoff"], expected, input,
      "仅在包含当前 replan handoff 消息的活动 branch 中应用计划；不要从旧 branch 提交。",
    );
  }
  return { ok: true, value: expected };
}

export function ensureWorkflowReplanHandoff(state: WorkflowState | undefined): WorkflowState | undefined {
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
