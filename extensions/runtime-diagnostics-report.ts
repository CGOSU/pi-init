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

export function formatProviderObservations(records: Data[]) {
  const key = (row: Data) => JSON.stringify([row.runtimeId, row.captureId, row.sessionId, row.run]);
  const summaries = new Map<string, { requests: number; missing: number; missingByHook?: Data }>();
  const requests = new Map<string, Data>();
  for (const row of records) {
    if (row.kind === "summary" && row.providerObservations && typeof row.providerObservations === "object") {
      const counts = row.providerObservations as Data;
      if (Number.isSafeInteger(counts.requests) && Number.isSafeInteger(counts.missing) && Number(counts.requests) >= 0 && Number(counts.missing) >= 0 && Number(counts.missing) <= Number(counts.requests)) summaries.set(key(row), { requests: Number(counts.requests), missing: Number(counts.missing), missingByHook: counts.missingByHook && typeof counts.missingByHook === "object" ? counts.missingByHook as Data : undefined });
    } else if (row.kind === "provider-request") requests.set(JSON.stringify([key(row), row.requestNumber]), row);
  }
  let total = 0, missing = 0, detailed = 0;
  const hooks = { headers: 0, response: 0, assistant: 0 };
  const addHooks = (counts: Data | undefined, count: number) => {
    if (!counts || !Object.keys(hooks).every(key => Number.isSafeInteger(counts[key]) && Number(counts[key]) >= 0 && Number(counts[key]) <= count)) return;
    detailed += count;
    for (const key of ["headers", "response", "assistant"] as const) hooks[key] += Number(counts[key]);
  };
  for (const counts of summaries.values()) { total += counts.requests; missing += counts.missing; addHooks(counts.missingByHook, counts.requests); }
  for (const row of requests.values()) {
    if (summaries.has(key(row))) continue;
    total++;
    if (Array.isArray(row.missingObservations)) {
      const missingObservations = row.missingObservations;
      if (missingObservations.length) missing++;
      addHooks(Object.fromEntries(Object.keys(hooks).map(hook => [hook, missingObservations.includes(hook) ? 1 : 0])), 1);
    }
  }
  const detail = detailed ? "；钩子缺失（有细项的 " + detailed + " 个请求）：headers=" + hooks.headers + "，response=" + hooks.response + "，assistant=" + hooks.assistant : "";
  return "Provider 请求摘要：" + total + "；观察缺失：" + missing + detail + "（仅统计启用记录后已观察到的请求；缺失不等于请求失败，不推断启用前的请求）。";
}
export function formatCacheObservations(records: Data[]) {
  const requests = new Map<string, Data>();
  for (const row of records) {
    if (row.kind !== "cache-request" || typeof row.runtimeId !== "string" || !Number.isSafeInteger(row.requestNumber) || Number(row.requestNumber) < 1) continue;
    requests.set(JSON.stringify([row.runtimeId, row.captureId, row.sessionId, row.requestNumber]), row);
  }
  if (!requests.size) return "缓存请求诊断：暂无请求级观测（未启用、旧日志或 hook 未触发均可能；不补零）。";
  let positive = 0, zero = 0;
  for (const row of requests.values()) {
    if (row.correlation !== "ordered-hooks" || row.cacheOutcome !== "assistant" || row.rawUsageState !== "observed" || !Number.isSafeInteger(row.rawReadTokens)) continue;
    if (row.rawReadState === "positive" && Number(row.rawReadTokens) > 0) positive++;
    if (row.rawReadState === "zero" && row.rawReadTokens === 0) zero++;
  }
  const label = (value: unknown) => typeof value === "number" ? String(value) : typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 128) : "未知";
  const lines = ["缓存请求诊断：" + requests.size + "；原始读字段正值：" + positive + "；显式零：" + zero + "；未知：" + (requests.size - positive - zero)];
  for (const row of [...requests.values()].slice(-6)) {
    lines.push("请求 #" + label(row.requestNumber) + " · " + [row.profileProvider, row.profileModel, row.profileRole, row.profileThinkingLevel].map(label).join("/")
      + "：raw=" + label(row.rawUsageState) + "/" + label(row.rawReadState) + "(" + label(row.rawReadTokens) + ")"
      + "；normalized=" + label(row.normalizedReadState) + "(" + label(row.normalizedReadTokens) + ")；关联=" + label(row.correlation) + "；结束=" + label(row.cacheOutcome)
      + "；缓存键=" + label(row.cacheKeyPresence) + "；contextGeneration=" + label(row.contextGeneration) + "；压缩=" + label(row.compactionPhase));
  }
  lines.push("指纹仅对应 before_provider_request 当时选定的提示/工具/上下文字段，HMAC 只可在同一运行时比较；原始 usage 为归一化前的已解析事件，normalized 为 message_end 观察。"
    + "公开 hook 无请求 ID，关联仅依据有序 hook 与可用响应身份；实际 transport/full-delta unavailable。字段缺失、失败或关联未知不等于零命中；显式零也不证明服务端缓存未命中原因，观测不等于最终网络请求。");
  return lines.join("\n");
}
export function formatContextProjections(records: Data[]) {
  const rounds = new Map<string, Data>();
  for (const row of records) if (row.kind === "summary" && row.contextProjection && typeof row.contextProjection === "object") {
    rounds.set(JSON.stringify([row.runtimeId, row.captureId, row.sessionId, row.run]), row.contextProjection as Data);
  }
  let checks = 0, overBudget = 0, checkpointed = 0;
  for (const row of rounds.values()) {
    if (Number.isSafeInteger(row.checks) && Number(row.checks) >= 0) checks += Number(row.checks);
    if (Number.isSafeInteger(row.overBudget) && Number(row.overBudget) >= 0) overBudget += Number(row.overBudget);
    if (Number.isSafeInteger(row.checkpointed) && Number(row.checkpointed) >= 0) checkpointed += Number(row.checkpointed);
  }
  return rounds.size ? "上下文投影检查：" + checks + "；检查点：" + checkpointed + "；投影预算超额：" + overBudget + "（字节预算，不等于模型窗口耗尽；旧日志无细项）" : "";
}
export function formatToolFailureChains(records: Data[]) {
  const calls = new Map<string, { parent?: string }>();
  for (const row of records) {
    if (row.kind !== "issue") continue;
    const scope = JSON.stringify([row.runtimeId, row.captureId, row.sessionId]);
    const observations = [...(Array.isArray(row.events) ? row.events : []), row.latestTrigger];
    for (const observation of observations) {
      if (!observation || !["tool.result", "routing.tool_result"].includes(observation.event)) continue;
      const data = observation.data as Data | undefined;
      if (!data || typeof data.toolCallId !== "string" || data.businessOk === false || !(data.isError === true || typeof data.exitCode === "number" && data.exitCode !== 0)) continue;
      const key = JSON.stringify([scope, data.toolCallId]);
      const parent = typeof data.parentToolCallId === "string" ? JSON.stringify([scope, data.parentToolCallId]) : calls.get(key)?.parent;
      calls.set(key, { parent });
    }
  }
  const links = new Map<string, Set<string>>();
  for (const [key, call] of calls) {
    if (!call.parent || key === call.parent || !calls.has(call.parent)) continue;
    for (const [a, b] of [[key, call.parent], [call.parent, key]]) {
      const neighbors = links.get(a) ?? new Set<string>();
      neighbors.add(b); links.set(a, neighbors);
    }
  }
  const seen = new Set<string>();
  let chains = 0;
  for (const key of links.keys()) {
    if (seen.has(key)) continue;
    chains++;
    const pending = [key];
    while (pending.length) {
      const next = pending.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const neighbor of links.get(next) ?? []) if (!seen.has(neighbor)) pending.push(neighbor);
    }
  }
  return chains ? "已关联嵌套工具失败链：" + chains + "（仅关联已观察到的失败调用；保留各工具次数，不推断独立根因数）" : "";
}
