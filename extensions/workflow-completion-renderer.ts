import { Text } from "@earendil-works/pi-tui";
import type { ReportTheme } from "./contracts.ts";
import type {
  CompletionDuration,
  WorkflowCompletionTaskView,
  WorkflowCompletionView,
  WorkflowTaskCompletionView,
} from "./workflow-completion-view.ts";
import { formatWorkflowDuration, formatWorkflowTimestamp } from "./workflow-view-format.ts";

const TASK_DURATION_UNAVAILABLE = "不可用（历史任务未记录有效的开始时间）";

function durationText(duration: CompletionDuration, unavailableText: string) {
  return formatWorkflowDuration(
    duration.kind === "available" ? duration.milliseconds : undefined,
    unavailableText,
  );
}

function verificationText(task: WorkflowCompletionTaskView) {
  return task.verificationFailures.length > 0
    ? `验证：${task.verificationFailures.join("；")}`
    : undefined;
}

function taskReportLines(task: WorkflowCompletionTaskView) {
  return [
    `ID：${task.id}`,
    `内容：${task.task}`,
    `摘要：${task.completionSummary ?? "无"}`,
    `实现原因：${task.implementationRationale ?? "无"}`,
    `状态：${task.status}${task.blockReason ? `；阻塞：${task.blockReason}` : ""}`,
    ...(task.outcomeUnknown ? ["副作用结果未知，禁止重放"] : []),
    ...(task.verification.length ? task.verification.map(item => `验证记录：${item}`) : ["验证：未记录，不代表验证通过"]),
  ];
}

/** Concise user-facing text; the full tool result remains available through the detailed renderer. */
export function formatWorkflowTaskCompletionSummaryText(view: WorkflowTaskCompletionView) {
  return [
    "任务完成报告",
    `已完成：${view.task.task}`,
    ...(view.task.completionSummary ? [`结果：${view.task.completionSummary}`] : []),
    ...(view.task.verificationFailures.length > 0
      ? [`验证未通过：${view.task.verificationFailures.join("；")}`]
      : []),
  ].join("\n");
}

/** Full tool text preserves completion data for the model and for expanded inspection. */
export function formatWorkflowTaskCompletionText(view: WorkflowTaskCompletionView) {
  const verification = verificationText(view.task);
  return [
    "任务完成报告",
    "",
    "1. 任务",
    `   - ID：${view.task.id}`,
    `   - 内容：${view.task.task}`,
    "",
    "2. 完成情况",
    `   - 摘要：${view.task.completionSummary ?? "无"}`,
    `   - 实现原因：${view.task.implementationRationale ?? "无"}`,
    "",
    "3. 执行结果",
    `   - 耗时：${durationText(view.duration, TASK_DURATION_UNAVAILABLE)}`,
    ...(verification ? [`   - ${verification}`] : []),
  ].join("\n");
}

/** Concise user-facing text; task records and timing stay in expanded details. */
export function formatWorkflowCompletionSummaryText(view: WorkflowCompletionView) {
  const finalResult = view.finalTask?.completionSummary ?? view.finalTask?.task;
  return [
    "工作流完成报告",
    `目标：${view.summary}`,
    `已完成任务：${view.progress.completed}/${view.progress.total}`,
    ...(finalResult ? [`最终结果：${finalResult}`] : []),
    ...(view.finalTask && view.finalTask.verificationFailures.length > 0
      ? [`验证未通过：${view.finalTask.verificationFailures.join("；")}`]
      : []),
  ].join("\n");
}

/** Shared recorded basis for model reports, expanded inspection, and deterministic delivery. */
export function formatWorkflowCompletionText(view: WorkflowCompletionView) {
  return [
    formatWorkflowCompletionSummaryText(view),
    `状态：${view.status}`,
    `约束与限制：${view.constraints.join("；") || "未记录额外约束"}`,
    "",
    "任务结果：",
    ...view.tasks.flatMap(task => taskReportLines(task).map(line => `   - ${line}`)),
    "",
    "时间：",
    `   - 开始时间：${formatWorkflowTimestamp(view.startedAt, "不可用（工作流未记录有效的开始时间）")}`,
    `   - 结束时间：${formatWorkflowTimestamp(view.completedAt, "不可用（工作流未记录有效的结束时间）")}`,
    `   - 总耗时：${durationText(view.duration, "不可用（工作流缺少有效的整体开始或结束时间）")}`,
    "限制：以上仅依据已记录的事实；未记录的验证、提交及推送状态均未知，不能推断为成功。不会自动续跑或重放任务。",
  ].join("\n");
}

export function formatWorkflowTaskCompletionDetailsText(view: WorkflowTaskCompletionView) {
  return formatWorkflowTaskCompletionText(view);
}

export function formatWorkflowCompletionDetailsText(view: WorkflowCompletionView) {
  return formatWorkflowCompletionText(view);
}

function section(theme: ReportTheme, text: string) {
  return theme.fg("accent", theme.bold(text));
}

export function renderWorkflowTaskCompletion(
  view: WorkflowTaskCompletionView,
  continuation: "next-task" | "awaiting-replan",
  theme: ReportTheme,
  expanded = false,
) {
  const continuationLine = continuation === "awaiting-replan"
    ? theme.fg("warning", "当前任务已完成，等待重规划；不会启动旧的后续任务。")
    : theme.fg("muted", "下一任务将自动开始。");
  if (expanded) {
    return new Text([
      section(theme, "◆ 任务完成详情"),
      theme.fg("text", formatWorkflowTaskCompletionDetailsText(view)),
      continuationLine,
    ].join("\n"), 0, 0);
  }
  const summaryLines = formatWorkflowTaskCompletionSummaryText(view).split("\n").slice(1);
  return new Text([
    section(theme, "◆ 任务完成报告"),
    ...summaryLines.map((line) => line.startsWith("验证未通过：")
      ? theme.fg("error", line)
      : line.startsWith("结果：")
        ? theme.fg("success", line)
        : theme.fg("text", line)),
    continuationLine,
  ].join("\n"), 0, 0);
}

export function renderWorkflowCompletion(view: WorkflowCompletionView, theme: ReportTheme, expanded = false) {
  if (expanded) {
    return new Text([
      section(theme, "◆ 工作流完成详情"),
      theme.fg("text", formatWorkflowCompletionDetailsText(view)),
    ].join("\n"), 0, 0);
  }
  const summaryLines = formatWorkflowCompletionSummaryText(view).split("\n").slice(1);
  return new Text([
    section(theme, "◆ 工作流完成报告"),
    ...summaryLines.map((line) => line.startsWith("验证未通过：")
      ? theme.fg("error", line)
      : line.startsWith("结果：")
        ? theme.fg("success", line)
        : line.startsWith("已完成任务：")
          ? theme.fg("muted", line)
          : theme.fg("text", line)),
  ].join("\n"), 0, 0);
}
