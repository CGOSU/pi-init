const KINDS = new Set(["issue", "summary", "provider-request", "cache-request"]);
const PROFILE_FIELDS = ["provider", "model", "role", "thinkingLevel"];
const HOOKS = ["headers", "response", "assistant"];
const OUTCOMES = ["normal-stop", "error", "aborted", "unknown"];
const CATEGORIES = new Set(["business-rejection", "tool-failure", "provider-http", "assistant-failure", "compaction-failure",
  "suspected-loop", "suspected-slow", "context-budget", "runtime-failure", "outcome-unknown", "delivery-failure", "suspected-stall"]);

// Pure project-log aggregation. Sources identify caller-owned snapshots; no log text is returned.
export function summarizeRuntime(records) {
  if (!Array.isArray(records)) throw new TypeError("Runtime records must be an array");
  const counts = { input: records.length, accepted: 0, invalid: 0, unsupported: 0, unscoped: 0 };
  const sources = new Map();
  const quality = { flags: new Set(), sources: [], droppedReportedMax: 0, overflowReportedMax: 0 };
  const issues = new Map(), rounds = new Map(), requests = new Map(), cache = new Map();
  for (const input of records) {
    const source = sourceRef(input);
    const sourceCounts = source ? sources.get(source.sourceId) ?? { sourceId: source.sourceId, input: 0, accepted: 0, invalid: 0, unsupported: 0, unscoped: 0 } : undefined;
    if (sourceCounts) { sourceCounts.input++; sources.set(source.sourceId, sourceCounts); }
    const recordCount = name => { counts[name]++; if (sourceCounts) sourceCounts[name]++; };
    const row = input?.row;
    if (!source || !object(row)) { recordCount("invalid"); flag(quality, "invalid-records", source); continue; }
    if (row.version !== 1 || !KINDS.has(row.kind)) { recordCount("unsupported"); flag(quality, "unsupported-records", source); continue; }
    const scope = readScope(row);
    if (!scope) { recordCount("unscoped"); flag(quality, "missing-scope", source); continue; }
    const item = normalizeRecord(row, source, scope);
    if (!item) { recordCount("invalid"); flag(quality, "invalid-records", source); continue; }
    recordCount("accepted");
    observeQuality(item, quality);
    const scopeKey = JSON.stringify(scope);
    if (item.kind === "issue") mergeIssue(issues, JSON.stringify([scopeKey, item.id]), item);
    else if (item.kind === "summary") mergeLatest(rounds, JSON.stringify([scopeKey, item.run]), item);
    else if (item.kind === "provider-request") mergeLatest(requests, JSON.stringify([scopeKey, item.run, item.requestNumber]), item);
    else mergeLatest(cache, JSON.stringify([scopeKey, item.requestNumber]), item);
  }
  const roundList = sortedValues(rounds);
  const issueList = sortedValues(issues);
  const flags = [...quality.flags].sort();
  return {
    schemaVersion: 1, records: { ...counts, sources: sortedValues(sources) },
    issues: { observations: issueList.reduce((sum, item) => sum + item.count, 0), entries: issueList },
    rounds: summarizeRounds(roundList), versions: summarizeVersions(roundList),
    provider: summarizeProvider(roundList, sortedValues(requests)), cache: summarizeCache(sortedValues(cache)),
    integrity: { incomplete: flags.length > 0, flags, droppedReportedMax: quality.droppedReportedMax,
      overflowReportedMax: quality.overflowReportedMax, sourceRefs: references(quality.sources) },
    caveats: [
      "问题次数是累计问题观察，不是独立失败请求数；嵌套工具与Provider事件可能描述同一故障。",
      "normal-stop仅表示模型回合正常停止，不证明任务验收；健康基线与全部回合分开统计。",
      "缺失数据保持未知；未提供日志、轮转丢失和尚未结束的回合无法从已有记录推断。",
      "版本组来自每条记录的加载身份；不同任务复杂度未控制，不作提速或费用收益结论。",
      "dropped与overflow仅展示记录中观测到的最大值，不把重复快照相加当丢失总量。",
      "Provider请求数仅涵盖可核对的回合汇总或请求记录；hook缺失和缓存零值都不等于请求失败。",
    ],
  };
}

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function duration(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function boolean(value) { return typeof value === "boolean" ? value : null; }
function metadataText(value, pattern, limit = 128) {
  return typeof value === "string" && value.length <= limit && !value.includes("..") && !/^[A-Za-z]:/.test(value)
    && pattern.test(value) ? value : "unknown";
}
function identifier(value, limit = 128) {
  return metadataText(value, /^[A-Za-z0-9_][A-Za-z0-9_.:@|+=-]*$/, limit);
}
function toolName(value) {
  return metadataText(value, /^[A-Za-z_][A-Za-z0-9_.:-]*$/);
}
function errorCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : "UNKNOWN";
}
function modelName(value) {
  return metadataText(value, /^[A-Za-z0-9@][A-Za-z0-9_.:@+-]*(?:\/[A-Za-z0-9@][A-Za-z0-9_.:@+-]*)*$/);
}
function callId(value) {
  if (typeof value !== "string" || value.length > 512) return "unknown";
  const [parent, ...children] = value.split("/");
  if (identifier(parent, 512) === "unknown" || children.length && (!parent.startsWith("call_") || children.some(child => !/^\d+$/.test(child)))) return "unknown";
  return value;
}
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function sourceRef(input) {
  if (!object(input) || identifier(input.sourceId, 512) === "unknown" || !Number.isSafeInteger(input.line) || input.line < 1) return undefined;
  return { sourceId: input.sourceId, line: input.line };
}
function readScope(row) {
  const scope = { runtimeId: identifier(row.runtimeId), captureId: identifier(row.captureId), sessionId: identifier(row.sessionId) };
  return Object.values(scope).includes("unknown") ? undefined : scope;
}
function readIdentity(row) {
  const identity = object(row.runtimeIdentity) ? row.runtimeIdentity : {};
  const hash = (value, minimum) => typeof value === "string" && new RegExp(`^[a-f0-9]{${minimum},64}$`).test(value) ? value : "unknown";
  const version = value => typeof value === "string" && /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(value) ? value : "unknown";
  const declared = version(row.extensionVersion), loaded = version(identity.extensionVersion);
  const extensionVersion = declared !== "unknown" && loaded !== "unknown" && declared !== loaded ? "unknown"
    : loaded !== "unknown" ? loaded : declared;
  return { extensionVersion, sourceCommit: hash(identity.sourceCommit, 40), sourceFingerprint: hash(identity.sourceFingerprint, 64) };
}
function readProfile(value) {
  return Object.fromEntries(PROFILE_FIELDS.map(key => [key,
    key === "provider" || key === "model" ? modelName(value?.[key]) : metadataText(value?.[key], /^[A-Za-z][A-Za-z0-9_-]*$/)]));
}
function normalizeRecord(row, source, scope) {
  const common = { kind: row.kind, scope, source, timestamp: timestamp(row.timestamp), identity: readIdentity(row),
    dropped: count(row.dropped), overflow: count(row.overflow), incomplete: boolean(row.incomplete), evidenceTruncated: boolean(row.evidenceTruncated) };
  if (row.kind === "issue") {
    const id = identifier(row.id);
    if (id === "unknown" || count(row.count) === null || row.count < 1) return undefined;
    return { ...common, id, count: row.count, category: CATEGORIES.has(row.category) ? row.category : "unknown",
      code: errorCode(row.code), toolName: toolName(row.toolName), firstSeen: timestamp(row.firstSeen), lastSeen: timestamp(row.lastSeen),
      latestTrigger: readTrigger(row.latestTrigger) };
  }
  if (count(row.run) === null) return undefined;
  if (row.kind === "summary") return { ...common, run: row.run, profile: readProfile(row.profile), durationMs: duration(row.durationMs),
    totalTokens: count(row.tokens?.totalTokens), outcome: row.aborted === true ? "aborted" : OUTCOMES.includes(row.outcome) ? row.outcome : "unknown",
    aborted: boolean(row.aborted), issueOccurrences: count(row.issueOccurrences), profileChanged: boolean(row.profileChanged), degraded: boolean(row.degraded),
    providerObservations: readProviderCounts(row.providerObservations) };
  if (count(row.requestNumber) === null || row.requestNumber < 1) return undefined;
  if (row.kind === "provider-request") {
    const missing = row.missingObservations;
    return { ...common, run: row.run, requestNumber: row.requestNumber,
      missingObservations: Array.isArray(missing) && missing.every(hook => HOOKS.includes(hook)) ? [...new Set(missing)].sort() : null };
  }
  const knownRead = row.correlation === "ordered-hooks" && row.cacheOutcome === "assistant" && row.rawUsageState === "observed";
  const readState = knownRead && row.rawReadState === "positive" && count(row.rawReadTokens) > 0 ? "positive"
    : knownRead && row.rawReadState === "zero" && row.rawReadTokens === 0 ? "zero" : "unknown";
  return { ...common, requestNumber: row.requestNumber, readState };
}

function readTrigger(value) {
  if (!object(value)) return null;
  const data = object(value.data) ? value.data : {};
  return { event: metadataText(value.event, /^[a-z][a-z0-9_.-]*$/, 64), sequence: count(value.sequence), timestamp: timestamp(value.timestamp),
    toolCallId: callId(data.toolCallId), parentToolCallId: callId(data.parentToolCallId), toolName: toolName(data.toolName),
    action: metadataText(data.action, /^[a-z][a-z0-9_-]*$/, 64), code: errorCode(data.code), isError: boolean(data.isError), businessOk: boolean(data.businessOk),
    exitCode: Number.isSafeInteger(data.exitCode) ? data.exitCode : null };
}
function readProviderCounts(value) {
  if (!object(value) || count(value.requests) === null || count(value.missing) === null || value.missing > value.requests) return null;
  const hooks = value.missingByHook;
  const validHooks = object(hooks) && HOOKS.every(key => count(hooks[key]) !== null && hooks[key] <= value.requests);
  return { requests: value.requests, missing: value.missing,
    missingByHook: validHooks ? Object.fromEntries(HOOKS.map(key => [key, hooks[key]])) : null };
}
function flag(quality, name, source) {
  quality.flags.add(name);
  if (source) quality.sources.push(source);
}
function observeQuality(item, quality) {
  if (item.dropped > 0) flag(quality, "dropped-records", item.source);
  if (item.overflow > 0) flag(quality, "overflow", item.source);
  quality.droppedReportedMax = Math.max(quality.droppedReportedMax, item.dropped ?? 0);
  quality.overflowReportedMax = Math.max(quality.overflowReportedMax, item.overflow ?? 0);
  if (item.incomplete === true) flag(quality, "incomplete-records", item.source);
  if (item.evidenceTruncated === true) flag(quality, "evidence-truncated", item.source);
  if (Object.values(item.identity).includes("unknown")) flag(quality, "unknown-version", item.source);
  if (latestTime(item) < 0) flag(quality, "missing-timestamp", item.source);
  if (item.kind === "summary") {
    if ([item.aborted, item.incomplete, item.dropped, item.overflow, item.issueOccurrences, item.profileChanged, item.degraded].includes(null)) flag(quality, "missing-health-fields", item.source);
    if (item.durationMs === null || item.totalTokens === null) flag(quality, "missing-metrics", item.source);
    if (Object.values(item.profile).includes("unknown")) flag(quality, "unknown-profile", item.source);
    if (!item.providerObservations) flag(quality, "missing-provider-summary", item.source);
  }
}

function latestTime(item) {
  const eventTimes = [item.latestTrigger?.timestamp, item.lastSeen].filter(Boolean);
  return Math.max(...(eventTimes.length ? eventTimes : [item.timestamp]).map(value => value ? Date.parse(value) : -1));
}
function chooseLatest(left, right) {
  const difference = latestTime(left) - latestTime(right);
  if (difference) return difference > 0 ? left : right;
  const leftSource = left.latestSource ?? left.source;
  const rightSource = right.latestSource ?? right.source;
  const sourceOrder = leftSource.sourceId.localeCompare(rightSource.sourceId) || leftSource.line - rightSource.line;
  return sourceOrder >= 0 ? left : right;
}
function maximum(left, right) { return left === null && right === null ? null : Math.max(left ?? 0, right ?? 0); }
function combinedFlag(left, right) { return left === true || right === true ? true : left === null || right === null ? null : false; }
function mergeLatest(map, key, item) {
  const previous = map.get(key);
  if (!previous) { map.set(key, item); return; }
  const latest = chooseLatest(previous, item);
  map.set(key, { ...latest, dropped: maximum(previous.dropped, item.dropped), overflow: maximum(previous.overflow, item.overflow) });
}
function mergeIssue(map, key, item) {
  const previous = map.get(key);
  if (!previous) {
    map.set(key, { scope: item.scope, id: item.id, category: item.category, code: item.code, toolName: item.toolName,
      count: item.count, firstSeen: item.firstSeen, lastSeen: item.lastSeen, latestTrigger: item.latestTrigger,
      countSource: item.source, latestSource: item.source, timestamp: item.timestamp,
      incomplete: item.incomplete, evidenceTruncated: item.evidenceTruncated });
    return;
  }
  const candidate = { ...previous, category: item.category, code: item.code, toolName: item.toolName,
    lastSeen: item.lastSeen, latestTrigger: item.latestTrigger, latestSource: item.source, timestamp: item.timestamp };
  const latest = chooseLatest(previous, candidate);
  const countSource = item.count > previous.count ? item.source : item.count < previous.count ? previous.countSource
    : references([previous.countSource, item.source])[0];
  const firstSeen = [previous.firstSeen, item.firstSeen].filter(Boolean).sort()[0] ?? null;
  map.set(key, { ...latest, count: Math.max(previous.count, item.count), countSource, firstSeen,
    incomplete: combinedFlag(previous.incomplete, item.incomplete),
    evidenceTruncated: combinedFlag(previous.evidenceTruncated, item.evidenceTruncated) });
}
function sortedValues(map) { return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value); }
function references(values) {
  return [...new Map(values.map(value => [JSON.stringify(value), value])).values()]
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.line - b.line);
}
function stats(values) {
  const sorted = values.filter(value => value !== null).sort((a, b) => a - b);
  return { count: sorted.length, p50: sorted.length ? sorted[Math.ceil(sorted.length * 0.5) - 1] : null,
    p95: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null };
}
function isHealthy(item) {
  return item.outcome === "normal-stop" && item.aborted === false && item.incomplete === false
    && item.issueOccurrences === 0 && item.dropped === 0 && item.overflow === 0 && item.profileChanged === false && item.degraded === false;
}
function summarizeRounds(rounds) {
  const healthy = rounds.filter(isHealthy);
  return { count: rounds.length, outcomes: Object.fromEntries(OUTCOMES.map(outcome => [outcome, rounds.filter(item => item.outcome === outcome).length])),
    healthySamples: healthy.length, durationMs: { all: stats(rounds.map(item => item.durationMs)), healthy: stats(healthy.map(item => item.durationMs)) },
    totalTokens: { all: stats(rounds.map(item => item.totalTokens)), healthy: stats(healthy.map(item => item.totalTokens)) } };
}
function summarizeVersions(rounds) {
  const groups = new Map();
  for (const item of rounds) {
    const key = JSON.stringify([item.identity, item.profile]);
    const group = groups.get(key) ?? { identity: item.identity, profile: item.profile, items: [] };
    group.items.push(item); groups.set(key, group);
  }
  return sortedValues(groups).map(group => ({ identity: group.identity, profile: group.profile,
    comparable: ![...Object.values(group.identity), ...Object.values(group.profile)].includes("unknown"),
    rounds: summarizeRounds(group.items), sourceRefs: references(group.items.map(item => item.source)) }));
}
function summarizeProvider(rounds, requests) {
  const result = { requests: 0, missing: 0, missingKnownRequests: 0, unknownRuns: 0,
    missingByHook: { headers: 0, response: 0, assistant: 0 }, hookKnownRequests: 0, sourceRefs: [] };
  const summarized = new Set();
  const runKey = item => JSON.stringify([item.scope, item.run]);
  for (const item of rounds) {
    const counts = item.providerObservations;
    if (!counts) { result.unknownRuns++; continue; }
    summarized.add(runKey(item));
    result.requests += counts.requests; result.missing += counts.missing; result.missingKnownRequests += counts.requests;
    result.sourceRefs.push(item.source);
    if (!counts.missingByHook) continue;
    result.hookKnownRequests += counts.requests;
    for (const hook of HOOKS) result.missingByHook[hook] += counts.missingByHook[hook];
  }
  for (const item of requests) {
    if (summarized.has(runKey(item))) continue;
    result.requests++; result.sourceRefs.push(item.source);
    if (item.missingObservations === null) continue;
    result.missingKnownRequests++; result.hookKnownRequests++;
    if (item.missingObservations.length) result.missing++;
    for (const hook of item.missingObservations) result.missingByHook[hook]++;
  }
  result.sourceRefs = references(result.sourceRefs);
  return result;
}
function summarizeCache(requests) {
  return { requests: requests.length, positiveRead: requests.filter(item => item.readState === "positive").length,
    zeroRead: requests.filter(item => item.readState === "zero").length, unknownRead: requests.filter(item => item.readState === "unknown").length,
    sourceRefs: references(requests.map(item => item.source)) };
}
