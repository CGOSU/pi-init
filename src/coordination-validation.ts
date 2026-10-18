import { randomUUID } from "node:crypto";
import type {
  AcceptedEvidenceReference,
  CoordinationPhase,
  CoordinationResult,
  CoordinationState,
  CoordinationStateInput,
  EvidenceClassification,
  EvidenceFinding,
  EvidenceReport,
  EvidenceReportInput,
  EvidenceRequest,
  EvidenceRequestInput,
  EvidenceRequestStatus,
  EvidenceReview,
  EvidenceReviewDecision,
  EvidenceReviewInput,
  EvidenceReviewReopening,
  EvidenceSource,
  EvidenceTestResult,
} from "./coordination-types.ts";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const COORDINATION_PHASES = ["evidence-gathering", "evidence-review", "ready", "blocked"] as const;
const REQUEST_STATUSES = ["pending", "reported", "accepted", "follow-up-needed", "blocked", "superseded"] as const;
const FINDING_CLASSIFICATIONS = ["fact", "inference", "unconfirmed", "conflict"] as const;
const REVIEW_DECISIONS = ["accept", "more", "block"] as const;

class CoordinationError extends Error {
  readonly code: string;
  readonly field?: string;

  constructor(code: string, message: string, field?: string) {
    super(message);
    this.name = "CoordinationError";
    this.code = code;
    this.field = field;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asFailure<T>(error: unknown): CoordinationResult<T> {
  return error instanceof CoordinationError
    ? { ok: false, code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) }
    : { ok: false, code: "COORDINATION_INPUT_INVALID", message: error instanceof Error ? error.message : String(error) };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new CoordinationError("COORDINATION_INPUT_TYPE", `${label} 必须是对象`, label);
  return value;
}

function requiredText(value: unknown, field: string): string {
  if (value === undefined || value === null) throw new CoordinationError("COORDINATION_FIELD_MISSING", `${field} 缺失`, field);
  if (typeof value !== "string") throw new CoordinationError("COORDINATION_FIELD_TYPE", `${field} 必须是文本`, field);
  const normalized = value.trim();
  if (!normalized) throw new CoordinationError("COORDINATION_FIELD_EMPTY", `${field} 不能为空`, field);
  return normalized;
}

function identifier(value: unknown, field: string): string {
  const normalized = requiredText(value, field).toLowerCase();
  if (!ID_PATTERN.test(normalized)) throw new CoordinationError("COORDINATION_FIELD_FORMAT", `${field} 格式无效`, field);
  return normalized;
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CoordinationError("COORDINATION_TIMESTAMP_INVALID", `${field} 必须是非负安全整数时间戳`, field);
  }
  return value;
}

function textList(value: unknown, field: string, { required = false }: { required?: boolean } = {}): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) {
    throw new CoordinationError(value === undefined ? "COORDINATION_FIELD_MISSING" : "COORDINATION_FIELD_TYPE", `${field} 必须是文本数组`, field);
  }
  const normalized = value.map((item, index) => requiredText(item, `${field}[${index}]`));
  if (required && normalized.length === 0) {
    throw new CoordinationError("COORDINATION_FIELD_EMPTY", `${field} 不能为空`, field);
  }
  return normalized;
}

function parseSource(value: unknown, field: string): EvidenceSource {
  const source = record(value, field);
  return {
    id: requiredText(source.id, `${field}.id`),
    location: requiredText(source.location, `${field}.location`),
    version: requiredText(source.version, `${field}.version`),
  };
}

function parseEvidenceReference(value: unknown, field: string): AcceptedEvidenceReference {
  const source = record(value, field);
  return {
    findingId: identifier(source.findingId, `${field}.findingId`),
    sourceId: requiredText(source.sourceId, `${field}.sourceId`),
    sourceVersion: requiredText(source.sourceVersion, `${field}.sourceVersion`),
  };
}

function parseEvidenceReferences(value: unknown, field: string): AcceptedEvidenceReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new CoordinationError("COORDINATION_FIELD_TYPE", `${field} 必须是数组`, field);
  const references = value.map((item, index) => parseEvidenceReference(item, `${field}[${index}]`));
  // 仅按完全一致的 findingId/sourceId/sourceVersion 无损合并并保留首次出现顺序；类别、版本与缺口校验仍逐项执行。
  const seen = new Set<string>();
  const unique: AcceptedEvidenceReference[] = [];
  for (const reference of references) {
    const key = `${reference.findingId}\0${reference.sourceId}\0${reference.sourceVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(reference);
  }
  return unique;
}

export function parseEvidenceRequest(input: EvidenceRequestInput, now: number, round = 1): CoordinationResult<EvidenceRequest> {
  try {
    const source = record(input, "证据请求");
    const requestId = source.requestId === undefined ? randomUUID() : identifier(source.requestId, "证据请求 requestId");
    const followUpOfRequestId = source.followUpOfRequestId === undefined
      ? undefined
      : identifier(source.followUpOfRequestId, "证据请求 followUpOfRequestId");
    const refreshReason = source.refreshReason === undefined
      ? undefined
      : requiredText(source.refreshReason, "证据请求 refreshReason");
    if (!Number.isSafeInteger(round) || round < 1) throw new CoordinationError("COORDINATION_ROUND_INVALID", "证据请求 round 必须是正整数", "round");
    return {
      ok: true,
      value: {
        requestId,
        questionId: identifier(source.questionId, "证据请求 questionId"),
        question: requiredText(source.question, "证据请求 question"),
        rationale: requiredText(source.rationale, "证据请求 rationale"),
        scope: textList(source.scope, "证据请求 scope", { required: true }),
        exclusions: textList(source.exclusions, "证据请求 exclusions"),
        completionCriteria: textList(source.completionCriteria, "证据请求 completionCriteria", { required: true }),
        addressesGaps: textList(source.addressesGaps, "证据请求 addressesGaps"),
        ...(followUpOfRequestId ? { followUpOfRequestId } : {}),
        ...(refreshReason ? { refreshReason } : {}),
        round,
        status: "pending",
        createdAt: timestamp(now, "requestedAt"),
      },
    };
  } catch (error) {
    return asFailure(error);
  }
}

function normalizeStoredRequest(input: unknown, index: number): CoordinationResult<EvidenceRequest> {
  const source = record(input, `协作状态 requests[${index}]`);
  if (source.requestId === undefined || source.requestId === null) {
    return { ok: false, code: "COORDINATION_FIELD_MISSING", message: `requests[${index}].requestId 缺失`, field: `requests[${index}].requestId` };
  }
  if (typeof source.requestId !== "string") {
    return { ok: false, code: "COORDINATION_FIELD_TYPE", message: `requests[${index}].requestId 必须是文本`, field: `requests[${index}].requestId` };
  }
  const round = source.round;
  if (typeof round !== "number" || !Number.isSafeInteger(round) || round < 1) {
    return { ok: false, code: "COORDINATION_ROUND_INVALID", message: `requests[${index}].round 必须是正整数`, field: `requests[${index}].round` };
  }
  const parsed = parseEvidenceRequest(source as unknown as EvidenceRequestInput, timestamp(source.createdAt, `requests[${index}].createdAt`), round);
  if (!parsed.ok) return parsed;
  const status = source.status;
  if (typeof status !== "string" || !(REQUEST_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, code: "COORDINATION_REQUEST_STATUS_INVALID", message: `证据请求状态无效：${String(status)}`, field: `requests[${index}].status` };
  }
  return { ok: true, value: { ...parsed.value, status: status as EvidenceRequestStatus } };
}

function normalizeFinding(input: unknown, index: number, questionId: string): EvidenceFinding {
  const field = `证据报告 findings[${index}]`;
  const source = record(input, field);
  const classification = source.classification;
  if (typeof classification !== "string" || !(FINDING_CLASSIFICATIONS as readonly string[]).includes(classification)) {
    throw new CoordinationError("COORDINATION_FINDING_CLASSIFICATION_INVALID", `${field}.classification 无效`, `${field}.classification`);
  }
  const findingQuestionId = identifier(source.questionId, `${field}.questionId`);
  if (findingQuestionId !== questionId) {
    throw new CoordinationError("COORDINATION_FINDING_QUESTION_MISMATCH", `${field}.questionId 与当前请求不匹配`, `${field}.questionId`);
  }
  if (!Array.isArray(source.sources)) {
    throw new CoordinationError(source.sources === undefined ? "COORDINATION_FIELD_MISSING" : "COORDINATION_FIELD_TYPE", `${field}.sources 必须是数组`, `${field}.sources`);
  }
  const parsedSources = source.sources.map((item, sourceIndex) => parseSource(item, `${field}.sources[${sourceIndex}]`));
  if (classification !== "unconfirmed" && parsedSources.length === 0) {
    throw new CoordinationError("COORDINATION_EVIDENCE_SOURCE_MISSING", `${field} 的 ${classification} 结论必须有来源`, `${field}.sources`);
  }
  // 单条 finding 内先完成全部字段校验，再按规范化后的 id/location/version 无损合并且保留首次出现顺序；
  // 同 id 不同版本或同版本不同位置仍分别失败，非法重复项不因去重被跳过。
  const sourcesById = new Map<string, EvidenceSource>();
  const sources: EvidenceSource[] = [];
  for (const [sourceIndex, item] of parsedSources.entries()) {
    const previous = sourcesById.get(item.id);
    if (!previous) {
      sourcesById.set(item.id, item);
      sources.push(item);
      continue;
    }
    if (previous.version !== item.version) {
      throw new CoordinationError(
        "COORDINATION_SOURCE_VERSION_CONFLICT",
        `${field} 的来源 ${item.id} 同时报告了版本 ${previous.version} 和 ${item.version}`,
        `${field}.sources[${sourceIndex}].version`,
      );
    }
    if (previous.location !== item.location) {
      throw new CoordinationError(
        "COORDINATION_SOURCE_LOCATION_CONFLICT",
        `${field} 的来源 ${item.id} 在版本 ${item.version} 下报告了不同位置：${previous.location} / ${item.location}`,
        `${field}.sources[${sourceIndex}].location`,
      );
    }
  }
  return {
    findingId: identifier(source.findingId, `${field}.findingId`),
    questionId: findingQuestionId,
    classification: classification as EvidenceClassification,
    statement: requiredText(source.statement, `${field}.statement`),
    sources,
  };
}

function normalizeTestResult(input: unknown, index: number): EvidenceTestResult {
  const field = `证据报告 testsRun[${index}]`;
  const source = record(input, field);
  return {
    command: requiredText(source.command, `${field}.command`),
    result: requiredText(source.result, `${field}.result`),
  };
}

export function parseEvidenceReport(
  input: EvidenceReportInput,
  request: EvidenceRequest,
  now: number,
): CoordinationResult<EvidenceReport> {
  try {
    const source = record(input, "证据报告");
    const requestId = identifier(source.requestId, "证据报告 requestId");
    if (requestId !== request.requestId) {
      throw new CoordinationError("COORDINATION_REPORT_REQUEST_MISMATCH", "证据报告不属于当前待处理请求", "requestId");
    }
    if (!Array.isArray(source.findings) || source.findings.length === 0) {
      throw new CoordinationError(source.findings === undefined ? "COORDINATION_FIELD_MISSING" : "COORDINATION_REPORT_FINDINGS_EMPTY", "证据报告必须包含至少一个发现（可明确标记为 unconfirmed）", "findings");
    }
    const findings = source.findings.map((finding, index) => normalizeFinding(finding, index, request.questionId));
    if (new Set(findings.map((finding) => finding.findingId)).size !== findings.length) {
      throw new CoordinationError("COORDINATION_FINDING_DUPLICATE", "证据报告包含重复 findingId", "findings");
    }
    const latestSourceVersions = new Map<string, string>();
    for (const finding of findings) {
      for (const item of finding.sources) {
        const previousVersion = latestSourceVersions.get(item.id);
        if (previousVersion !== undefined && previousVersion !== item.version) {
          throw new CoordinationError("COORDINATION_SOURCE_VERSION_CONFLICT", `同一报告对来源 ${item.id} 报告了冲突版本`, "findings.sources");
        }
        latestSourceVersions.set(item.id, item.version);
      }
    }
    if (!Array.isArray(source.testsRun) && source.testsRun !== undefined) {
      throw new CoordinationError("COORDINATION_FIELD_TYPE", "证据报告 testsRun 必须是数组", "testsRun");
    }
    return {
      ok: true,
      value: {
        reportId: source.reportId === undefined ? randomUUID() : identifier(source.reportId, "证据报告 reportId"),
        requestId,
        findings,
        inspectedScope: textList(source.inspectedScope, "证据报告 inspectedScope", { required: true }),
        testsLocated: textList(source.testsLocated, "证据报告 testsLocated"),
        testsRun: Array.isArray(source.testsRun) ? source.testsRun.map(normalizeTestResult) : [],
        unresolved: textList(source.unresolved, "证据报告 unresolved"),
        createdAt: timestamp(now, "reportedAt"),
      },
    };
  } catch (error) {
    return asFailure(error);
  }
}

export function parseEvidenceReview(
  input: EvidenceReviewInput,
  report: EvidenceReport,
  now: number,
): CoordinationResult<EvidenceReview> {
  try {
    const source = record(input, "证据审阅");
    const reportId = identifier(source.reportId, "证据审阅 reportId");
    if (reportId !== report.reportId) throw new CoordinationError("COORDINATION_REVIEW_REPORT_MISMATCH", "审阅不属于当前待审阅报告", "reportId");
    const decision = source.decision;
    if (typeof decision !== "string" || !(REVIEW_DECISIONS as readonly string[]).includes(decision)) {
      throw new CoordinationError("COORDINATION_REVIEW_DECISION_INVALID", "证据审阅 decision 必须是 accept、more 或 block", "decision");
    }
    const acceptedEvidence = parseEvidenceReferences(source.acceptedEvidence, "证据审阅 acceptedEvidence");
    const gaps = textList(source.gaps, "证据审阅 gaps");
    const reason = source.reason === undefined ? undefined : requiredText(source.reason, "证据审阅 reason");
    for (const reference of acceptedEvidence) {
      const finding = report.findings.find((candidate) => candidate.findingId === reference.findingId);
      if (!finding || finding.classification !== "fact") {
        throw new CoordinationError("COORDINATION_ONLY_FACTS_ACCEPTABLE", "推断、未确认或冲突结论不能作为已接受事实", "acceptedEvidence");
      }
      if (!finding.sources.some((item) => item.id === reference.sourceId && item.version === reference.sourceVersion)) {
        throw new CoordinationError("COORDINATION_EVIDENCE_VERSION_MISMATCH", `证据来源版本与报告不匹配：${reference.sourceId}`, "acceptedEvidence");
      }
    }
    if (decision === "accept") {
      // report.unresolved 是取证者披露的未知项；architect 通过 review.gaps 明确标记哪些未知项阻塞本轮。
      // accept 且 gaps 为空表示其余 unresolved 已被判断为非阻塞，不抹去报告中的原始披露。
      if (gaps.length > 0) {
        throw new CoordinationError("COORDINATION_EVIDENCE_INCOMPLETE", "审阅仍有阻塞缺口，不能接受为证据充分", "gaps");
      }
      if (acceptedEvidence.length === 0) {
        throw new CoordinationError("COORDINATION_ACCEPT_WITHOUT_FACTS", "必须明确接受至少一条来源可追溯的事实", "acceptedEvidence");
      }
    }
    if (decision === "more" && gaps.length === 0) {
      throw new CoordinationError("COORDINATION_REVIEW_GAPS_MISSING", "要求继续取证时必须列出具体缺口", "gaps");
    }
    if (decision === "block" && !reason) {
      throw new CoordinationError("COORDINATION_REVIEW_REASON_MISSING", "阻塞审阅必须说明原因", "reason");
    }
    return {
      ok: true,
      value: {
        reviewId: source.reviewId === undefined ? randomUUID() : identifier(source.reviewId, "证据审阅 reviewId"),
        reportId,
        decision: decision as EvidenceReviewDecision,
        acceptedEvidence,
        gaps,
        ...(reason ? { reason } : {}),
        reviewedAt: timestamp(now, "reviewedAt"),
      },
    };
  } catch (error) {
    return asFailure(error);
  }
}

function normalizeStoredReview(input: unknown, report: EvidenceReport, index: number): CoordinationResult<EvidenceReview> {
  const source = record(input, `协作状态 reviews[${index}]`);
  const parsed = parseEvidenceReview(source as unknown as EvidenceReviewInput, report, timestamp(source.reviewedAt, `reviews[${index}].reviewedAt`));
  if (!parsed.ok) return parsed;
  const reviewId = identifier(source.reviewId, `reviews[${index}].reviewId`);
  const reopeningId = source.reopeningId === undefined ? undefined : identifier(source.reopeningId, `reviews[${index}].reopeningId`);
  return { ok: true, value: { ...parsed.value, reviewId, ...(reopeningId ? { reopeningId } : {}) } };
}

function normalizeStoredReviewReopening(input: unknown, index: number): EvidenceReviewReopening {
  const source = record(input, `协作状态 reviewReopenings[${index}]`);
  return {
    reopeningId: identifier(source.reopeningId, `reviewReopenings[${index}].reopeningId`),
    requestId: identifier(source.requestId, `reviewReopenings[${index}].requestId`),
    reportId: identifier(source.reportId, `reviewReopenings[${index}].reportId`),
    previousReviewId: identifier(source.previousReviewId, `reviewReopenings[${index}].previousReviewId`),
    reason: requiredText(source.reason, `reviewReopenings[${index}].reason`),
    createdAt: timestamp(source.createdAt, `reviewReopenings[${index}].createdAt`),
  };
}

function validateReviewReopeningHistory(
  reopenings: EvidenceReviewReopening[],
  reviews: EvidenceReview[],
  reports: EvidenceReport[],
  requests: Map<string, EvidenceRequest>,
) {
  const reportById = new Map(reports.map((report) => [report.reportId, report]));
  const reviewById = new Map(reviews.map((review) => [review.reviewId, review]));
  const reopeningById = new Map(reopenings.map((reopening) => [reopening.reopeningId, reopening]));
  const reviewByReopeningId = new Map<string, EvidenceReview>();

  for (const review of reviews) {
    if (!review.reopeningId) continue;
    const reopening = reopeningById.get(review.reopeningId);
    if (!reopening || reopening.reportId !== review.reportId) {
      throw new CoordinationError("COORDINATION_REOPEN_REVIEW_MISMATCH", "复审引用了不存在或不匹配的重开记录", "reviews");
    }
    if (reviewByReopeningId.has(review.reopeningId)) {
      throw new CoordinationError("COORDINATION_REOPEN_REVIEW_DUPLICATE", "同一重开记录包含多个复审", "reviews");
    }
    reviewByReopeningId.set(review.reopeningId, review);
  }

  const reopeningsByReport = new Map<string, EvidenceReviewReopening[]>();
  for (const reopening of reopenings) {
    const report = reportById.get(reopening.reportId);
    if (!report || report.requestId !== reopening.requestId || !requests.has(reopening.requestId)) {
      throw new CoordinationError("COORDINATION_REOPEN_REPORT_MISMATCH", "重开记录引用了不存在或不匹配的请求/报告", "reviewReopenings");
    }
    if (!reviewById.has(reopening.previousReviewId)) {
      throw new CoordinationError("COORDINATION_REOPEN_REVIEW_MISSING", "重开记录缺少原阻塞审阅", "reviewReopenings");
    }
    const grouped = reopeningsByReport.get(reopening.reportId) ?? [];
    grouped.push(reopening);
    reopeningsByReport.set(reopening.reportId, grouped);
  }

  for (const report of reports) {
    const reportReviews = reviews.filter((review) => review.reportId === report.reportId);
    const reportReopenings = reopeningsByReport.get(report.reportId) ?? [];
    if (reportReviews[0]?.reopeningId) {
      throw new CoordinationError("COORDINATION_REOPEN_HISTORY_INVALID", "报告首轮审阅不能引用重开记录", "reviews");
    }
    if (reportReopenings.length > reportReviews.length) {
      throw new CoordinationError("COORDINATION_REOPEN_HISTORY_INVALID", "报告重开次数超过其复审轮次", "reviewReopenings");
    }
    for (let index = 1; index < reportReviews.length; index += 1) {
      const previousReview = reportReviews[index - 1];
      const review = reportReviews[index];
      const reopening = review.reopeningId ? reopeningById.get(review.reopeningId) : undefined;
      if (!reopening || reopening.reportId !== report.reportId
        || reopening.requestId !== report.requestId
        || reopening.previousReviewId !== previousReview.reviewId
        || previousReview.decision !== "block"
        || reopening.createdAt < previousReview.reviewedAt
        || review.reviewedAt < reopening.createdAt) {
        throw new CoordinationError("COORDINATION_REOPEN_HISTORY_INVALID", "同一报告的再次审阅必须由紧邻的明确阻塞记录重开", "reviews");
      }
    }
    for (let index = 0; index < reportReopenings.length; index += 1) {
      const reopening = reportReopenings[index];
      const previousReview = index === 0
        ? reportReviews[0]
        : reviewByReopeningId.get(reportReopenings[index - 1].reopeningId);
      if (!previousReview || previousReview.reviewId !== reopening.previousReviewId || previousReview.decision !== "block"
        || reopening.createdAt < previousReview.reviewedAt) {
        throw new CoordinationError("COORDINATION_REOPEN_HISTORY_INVALID", "重开记录必须关联同一报告最近的明确阻塞审阅", "reviewReopenings");
      }
      const linkedReview = reviewByReopeningId.get(reopening.reopeningId);
      if (index < reportReopenings.length - 1 && !linkedReview) {
        throw new CoordinationError("COORDINATION_REOPEN_HISTORY_INVALID", "后续重开前必须完成上一重开轮次的审阅", "reviewReopenings");
      }
    }
  }
}

function semanticRequestKey(request: EvidenceRequest): string {
  return JSON.stringify({
    question: request.question.toLowerCase(),
    scope: request.scope.map((value) => value.toLowerCase()).sort(),
    exclusions: request.exclusions.map((value) => value.toLowerCase()).sort(),
    completionCriteria: request.completionCriteria.map((value) => value.toLowerCase()).sort(),
  });
}

export function deriveCoordinationPhase(requests: EvidenceRequest[]): CoordinationPhase {
  const latestByQuestion = new Map<string, EvidenceRequest>();
  for (const request of requests) latestByQuestion.set(request.questionId, request);
  const latest = [...latestByQuestion.values()];
  if (latest.some((request) => request.status === "blocked")) return "blocked";
  if (latest.some((request) => request.status === "reported")) return "evidence-review";
  if (latest.some((request) => request.status === "pending" || request.status === "follow-up-needed")) return "evidence-gathering";
  return "ready";
}

export function hydrateCoordinationState(input: CoordinationStateInput): CoordinationResult<CoordinationState> {
  try {
    const source = record(input, "协作状态");
    if (source.version !== 1 && source.version !== 2) {
      throw new CoordinationError("COORDINATION_VERSION_UNSUPPORTED", `协作状态版本不受支持：${String(source.version)}`, "version");
    }
    if (!Array.isArray(source.requests) || !Array.isArray(source.reports) || !Array.isArray(source.reviews)) {
      throw new CoordinationError("COORDINATION_STATE_ARRAY_INVALID", "协作状态 requests/reports/reviews 必须是数组");
    }
    if (source.version === 2 && !Array.isArray(source.reviewReopenings)) {
      throw new CoordinationError("COORDINATION_STATE_ARRAY_INVALID", "协作状态 version 2 必须包含 reviewReopenings 数组", "reviewReopenings");
    }
    const requests = source.requests.map((item, index) => {
      const parsed = normalizeStoredRequest(item, index);
      if (!parsed.ok) throw new CoordinationError(parsed.code, parsed.message, parsed.field);
      return parsed.value;
    });
    if (new Set(requests.map((request) => request.requestId)).size !== requests.length) {
      throw new CoordinationError("COORDINATION_REQUEST_DUPLICATE", "协作状态包含重复 requestId", "requests");
    }
    const activeRequests = requests.filter((request) =>
      request.status === "pending" || request.status === "reported" || request.status === "follow-up-needed",
    );
    if (activeRequests.length > 0) {
      const activeIds = new Set(activeRequests.map((request) => request.questionId));
      if (activeIds.size !== activeRequests.length) {
        throw new CoordinationError("COORDINATION_STATE_INCONSISTENT", "同一问题只能有一个未完成取证交接", "requests");
      }
    }
    const requestById = new Map(requests.map((request) => [request.requestId, request]));
    const reports = source.reports.map((item, index) => {
      const value = record(item, `协作状态 reports[${index}]`);
      const request = requestById.get(identifier(value.requestId, `reports[${index}].requestId`));
      if (!request) throw new CoordinationError("COORDINATION_REPORT_REQUEST_MISSING", "证据报告引用了不存在的请求", `reports[${index}].requestId`);
      const parsed = parseEvidenceReport(value as unknown as EvidenceReportInput, request, timestamp(value.createdAt, `reports[${index}].createdAt`));
      if (!parsed.ok) throw new CoordinationError(parsed.code, parsed.message, parsed.field);
      return { ...parsed.value, reportId: identifier(value.reportId, `reports[${index}].reportId`) };
    });
    if (new Set(reports.map((report) => report.reportId)).size !== reports.length
      || new Set(reports.map((report) => report.requestId)).size !== reports.length) {
      throw new CoordinationError("COORDINATION_REPORT_DUPLICATE", "协作状态包含重复 reportId 或每个请求存在多个报告", "reports");
    }
    const reportById = new Map(reports.map((report) => [report.reportId, report]));
    const reviewReopenings = source.version === 1
      ? []
      : (source.reviewReopenings as unknown[]).map((item, index) => normalizeStoredReviewReopening(item, index));
    const reviews = source.reviews.map((item, index) => {
      const value = record(item, `协作状态 reviews[${index}]`);
      const report = reportById.get(identifier(value.reportId, `reviews[${index}].reportId`));
      if (!report) throw new CoordinationError("COORDINATION_REVIEW_REPORT_MISSING", "证据审阅引用了不存在的报告", `reviews[${index}].reportId`);
      const parsed = normalizeStoredReview(value, report, index);
      if (!parsed.ok) throw new CoordinationError(parsed.code, parsed.message, parsed.field);
      return parsed.value;
    });
    if (new Set(reviews.map((review) => review.reviewId)).size !== reviews.length) {
      throw new CoordinationError("COORDINATION_REVIEW_DUPLICATE", "协作状态包含重复 reviewId", "reviews");
    }
    if (new Set(reviewReopenings.map((reopening) => reopening.reopeningId)).size !== reviewReopenings.length) {
      throw new CoordinationError("COORDINATION_REOPEN_DUPLICATE", "协作状态包含重复 reopeningId", "reviewReopenings");
    }
    validateReviewReopeningHistory(reviewReopenings, reviews, reports, requestById);

    const latestReviewForReport = (reportId: string) => reviews.findLast((review) => review.reportId === reportId);
    const pendingReopeningForReport = (reportId: string) => reviewReopenings.findLast((reopening) =>
      reopening.reportId === reportId && !reviews.some((review) => review.reopeningId === reopening.reopeningId));

    const roundsByQuestion = new Map<string, number>();
    for (const [index, request] of requests.entries()) {
      const expectedRound = (roundsByQuestion.get(request.questionId) ?? 0) + 1;
      if (request.round !== expectedRound) {
        throw new CoordinationError("COORDINATION_ROUND_INVALID", `问题 ${request.questionId} 的轮次应为 ${expectedRound}`, `requests[${index}].round`);
      }
      roundsByQuestion.set(request.questionId, expectedRound);
      const previous = index > 0
        ? [...requests.slice(0, index)].reverse().find((candidate) => candidate.questionId === request.questionId)
        : undefined;
      if (!previous && (request.followUpOfRequestId || request.addressesGaps.length > 0)) {
        throw new CoordinationError("COORDINATION_FOLLOW_UP_ID_MISMATCH", "首轮请求不能引用前序请求或审阅缺口", `requests[${index}].followUpOfRequestId`);
      }
      if (request.followUpOfRequestId) {
        const previousReport = previous && reports.find((candidate) => candidate.requestId === previous.requestId);
        const previousReview = previousReport && latestReviewForReport(previousReport.reportId);
        if (!previous || request.followUpOfRequestId !== previous.requestId || previousReview?.decision !== "more"
          || !request.addressesGaps.some((gap) => previousReview.gaps.includes(gap))) {
          throw new CoordinationError("COORDINATION_FOLLOW_UP_ID_MISMATCH", "补查请求必须引用上一轮的 more 审阅及其明确缺口", `requests[${index}].followUpOfRequestId`);
        }
      }
      if (previous) {
        const previousReport = reports.find((candidate) => candidate.requestId === previous.requestId);
        const previousReview = previousReport && latestReviewForReport(previousReport.reportId);
        if (previousReview?.decision === "more" && request.followUpOfRequestId !== previous.requestId) {
          throw new CoordinationError("COORDINATION_FOLLOW_UP_ID_MISMATCH", "more 审阅后的下一轮必须关联原请求", `requests[${index}].followUpOfRequestId`);
        }
        if (previousReview?.decision === "block") {
          throw new CoordinationError("COORDINATION_QUESTION_BLOCKED", "已阻塞的问题不能在没有明确处置的情况下自行重开", `requests[${index}].questionId`);
        }
        if (previousReview?.decision === "accept" && semanticRequestKey(request) === semanticRequestKey(previous) && !request.refreshReason) {
          throw new CoordinationError("COORDINATION_NO_PROGRESS", "重复已接受请求必须说明来源变化或其他重新核实理由", `requests[${index}].refreshReason`);
        }
        if (previousReview?.decision !== "more" && (request.followUpOfRequestId || request.addressesGaps.length > 0)) {
          throw new CoordinationError("COORDINATION_FOLLOW_UP_ID_MISMATCH", "只有 more 审阅可以创建补查关联", `requests[${index}].followUpOfRequestId`);
        }
      }
    }

    for (const request of requests) {
      const report = reports.find((candidate) => candidate.requestId === request.requestId);
      const reportReviews = report ? reviews.filter((candidate) => candidate.reportId === report.reportId) : [];
      const review = reportReviews.at(-1);
      const pendingReopening = report ? pendingReopeningForReport(report.reportId) : undefined;
      if (request.status === "pending" && (report || reportReviews.length > 0 || pendingReopening)) {
        throw new CoordinationError("COORDINATION_STATE_INCONSISTENT", `待处理请求 ${request.requestId} 已有报告或审阅`, "requests");
      }
      if (request.status === "reported" && (!report || (review && (review.decision !== "block" || pendingReopening?.previousReviewId !== review.reviewId)))) {
        throw new CoordinationError("COORDINATION_STATE_INCONSISTENT", `报告待审请求 ${request.requestId} 状态不一致`, "requests");
      }
      if (request.status === "accepted" && (!report || review?.decision !== "accept" || pendingReopening)) {
        throw new CoordinationError("COORDINATION_STATE_INCONSISTENT", `已接受请求 ${request.requestId} 缺少 accept 审阅`, "requests");
      }
      if (request.status === "follow-up-needed" && (!report || review?.decision !== "more" || pendingReopening)) {
        throw new CoordinationError("COORDINATION_STATE_INCONSISTENT", `待补查请求 ${request.requestId} 缺少 more 审阅`, "requests");
      }
      if (request.status === "blocked" && (!report || review?.decision !== "block" || pendingReopening)) {
        throw new CoordinationError("COORDINATION_STATE_INCONSISTENT", `阻塞请求 ${request.requestId} 缺少有效 block 审阅`, "requests");
      }
      if (request.status === "superseded" && (!report || !review || pendingReopening)) {
        throw new CoordinationError("COORDINATION_STATE_INCONSISTENT", `已替代请求 ${request.requestId} 缺少报告或审阅`, "requests");
      }
    }

    const workflowLink = source.workflowLink === undefined
      ? undefined
      : (() => {
          const link = record(source.workflowLink, "协作状态 workflowLink");
          const planVersion = timestamp(link.planVersion, "workflowLink.planVersion");
          const recoveryGeneration = timestamp(link.recoveryGeneration, "workflowLink.recoveryGeneration");
          return { workflowId: identifier(link.workflowId, "workflowLink.workflowId"), planVersion, recoveryGeneration };
        })();
    const phase = source.phase;
    if (typeof phase !== "string" || !(COORDINATION_PHASES as readonly string[]).includes(phase)) {
      throw new CoordinationError("COORDINATION_PHASE_INVALID", `协作状态 phase 无效：${String(phase)}`, "phase");
    }
    const expectedPhase = deriveCoordinationPhase(requests);
    if (phase !== expectedPhase) throw new CoordinationError("COORDINATION_STATE_INCONSISTENT", `协作状态 phase 应为 ${expectedPhase}，收到 ${phase}`, "phase");
    const createdAt = timestamp(source.createdAt, "协作状态 createdAt");
    const updatedAt = timestamp(source.updatedAt, "协作状态 updatedAt");
    if (updatedAt < createdAt) throw new CoordinationError("COORDINATION_TIMESTAMP_INVALID", "协作状态 updatedAt 早于 createdAt", "updatedAt");
    if (requests.some((request) => request.createdAt < createdAt || request.createdAt > updatedAt)
      || reviewReopenings.some((reopening) => reopening.createdAt < createdAt || reopening.createdAt > updatedAt)
      || reports.some((report) => {
        const request = requestById.get(report.requestId)!;
        return report.createdAt < request.createdAt || report.createdAt > updatedAt;
      })
      || reviews.some((review) => {
        const report = reportById.get(review.reportId)!;
        return review.reviewedAt < report.createdAt || review.reviewedAt > updatedAt;
      })) {
      throw new CoordinationError("COORDINATION_TIMESTAMP_REGRESSION", "协作事件时间戳不符合请求、报告、审阅的先后顺序", "updatedAt");
    }

    return {
      ok: true,
      value: {
        version: 2,
        coordinationId: identifier(source.coordinationId, "协作状态 coordinationId"),
        sessionId: requiredText(source.sessionId, "协作状态 sessionId"),
        phase: phase as CoordinationPhase,
        requests,
        reports,
        reviews,
        reviewReopenings,
        ...(workflowLink ? { workflowLink } : {}),
        createdAt,
        updatedAt,
      },
    };
  } catch (error) {
    return asFailure(error);
  }
}
