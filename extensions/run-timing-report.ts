import type { RunTimingEntryData } from "./contracts.ts";

function stageDuration(start: unknown, end: unknown) {
  if (
    typeof start !== "number"
    || !Number.isFinite(start)
    || typeof end !== "number"
    || !Number.isFinite(end)
    || end < start
  ) return undefined;
  return end - start;
}

export function formatRunTimingDiagnostics(
  data: RunTimingEntryData,
  formatDuration: (milliseconds: number | undefined) => string,
) {
  const values = [data.inputAt, data.beforeAgentStartAt, data.beforeProviderRequestAt, data.firstMessageUpdateAt, data.settledAt];
  if (!values.some((value) => typeof value === "number" && Number.isFinite(value))) return [];
  const stage = (label: string, start: unknown, end: unknown) => `${label}：${formatDuration(stageDuration(start, end))}`;
  return [
    "阶段耗时：",
    stage("input → before_agent_start", data.inputAt, data.beforeAgentStartAt),
    stage("before_agent_start → agent_start", data.beforeAgentStartAt, data.startedAt),
    stage("agent_start → before_provider_request", data.startedAt, data.beforeProviderRequestAt),
    stage("before_provider_request → 首个 assistant 更新", data.beforeProviderRequestAt, data.firstMessageUpdateAt),
    stage("首个 assistant 更新 → agent_settled", data.firstMessageUpdateAt, data.settledAt ?? data.completedAt),
  ];
}
