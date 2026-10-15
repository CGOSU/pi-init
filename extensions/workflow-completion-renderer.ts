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

function taskReportLines(task: WorkflowCompletionTaskView | undefined) {
  if (!task) return ["内容：无"];
  return [
    `ID：${task.id}`,
    `内容：${task.task}`,
    `摘要：${task.completionSummary ?? "无"}`,
    `实现原因：${task.implementationRationale ?? "无"}`,
    ...(verificationText(task) ? [verificationText(task)!] : []),
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

/** Concise user-facing text; child identities and timing stay in expanded details. */
export function formatWorkflowCompletionSummaryText(view: WorkflowCompletionView) {
  const cancelledChildren = view.subworkflows.filter((child) => child.status === "cancelled").length;
  const completedChildren = view.subworkflows.length - cancelledChildren;
  const finalResult = view.finalTask?.completionSummary ?? view.finalTask?.task;
  return [
    "工作流完成报告",
    `目标：${view.summary}`,
    `已完成任务：${view.progress.completed}/${view.progress.total}`,
    ...(finalResult ? [`最终结果：${finalResult}`] : []),
    ...(view.subworkflows.length > 0
      ? [`子目标：${completedChildren} 完成，${cancelledChildren} 取消`]
      : []),
    ...(view.finalTask && view.finalTask.verificationFailures.length > 0
      ? [`验证未通过：${view.finalTask.verificationFailures.join("；")}`]
      : []),
  ].join("\n");
}

/** Full tool text preserves child lineage, audit details, and timing for follow-up work. */
export function formatWorkflowCompletionText(view: WorkflowCompletionView) {
  const taskSection = view.subworkflows.length > 0 ? "3. 最终任务" : "2. 最终任务";
  const timeSection = view.subworkflows.length > 0 ? "4. 时间" : "3. 时间";
  return [
    "工作流完成报告",
    "",
    "1. 总览",
    `   - 目标：${view.summary}`,
    `   - 已完成任务：${view.progress.completed}/${view.progress.total}`,
    ...(view.subworkflows.length > 0
      ? ["", "2. 子工作流历史（独立状态与结果）：", ...view.subworkflows.map((child) =>
          `   - [${child.status}] ${child.workflowId} · ${child.summary} · ${child.completed}/${child.total} · 父工作流 ${child.parentWorkflowId}${child.parentTaskId ? ` · 父任务 ${child.parentTaskId}` : ""}`)]
      : []),
    "",
    taskSection,
    ...taskReportLines(view.finalTask).map((line) => `   - ${line}`),
    "",
    timeSection,
    `   - 开始时间：${formatWorkflowTimestamp(view.startedAt, "不可用（工作流未记录有效的开始时间）")}`,
    `   - 结束时间：${formatWorkflowTimestamp(view.completedAt, "不可用（工作流未记录有效的结束时间）")}`,
    `   - 总耗时：${durationText(view.duration, "不可用（工作流缺少有效的整体开始或结束时间）")}`,
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
        : line.startsWith("已完成任务：") || line.startsWith("子目标：")
          ? theme.fg("muted", line)
          : theme.fg("text", line)),
  ].join("\n"), 0, 0);
}
