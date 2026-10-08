import { Text } from "@earendil-works/pi-tui";
import { workflowProgress } from "../src/workflow.ts";
import type { ReportTheme } from "./contracts.ts";
import type { WorkflowState } from "./runtime-state.ts";

type WorkflowPauseReport = {
  formatWorkflowPauseSummary: (state: WorkflowState) => string;
  formatWorkflowState: (state: WorkflowState) => string;
};

export function renderWorkflowPauseResult(
  state: WorkflowState,
  expanded: boolean,
  theme: ReportTheme,
  report: WorkflowPauseReport,
) {
  const progress = workflowProgress(state);
  const summaryLines = report.formatWorkflowPauseSummary(state).split("\n").slice(1);
  const lines = [
    theme.fg("warning", theme.bold("⏸ 工作流已暂停")),
    theme.fg("muted", `进度：${progress.completed}/${progress.total}${progress.currentTaskId ? ` · 当前任务：${progress.currentTaskId}` : ""}`),
    ...summaryLines.map((line) => {
      const heading = line.startsWith("阻塞任务：") || line.startsWith("恢复建议：");
      const color = heading ? "accent" : line.startsWith("暂停原因：") || line.startsWith("暂停说明：") ? "warning" : "text";
      return theme.fg(color, heading ? theme.bold(line) : line);
    }),
  ];
  if (expanded) {
    lines.push(theme.fg("accent", theme.bold("技术详情：")), report.formatWorkflowState(state));
  } else {
    lines.push(theme.fg("muted", "展开结果以查看完整任务与身份状态。"));
  }
  return new Text(lines.join("\n"), 0, 0);
}
