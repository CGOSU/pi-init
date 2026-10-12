import { randomUUID } from "node:crypto";
import type {
  AcceptedEvidenceReference,
  CoordinationFailure,
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
  const keys = new Set<string>();
  for (const reference of references) {
    const key = `${reference.findingId}\0${reference.sourceId}\0${reference.sourceVersion}`;
    if (keys.has(key)) throw new CoordinationError("COORDINATION_EVIDENCE_DUPLICATE", `${field} 包含重复证据引用`, field);
    keys.add(key);
  }
  return references;
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
  const sources = source.sources.map((item, sourceIndex) => parseSource(item, `${field}.sources[${sourceIndex}]`));
  if (classification !== "unconfirmed" && sources.length === 0) {
    throw new CoordinationError("COORDINATION_EVIDENCE_SOURCE_MISSING", `${field} 的 ${classification} 结论必须有来源`, `${field}.sources`);
  }
  const sourceIds = new Set<string>();
  for (const item of sources) {
    if (sourceIds.has(item.id)) throw new CoordinationError("COORDINATION_EVIDENCE_SOURCE_DUPLICATE", `${field}.sources 包含重复 source id`, `${field}.sources`);
    sourceIds.add(item.id);
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
      if (gaps.length > 0 || report.unresolved.length > 0) {
        throw new CoordinationError("COORDINATION_EVIDENCE_INCOMPLETE", "存在未解决缺口，不能接受为证据充分", "gaps");
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
  return { ok: true, value: { ...parsed.value, reviewId } };
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
    if (source.version !== 1) {
      throw new CoordinationError("COORDINATION_VERSION_UNSUPPORTED", `协作状态版本不受支持：${String(source.version)}`, "version");
    }
    if (!Array.isArray(source.requests) || !Array.isArray(source.reports) || !Array.isArray(source.reviews)) {
      throw new CoordinationError("COORDINATION_STATE_ARRAY_INVALID", "协作状态 requests/reports/reviews 必须是数组");
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
    if (activeRequests.length > 1) {
      throw new CoordinationError("COORDINATION_STATE_INCONSISTENT", "当前 local 协调状态只能有一个未完成取证交接", "requests");
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
    const reviews = source.reviews.map((item, index) => {
      const value = record(item, `协作状态 reviews[${index}]`);
      const report = reportById.get(identifier(value.reportId, `reviews[${index}].reportId`));
      if (!report) throw new CoordinationError("COORDINATION_REVIEW_REPORT_MISSING", "证据审阅引用了不存在的报告", `reviews[${index}].reportId`);
      const parsed = normalizeStoredReview(value, report, index);
      if (!parsed.ok) throw new CoordinationError(parsed.code, parsed.message, parsed.field);
      return parsed.value;
    });
    if (new Set(reviews.map((review) => review.reviewId)).size !== reviews.length
      || new Set(reviews.map((review) => review.reportId)).size !== reviews.length) {
      throw new CoordinationError("COORDINATION_REVIEW_DUPLICATE", "协作状态包含重复 reviewId 或报告被重复审阅", "reviews");
    }

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
        const previousReview = previousReport && reviews.find((candidate) => candidate.reportId === previousReport.reportId);
        if (!previous || request.followUpOfRequestId !== previous.requestId || previousReview?.decision !== "more"
          || !request.addressesGaps.some((gap) => previousReview.gaps.includes(gap))) {
          throw new CoordinationError("COORDINATION_FOLLOW_UP_ID_MISMATCH", "补查请求必须引用上一轮的 more 审阅及其明确缺口", `requests[${index}].followUpOfRequestId`);
        }
      }
      if (previous) {
        const previousReport = reports.find((candidate) => candidate.requestId === previous.requestId);
        const previousReview = previousReport && reviews.find((candidate) => candidate.reportId === previousReport.reportId);
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
      const review = report ? reviews.find((candidate) => candidate.reportId === report.reportId) : undefined;
      if (request.status === "pending" && (report || review)) throw new CoordinationError("COORDINATION_STATE_INCONSISTENT", `待处理请求 ${request.requestId} 已有报告或审阅`, "requests");
      if (request.status === "reported" && (!report || review)) throw new CoordinationError("COORDINATION_STATE_INCONSISTENT", `报告待审请求 ${request.requestId} 状态不一致`, "requests");
      if (request.status === "accepted" && (!report || review?.decision !== "accept")) throw new CoordinationError("COORDINATION_STATE_INCONSISTENT", `已接受请求 ${request.requestId} 缺少 accept 审阅`, "requests");
      if (request.status === "follow-up-needed" && (!report || review?.decision !== "more")) throw new CoordinationError("COORDINATION_STATE_INCONSISTENT", `待补查请求 ${request.requestId} 缺少 more 审阅`, "requests");
      if (request.status === "blocked" && (!report || review?.decision !== "block")) throw new CoordinationError("COORDINATION_STATE_INCONSISTENT", `阻塞请求 ${request.requestId} 缺少 block 审阅`, "requests");
      if (request.status === "superseded" && (!report || !review)) throw new CoordinationError("COORDINATION_STATE_INCONSISTENT", `已替代请求 ${request.requestId} 缺少报告或审阅`, "requests");
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
        version: 1,
        coordinationId: identifier(source.coordinationId, "协作状态 coordinationId"),
        sessionId: requiredText(source.sessionId, "协作状态 sessionId"),
        phase: phase as CoordinationPhase,
        requests,
        reports,
        reviews,
        ...(workflowLink ? { workflowLink } : {}),
        createdAt,
        updatedAt,
      },
    };
  } catch (error) {
    return asFailure(error);
  }
}

export function isEvidenceClassification(value: unknown): value is EvidenceClassification {
  return typeof value === "string" && (FINDING_CLASSIFICATIONS as readonly string[]).includes(value);
}

export function isEvidenceRequestStatus(value: unknown): value is EvidenceRequestStatus {
  return typeof value === "string" && (REQUEST_STATUSES as readonly string[]).includes(value);
}

export function isCoordinationPhase(value: unknown): value is CoordinationPhase {
  return typeof value === "string" && (COORDINATION_PHASES as readonly string[]).includes(value);
}

export function isEvidenceReviewDecision(value: unknown): value is EvidenceReviewDecision {
  return typeof value === "string" && (REVIEW_DECISIONS as readonly string[]).includes(value);
}
