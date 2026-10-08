import type { ReportTheme } from "./contracts.ts";

const WORKFLOW_ERROR_MARKER = "[PI-INIT_WORKFLOW_ERROR] ";
const SAFE_IDENTITY_FIELDS = new Set([
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
]);

type IdentityValues = Record<string, unknown>;

type WorkflowDiagnostic = {
  code: string;
  message: string;
  mismatchedFields: string[];
  expected?: IdentityValues;
  received?: IdentityValues;
  nextAction?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseWorkflowDiagnostic(content: string): WorkflowDiagnostic | undefined {
  if (!content.startsWith(WORKFLOW_ERROR_MARKER)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(WORKFLOW_ERROR_MARKER.length));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)
    || typeof parsed.code !== "string"
    || !/^WORKFLOW_[A-Z0-9_]+$/u.test(parsed.code)
    || typeof parsed.message !== "string") {
    return undefined;
  }

  const mismatchedFields = Array.isArray(parsed.mismatchedFields)
    ? parsed.mismatchedFields.filter((field): field is string =>
      typeof field === "string" && SAFE_IDENTITY_FIELDS.has(field))
    : [];
  return {
    code: parsed.code,
    message: parsed.message,
    mismatchedFields,
    expected: isRecord(parsed.expected) ? parsed.expected : undefined,
    received: isRecord(parsed.received) ? parsed.received : undefined,
    nextAction: typeof parsed.nextAction === "string" ? parsed.nextAction : undefined,
  };
}

function categoryForCode(code: string) {
  if (code.startsWith("WORKFLOW_ACTION_IDENTITY_")) return "动作身份校验";
  if (code.startsWith("WORKFLOW_SESSION_")) return "会话身份校验";
  if (code.startsWith("WORKFLOW_HANDOFF_")) return "任务交接校验";
  if (code.startsWith("WORKFLOW_REPLAN_")) return "重规划交接校验";
  if (code.startsWith("WORKFLOW_EXECUTION_ROLE_") || code.startsWith("WORKFLOW_TASK_ROLE_")) return "执行角色校验";
  return "工作流校验";
}

function identityValue(values: IdentityValues | undefined, field: string): string | undefined {
  const key = field === "handoff.phase" ? "phase" : field;
  if (!values || !Object.prototype.hasOwnProperty.call(values, key)) return undefined;
  const value = values[key];
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return undefined;
}

function formatIdentityDifferences(diagnostic: WorkflowDiagnostic, theme: ReportTheme) {
  if (diagnostic.mismatchedFields.length === 0) return [];
  return [
    theme.fg("warning", theme.bold("身份差异：")),
    ...diagnostic.mismatchedFields.map((field) => {
      const expected = identityValue(diagnostic.expected, field);
      const received = identityValue(diagnostic.received, field);
      if (expected === undefined && received === undefined) {
        return theme.fg("warning", `  • ${field}`);
      }
      return theme.fg("warning", `  • ${field}：当前 ${expected ?? "未提供"}；提交 ${received ?? "未提供"}`);
    }),
  ];
}

export function formatWorkflowOperationFailure(content: unknown, theme: ReportTheme): string {
  const text = typeof content === "string" ? content.trim() : "";
  const lines = [theme.fg("error", theme.bold("✕ 工作流操作失败"))];
  const diagnostic = parseWorkflowDiagnostic(text);
  if (!diagnostic) {
    lines.push(theme.fg("accent", theme.bold("类别：操作未能完成")));
    if (text) {
      const detail = text.startsWith(WORKFLOW_ERROR_MARKER)
        ? `原始诊断无法解析：${text.slice(WORKFLOW_ERROR_MARKER.length)}`
        : `原因：${text}`;
      lines.push(theme.fg("text", detail));
    } else {
      lines.push(theme.fg("text", "原因：没有提供错误详情。"));
    }
    return lines.join("\n");
  }

  lines.push(theme.fg("accent", theme.bold(`类别：${categoryForCode(diagnostic.code)}`)));
  lines.push(theme.fg("muted", `代码：${diagnostic.code}`));
  lines.push(theme.fg("text", `原因：${diagnostic.message}`));
  lines.push(...formatIdentityDifferences(diagnostic, theme));
  if (diagnostic.nextAction?.trim()) {
    lines.push(theme.fg("warning", theme.bold("建议下一步：")));
    lines.push(theme.fg("text", diagnostic.nextAction.trim()));
  }
  return lines.join("\n");
}
