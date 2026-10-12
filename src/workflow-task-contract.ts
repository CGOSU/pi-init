import type {
  AcceptedEvidenceReference,
  CoordinationResult,
  TaskContractReadiness,
  WorkflowTaskClarificationResolution,
  WorkflowTaskContract,
  WorkflowTaskContractInput,
} from "./coordination-types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failure<T>(code: string, message: string, field?: string): CoordinationResult<T> {
  return { ok: false, code, message, ...(field ? { field } : {}) };
}

function requiredText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return `${field} 缺失`;
  if (typeof value !== "string") return `${field} 必须是文本`;
  if (!value.trim()) return `${field} 不能为空`;
  return undefined;
}

function textList(value: unknown, field: string): CoordinationResult<string[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return failure("TASK_CONTRACT_FIELD_TYPE", `${field} 必须是文本数组`, field);
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    const error = requiredText(item, `${field}[${index}]`);
    if (error) return failure("TASK_CONTRACT_FIELD_INVALID", error, `${field}[${index}]`);
    result.push((item as string).trim());
  }
  return { ok: true, value: result };
}

function parseEvidence(value: unknown, fieldName = "evidence"): CoordinationResult<AcceptedEvidenceReference[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return failure("TASK_CONTRACT_FIELD_TYPE", `任务契约 ${fieldName} 必须是数组`, fieldName);
  const references: AcceptedEvidenceReference[] = [];
  for (const [index, item] of value.entries()) {
    const field = `${fieldName}[${index}]`;
    if (!isRecord(item)) return failure("TASK_CONTRACT_EVIDENCE_INVALID", `任务契约 ${field} 必须是对象`, field);
    for (const key of ["findingId", "sourceId", "sourceVersion"] as const) {
      const error = requiredText(item[key], `${field}.${key}`);
      if (error) return failure("TASK_CONTRACT_EVIDENCE_INVALID", error, `${field}.${key}`);
    }
    const findingId = (item.findingId as string).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(findingId)) {
      return failure("TASK_CONTRACT_EVIDENCE_INVALID", `${field}.findingId 格式无效`, `${field}.findingId`);
    }
    references.push({
      findingId,
      sourceId: (item.sourceId as string).trim(),
      sourceVersion: (item.sourceVersion as string).trim(),
    });
  }
  const keys = references.map(({ findingId, sourceId, sourceVersion }) => `${findingId}\0${sourceId}\0${sourceVersion}`);
  if (new Set(keys).size !== keys.length) return failure("TASK_CONTRACT_EVIDENCE_DUPLICATE", `任务契约 ${fieldName} 含重复引用`, fieldName);
  return { ok: true, value: references };
}

function parseClarificationResolutions(value: unknown): CoordinationResult<WorkflowTaskClarificationResolution[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return failure("TASK_CONTRACT_FIELD_TYPE", "clarificationResolutions 必须是数组", "clarificationResolutions");
  const resolutions: WorkflowTaskClarificationResolution[] = [];
  for (const [index, item] of value.entries()) {
    const field = `clarificationResolutions[${index}]`;
    if (!isRecord(item)) return failure("TASK_CONTRACT_CLARIFICATION_INVALID", `${field} 必须是对象`, field);
    const issueIdError = requiredText(item.issueId, `${field}.issueId`);
    if (issueIdError) return failure("TASK_CONTRACT_CLARIFICATION_INVALID", issueIdError, `${field}.issueId`);
    const issueId = (item.issueId as string).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(issueId)) {
      return failure("TASK_CONTRACT_CLARIFICATION_INVALID", `${field}.issueId 格式无效`, `${field}.issueId`);
    }
    const resolutionKind = item.resolutionKind;
    if (!['evidence', 'contract', 'decision'].includes(String(resolutionKind))) {
      return failure("TASK_CONTRACT_CLARIFICATION_INVALID", `${field}.resolutionKind 无效`, `${field}.resolutionKind`);
    }
    const resolution = requiredText(item.resolution, `${field}.resolution`);
    if (resolution) return failure("TASK_CONTRACT_CLARIFICATION_INVALID", resolution, `${field}.resolution`);
    const sideEffectDisposition = item.sideEffectDisposition;
    if (!['none', 'reconciled', 'no-replay'].includes(String(sideEffectDisposition))) {
      return failure("TASK_CONTRACT_CLARIFICATION_INVALID", `${field}.sideEffectDisposition 无效`, `${field}.sideEffectDisposition`);
    }
    resolutions.push({
      issueId,
      resolutionKind: resolutionKind as WorkflowTaskClarificationResolution["resolutionKind"],
      resolution: (item.resolution as string).trim(),
      sideEffectDisposition: sideEffectDisposition as WorkflowTaskClarificationResolution["sideEffectDisposition"],
    });
  }
  if (new Set(resolutions.map((resolution) => resolution.issueId)).size !== resolutions.length) {
    return failure("TASK_CONTRACT_CLARIFICATION_DUPLICATE", "clarificationResolutions 含重复 issueId", "clarificationResolutions");
  }
  return { ok: true, value: resolutions };
}

export function validateWorkflowTaskContract(input: WorkflowTaskContractInput): CoordinationResult<WorkflowTaskContract> {
  if (!isRecord(input)) return failure("TASK_CONTRACT_INVALID_TYPE", "任务契约必须是对象");
  if (input.version !== 1) return failure("TASK_CONTRACT_VERSION_UNSUPPORTED", `任务契约版本不受支持：${String(input.version)}`, "version");
  const outcomeError = requiredText(input.outcome, "任务契约 outcome");
  if (outcomeError) return failure(input.outcome === undefined ? "TASK_CONTRACT_OUTCOME_MISSING" : "TASK_CONTRACT_OUTCOME_INVALID", outcomeError, "outcome");
  const requirementSources = textList(input.requirementSources, "requirementSources");
  if (!requirementSources.ok) return requirementSources;
  const expectedBehavior = textList(input.expectedBehavior, "expectedBehavior");
  if (!expectedBehavior.ok) return expectedBehavior;
  const evidence = parseEvidence(input.evidence);
  if (!evidence.ok) return evidence;
  const clarificationResolutions = parseClarificationResolutions(input.clarificationResolutions);
  if (!clarificationResolutions.ok) return clarificationResolutions;
  const fixedDecisions = textList(input.fixedDecisions, "fixedDecisions");
  if (!fixedDecisions.ok) return fixedDecisions;
  const invariants = textList(input.invariants, "invariants");
  if (!invariants.ok) return invariants;
  const nonGoals = textList(input.nonGoals, "nonGoals");
  if (!nonGoals.ok) return nonGoals;
  const blockingQuestions = textList(input.blockingQuestions, "blockingQuestions");
  if (!blockingQuestions.ok) return blockingQuestions;
  const engineeringDiscretion = textList(input.engineeringDiscretion, "engineeringDiscretion");
  if (!engineeringDiscretion.ok) return engineeringDiscretion;
  const verification = textList(input.verification, "verification");
  if (!verification.ok) return verification;
  return {
    ok: true,
    value: {
      version: 1,
      outcome: (input.outcome as string).trim(),
      requirementSources: requirementSources.value,
      expectedBehavior: expectedBehavior.value,
      evidence: evidence.value,
      clarificationResolutions: clarificationResolutions.value,
      fixedDecisions: fixedDecisions.value,
      invariants: invariants.value,
      nonGoals: nonGoals.value,
      blockingQuestions: blockingQuestions.value,
      engineeringDiscretion: engineeringDiscretion.value,
      verification: verification.value,
    },
  };
}

export function cloneWorkflowTaskContract(contract: WorkflowTaskContract): WorkflowTaskContract {
  return {
    ...contract,
    requirementSources: [...(contract.requirementSources ?? [])],
    expectedBehavior: [...contract.expectedBehavior],
    evidence: contract.evidence.map((reference) => ({ ...reference })),
    clarificationResolutions: (contract.clarificationResolutions ?? []).map((resolution) => ({ ...resolution })),
    fixedDecisions: [...contract.fixedDecisions],
    invariants: [...contract.invariants],
    nonGoals: [...contract.nonGoals],
    blockingQuestions: [...contract.blockingQuestions],
    engineeringDiscretion: [...contract.engineeringDiscretion],
    verification: [...contract.verification],
  };
}

export function checkWorkflowTaskContractReadiness(
  input: WorkflowTaskContractInput | undefined,
  acceptedEvidence: AcceptedEvidenceReference[],
): TaskContractReadiness {
  if (input === undefined) return { ok: true, value: { ready: true } };
  const accepted = parseEvidence(acceptedEvidence, "acceptedEvidence");
  if (!accepted.ok) return accepted;
  const parsed = validateWorkflowTaskContract(input);
  if (!parsed.ok) return parsed;
  const contract = parsed.value;
  if (contract.blockingQuestions.length > 0) {
    return failure(
      "TASK_CONTRACT_BLOCKING_QUESTIONS",
      `任务契约仍有关键未决问题：${contract.blockingQuestions.join("；")}`,
      "blockingQuestions",
    );
  }
  for (const reference of contract.evidence) {
    const sameSource = accepted.value.filter((candidate) =>
      candidate.findingId === reference.findingId && candidate.sourceId === reference.sourceId,
    );
    if (sameSource.some((candidate) => candidate.sourceVersion !== reference.sourceVersion)) {
      return failure("TASK_CONTRACT_EVIDENCE_STALE", `任务契约证据来源版本已变化：${reference.sourceId}`, "evidence");
    }
    if (!sameSource.some((candidate) => candidate.sourceVersion === reference.sourceVersion)) {
      return failure("TASK_CONTRACT_EVIDENCE_UNACCEPTED", `任务契约引用了尚未接受的证据：${reference.findingId}`, "evidence");
    }
  }
  return { ok: true, value: { ready: true } };
