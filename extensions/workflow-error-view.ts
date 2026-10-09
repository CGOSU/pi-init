const WORKFLOW_ERROR_PREFIX = "[PI-INIT_WORKFLOW_ERROR]";
const WORKFLOW_ERROR_MARKER = `${WORKFLOW_ERROR_PREFIX} `;
const SAFE_IDENTITY_FIELDS = [
  "workflowId",
  "planVersion",
  "sessionId",
  "workflowSessionId",
  "recoveryGeneration",
  "taskId",
  "attemptId",
  "handoffId",
  "revisionId",
  "handoff",
  "handoff.phase",
  "branch.handoff",
  "replan.handoff",
] as const;
const SAFE_IDENTITY_FIELD_SET: ReadonlySet<string> = new Set(SAFE_IDENTITY_FIELDS);

type SafeIdentityField = typeof SAFE_IDENTITY_FIELDS[number];
type SafeIdentityScalar = string | number | boolean | null;
type IdentityValues = Record<string, unknown>;

export type WorkflowDiagnosticCategory =
  | "action-identity"
  | "session-identity"
  | "task-handoff"
  | "replan-handoff"
  | "execution-role"
  | "workflow-validation";

export type WorkflowIdentityDifferenceView = {
  field: SafeIdentityField;
  expected?: SafeIdentityScalar;
  received?: SafeIdentityScalar;
};

export type WorkflowErrorView =
  | { kind: "ordinary"; text: string }
  | {
      kind: "diagnostic";
      category: WorkflowDiagnosticCategory;
      code: string;
      message: string;
      identityDifferences: WorkflowIdentityDifferenceView[];
      nextAction?: string;
    };

export type WorkflowErrorViewFailure = {
  kind: "invalid-input" | "invalid-diagnostic";
  code: string;
  message: string;
  rawText?: string;
};

export type WorkflowErrorViewResult =
  | { ok: true; value: WorkflowErrorView }
  | { ok: false; error: WorkflowErrorViewFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function invalidInput(code: string, message: string, rawText?: string): WorkflowErrorViewResult {
  return { ok: false, error: { kind: "invalid-input", code, message, ...(rawText !== undefined ? { rawText } : {}) } };
}

function invalidDiagnostic(code: string, message: string, rawText: string): WorkflowErrorViewResult {
  return { ok: false, error: { kind: "invalid-diagnostic", code, message, rawText } };
}

function isSafeIdentityField(value: string): value is SafeIdentityField {
  return SAFE_IDENTITY_FIELD_SET.has(value);
}

function categoryForCode(code: string): WorkflowDiagnosticCategory {
  if (code.startsWith("WORKFLOW_ACTION_IDENTITY_")) return "action-identity";
  if (code.startsWith("WORKFLOW_SESSION_")) return "session-identity";
  if (code.startsWith("WORKFLOW_HANDOFF_")) return "task-handoff";
  if (code.startsWith("WORKFLOW_REPLAN_")) return "replan-handoff";
  if (code.startsWith("WORKFLOW_EXECUTION_ROLE_") || code.startsWith("WORKFLOW_TASK_ROLE_")) return "execution-role";
  return "workflow-validation";
}

function safeIdentityValue(values: IdentityValues | undefined, field: SafeIdentityField): SafeIdentityScalar | undefined {
  const key = field === "handoff.phase" ? "phase" : field;
  if (!values || !hasOwn(values, key)) return undefined;
  const value = values[key];
  if (typeof value === "string" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function parseDiagnostic(text: string): WorkflowErrorViewResult {
  const normalized = text.trim();
  if (!normalized.startsWith(WORKFLOW_ERROR_PREFIX)) {
    return { ok: true, value: { kind: "ordinary", text } };
  }
  const rawText = text;
  if (!normalized.startsWith(WORKFLOW_ERROR_MARKER)) {
    return invalidDiagnostic("WORKFLOW_ERROR_MARKER_FORMAT", "工作流错误诊断 marker 格式无效。", rawText);
  }
  const payload = normalized.slice(WORKFLOW_ERROR_MARKER.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return invalidDiagnostic("WORKFLOW_ERROR_JSON_INVALID", "工作流错误诊断 JSON 无法解析。", rawText);
  }
  if (!isRecord(parsed)) {
    return invalidDiagnostic("WORKFLOW_ERROR_DIAGNOSTIC_NOT_OBJECT", "工作流错误诊断必须是 JSON 对象。", rawText);
  }
  if (!hasOwn(parsed, "code")) {
    return invalidDiagnostic("WORKFLOW_ERROR_CODE_MISSING", "工作流错误诊断缺少 code。", rawText);
  }
  if (typeof parsed.code !== "string") {
    return invalidDiagnostic("WORKFLOW_ERROR_CODE_TYPE", "工作流错误诊断 code 必须是字符串。", rawText);
  }
  if (!/^WORKFLOW_[A-Z0-9_]+$/u.test(parsed.code)) {
    return invalidDiagnostic("WORKFLOW_ERROR_CODE_FORMAT", "工作流错误诊断 code 格式无效。", rawText);
  }
  if (!hasOwn(parsed, "message")) {
    return invalidDiagnostic("WORKFLOW_ERROR_MESSAGE_MISSING", "工作流错误诊断缺少 message。", rawText);
  }
  if (typeof parsed.message !== "string") {
    return invalidDiagnostic("WORKFLOW_ERROR_MESSAGE_TYPE", "工作流错误诊断 message 必须是字符串。", rawText);
  }
  if (hasOwn(parsed, "mismatchedFields") && !Array.isArray(parsed.mismatchedFields)) {
    return invalidDiagnostic("WORKFLOW_ERROR_FIELDS_TYPE", "工作流错误诊断 mismatchedFields 必须是数组。", rawText);
  }
  if (hasOwn(parsed, "expected") && !isRecord(parsed.expected)) {
    return invalidDiagnostic("WORKFLOW_ERROR_EXPECTED_TYPE", "工作流错误诊断 expected 必须是对象。", rawText);
  }
  if (hasOwn(parsed, "received") && !isRecord(parsed.received)) {
    return invalidDiagnostic("WORKFLOW_ERROR_RECEIVED_TYPE", "工作流错误诊断 received 必须是对象。", rawText);
  }
  if (hasOwn(parsed, "nextAction") && typeof parsed.nextAction !== "string") {
    return invalidDiagnostic("WORKFLOW_ERROR_NEXT_ACTION_TYPE", "工作流错误诊断 nextAction 必须是字符串。", rawText);
  }

  const mismatchedFields = Array.isArray(parsed.mismatchedFields)
    ? parsed.mismatchedFields.filter((field): field is SafeIdentityField =>
      typeof field === "string" && isSafeIdentityField(field))
    : [];
  const expected = isRecord(parsed.expected) ? parsed.expected : undefined;
  const received = isRecord(parsed.received) ? parsed.received : undefined;
  const identityDifferences = mismatchedFields.map((field) => {
    const expectedValue = safeIdentityValue(expected, field);
    const receivedValue = safeIdentityValue(received, field);
    return {
      field,
      ...(expectedValue !== undefined ? { expected: expectedValue } : {}),
      ...(receivedValue !== undefined ? { received: receivedValue } : {}),
    };
  });
  return {
    ok: true,
    value: {
      kind: "diagnostic",
      category: categoryForCode(parsed.code),
      code: parsed.code,
      message: parsed.message,
      identityDifferences,
      ...(typeof parsed.nextAction === "string" ? { nextAction: parsed.nextAction } : {}),
    },
  };
}

export function createWorkflowErrorView(content: unknown): WorkflowErrorViewResult {
  if (typeof content !== "string") {
    if (content === undefined || content === null) {
      return invalidInput("WORKFLOW_ERROR_CONTENT_MISSING", "没有提供错误详情。");
    }
    return invalidInput(
      "WORKFLOW_ERROR_CONTENT_TYPE",
      `错误详情必须是文本，收到 ${Array.isArray(content) ? "array" : typeof content}。`,
    );
  }
  if (!content.trim()) {
    return invalidInput("WORKFLOW_ERROR_CONTENT_EMPTY", "没有提供错误详情。", content);
  }
  return parseDiagnostic(content);
}
