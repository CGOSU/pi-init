import { Text } from "@earendil-works/pi-tui";
import type { ReportTheme } from "./contracts.ts";
import type { RunTimingView, RunTimingValue } from "./run-timing-view.ts";
import { formatWorkflowDuration, formatWorkflowTimestamp } from "./workflow-view-format.ts";

const INVALID_DURATION = "不可用（无效或不完整的时间戳）";

function sourceLabel(source: RunTimingView["source"]) {
  if (source === "interactive") return "交互式输入";
  if (source === "rpc") return "RPC 输入";
  return "未知来源";
}

function timestampText(value: RunTimingValue, unavailableText: string) {
  return value.kind === "available"
    ? formatWorkflowTimestamp(value.milliseconds, unavailableText)
    : unavailableText;
}

function durationText(value: RunTimingValue) {
  return formatWorkflowDuration(
    value.kind === "available" ? value.milliseconds : undefined,
    INVALID_DURATION,
  );
}

export function formatRunTimingText(view: RunTimingView) {
  return [
    "普通执行时间报告",
    `来源：${sourceLabel(view.source)}`,
    `开始时间：${timestampText(view.startedAt, "不可用（无效的开始时间）")}`,
    `结束时间：${timestampText(view.completedAt, "不可用（无效的结束时间）")}`,
    `总耗时：${durationText(view.duration)}`,
  ].join("\n");
}

export function renderRunTimingReport(view: RunTimingView, theme: ReportTheme) {
  return new Text([
    theme.fg("accent", theme.bold("◆ 普通执行时间报告")),
    theme.fg("text", `来源：${sourceLabel(view.source)}`),
    theme.fg("accent", `开始时间：${timestampText(view.startedAt, "不可用（无效的开始时间）")}`),
    theme.fg("accent", `结束时间：${timestampText(view.completedAt, "不可用（无效的结束时间）")}`),
    theme.fg("warning", `总耗时：${durationText(view.duration)}`),
  ].join("\n"), 0, 0);
}
