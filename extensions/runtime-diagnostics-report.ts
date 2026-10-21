type Data = Record<string, unknown>;
export type RuntimeProfile = { provider: string; model: string; role: string; thinkingLevel: string };
export function normalizeProfile(value: unknown): RuntimeProfile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Data;
  const result: Data = {};
  for (const key of ["provider", "model", "role", "thinkingLevel"]) {
    const item = source[key];
    if (typeof item !== "string" || !item.trim() || item.length > 128 || /[\x00-\x1f\x7f]/.test(item)) return undefined;
    result[key] = item;
  }
  return result as RuntimeProfile;
}
export function durationStats(values: number[]): { count: number; p50?: number; p95?: number } {
  const sorted = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0 };
  return { count: sorted.length, p50: sorted[Math.max(0, Math.ceil(sorted.length * 0.5) - 1)], p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}
export function isHealthySample(row: Data) {
  return row.outcome === "normal-stop" && row.aborted === false && row.incomplete === false && row.issueOccurrences === 0
    && !(typeof row.dropped === "number" && row.dropped > 0) && !(typeof row.overflow === "number" && row.overflow > 0) && row.profileChanged !== true && row.degraded !== true;
}
export function analyzeRuntimeSamples(records: Data[]) {
  const rounds = new Map<string, Data>();
  for (const row of records) {
    if (row.version !== 1 || row.kind !== "summary" || typeof row.runtimeId !== "string" || typeof row.sessionId !== "string" || !Number.isSafeInteger(row.run) || typeof row.durationMs !== "number" || !Number.isFinite(row.durationMs) || row.durationMs < 0) continue;
    rounds.set(JSON.stringify([row.runtimeId, row.captureId, row.sessionId, row.run]), row);
  }
  const groups = new Map<string, { version: string; profile?: RuntimeProfile; durations: number[]; tokens: number[]; rounds: number; lastSeen: number }>();
  for (const row of rounds.values()) {
    const profile = normalizeProfile(row.profile);
    const version = typeof row.extensionVersion === "string" && /^[a-zA-Z0-9._+-]{1,64}$/.test(row.extensionVersion) ? row.extensionVersion : "unknown";
    const key = JSON.stringify([version, profile ?? null]);
    const group = groups.get(key) ?? { version, profile, durations: [], tokens: [], rounds: 0, lastSeen: 0 };
    group.rounds++;
    const timestamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    if (Number.isFinite(timestamp)) group.lastSeen = Math.max(group.lastSeen, timestamp);
    if (isHealthySample(row)) {
      group.durations.push(row.durationMs as number);
      const usage = row.tokens && typeof row.tokens === "object" ? row.tokens as Data : {};
      if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0) group.tokens.push(usage.totalTokens);
    }
    groups.set(key, group);
  }
  const summaries = [...groups.values()].map(group => ({ version: group.version, profile: group.profile, rounds: group.rounds, duration: durationStats(group.durations), tokens: durationStats(group.tokens), lastSeen: group.lastSeen }));
  const profiles = new Map<string, typeof summaries>();
  for (const group of summaries) {
    if (!group.profile || group.profile.thinkingLevel === "unknown" || group.version === "unknown" || group.duration.count < 8 || !group.lastSeen) continue;
    const key = JSON.stringify(group.profile);
    profiles.set(key, [...(profiles.get(key) ?? []), group]);
  }
  const comparisons: { profile: RuntimeProfile; beforeVersion: string; afterVersion: string; beforeSamples: number; afterSamples: number; durationRatio?: number; tokenRatio?: number }[] = [];
  for (const values of profiles.values()) {
    const ordered = values.sort((a, b) => a.lastSeen - b.lastSeen || a.version.localeCompare(b.version));
    if (ordered.length < 2) continue;
    const before = ordered.at(-2)!;
    const after = ordered.at(-1)!;
    if (before.lastSeen === after.lastSeen) continue;
    comparisons.push({ profile: after.profile!, beforeVersion: before.version, afterVersion: after.version, beforeSamples: before.duration.count, afterSamples: after.duration.count,
      durationRatio: before.duration.p50! > 0 ? after.duration.p50! / before.duration.p50! : undefined,
      tokenRatio: before.tokens.count >= 8 && after.tokens.count >= 8 && before.tokens.p50! > 0 ? after.tokens.p50! / before.tokens.p50! : undefined });
  }
  return { rounds: rounds.size, unknown: [...rounds.values()].filter(row => !["normal-stop", "error", "aborted"].includes(String(row.outcome))).length, normalStops: [...rounds.values()].filter(row => row.outcome === "normal-stop" && row.aborted === false).length, aborted: [...rounds.values()].filter(row => row.aborted === true).length, groups: summaries, comparisons };
}
export function formatRuntimeSamples(records: Data[]) {
  const result = analyzeRuntimeSamples(records);
  if (!result.rounds) return "暂无回合统计。";
  const lines = ["回合统计：" + result.rounds + "；正常结束观察：" + result.normalStops + "；结束未知：" + result.unknown + "；用户中止：" + result.aborted + "（不计作故障）"];
  for (const group of result.groups.slice(-8)) {
    const label = group.profile ? [group.profile.provider, group.profile.model, group.profile.role, group.profile.thinkingLevel].join("/") : "配置未知";
    lines.push(group.version + " · " + label + "：可用样本 n=" + group.duration.count + (group.duration.count ? "，p50=" + Math.round(group.duration.p50!) + "ms，p95=" + Math.round(group.duration.p95!) + "ms" : "，耗时未知") + "；totalTokens 样本 n=" + group.tokens.count + (group.tokens.count ? "，p50=" + Math.round(group.tokens.p50!) : "，未知"));
  }
  for (const comparison of result.comparisons.slice(-4)) lines.push("版本观察 " + comparison.beforeVersion + " → " + comparison.afterVersion + "（" + [comparison.profile.provider, comparison.profile.model, comparison.profile.role, comparison.profile.thinkingLevel].join("/") + "，n=" + comparison.beforeSamples + "/" + comparison.afterSamples + "）：耗时 p50 比值=" + (comparison.durationRatio?.toFixed(2) ?? "未知") + "；token p50 比值=" + (comparison.tokenRatio?.toFixed(2) ?? "未知"));
  if (!result.comparisons.length) lines.push("版本对照样本不足或配置不可比（每版本同配置至少 8 个完整无异常回合）。");
  lines.push("不同任务复杂度未控制；以上仅为同配置观察，不证明版本提速或节省费用。缺失用量不补零。");
  return lines.join("\n");
}
