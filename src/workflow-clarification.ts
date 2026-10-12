import type {
  CoordinationResult,
  WorkflowTaskClarificationResolution,
} from "./coordination-types.ts";
import type {
  WorkflowHandoffIdentity,
  WorkflowTask,
  WorkflowTaskClarification,
  WorkflowClarificationCategory,
} from "./workflow-types.ts";

export type WorkflowTaskClarificationDraft = Omit<WorkflowTaskClarification, "issueId" | "handoff" | "createdAt">;

const CATEGORIES = ["missing-fact", "contract-conflict", "business-decision"] as const;
const SIDE_EFFECT_STATUSES = ["none", "occurred", "unknown"] as const;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failure<T>(code: string, message: string, field?: string): CoordinationResult<T> {
  return { ok: false, code, message, ...(field ? { field } : {}) };
}

function requiredText(value: unknown, field: string): CoordinationResult<string> {
  if (value === undefined || value === null) return failure("WORKFLOW_CLARIFICATION_FIELD_MISSING", `${field} 缺失`, field);
  if (typeof value !== "string") return failure("WORKFLOW_CLARIFICATION_FIELD_TYPE", `${field} 必须是文本`, field);
  const text = value.trim();
  if (!text) return failure("WORKFLOW_CLARIFICATION_FIELD_INVALID", `${field} 不能为空`, field);
  return { ok: true, value: text };
}

function textList(value: unknown, field: string): CoordinationResult<string[]> {
  if (value === undefined || value === null) return failure("WORKFLOW_CLARIFICATION_FIELD_MISSING", `${field} 缺失`, field);
  if (!Array.isArray(value)) return failure("WORKFLOW_CLARIFICATION_FIELD_TYPE", `${field} 必须是文本数组`, field);
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = requiredText(item, `${field}[${index}]`);
    if (!parsed.ok) return parsed;
    result.push(parsed.value);
  }
  return { ok: true, value: result };
}

function parseDraft(input: unknown): CoordinationResult<WorkflowTaskClarificationDraft> {
  if (!isRecord(input)) return failure("WORKFLOW_CLARIFICATION_INVALID_TYPE", "clarification 必须是对象");
  const category = input.category;
  if (typeof category !== "string" || !CATEGORIES.includes(category as WorkflowClarificationCategory)) {
    return failure("WORKFLOW_CLARIFICATION_CATEGORY_INVALID", "澄清类别必须是 missing-fact、contract-conflict 或 business-decision", "category");
  }
  const question = requiredText(input.question, "question");
  if (!question.ok) return question;
  const impact = requiredText(input.impact, "impact");
  if (!impact.ok) return impact;
  const checkedFacts = textList(input.checkedFacts, "checkedFacts");
  if (!checkedFacts.ok) return checkedFacts;
  const completedWork = textList(input.completedWork, "completedWork");
  if (!completedWork.ok) return completedWork;
  const verification = textList(input.verification, "verification");
  if (!verification.ok) return verification;
  if (!isRecord(input.sideEffects)) {
    return failure(input.sideEffects === undefined ? "WORKFLOW_CLARIFICATION_FIELD_MISSING" : "WORKFLOW_CLARIFICATION_FIELD_TYPE", "sideEffects 必须是对象", "sideEffects");
  }
  const sideEffectStatus = input.sideEffects.status;
  if (typeof sideEffectStatus !== "string" || !SIDE_EFFECT_STATUSES.includes(sideEffectStatus as typeof SIDE_EFFECT_STATUSES[number])) {
    return failure("WORKFLOW_CLARIFICATION_SIDE_EFFECT_STATUS_INVALID", "sideEffects.status 必须是 none、occurred 或 unknown", "sideEffects.status");
  }
  const sideEffectDetails = textList(input.sideEffects.details, "sideEffects.details");
  if (!sideEffectDetails.ok) return sideEffectDetails;
  if (sideEffectStatus === "none" && sideEffectDetails.value.length > 0) {
    return failure("WORKFLOW_CLARIFICATION_SIDE_EFFECT_CONFLICT", "sideEffects.status=none 时 details 必须为空", "sideEffects.details");
  }
  if (sideEffectStatus !== "none" && sideEffectDetails.value.length === 0) {
    return failure("WORKFLOW_CLARIFICATION_SIDE_EFFECT_DETAILS_MISSING", "sideEffects.status 为 occurred/unknown 时必须说明已知副作用或核对缺口", "sideEffects.details");
  }
  return {
    ok: true,
    value: {
      category: category as WorkflowClarificationCategory,
      question: question.value,
      impact: impact.value,
      checkedFacts: checkedFacts.value,
      completedWork: completedWork.value,
      verification: verification.value,
      sideEffects: { status: sideEffectStatus as WorkflowTaskClarification["sideEffects"]["status"], details: sideEffectDetails.value },
    },
  };
}

export function parseWorkflowTaskClarificationInput(input: unknown): CoordinationResult<WorkflowTaskClarificationDraft> {
  if (isRecord(input) && ["issueId", "handoff", "createdAt"].some((key) => key in input)) {
    return failure("WORKFLOW_CLARIFICATION_IDENTITY_FORBIDDEN", "澄清身份由当前任务 handoff 生成，调用方不能自行指定");
  }
  return parseDraft(input);
}

function normalizeHandoffIdentity(input: unknown): CoordinationResult<WorkflowHandoffIdentity> {
  if (!isRecord(input)) return failure("WORKFLOW_CLARIFICATION_IDENTITY_INVALID", "澄清记录缺少 handoff identity", "handoff");
  const textFields = ["workflowId", "sessionId", "taskId", "attemptId", "handoffId"] as const;
  const normalized: Record<string, unknown> = {};
  for (const field of textFields) {
    const parsed = requiredText(input[field], `handoff.${field}`);
    if (!parsed.ok) return { ...parsed, code: "WORKFLOW_CLARIFICATION_IDENTITY_INVALID" };
    if (parsed.value.length > 128 || (field === "taskId" && !TOKEN_PATTERN.test(parsed.value))) {
      return failure("WORKFLOW_CLARIFICATION_IDENTITY_INVALID", `handoff.${field} 格式无效`, `handoff.${field}`);
    }
    normalized[field] = parsed.value;
  }
  for (const field of ["planVersion", "recoveryGeneration"] as const) {
    const value = input[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return failure("WORKFLOW_CLARIFICATION_IDENTITY_INVALID", `handoff.${field} 必须是非负安全整数`, `handoff.${field}`);
    }
    normalized[field] = value;
  }
  return { ok: true, value: normalized as unknown as WorkflowHandoffIdentity };
}

export function validateWorkflowTaskClarification(input: unknown): CoordinationResult<WorkflowTaskClarification> {
  if (!isRecord(input)) return failure("WORKFLOW_CLARIFICATION_INVALID_TYPE", "已保存的澄清记录必须是对象");
  const draft = parseDraft(input);
  if (!draft.ok) return draft;
  const issueId = requiredText(input.issueId, "issueId");
  if (!issueId.ok) return issueId;
  const normalizedIssueId = issueId.value.toLowerCase();
  if (!TOKEN_PATTERN.test(normalizedIssueId)) {
    return failure("WORKFLOW_CLARIFICATION_ID_INVALID", "澄清 issueId 格式无效", "issueId");
  }
  const handoff = normalizeHandoffIdentity(input.handoff);
  if (!handoff.ok) return handoff;
  const createdAt = input.createdAt;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt < 0) {
    return failure("WORKFLOW_CLARIFICATION_TIMESTAMP_INVALID", "澄清 createdAt 必须是非负时间戳", "createdAt");
  }
  return { ok: true, value: { ...draft.value, issueId: normalizedIssueId, handoff: handoff.value, createdAt } };
}

export function cloneWorkflowTaskClarification(clarification: WorkflowTaskClarification): WorkflowTaskClarification {
  return {
    ...clarification,
    checkedFacts: [...clarification.checkedFacts],
    completedWork: [...clarification.completedWork],
    verification: [...clarification.verification],
    sideEffects: { ...clarification.sideEffects, details: [...clarification.sideEffects.details] },
    handoff: { ...clarification.handoff },
  };
}

function expectedResolutionKind(category: WorkflowClarificationCategory): WorkflowTaskClarificationResolution["resolutionKind"] {
  if (category === "missing-fact") return "evidence";
  if (category === "contract-conflict") return "contract";
  return "decision";
}

export function validateClarificationResolutionCoverage(
  tasks: readonly WorkflowTask[],
  previousTasks: readonly WorkflowTask[],
): CoordinationResult<{ ready: true }> {
  const clarifications = previousTasks.flatMap((task) => task.clarification ? [task.clarification] : []);
  const resolved = tasks.flatMap((task) => task.contract
    ? task.contract.clarificationResolutions.map((resolution) => ({ task, resolution }))
    : []);
  const knownIssueIds = new Set(clarifications.map((item) => item.issueId));
  for (const item of resolved) {
    if (!knownIssueIds.has(item.resolution.issueId)) {
      return failure("WORKFLOW_CLARIFICATION_UNKNOWN", `重规划引用了不存在的澄清 issueId：${item.resolution.issueId}`, "clarificationResolutions");
    }
  }
  for (const clarification of clarifications) {
    const matches = resolved.filter((item) => item.resolution.issueId === clarification.issueId);
    if (matches.length === 0) {
      return failure("WORKFLOW_CLARIFICATION_UNRESOLVED", `新任务契约尚未回应澄清 ${clarification.issueId}`, "clarificationResolutions");
    }
    if (matches.length > 1) {
      return failure("WORKFLOW_CLARIFICATION_RESOLUTION_DUPLICATE", `澄清 ${clarification.issueId} 被多个任务重复处置`, "clarificationResolutions");
    }
    const { task, resolution } = matches[0];
    if (resolution.resolutionKind !== expectedResolutionKind(clarification.category)) {
      return failure("WORKFLOW_CLARIFICATION_RESOLUTION_KIND_MISMATCH", `澄清 ${clarification.issueId} 的处置类型与类别不匹配`, "clarificationResolutions");
    }
    if (clarification.category === "missing-fact" && task.contract?.evidence.length === 0) {
      return failure("WORKFLOW_CLARIFICATION_EVIDENCE_MISSING", `事实澄清 ${clarification.issueId} 必须引用已接受证据`, "evidence");
    }
    if ((clarification.category === "contract-conflict" || clarification.category === "business-decision")
      && task.contract?.fixedDecisions.length === 0) {
      return failure("WORKFLOW_CLARIFICATION_DECISION_MISSING", `澄清 ${clarification.issueId} 必须记录已确认的固定决策`, "fixedDecisions");
    }
    if (clarification.sideEffects.status === "none" && resolution.sideEffectDisposition !== "none") {
      return failure("WORKFLOW_CLARIFICATION_SIDE_EFFECT_DISPOSITION_INVALID", `澄清 ${clarification.issueId} 没有副作用时 disposition 必须是 none`, "sideEffectDisposition");
    }
    if (clarification.sideEffects.status !== "none" && resolution.sideEffectDisposition === "none") {
      return failure("WORKFLOW_CLARIFICATION_SIDE_EFFECT_UNRESOLVED", `澄清 ${clarification.issueId} 的副作用状态未核实或已发生，必须显式 reconciled 或 no-replay`, "sideEffectDisposition");
    }
  }
  return { ok: true, value: { ready: true } };
}

export { expectedResolutionKind };
