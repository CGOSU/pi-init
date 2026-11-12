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

function verificationWarnings(task: WorkflowCompletionTaskView) {
  return [
    ...(task.verificationFailures.length ? ["验证未通过：" + task.verificationFailures.join("；")] : []),
    ...(task.verificationPending.length ? ["验证未执行：" + task.verificationPending.join("；")] : []),
    ...(task.verificationUnclassified.length ? ["历史验证未判定：" + task.verificationUnclassified.join("；")] : []),
  ];
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
    ...verificationWarnings(view.task),
  ].join("\n");
}

/** Full tool text preserves completion data for the model and for expanded inspection. */
export function formatWorkflowTaskCompletionText(view: WorkflowTaskCompletionView) {
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
    ...verificationWarnings(view.task).map(warning => "   - " + warning),
  ].join("\n");
}

export function formatWorkflowCompletionTimingLines(view: WorkflowCompletionView) {
  return [
    `开始时间：${formatWorkflowTimestamp(view.startedAt, "不可用（工作流未记录有效的开始时间）")}`,
    `结束时间：${formatWorkflowTimestamp(view.completedAt, "不可用（工作流未记录有效的结束时间）")}`,
    `总耗时：${durationText(view.duration, "不可用（工作流缺少有效的起止时间或暂停计时记录）")}${view.duration.kind === "available" ? "（不含暂停）" : ""}`,
  ];
}

function summaryText(text: string, limit: number) {
  const characters = Array.from(text.replace(/\s+/gu, " ").trim());
  return characters.length > limit ? characters.slice(0, limit).join("") + "…" : characters.join("");
}

function completionAttention(view: WorkflowCompletionView) {
  const counts = [
    ["项验证失败", view.tasks.reduce((total, task) => total + task.verificationFailures.length, 0)],
    ["项验证未执行", view.tasks.reduce((total, task) => total + task.verificationPending.length, 0)],
    ["项历史验证未判定", view.tasks.reduce((total, task) => total + task.verificationUnclassified.length, 0)],
    ["项任务未记录验证", view.tasks.filter(task => !task.verification.length).length],
    ["项阻塞记录待核对", view.tasks.filter(task => task.blockReason).length],
    ["项任务结果未知，禁止重放", view.tasks.filter(task => task.outcomeUnknown).length],
  ] as const;
  const warnings = counts.filter(([, count]) => count > 0).map(([label, count]) => `${count}${label}`);
  return warnings.length ? `需注意：${warnings.join("；")}（详见展开详情）` : undefined;
}

/** Default completion is bounded; detailed evidence remains available in the expanded report. */
export function formatWorkflowCompletionSummaryText(view: WorkflowCompletionView) {
  const finalResult = view.finalTask?.completionSummary ?? view.finalTask?.task;
  const attention = completionAttention(view);
  return [
    `工作流完成：${summaryText(view.summary, 80)}`,
    `结果：${finalResult ? summaryText(finalResult, 160) : "未记录最终结果"} · 任务 ${view.progress.completed}/${view.progress.total}`,
    ...formatWorkflowCompletionTimingLines(view),
    ...(attention ? [attention] : []),
  ].join("\n");
}

/** Shared recorded basis for model reports, expanded inspection, and deterministic delivery. */
export function formatWorkflowCompletionText(view: WorkflowCompletionView) {
  return [
    "工作流完成报告",
    `目标：${view.summary}`,
    `已完成任务：${view.progress.completed}/${view.progress.total}`,
    ...(view.finalTask ? [`最终结果：${view.finalTask.completionSummary ?? view.finalTask.task}`] : []),
    ...formatWorkflowCompletionTimingLines(view),
    `状态：${view.status}`,
    `约束与限制：${view.constraints.join("；") || "未记录额外约束"}`,
    "",
    "任务结果：",
    ...view.tasks.flatMap(task => taskReportLines(task).map(line => `   - ${line}`)),
    "",
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
  const [heading, ...summaryLines] = formatWorkflowCompletionSummaryText(view).split("\n");
  return new Text([
    section(theme, "◆ " + heading),
    ...summaryLines.map((line) => line.startsWith("需注意：")
      ? theme.fg("warning", line)
      : /^(?:开始时间|结束时间|总耗时)：/u.test(line)
        ? theme.fg("muted", line)
        : theme.fg("text", line)),
  ].join("\n"), 0, 0);
}
