import { hydrateCoordinationState } from "../src/coordination.ts";
import type { CoordinationFailure } from "../src/coordination-types.ts";
import type {
  CoordinationHandoff,
  CoordinationHandoffIdentity,
  CoordinationRole,
  CoordinationRuntimeState,
  CoordinationRuntimeStateInput,
} from "../src/coordination-runtime-types.ts";

export const COORDINATION_ENTRY_TYPE = "pi-init-coordination";
export const COORDINATION_EVIDENCE_MESSAGE_TYPE = "pi-init-coordination-evidence";
export const COORDINATION_REVIEW_MESSAGE_TYPE = "pi-init-coordination-review";

export const COORDINATION_RUNTIME_VERSION = 1;
const HANDOFF_PHASES = ["prepared", "dispatching", "queued", "executing", "blocked"] as const;
const ROLES = ["docs-commit", "architect"] as const;
const HANDOFF_KINDS = ["evidence", "review"] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function coordinationFailure(code: string, message: string) {
  return { ok: false as const, code, message };
}

export type CoordinationErrorDetails = {
  field?: string;
  retryable?: boolean;
  nextAction?: string;
};

const REPORT_INPUT_RETRY_GUIDANCE =
  "修正当前 report 输入后，在原 handoff 仍有效时用同一身份重提 task_workflow(action=report-evidence)，可传回当前 coordinationHandoffId 或完整 coordinationIdentity；不需要新建 attempt、重新取证或复用已消费身份。";

/** 保留 domain 的 field/retryable 定位，避免只重组 code/message 丢失现场。 */
export function coordinationError(code: string, message: string, extra: CoordinationErrorDetails = {}) {
  const details = {
    ok: false as const,
    code,
    message,
    ...(extra.field ? { field: extra.field } : {}),
    ...(extra.retryable ? { retryable: true } : {}),
    ...(extra.nextAction ? { nextAction: extra.nextAction } : {}),
  };
  return Object.assign(new Error(`[PI-INIT_COORDINATION_ERROR] ${JSON.stringify(details)}`), {
    code,
    details,
  });
}

/** 仅当 domain 确认该失败属于尚未持久化的可重提输入错误时才附带就地重提指引。 */
export function requireCoordinationResult<T>(result: { ok: true; value: T } | CoordinationFailure): T {
  if (!result.ok) {
    throw coordinationError(result.code, result.message, {
      ...(result.field ? { field: result.field } : {}),
      ...(result.retryable ? { retryable: true, nextAction: REPORT_INPUT_RETRY_GUIDANCE } : {}),
    });
  }
  return result.value;
}

export function nonEmptyText(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw coordinationError("COORDINATION_IDENTITY_FIELD_INVALID", `${field} 必须是非空文本`);
  }
  return value;
}

export function sameCoordinationIdentity(left: unknown, right: CoordinationHandoffIdentity) {
  if (!isRecord(left)) return false;
  const fields = [
    "coordinationId", "coordinationVersion", "sessionId", "recoveryGeneration", "requestId",
    "role", "kind", "attemptId", "handoffId", "reportId",
  ] as const;
  if (!fields.every((field) => left[field] === right[field] || (field === "reportId" && left[field] === undefined))) return false;
  if (typeof left.reportId !== "string" && Array.isArray(left.reportIds) && Array.isArray(right.reportIds)
    && right.reportIds.length > 0 && left.reportIds.every((item) => right.reportIds!.includes(item))) {
    return true;
  }
  if (typeof left.reportId !== "string" && Array.isArray(left.reportIds) && right.reportId !== undefined) {
    return left.reportIds.length === 1 && left.reportIds[0] === right.reportId;
  }
  const leftReports = Array.isArray(left.reportIds) ? left.reportIds : [];
  const rightReports = right.reportIds ?? [];
  return leftReports.length === rightReports.length
    && leftReports.every((item, index) => item === rightReports[index]);
}

export function coordinationHandoffIdentity(current: CoordinationRuntimeState): CoordinationHandoffIdentity | undefined {
  const handoff = current.handoff;
  if (!handoff) return undefined;
  return {
    coordinationId: current.coordination.coordinationId,
    coordinationVersion: current.coordination.version,
    sessionId: current.sessionId,
    recoveryGeneration: current.recoveryGeneration,
    requestId: handoff.requestId,
    role: handoff.role,
    kind: handoff.kind,
    attemptId: handoff.attemptId,
    handoffId: handoff.handoffId,
    ...(handoff.reportId ? { reportId: handoff.reportId } : {}),
    ...(handoff.reportIds ? { reportIds: [...handoff.reportIds] } : {}),
  };
}

function parseHandoff(value: unknown, coordination: CoordinationRuntimeState["coordination"]):
  | { ok: true; value: CoordinationHandoff }
  | { ok: false; code: string; message: string } {
  if (!isRecord(value)) return coordinationFailure("COORDINATION_HANDOFF_INVALID", "协作 handoff 必须是对象");
  if (!(ROLES as readonly unknown[]).includes(value.role)) return coordinationFailure("COORDINATION_HANDOFF_ROLE_INVALID", "协作 handoff role 无效");
  if (!(HANDOFF_KINDS as readonly unknown[]).includes(value.kind)) return coordinationFailure("COORDINATION_HANDOFF_KIND_INVALID", "协作 handoff kind 无效");
  if (!(HANDOFF_PHASES as readonly unknown[]).includes(value.phase)) return coordinationFailure("COORDINATION_HANDOFF_PHASE_INVALID", "协作 handoff phase 无效");
  if (typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    return coordinationFailure("COORDINATION_HANDOFF_TIMESTAMP_INVALID", "协作 handoff createdAt 无效");
  }
  const requestIds = Array.isArray(value.requestIds) && value.requestIds.length > 0
    ? value.requestIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const requestId = typeof value.requestId === "string" ? value.requestId : "";
  const requestedIds = requestIds.length > 0 ? requestIds : [requestId];
  let reportId: string | undefined;
  let reportIds: string[] | undefined;
  if (value.kind === "evidence") {
    if (value.role !== "docs-commit" || value.reportId !== undefined || requestedIds.length === 0) {
      return coordinationFailure("COORDINATION_HANDOFF_STATE_MISMATCH", "取证 handoff 必须分派给 docs-commit 且对应待处理请求");
    }
    for (const id of requestedIds) {
      const request = coordination.requests.find((candidate) => candidate.requestId === id);
      if (!request) return coordinationFailure("COORDINATION_HANDOFF_REQUEST_MISMATCH", "协作 handoff 引用了不存在的证据请求");
      if (request.status !== "pending") {
        return coordinationFailure("COORDINATION_HANDOFF_STATE_MISMATCH", "取证 handoff 必须分派给 docs-commit 且对应待处理请求");
      }
    }
  } else {
    if (requestedIds.length !== 1) {
      return coordinationFailure("COORDINATION_HANDOFF_STATE_MISMATCH", "审阅 handoff 只能引用一个报告");
    }
    const request = coordination.requests.find((candidate) => candidate.requestId === requestId);
    if (!request) return coordinationFailure("COORDINATION_HANDOFF_REQUEST_MISMATCH", "协作 handoff 引用了不存在的证据请求");
    reportId = typeof value.reportId === "string" ? value.reportId : "";
    const report = coordination.reports.find((candidate) => candidate.reportId === reportId && candidate.requestId === requestId);
    const reportReviews = coordination.reviews.filter((candidate) => candidate.reportId === reportId);
    const latestReview = reportReviews.at(-1);
    const pendingReopening = coordination.reviewReopenings.findLast((reopening) => reopening.reportId === reportId
      && !coordination.reviews.some((review) => review.reopeningId === reopening.reopeningId));
    const newlyReported = request.status === "reported"
      && (!latestReview || (latestReview.decision === "block" && pendingReopening?.previousReviewId === latestReview.reviewId));
    const moreReview = request.status === "follow-up-needed" && latestReview?.decision === "more";
    if (value.role !== "architect" || !report || (!newlyReported && !moreReview)) {
      return coordinationFailure("COORDINATION_HANDOFF_STATE_MISMATCH", "审阅 handoff 必须分派给 architect 且引用当前可审阅报告");
    }
    if (Array.isArray(value.reportIds) && value.reportIds.length > 0) {
      reportIds = value.reportIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
  }
  if (typeof value.attemptId !== "string" || !value.attemptId.trim()
    || typeof value.handoffId !== "string" || !value.handoffId.trim()) {
    return coordinationFailure("COORDINATION_HANDOFF_IDENTITY_INVALID", "协作 handoff 缺少 attemptId 或 handoffId");
  }
  return {
    ok: true,
    value: {
      role: value.role as CoordinationRole,
      kind: value.kind as CoordinationHandoff["kind"],
      requestId: requestedIds[0] ?? requestId,
      ...(requestIds.length > 1 ? { requestIds } : {}),
      ...(reportId ? { reportId } : {}),
      ...(reportIds ? { reportIds } : {}),
      attemptId: value.attemptId,
      handoffId: value.handoffId,
      phase: value.phase as CoordinationHandoff["phase"],
      createdAt: value.createdAt,
      ...(isRecord(value.failure)
        && typeof value.failure.code === "string"
        && typeof value.failure.message === "string"
        ? { failure: { code: value.failure.code, message: value.failure.message } }
        : {}),
    },
  };
}

export function hydrateCoordinationRuntimeState(
  input: CoordinationRuntimeStateInput,
  currentSessionId: unknown,
): { ok: true; value: CoordinationRuntimeState } | { ok: false; code: string; message: string } {
  if (!isRecord(input)) return coordinationFailure("COORDINATION_RUNTIME_INVALID_TYPE", "已保存的协作运行状态必须是对象");
  if (input.runtimeVersion !== COORDINATION_RUNTIME_VERSION) {
    return coordinationFailure("COORDINATION_RUNTIME_VERSION_UNSUPPORTED", "协作运行状态版本不受支持");
  }
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  if (!sessionId.trim()) return coordinationFailure("COORDINATION_SESSION_ID_MISSING", "已保存的协作状态缺少 sessionId");
  if (typeof currentSessionId !== "string" || !currentSessionId.trim()) {
    return coordinationFailure("COORDINATION_SESSION_ID_UNAVAILABLE", "无法读取当前 Pi sessionId");
  }
  if (sessionId !== currentSessionId) return coordinationFailure("COORDINATION_SESSION_MISMATCH", "已保存的协作状态属于其他 Pi session；不会恢复或重放");
  if (typeof input.recoveryGeneration !== "number" || !Number.isSafeInteger(input.recoveryGeneration) || input.recoveryGeneration < 0) {
    return coordinationFailure("COORDINATION_RECOVERY_GENERATION_INVALID", "协作状态 recoveryGeneration 无效");
  }
  const coordination = hydrateCoordinationState(input.coordination);
  if (!coordination.ok) return coordinationFailure(coordination.code, coordination.message);
  if (coordination.value.sessionId !== sessionId) {
    return coordinationFailure("COORDINATION_SESSION_MISMATCH", "协作状态与运行时封装的 sessionId 不一致");
  }
  const parsedHandoff = input.handoff === undefined
    ? { ok: true as const, value: undefined }
    : parseHandoff(input.handoff, coordination.value);
  if (!parsedHandoff.ok) return parsedHandoff;
  if (!parsedHandoff.value && ["evidence-gathering", "evidence-review"].includes(coordination.value.phase)) {
    return coordinationFailure("COORDINATION_HANDOFF_MISSING", "未完成的协作阶段缺少可恢复的 handoff");
  }
  return {
    ok: true,
    value: {
      runtimeVersion: COORDINATION_RUNTIME_VERSION,
      coordination: coordination.value,
      sessionId,
      recoveryGeneration: input.recoveryGeneration,
      ...(parsedHandoff.value ? { handoff: parsedHandoff.value } : {}),
    },
  };
}
