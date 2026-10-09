export const WORKFLOW_RECOVERY_DISPOSITION_TYPE = "pi-init-workflow-recovery-disposition";
export const WORKFLOW_RECOVERY_DISPOSITION_VERSION = 1;

export type WorkflowRecoveryClassification =
  | {
      kind: "discardable";
      code: string;
      message: string;
      requiresUnknownOutcomeConfirmation: true;
    }
  | {
      kind: "recoverable";
      code: string;
      message: string;
      action: "switch-session-or-plan" | "cancel-valid-state";
    }
  | { kind: "blocked"; code: string; message: string };

export type WorkflowRecoveryCommandInput = {
  sourceEntryId: string;
  confirmedUnknownOutcome: true;
};

export type WorkflowRecoveryDispositionRecord = {
  version: 1;
  action: "discard";
  sessionId: string;
  sourceEntryId: string;
  sourceErrorCode: string;
  confirmedUnknownOutcome: true;
};

export type WorkflowRecoveryDispositionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

function fail(code: string, message: string): WorkflowRecoveryDispositionResult<never> {
  return { ok: false, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeIdentifier(value: unknown, label: string) {
  if (typeof value !== "string") return fail("WORKFLOW_RECOVERY_DISPOSITION_IDENTIFIER_TYPE", `${label} 必须是文本`);
  const normalized = value.trim();
  if (!normalized) return fail("WORKFLOW_RECOVERY_DISPOSITION_IDENTIFIER_MISSING", `${label} 不能为空`);
  if (normalized !== value) return fail("WORKFLOW_RECOVERY_DISPOSITION_IDENTIFIER_WHITESPACE", `${label} 不能包含首尾空白`);
  if (normalized.length > 256) return fail("WORKFLOW_RECOVERY_DISPOSITION_IDENTIFIER_LENGTH", `${label} 不能超过 256 个字符`);
  return { ok: true as const, value: normalized };
}

export function classifyWorkflowRecoveryError(code: unknown): WorkflowRecoveryDispositionResult<WorkflowRecoveryClassification> {
  if (typeof code !== "string") return fail("WORKFLOW_RECOVERY_ERROR_CODE_TYPE", "恢复错误 code 必须是文本");
  const normalized = code.trim();
  if (!normalized) return fail("WORKFLOW_RECOVERY_ERROR_CODE_MISSING", "恢复错误 code 不能为空");

  switch (normalized) {
    case "WORKFLOW_STATE_MISSING":
    case "WORKFLOW_STATE_INVALID_TYPE":
    case "WORKFLOW_STATE_INVALID":
    case "WORKFLOW_STATE_RUNTIME_RETIRED":
    case "WORKFLOW_EXECUTOR_RETIRED":
    case "WORKFLOW_EXECUTOR_INVALID":
    case "WORKFLOW_HANDOFF_STATE_MISMATCH":
    case "WORKFLOW_HANDOFF_IDENTITY_MISMATCH":
      return {
        ok: true,
        value: {
          kind: "discardable",
          code: normalized,
          message: "已保存的记录无法安全恢复；隔离前必须核对旧任务可能产生的外部副作用。",
          requiresUnknownOutcomeConfirmation: true,
        },
      };
    case "WORKFLOW_SESSION_MISMATCH":
      return {
        ok: true,
        value: {
          kind: "recoverable",
          code: normalized,
          message: "记录属于其他 Pi session；请回到所属 session，或在当前项目受信任时由架构角色创建新计划。",
          action: "switch-session-or-plan",
        },
      };
    case "WORKFLOW_EXECUTION_ROLE_FORBIDDEN":
    case "WORKFLOW_TASK_ROLE_INVALID":
      return {
        ok: true,
        value: {
          kind: "recoverable",
          code: normalized,
          message: "工作流身份仍可读取；检查任务后可显式取消该工作流。",
          action: "cancel-valid-state",
        },
      };
    case "WORKFLOW_SESSION_ID_UNAVAILABLE":
      return {
        ok: true,
        value: {
          kind: "blocked",
          code: normalized,
          message: "Pi SessionManager 未提供可靠 sessionId；修复 session 环境后再恢复，不得隔离记录。",
        },
      };
    case "WORKFLOW_RECOVERY_PERSIST_FAILED":
      return {
        ok: true,
        value: {
          kind: "blocked",
          code: normalized,
          message: "恢复状态尚未持久化；修复 Session 存储并重新加载，不能用隔离掩盖写入失败。",
        },
      };
    default:
      return {
        ok: true,
        value: {
          kind: "blocked",
          code: normalized,
          message: "未识别的恢复错误；没有安全的隔离操作，请保留记录并进一步诊断。",
        },
      };
  }
}

export function parseWorkflowRecoveryCommandInput(
  sourceEntryIdInput: unknown,
  confirmationInput: unknown,
): WorkflowRecoveryDispositionResult<WorkflowRecoveryCommandInput> {
  const sourceEntryId = normalizeIdentifier(sourceEntryIdInput, "原 Session entry ID");
  if (!sourceEntryId.ok) return sourceEntryId;
  if (confirmationInput !== true) {
    return fail("WORKFLOW_RECOVERY_DISPOSITION_CONFIRMATION_REQUIRED", "必须先核对旧任务结果及潜在外部副作用，并附加 --confirm-unknown-outcome");
  }
  return {
    ok: true,
    value: { sourceEntryId: sourceEntryId.value, confirmedUnknownOutcome: true },
  };
}

export function parseWorkflowRecoveryDisposition(input: unknown): WorkflowRecoveryDispositionResult<WorkflowRecoveryDispositionRecord> {
  if (!isRecord(input)) return fail("WORKFLOW_RECOVERY_DISPOSITION_TYPE", "隔离处置记录必须是对象");
  if (input.version !== WORKFLOW_RECOVERY_DISPOSITION_VERSION) {
    return fail("WORKFLOW_RECOVERY_DISPOSITION_VERSION", `不支持的隔离处置版本：${String(input.version)}`);
  }
  if (input.action !== "discard") return fail("WORKFLOW_RECOVERY_DISPOSITION_ACTION", "隔离处置 action 必须是 discard");
  if (input.confirmedUnknownOutcome !== true) {
    return fail("WORKFLOW_RECOVERY_DISPOSITION_CONFIRMATION_REQUIRED", "隔离处置必须明确确认旧任务结果及潜在外部副作用已核对");
  }

  const sessionId = normalizeIdentifier(input.sessionId, "隔离处置 sessionId");
  if (!sessionId.ok) return sessionId;
  const sourceEntryId = normalizeIdentifier(input.sourceEntryId, "隔离处置 sourceEntryId");
  if (!sourceEntryId.ok) return sourceEntryId;
  const classification = classifyWorkflowRecoveryError(input.sourceErrorCode);
  if (!classification.ok) return classification;
  if (classification.value.kind !== "discardable") {
    return fail(
      "WORKFLOW_RECOVERY_DISPOSITION_ERROR_NOT_DISCARDABLE",
      `恢复错误 ${classification.value.code} 不允许隔离：${classification.value.message}`,
    );
  }

  return {
    ok: true,
    value: {
      version: WORKFLOW_RECOVERY_DISPOSITION_VERSION,
      action: "discard",
      sessionId: sessionId.value,
      sourceEntryId: sourceEntryId.value,
      sourceErrorCode: classification.value.code,
      confirmedUnknownOutcome: true,
    },
  };
}

export function createWorkflowRecoveryDisposition(input: unknown): WorkflowRecoveryDispositionResult<WorkflowRecoveryDispositionRecord> {
  if (!isRecord(input)) return fail("WORKFLOW_RECOVERY_DISPOSITION_INPUT_TYPE", "隔离处置输入必须是对象");
  return parseWorkflowRecoveryDisposition({
    version: WORKFLOW_RECOVERY_DISPOSITION_VERSION,
    action: "discard",
    ...input,
  });
}

export function workflowRecoveryDispositionMatches(
  input: unknown,
  expected: { sessionId: unknown; sourceEntryId: unknown; sourceErrorCode: unknown },
): WorkflowRecoveryDispositionResult<boolean> {
  const parsed = parseWorkflowRecoveryDisposition(input);
  if (!parsed.ok) return parsed;
  const sessionId = normalizeIdentifier(expected.sessionId, "当前 sessionId");
  if (!sessionId.ok) return sessionId;
  const sourceEntryId = normalizeIdentifier(expected.sourceEntryId, "当前 sourceEntryId");
  if (!sourceEntryId.ok) return sourceEntryId;
  const sourceErrorCode = classifyWorkflowRecoveryError(expected.sourceErrorCode);
  if (!sourceErrorCode.ok) return sourceErrorCode;
  if (sourceErrorCode.value.kind !== "discardable") {
    return fail("WORKFLOW_RECOVERY_DISPOSITION_ERROR_NOT_DISCARDABLE", "当前恢复错误不允许隔离");
  }
  return {
    ok: true,
    value: parsed.value.sessionId === sessionId.value
      && parsed.value.sourceEntryId === sourceEntryId.value
      && parsed.value.sourceErrorCode === sourceErrorCode.value.code,
  };
}
