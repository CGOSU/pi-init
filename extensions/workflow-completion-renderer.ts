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

export function formatWorkflowCompletionText(view: WorkflowCompletionView) {
  return [
    "工作流完成报告",
    "",
    "1. 总览",
    `   - 目标：${view.summary}`,
    `   - 进度：${view.progress.completed}/${view.progress.total}`,
    "",
    "2. 最终任务",
    ...taskReportLines(view.finalTask).map((line) => `   - ${line}`),
    "",
    "3. 时间",
    `   - 开始时间：${formatWorkflowTimestamp(view.startedAt, "不可用（工作流未记录有效的开始时间）")}`,
    `   - 结束时间：${formatWorkflowTimestamp(view.completedAt, "不可用（工作流未记录有效的结束时间）")}`,
    `   - 总耗时：${durationText(view.duration, "不可用（工作流缺少有效的整体开始或结束时间）")}`,
  ].join("\n");
}

function section(theme: ReportTheme, text: string) {
  return theme.fg("accent", theme.bold(text));
}

export function renderWorkflowTaskCompletion(
  view: WorkflowTaskCompletionView,
  continuation: "next-task" | "awaiting-replan",
  theme: ReportTheme,
) {
  const verification = verificationText(view.task);
  const lines = [
    section(theme, "◆ 任务完成报告"),
    "",
    section(theme, "1. 任务"),
    theme.fg("text", `   - ID：${view.task.id}`),
    theme.fg("text", `   - 内容：${view.task.task}`),
    "",
    section(theme, "2. 完成情况"),
    theme.fg("success", `   - 摘要：${view.task.completionSummary ?? "无"}`),
    theme.fg("success", `   - 实现原因：${view.task.implementationRationale ?? "无"}`),
    "",
    section(theme, "3. 执行结果"),
    theme.fg("warning", `   - 耗时：${durationText(view.duration, TASK_DURATION_UNAVAILABLE)}`),
    ...(verification ? [theme.fg("error", `   - ${verification}`)] : []),
    continuation === "awaiting-replan"
      ? theme.fg("warning", "\n当前任务已完成，等待架构师重规划，不会启动旧的后续任务。")
      : theme.fg("muted", "\n下一任务将自动开始。"),
  ];
  return new Text(lines.join("\n"), 0, 0);
}

export function renderWorkflowCompletion(view: WorkflowCompletionView, theme: ReportTheme) {
  const taskLines = view.finalTask
    ? [
        theme.fg("text", `   - ID：${view.finalTask.id}`),
        theme.fg("text", `   - 内容：${view.finalTask.task}`),
        theme.fg("success", `   - 摘要：${view.finalTask.completionSummary ?? "无"}`),
        theme.fg("success", `   - 实现原因：${view.finalTask.implementationRationale ?? "无"}`),
        ...(view.finalTask.verificationFailures.length > 0
          ? [theme.fg("error", `   - 验证：${view.finalTask.verificationFailures.join("；")}`)]
          : []),
      ]
    : [theme.fg("text", "   - 内容：无")];
  const lines = [
    section(theme, "◆ 工作流完成报告"),
    "",
    section(theme, "1. 总览"),
    theme.fg("success", `   - 目标：${view.summary}`),
    theme.fg("success", `   - 进度：${view.progress.completed}/${view.progress.total}`),
    "",
    section(theme, "2. 最终任务"),
    ...taskLines,
    "",
    section(theme, "3. 时间"),
    theme.fg("accent", `   - 开始时间：${formatWorkflowTimestamp(view.startedAt, "不可用（工作流未记录有效的开始时间）")}`),
    theme.fg("accent", `   - 结束时间：${formatWorkflowTimestamp(view.completedAt, "不可用（工作流未记录有效的结束时间）")}`),
    theme.fg("warning", `   - 总耗时：${durationText(view.duration, "不可用（工作流缺少有效的整体开始或结束时间）")}`),
    theme.fg("success", "\n工作流已完成。"),
  ];
  return new Text(lines.join("\n"), 0, 0);
}
