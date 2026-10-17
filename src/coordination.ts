import { randomUUID } from "node:crypto";
import type {
  AcceptedEvidenceReference,
  CoordinationFailure,
  CoordinationReadiness,
  CoordinationResult,
  CoordinationState,
  CoordinationStateInput,
  EvidenceReportInput,
  EvidenceRequest,
  EvidenceRequestInput,
  EvidenceReviewInput,
  EvidenceReviewReopeningInput,
  TaskContractReadiness,
  WorkflowTaskContractInput,
} from "./coordination-types.ts";
import {
  deriveCoordinationPhase,
  hydrateCoordinationState,
  parseEvidenceReport,
  parseEvidenceRequest,
  parseEvidenceReview,
} from "./coordination-validation.ts";
import { checkWorkflowTaskContractReadiness } from "./workflow-task-contract.ts";

function failure<T>(code: string, message: string, field?: string, retryable = false): CoordinationResult<T> {
  return { ok: false, code, message, ...(field ? { field } : {}), ...(retryable ? { retryable: true } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function semanticInvestigationKey(request: Pick<EvidenceRequest, "question" | "scope" | "exclusions" | "completionCriteria">): string {
  return JSON.stringify({
    question: request.question.toLowerCase(),
    scope: request.scope.map((value) => value.toLowerCase()).sort(),
    exclusions: request.exclusions.map((value) => value.toLowerCase()).sort(),
    completionCriteria: request.completionCriteria.map((value) => value.toLowerCase()).sort(),
  });
}

const WRITE_SCOPE_PATTERN = /\b(write|edit|create|delete|rename|apply|mutate|run|execute|install)\b/i;

function isWriteScope(scope: string[]): boolean {
  return scope.some((value) => WRITE_SCOPE_PATTERN.test(value));
}

function matchesGlob(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$').test(value);
}

function scopeEntryOverlaps(leftPath: string, rightPath: string): boolean {
  if (leftPath.includes('*') || leftPath.includes('?')) {
    return matchesGlob(leftPath, rightPath) || matchesGlob(leftPath, rightPath + '/x');
  }
  if (rightPath.includes('*') || rightPath.includes('?')) {
    return matchesGlob(rightPath, leftPath) || matchesGlob(rightPath, leftPath + '/x');
  }
  return leftPath === rightPath
    || leftPath.startsWith(rightPath + '/')
    || rightPath.startsWith(leftPath + '/');
}

function scopeOverlaps(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const normalize = (value: string) => value.replace(/^[*+]/, '').replace(/\/+/g, '/').replace(/\/+$/, '').toLowerCase();
  return left.some((a) => right.some((b) => scopeEntryOverlaps(normalize(a), normalize(b))));
}

function validNextTimestamp(now: number, state: CoordinationState): CoordinationFailure | undefined {
  if (!Number.isSafeInteger(now) || now < 0) {
    return { ok: false, code: "COORDINATION_TIMESTAMP_INVALID", message: "操作时间必须是非负安全整数时间戳" };
  }
  if (now < state.updatedAt) {
    return { ok: false, code: "COORDINATION_TIMESTAMP_REGRESSION", message: "操作时间早于协作状态更新时间；拒绝倒退状态" };
  }
  return undefined;
}

function latestRequestForQuestion(requests: EvidenceRequest[], questionId: string): EvidenceRequest | undefined {
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    if (requests[index].questionId === questionId) return requests[index];
  }
  return undefined;
}

export function cloneCoordinationState(input: CoordinationStateInput): CoordinationResult<CoordinationState> {
  return hydrateCoordinationState(input);
}

export function createCoordinationState(input: unknown, now = Date.now()): CoordinationResult<CoordinationState> {
  if (!isRecord(input)) return failure("COORDINATION_INPUT_TYPE", "协作状态初始化参数必须是对象");
  if (input.sessionId === undefined || input.sessionId === null) {
    return failure("COORDINATION_FIELD_MISSING", "sessionId 缺失", "sessionId");
  }
  if (typeof input.sessionId !== "string") {
    return failure("COORDINATION_FIELD_TYPE", "sessionId 必须是文本", "sessionId");
  }
  if (!input.sessionId.trim()) return failure("COORDINATION_FIELD_EMPTY", "sessionId 不能为空", "sessionId");
  if (input.coordinationId !== undefined && typeof input.coordinationId !== "string") {
    return failure("COORDINATION_FIELD_TYPE", "coordinationId 必须是文本", "coordinationId");
  }
  if (input.coordinationId !== undefined && !(input.coordinationId as string).trim()) {
    return failure("COORDINATION_FIELD_EMPTY", "coordinationId 不能为空", "coordinationId");
  }
  if (!Number.isSafeInteger(now) || now < 0) return failure("COORDINATION_TIMESTAMP_INVALID", "createdAt 必须是非负安全整数时间戳", "createdAt");
  const state: CoordinationState = {
    version: 2,
    coordinationId: input.coordinationId === undefined ? randomUUID() : (input.coordinationId as string).trim().toLowerCase(),
    sessionId: input.sessionId.trim(),
    phase: "ready",
    requests: [],
    reports: [],
    reviews: [],
    reviewReopenings: [],
    createdAt: now,
    updatedAt: now,
  };
  return hydrateCoordinationState(state);
}

export function requestEvidence(
  stateInput: CoordinationStateInput,
  input: EvidenceRequestInput,
  now = Date.now(),
): CoordinationResult<CoordinationState> {
  const hydrated = hydrateCoordinationState(stateInput);
  if (!hydrated.ok) return hydrated;
  const state = hydrated.value;
  const timeFailure = validNextTimestamp(now, state);
  if (timeFailure) return timeFailure;
  if (state.phase === "blocked") return failure("COORDINATION_BLOCKED", "协作状态已阻塞；解决阻塞原因后再创建请求");
  const parsed = parseEvidenceRequest(input, now, 1);
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  const activeRequest = [...state.requests].reverse().find((candidate) =>
    candidate.status === "pending" || candidate.status === "reported" || candidate.status === "follow-up-needed",
  );
  if (isWriteScope(request.scope)) {
    if (activeRequest && activeRequest.questionId !== request.questionId) {
      return failure("COORDINATION_REQUEST_IN_FLIGHT", `写范围取证不能与其他请求并发：问题 ${activeRequest.questionId} 尚未审阅完成`, "questionId");
    }
  } else {
    const conflicting = [...state.requests].reverse().find((candidate) =>
      (candidate.status === "pending" || candidate.status === "reported" || candidate.status === "follow-up-needed")
      && candidate.questionId !== request.questionId
      && (isWriteScope(candidate.scope) || scopeOverlaps(candidate.scope, request.scope)),
    );
    if (conflicting) {
      return failure("COORDINATION_REQUEST_IN_FLIGHT", `问题 ${conflicting.questionId} 的取证范围与当前请求重叠，暂不并发派发`, "scope");
    }
  }
  const prior = latestRequestForQuestion(state.requests, request.questionId);
  request.round = prior ? prior.round + 1 : 1;
  if (state.requests.some((candidate) => candidate.requestId === request.requestId)) {
    return failure("COORDINATION_REQUEST_DUPLICATE", `requestId 已存在：${request.requestId}`, "requestId");
  }
  if (prior) {
    if (prior.status === "pending" || prior.status === "reported" || prior.status === "superseded") {
      return failure("COORDINATION_REQUEST_IN_FLIGHT", `问题 ${request.questionId} 仍有未审阅请求`, "questionId");
    }
    if (prior.status === "blocked") {
      return failure("COORDINATION_QUESTION_BLOCKED", `问题 ${request.questionId} 已被阻塞，不能自动重开`, "questionId");
    }
    if (prior.status === "follow-up-needed") {
      if (request.followUpOfRequestId !== prior.requestId) {
        return failure("COORDINATION_FOLLOW_UP_ID_MISMATCH", "补查请求必须引用当前 follow-up-needed 请求", "followUpOfRequestId");
      }
      const priorReport = state.reports.find((report) => report.requestId === prior.requestId);
      const review = priorReport && state.reviews.findLast((candidate) => candidate.reportId === priorReport.reportId);
      if (!review || review.decision !== "more" || !request.addressesGaps.some((gap) => review.gaps.includes(gap))) {
        return failure("COORDINATION_FOLLOW_UP_GAP_MISSING", "补查请求必须明确回应上一轮审阅指出的缺口", "addressesGaps");
      }
      if (semanticInvestigationKey(request) === semanticInvestigationKey(prior)) {
        return failure("COORDINATION_NO_PROGRESS", "补查请求没有改变问题、范围、排除范围或完成条件；不会重复派发相同取证", "scope");
      }
    } else if (prior.status === "accepted"
      && semanticInvestigationKey(request) === semanticInvestigationKey(prior)
      && !request.refreshReason) {
      return failure("COORDINATION_NO_PROGRESS", "该问题已被接受；来源变化时须说明重新核实理由", "refreshReason");
    }
    prior.status = "superseded";
  }
  const requests = [...state.requests, request];
  const next: CoordinationState = {
    ...state,
    phase: deriveCoordinationPhase(requests),
    requests,
    reports: [...state.reports],
    reviews: [...state.reviews],
    ...(state.workflowLink ? { workflowLink: { ...state.workflowLink } } : {}),
    updatedAt: now,
  };
  return hydrateCoordinationState(next);
}

export function reportEvidence(
  stateInput: CoordinationStateInput,
  input: EvidenceReportInput,
  now = Date.now(),
): CoordinationResult<CoordinationState> {
  const hydrated = hydrateCoordinationState(stateInput);
  if (!hydrated.ok) return hydrated;
  const state = hydrated.value;
  const timeFailure = validNextTimestamp(now, state);
  if (timeFailure) return timeFailure;
  // 报告输入校验失败发生在任何持久化之前，且原请求仍为 pending；只有这些失败可标记 retryable，
  // 已消费请求、时间戳倒退、状态恢复失败等仍按不可重提处理。
  if (!isRecord(input)) return failure("COORDINATION_INPUT_TYPE", "证据报告必须是对象", undefined, true);
  if (input.requestId === undefined || input.requestId === null) return failure("COORDINATION_FIELD_MISSING", "证据报告 requestId 缺失", "requestId", true);
  if (typeof input.requestId !== "string") return failure("COORDINATION_FIELD_TYPE", "证据报告 requestId 必须是文本", "requestId", true);
  const request = state.requests.find((candidate) => candidate.requestId === input.requestId);
  if (!request || request.status !== "pending") {
    return failure("COORDINATION_REQUEST_NOT_PENDING", "证据报告没有匹配的待处理请求", "requestId");
  }
  const parsed = parseEvidenceReport(input, request, now);
  if (!parsed.ok) return { ...parsed, retryable: true };
  if (state.reports.some((candidate) => candidate.reportId === parsed.value.reportId)) {
    return failure("COORDINATION_REPORT_DUPLICATE", `reportId 已存在：${parsed.value.reportId}`, "reportId", true);
  }
  request.status = "reported";
  const requests = [...state.requests];
  const reports = [...state.reports, parsed.value];
  return hydrateCoordinationState({
    ...state,
    phase: deriveCoordinationPhase(requests),
    requests,
    reports,
    reviews: [...state.reviews],
    ...(state.workflowLink ? { workflowLink: { ...state.workflowLink } } : {}),
    updatedAt: now,
  });
}

export function reviewEvidence(
  stateInput: CoordinationStateInput,
  input: EvidenceReviewInput,
  now = Date.now(),
): CoordinationResult<CoordinationState> {
  const hydrated = hydrateCoordinationState(stateInput);
  if (!hydrated.ok) return hydrated;
  const state = hydrated.value;
  const timeFailure = validNextTimestamp(now, state);
  if (timeFailure) return timeFailure;
  if (!isRecord(input)) return failure("COORDINATION_INPUT_TYPE", "证据审阅必须是对象");
  if (input.reportId === undefined || input.reportId === null) return failure("COORDINATION_FIELD_MISSING", "证据审阅 reportId 缺失", "reportId");
  if (typeof input.reportId !== "string") return failure("COORDINATION_FIELD_TYPE", "证据审阅 reportId 必须是文本", "reportId");
  const report = state.reports.find((candidate) => candidate.reportId === input.reportId);
  if (!report) return failure("COORDINATION_REPORT_NOT_FOUND", "找不到待审阅的证据报告", "reportId");
  const request = state.requests.find((candidate) => candidate.requestId === report.requestId);
  if (!request || request.status !== "reported") {
    return failure("COORDINATION_REPORT_NOT_REVIEWABLE", "报告已审阅或对应请求状态已变化", "reportId");
  }
  const priorReviews = state.reviews.filter((candidate) => candidate.reportId === report.reportId);
  const reopening = state.reviewReopenings.findLast((candidate) => candidate.reportId === report.reportId
    && !state.reviews.some((review) => review.reopeningId === candidate.reopeningId));
  if (priorReviews.length > 0 && (!reopening || reopening.previousReviewId !== priorReviews.at(-1)?.reviewId)) {
    return failure("COORDINATION_REPORT_NOT_REVIEWABLE", "报告已审阅且没有待处理的显式重开记录", "reportId");
  }
  const parsed = parseEvidenceReview(input, report, now);
  if (!parsed.ok) return parsed;
  if (state.reviews.some((candidate) => candidate.reviewId === parsed.value.reviewId)) {
    return failure("COORDINATION_REVIEW_DUPLICATE", `reviewId 已存在：${parsed.value.reviewId}`, "reviewId");
  }
  request.status = parsed.value.decision === "accept"
    ? "accepted"
    : parsed.value.decision === "more"
      ? "follow-up-needed"
      : "blocked";
  const review = reopening ? { ...parsed.value, reopeningId: reopening.reopeningId } : parsed.value;
  const requests = [...state.requests];
  return hydrateCoordinationState({
    ...state,
    phase: deriveCoordinationPhase(requests),
    requests,
    reports: [...state.reports],
    reviews: [...state.reviews, review],
    ...(state.workflowLink ? { workflowLink: { ...state.workflowLink } } : {}),
    updatedAt: now,
  });
}

export function reopenEvidenceReview(
  stateInput: CoordinationStateInput,
  input: EvidenceReviewReopeningInput,
  now = Date.now(),
): CoordinationResult<CoordinationState> {
  const hydrated = hydrateCoordinationState(stateInput);
  if (!hydrated.ok) return hydrated;
  const state = hydrated.value;
  const timeFailure = validNextTimestamp(now, state);
  if (timeFailure) return timeFailure;
  if (!isRecord(input)) return failure("COORDINATION_REOPEN_INPUT_TYPE", "重开审阅参数必须是对象");
  if (input.reportId === undefined || input.reportId === null) {
    return failure("COORDINATION_FIELD_MISSING", "重开审阅 reportId 缺失", "reportId");
  }
  if (typeof input.reportId !== "string") {
    return failure("COORDINATION_FIELD_TYPE", "重开审阅 reportId 必须是文本", "reportId");
  }
  const reportId = input.reportId.trim().toLowerCase();
  if (!reportId) return failure("COORDINATION_FIELD_EMPTY", "重开审阅 reportId 不能为空", "reportId");
  if (input.reason === undefined || input.reason === null) {
    return failure("COORDINATION_FIELD_MISSING", "重开审阅 reason 缺失", "reason");
  }
  if (typeof input.reason !== "string") return failure("COORDINATION_FIELD_TYPE", "重开审阅 reason 必须是文本", "reason");
  const reason = input.reason.trim();
  if (!reason) return failure("COORDINATION_FIELD_EMPTY", "重开审阅 reason 不能为空", "reason");
  if (state.phase !== "blocked") return failure("COORDINATION_REOPEN_NOT_BLOCKED", "当前协作状态没有明确阻塞的审阅", "reportId");

  const report = state.reports.find((candidate) => candidate.reportId === reportId);
  if (!report) return failure("COORDINATION_REPORT_NOT_FOUND", "找不到要重开的证据报告", "reportId");
  const request = latestRequestForQuestion(state.requests, state.requests.find((item) => item.requestId === report.requestId)?.questionId ?? "");
  if (!request || request.requestId !== report.requestId || request.status !== "blocked") {
    return failure("COORDINATION_REOPEN_NOT_LATEST_BLOCK", "只能重开该问题最新的明确阻塞报告", "reportId");
  }
  const previousReview = state.reviews.findLast((candidate) => candidate.reportId === reportId);
  if (!previousReview || previousReview.decision !== "block") {
    return failure("COORDINATION_REOPEN_NOT_LATEST_BLOCK", "目标报告的最新审阅不是明确阻塞", "reportId");
  }
  const existingPending = state.reviewReopenings.some((candidate) => candidate.reportId === reportId
    && !state.reviews.some((review) => review.reopeningId === candidate.reopeningId));
  if (existingPending) return failure("COORDINATION_REOPEN_ALREADY_PENDING", "该报告已有待处理的重开审阅", "reportId");

  const reviewReopening = {
    reopeningId: randomUUID(),
    requestId: request.requestId,
    reportId,
    previousReviewId: previousReview.reviewId,
    reason,
    createdAt: now,
  };
  const requests = state.requests.map((item) => item.requestId === request.requestId
    ? { ...item, status: "reported" as const }
    : { ...item });
  return hydrateCoordinationState({
    ...state,
    phase: deriveCoordinationPhase(requests),
    requests,
    reviewReopenings: [...state.reviewReopenings, reviewReopening],
    updatedAt: now,
  });
}

export function getAcceptedEvidence(input: CoordinationStateInput): CoordinationResult<AcceptedEvidenceReference[]> {
  const hydrated = hydrateCoordinationState(input);
  if (!hydrated.ok) return hydrated;
  const { reports, reviews } = hydrated.value;
  const latestVersionBySource = new Map<string, string>();
  for (const report of reports) {
    for (const finding of report.findings) {
      for (const source of finding.sources) latestVersionBySource.set(source.id, source.version);
    }
  }
  const references: AcceptedEvidenceReference[] = [];
  for (const review of reviews) {
    if (review.decision === "block") continue;
    for (const reference of review.acceptedEvidence) {
      if (latestVersionBySource.get(reference.sourceId) === reference.sourceVersion) references.push({ ...reference });
    }
  }
  const unique = new Map(references.map((reference) => [
    `${reference.findingId}\0${reference.sourceId}\0${reference.sourceVersion}`,
    reference,
  ]));
  return { ok: true, value: [...unique.values()] };
}

export function checkCoordinationReadiness(input: CoordinationStateInput): CoordinationReadiness {
  const hydrated = hydrateCoordinationState(input);
  if (!hydrated.ok) return hydrated;
  const state = hydrated.value;
  if (state.phase === "blocked") return failure("COORDINATION_BLOCKED", "至少一个证据问题被明确阻塞");
  const latestByQuestion = new Map<string, EvidenceRequest>();
  for (const request of state.requests) latestByQuestion.set(request.questionId, request);
  const incomplete = [...latestByQuestion.values()].filter((request) => request.status !== "accepted");
  if (incomplete.length > 0) {
    const ids = incomplete.map((request) => `${request.questionId}:${request.status}`);
    return failure("COORDINATION_EVIDENCE_INCOMPLETE", `证据尚未审阅完成：${ids.join(", ")}`, "requests");
  }
  const accepted = getAcceptedEvidence(state);
  return accepted.ok ? { ok: true, value: { ready: true, acceptedEvidence: accepted.value } } : accepted;
}

export function checkTaskContractAgainstCoordination(
  contract: WorkflowTaskContractInput | undefined,
  coordination: CoordinationStateInput,
): TaskContractReadiness {
  const readiness = checkCoordinationReadiness(coordination);
  if (!readiness.ok) return readiness;
  return checkWorkflowTaskContractReadiness(contract, readiness.value.acceptedEvidence);
}

export { hydrateCoordinationState };
