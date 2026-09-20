import type { RunTimingEntryData } from "./contracts.ts";

function validNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stageDuration(start: unknown, end: unknown) {
  const from = validNumber(start);
  const to = validNumber(end);
  return from !== undefined && to !== undefined && to >= from ? to - from : undefined;
}

export function formatRunTimingDiagnostics(
  data: RunTimingEntryData,
  formatDuration: (milliseconds: number | undefined) => string,
) {
  const values = [
    data.inputAt,
    data.beforeAgentStartAt,
    data.beforeProviderRequestAt,
    data.firstMessageUpdateAt,
    data.assistantMessageEndAt,
    data.agentEndAt,
    data.settledAt,
  ];
  if (!values.some((value) => validNumber(value) !== undefined)) return [];
  const stage = (label: string, start: unknown, end: unknown) => `${label}：${formatDuration(stageDuration(start, end))}`;
  const lines = [
    "阶段耗时：",
    stage("input → before_agent_start", data.inputAt, data.beforeAgentStartAt),
    stage("before_agent_start → agent_start", data.beforeAgentStartAt, data.startedAt),
    stage("agent_start → before_provider_request", data.startedAt, data.beforeProviderRequestAt),
    stage("before_provider_request → 首个 assistant 更新", data.beforeProviderRequestAt, data.firstMessageUpdateAt),
    stage("首个 assistant 更新 → 最后 assistant message_end", data.firstMessageUpdateAt, data.assistantMessageEndAt),
    stage("最后 assistant message_end → agent_end", data.assistantMessageEndAt, data.agentEndAt),
    stage("最后 agent_end → agent_settled", data.agentEndAt, data.settledAt ?? data.completedAt),
  ];
  const providerCount = validNumber(data.providerRequestCount);
  if (providerCount !== undefined) lines.push(`Provider 请求次数：${providerCount}`);
  const providerDurations = Array.isArray(data.providerRequestDurations)
    ? data.providerRequestDurations.filter((value): value is number => validNumber(value) !== undefined)
    : [];
  if (providerDurations.length > 0) {
    lines.push(`Provider 各次耗时：${providerDurations.map((value, index) => `#${index + 1} ${formatDuration(value)}`).join("、")}`);
  }
  const agentStartCount = validNumber(data.agentStartCount);
  const agentEndCount = validNumber(data.agentEndCount);
  if (agentStartCount !== undefined || agentEndCount !== undefined) {
    lines.push(`Agent run 次数：${agentStartCount ?? "不可用"} 启动 / ${agentEndCount ?? "不可用"} 结束`);
  }
  const toolCount = validNumber(data.toolExecutionCount);
  if (toolCount !== undefined) {
    lines.push(`工具执行次数：${toolCount}`);
    if (toolCount > 0) {
      const names = Array.isArray(data.toolNames) ? data.toolNames.filter((name): name is string => typeof name === "string") : [];
      lines.push(`工具名称：${names.join("、") || "未知"}`);
      const durations = Array.isArray(data.toolDurations)
        ? data.toolDurations.filter((value): value is { name?: unknown; durationMs?: unknown } => value !== null && typeof value === "object")
        : [];
      if (durations.length > 0) {
        lines.push(`工具各次耗时：${durations.map((value, index) => `${value.name || `#${index + 1}`} ${formatDuration(validNumber(value.durationMs))}`).join("、")}`);
      }
      lines.push(stage("工具执行跨度", data.toolExecutionStartAt, data.toolExecutionEndAt));
      lines.push(`工具累计耗时：${formatDuration(validNumber(data.toolExecutionDurationMs))}`);
    }
  }
  return lines;
}
