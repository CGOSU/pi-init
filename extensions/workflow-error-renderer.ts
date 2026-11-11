import { Text } from "@earendil-works/pi-tui";
import type { ReportTheme } from "./contracts.ts";
import type { WorkflowErrorView, WorkflowErrorViewFailure, WorkflowErrorViewResult } from "./workflow-error-view.ts";

const WORKFLOW_ERROR_MARKER = "[PI-INIT_WORKFLOW_ERROR] ";

function categoryLabel(category: Extract<WorkflowErrorView, { kind: "diagnostic" }>["category"]) {
  switch (category) {
    case "action-identity": return "动作身份校验";
    case "session-identity": return "会话身份校验";
    case "task-handoff": return "任务交接校验";
    case "replan-handoff": return "重规划交接校验";
    case "execution-role": return "执行角色校验";
    case "workflow-validation": return "工作流校验";
  }
}

function scalarText(value: string | number | boolean | null) {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function failureLines(failure: WorkflowErrorViewFailure, theme: ReportTheme) {
  const lines = [theme.fg("accent", theme.bold("类别：操作未能完成")), theme.fg("text", `原因：${failure.message}`)];
  if (failure.kind === "invalid-diagnostic" && failure.rawText !== undefined) {
    const normalized = failure.rawText.trim();
    const rawDiagnostic = normalized.startsWith(WORKFLOW_ERROR_MARKER)
      ? normalized.slice(WORKFLOW_ERROR_MARKER.length)
      : failure.rawText;
    lines.push(theme.fg("text", `原始诊断无法解析：${rawDiagnostic}`));
  }
  return lines;
}

function identityDifferenceLines(view: Extract<WorkflowErrorView, { kind: "diagnostic" }>, theme: ReportTheme) {
  if (view.identityDifferences.length === 0) return [];
  return [
    theme.fg("warning", theme.bold("身份差异：")),
    ...view.identityDifferences.map((difference) => {
      const expected = difference.expected === undefined ? undefined : scalarText(difference.expected);
      const received = difference.received === undefined ? undefined : scalarText(difference.received);
      if (expected === undefined && received === undefined) {
        return theme.fg("warning", `  • ${difference.field}`);
      }
      return theme.fg("warning", `  • ${difference.field}：当前 ${expected ?? "未提供"}；提交 ${received ?? "未提供"}`);
    }),
  ];
}

function viewLines(view: WorkflowErrorView, theme: ReportTheme) {
  if (view.kind === "ordinary") {
    return [
      theme.fg("accent", theme.bold("类别：操作未能完成")),
      theme.fg("text", `原因：${view.text.trim()}`),
    ];
  }
  const lines = [
    theme.fg("accent", theme.bold(`类别：${categoryLabel(view.category)}`)),
    theme.fg("muted", `代码：${view.code}`),
    theme.fg("text", `原因：${view.message}`),
    ...identityDifferenceLines(view, theme),
  ];
  if (view.nextAction?.trim()) {
    lines.push(theme.fg("warning", theme.bold("建议下一步：")));
    lines.push(theme.fg("text", view.nextAction.trim()));
  }
  return lines;
}

export function renderWorkflowOperationFailure(result: WorkflowErrorViewResult, theme: ReportTheme) {
  const lines = [theme.fg("error", theme.bold("✕ 工作流操作失败"))];
  lines.push(...(result.ok ? viewLines(result.value, theme) : failureLines(result.error, theme)));
  return new Text(lines.join("\n"), 0, 0);
}
