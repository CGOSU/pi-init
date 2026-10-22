import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fingerprint } from "./handoff-tool-diagnostics.ts";
import { createRequire } from "node:module";
import { normalizeProfile, durationStats, isHealthySample, formatRuntimeSamples, formatProviderObservations, type RuntimeProfile, formatContextProjections, formatToolFailureChains } from "./runtime-diagnostics-report.ts";

const extensionVersion = readExtensionVersion();

type Data = Record<string, unknown>;
type Observation = { sequence: number; timestamp: string; event: string; data: Data };
type Issue = { id: string; category: string; code: string; stage: string; toolName?: string; count: number; firstSeen: string; lastSeen: string; events: Observation[]; snapshot: unknown; latestSnapshot: unknown; latestTrigger: Observation; evidenceTruncated: boolean; incomplete: boolean; dirty: boolean };
const queues = new Map<string, Promise<void>>();
const RETENTION_MS = 7 * 86400000;
const MAX_RING_BYTES = 32 * 1024;
const MAX_ISSUES = 24;
const MAX_PENDING = 32;
const fields = new Set(["toolName", "toolCallId", "parentToolCallId", "action", "code", "status", "isError", "businessOk", "exitCode", "durationMs", "observedElapsedMs", "requestNumber", "stopReason", "errorCodeHint", "source", "aborted", "failed", "operationId", "workflowId", "taskId", "handoffId", "recoveryGeneration", "suspicionKind", "windowSize", "historyLimit", "baselineSamples", "baselineP95Ms", "tokens", "contextWindow", "percent", "reason", "decision", "headersObserved", "responseObserved", "assistantObserved", "outcome", "mode", "reasonCode", "inputBytes", "outputBytes", "budgetBytes", "checkpointed", "omittedMessages", "overBudget"]);
function metadata(data: Data): Data {
  const result: Data = {};
  for (const key of fields) {
    const value = data[key];
    if (typeof value === "string") result[key] = value.slice(0, 128);
    else if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
  return result;
}
function classify(event: string, data: Data) {
  const code = typeof data.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(data.code) ? data.code : "UNKNOWN";
  if (event === "workflow.action_rejected" || data.businessOk === false) return { category: "business-rejection", code };
  if ((event === "tool.result" || event === "routing.tool_result") && (data.isError === true || typeof data.exitCode === "number" && data.exitCode !== 0)) return { category: "tool-failure", code };
  if (event === "provider.response" && typeof data.status === "number" && data.status >= 400) return { category: "provider-http", code: "HTTP_" + data.status };
  if (event === "assistant.result" && data.stopReason === "error") return { category: "assistant-failure", code: typeof data.errorCodeHint === "string" ? data.errorCodeHint : "UNKNOWN" };
  if (event === "compaction.settled" && data.failed === true) return { category: "compaction-failure", code };
  if (event === "workflow.suspected_loop") return { category: "suspected-loop", code };
  if (event === "runtime.slow_round") return { category: "suspected-slow", code };
  if (event === "context.budget_checked" && ["failed", "error"].includes(String(data.decision))) return { category: "context-budget", code: "BUDGET_DECISION" };
  if (event === "runtime.failure") return { category: "runtime-failure", code };
  if (event === "role.handoff_dispatch_unknown") return { category: "outcome-unknown", code: "HANDOFF_DISPATCH_UNKNOWN" };
  if (event === "workflow.delivery.fallback_failed") return { category: "delivery-failure", code: "FALLBACK_FAILED" };
  if (event === "compaction.long_wait") return { category: "suspected-stall", code: "COMPACTION_LONG_WAIT" };
  return undefined;
}

export function createDiagnosticWriter(options: { file: string; maxBytes: number; maxPending: number; warning: string; retentionMs?: number; rejectOversize?: boolean; directoryMode?: number }) {
  let failed = false, pending = 0, dropped = 0;
  let tail = Promise.resolve();
  function write(ctx: ExtensionContext, record: (dropped: number) => Data) {
    if (failed || !ctx.isProjectTrusted()) return;
    if (pending >= options.maxPending) { dropped++; return; }
    const path = join(ctx.cwd, ".pi", options.file);
    const line = JSON.stringify(record(dropped)) + "\n";
    const bytes = Buffer.byteLength(line);
    if (options.rejectOversize && bytes > options.maxBytes) { dropped++; return; }
    dropped = 0; pending++;
    const write = (queues.get(path) ?? Promise.resolve()).then(async () => {
      if (failed) return;
      await mkdir(dirname(path), { recursive: true, mode: options.directoryMode });
      let size = 0;
      const expired = (mtimeMs: number) => options.retentionMs !== undefined && Date.now() - mtimeMs > options.retentionMs;
      try {
        const info = await stat(path); size = info.size;
        if (expired(info.mtimeMs)) { await rm(path, { force: true }); size = 0; }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (options.retentionMs !== undefined) {
        try { if (expired((await stat(path + ".1")).mtimeMs)) await rm(path + ".1", { force: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (size + bytes > options.maxBytes) {
        await rm(path + ".1", { force: true });
        if (size) await rename(path, path + ".1");
      }
      await appendFile(path, line, { mode: 0o600 });
    }).catch(() => {
      if (!failed) {
        failed = true;
        try { ctx.ui.notify(options.warning, "warning"); } catch {}
      }
    }).finally(() => { pending--; });
    queues.set(path, write);
    void write.then(() => { if (queues.get(path) === write) queues.delete(path); });
    tail = Promise.all([tail, write]).then(() => {});
  }
  return { write, flush: () => tail, get failed() { return failed; }, get dropped() { return dropped; } };
}

export function createRuntimeDiagnostics(snapshot: () => unknown, options: { maxBytes?: number; now?: () => number } = {}) {
  const maxBytes = Math.max(128 * 1024, Math.min(options.maxBytes ?? 2 * 1024 * 1024, 2 * 1024 * 1024));
  const runtimeId = randomUUID();
  const nowMs = options.now ?? (() => performance.now());
  let profile: RuntimeProfile | undefined;
  let profileChanged = false;
  let degraded = false;
  let stopReason: unknown;
  let baselineCwd = "";
  const baselines = new Map<string, number[]>();
  let scope = "";
  let captureId = randomUUID();
  let sequence = 0;
  let run = 0;
  let ring: Observation[] = [];
  let ringBytes = 0;
  let issues = new Map<string, Issue>();

  let startedAt: number | undefined;
  let toolCalls = 0;
  let providerRequests = 0;
  let tokens: Record<string, number> = {};
  let issueOccurrences = 0;
  let overflow = 0;
  let budget: { checks: number; decisions: Record<string, number>; last?: Data } = { checks: 0, decisions: {} };
  const emptyProviderObservations = () => ({ requests: 0, missing: 0, missingByHook: { headers: 0, response: 0, assistant: 0 } });
  let providerObservations = emptyProviderObservations();
  const emptyProjection = () => ({ checks: 0, checkpointed: 0, overBudget: 0, last: undefined as Data | undefined });
  let contextProjection = emptyProjection();
  const seen = new Set<string>();
  const writer = createDiagnosticWriter({ file: "diagnostics/runtime.jsonl", maxBytes, maxPending: MAX_PENDING, retentionMs: RETENTION_MS, rejectOversize: true, directoryMode: 0o700, warning: "运行黑匣子写入失败；已停用记录，不影响任务执行。" });
  function write(ctx: ExtensionContext, record: Data) {
    writer.write(ctx, dropped => ({ version: 1, extensionVersion, runtimeId, captureId, sessionId: ctx.sessionManager.getSessionId(), run, dropped, ...record }));
  }
  function save(ctx: ExtensionContext, issue: Issue) {
    if (!issue.dirty) return;
    write(ctx, { kind: "issue", ...issue, dirty: undefined });
    issue.dirty = false;
  }
  function captureSnapshot() {
    let state: unknown;
    try { state = snapshot(); } catch { state = { omitted: true, reason: "snapshot-unavailable" }; }
    if (Buffer.byteLength(JSON.stringify(state) ?? "") > 8192) state = { omitted: true, reason: "snapshot-budget" };
    return state;
  }
  function observe(ctx: ExtensionContext, event: string, raw: Data = {}) {
    try {
      if (writer.failed || !ctx.isProjectTrusted()) { ring = []; ringBytes = 0; issues.clear(); scope = ""; return; }
      if (baselineCwd !== ctx.cwd) { baselines.clear(); baselineCwd = ctx.cwd; }
      const nextScope = JSON.stringify([ctx.cwd, ctx.sessionManager.getSessionId()]);
      if (scope !== nextScope || event === "session.tree" || event === "session.start") {
        ring = []; ringBytes = 0; issues = new Map(); seen.clear(); startedAt = undefined; tokens = {}; toolCalls = 0; providerRequests = 0; issueOccurrences = 0; overflow = 0;
        budget = { checks: 0, decisions: {} }; providerObservations = emptyProviderObservations(); contextProjection = emptyProjection();
        scope = nextScope; captureId = randomUUID(); profile = undefined; profileChanged = false; stopReason = undefined;
      }
      const now = new Date().toISOString();
      const row = { sequence: ++sequence, timestamp: now, event, data: metadata(raw) };
      const bytes = Buffer.byteLength(JSON.stringify(row));
      ring.push(row); ringBytes += bytes;
      while (ring.length > 64 || ringBytes > MAX_RING_BYTES) ringBytes -= Buffer.byteLength(JSON.stringify(ring.shift()));
      for (const issue of issues.values()) {
        if (issue.events.length < 32) { issue.events.push(row); issue.dirty = true; }
        else { issue.events.splice(16, 1); issue.events.push(row); issue.incomplete = true; issue.evidenceTruncated = true; issue.dirty = true; }
      }
      if (event === "agent.before_start") {
        run++; startedAt = nowMs(); toolCalls = 0; providerRequests = 0; tokens = {}; issueOccurrences = 0; overflow = 0; seen.clear();
        profile = normalizeProfile(raw.profile); profileChanged = false; stopReason = undefined; degraded = raw.degraded === true;
        budget = { checks: 0, decisions: {} }; providerObservations = emptyProviderObservations(); contextProjection = emptyProjection();
      }
      const currentProfile = normalizeProfile(raw.profile);
      if (profile && (currentProfile && JSON.stringify(profile) !== JSON.stringify(currentProfile) || !ctx.model || profile.provider !== ctx.model.provider || profile.model !== ctx.model.id)) profileChanged = true;
      if (event === "assistant.result") stopReason = raw.stopReason;
      if (event === "tool.call" || event === "routing.tool_call") toolCalls++;
      if (event === "provider.request") providerRequests++;
      if (event === "assistant.result" && raw.tokens && typeof raw.tokens === "object") {
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
          const value = (raw.tokens as Data)[key];
          if (typeof value === "number" && Number.isFinite(value) && value >= 0) tokens[key] = (tokens[key] ?? 0) + value;
        }
      }
      if (event === "context.budget_checked") {
        budget.checks++; budget.last = row.data;
        const decision = typeof raw.decision === "string" && /^(?:guard|inflight|unavailable|mode|cooldown|threshold|started|failed|error)$/.test(raw.decision) ? raw.decision : "other";
        budget.decisions[decision] = (budget.decisions[decision] ?? 0) + 1;
      }
      if (event === "context.projected") {
        contextProjection.checks++;
        if (raw.checkpointed === true) contextProjection.checkpointed++;
        if (raw.overBudget === true) contextProjection.overBudget++;
        contextProjection.last = row.data;
      }
      if (event === "provider.request_summary") {
        const missingObservations = ["headers", "response", "assistant"].filter(name => raw[name + "Observed"] !== true);
        providerObservations.requests++;
        for (const hook of ["headers", "response", "assistant"] as const) if (raw[hook + "Observed"] !== true) providerObservations.missingByHook[hook]++;
        if (missingObservations.length) providerObservations.missing++;
        if (raw.outcome !== "assistant" || stopReason === "error" || stopReason === "aborted" || typeof raw.errorCodeHint === "string" || typeof raw.status === "number" && raw.status >= 400) {
          write(ctx, { kind: "provider-request", timestamp: now, ...row.data, missingObservations });
        }
      }
      const problem = classify(event, raw);
      if (problem) {
        const stage = problem.category === "business-rejection" ? "business" : problem.category === "tool-failure" ? "tool" : event;
        const toolName = typeof row.data.toolName === "string" ? row.data.toolName : raw.action === "switch_role" ? "switch_role" : event === "workflow.action_rejected" ? "task_workflow" : undefined;
        const id = fingerprint([problem.category, problem.code, stage, toolName])!;
        const occurrence = raw.toolCallId ? JSON.stringify([raw.toolCallId, problem.category, problem.code]) : undefined;
        const existing = issues.get(id);
        if (existing && toolName && !existing.toolName) { existing.toolName = toolName; existing.dirty = true; }
        if (!occurrence || !seen.has(occurrence)) {
          if (occurrence) { seen.add(occurrence); if (seen.size > 128) seen.delete(seen.values().next().value!); }
          issueOccurrences++;
          let issue = issues.get(id);
          if (!issue && issues.size < MAX_ISSUES) {
            const state = captureSnapshot();
            issue = { id, ...problem, stage, toolName, count: 0, firstSeen: now, lastSeen: now, events: ring.slice(-16), snapshot: state, latestSnapshot: state, latestTrigger: row, evidenceTruncated: ring.length > 16, incomplete: ring.length > 16, dirty: true };
            issues.set(id, issue);
            try { ctx.ui.notify("运行黑匣子已发现新问题：" + problem.category + "/" + problem.code + "。使用 /blackbox 查看。", "info"); } catch {}
          }
          if (issue) { issue.count++; issue.lastSeen = now; issue.latestTrigger = row; issue.latestSnapshot = issue.count === 1 ? issue.snapshot : captureSnapshot(); issue.dirty = true; if (issue.count === 1) save(ctx, issue); }
          else overflow++;
        }
      }
      if (event === "agent.settled" || event === "session.shutdown") {
        let summary: Data | undefined;
        if (startedAt !== undefined) {
          const durationMs = Math.max(0, nowMs() - startedAt);
          summary = { kind: "summary", timestamp: now, durationMs, toolCalls, providerRequests, tokens, profile, profileChanged, degraded, budget, contextProjection, providerObservations, issueOccurrences, overflow, aborted: raw.aborted === true, incomplete: event !== "agent.settled", outcome: raw.aborted === true ? "aborted" : stopReason === "stop" ? "normal-stop" : stopReason === "error" ? "error" : "unknown", dropped: writer.dropped };
          if (profile && profile.thinkingLevel !== "unknown" && isHealthySample(summary)) {
            const key = JSON.stringify(profile);
            const history = baselines.get(key) ?? [];
            const baseline = durationStats(history);
            if (baseline.count >= 8 && durationMs > Math.max(1000, baseline.p95! * 2)) {
              observe(ctx, "runtime.slow_round", { code: "ROUND_DURATION_OUTLIER", durationMs, baselineP95Ms: baseline.p95, baselineSamples: baseline.count });
              summary.issueOccurrences = issueOccurrences;
            } else {
              history.push(durationMs);
              if (history.length > 64) history.shift();
              baselines.set(key, history);
              if (baselines.size > 8) baselines.delete(baselines.keys().next().value!);
            }
          }
          startedAt = undefined;
        }
        for (const issue of issues.values()) save(ctx, issue);
        if (summary) { delete summary.dropped; write(ctx, summary); }
      }
    } catch {
      // Observation must never affect task execution.
    }
  }
  async function report(ctx: ExtensionContext) {
    if (!ctx.isProjectTrusted()) return "运行黑匣子：未信任项目，不读取诊断。";
    await writer.flush();
    const latest = new Map<string, Data>();
    const summaries: Data[] = [];
      const requests: Data[] = [];
    let incomplete = false;
    for (const suffix of [".1", ""]) {
      const path = join(ctx.cwd, ".pi", "diagnostics", "runtime.jsonl" + suffix);
      try {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > RETENTION_MS) continue;
        if (info.size > maxBytes) { incomplete = true; continue; }
        for (const line of (await readFile(path, "utf8")).split("\n")) {
          if (!line) continue;
          try {
            const row = JSON.parse(line);
            if (row && row.kind === "summary") summaries.push(row);
              if (row && row.kind === "provider-request") requests.push(row);
            if (row.dropped > 0 || row.overflow > 0 || row.incomplete === true) incomplete = true;
            if (row.version === 1 && row.kind === "issue" && typeof row.id === "string" && typeof row.runtimeId === "string" && Number.isSafeInteger(row.count) && row.count > 0) latest.set(JSON.stringify([row.runtimeId, row.captureId, row.sessionId, row.id]), row);
          } catch { incomplete = true; }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") incomplete = true; }
    }
    const grouped = new Map<string, { label: string; count: number }>();
    for (const row of latest.values()) {
      const label = [row.category, row.code, row.toolName].filter(value => typeof value === "string").join(" / ").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
      const item = grouped.get(String(row.id)) ?? { label, count: 0 };
      item.count += Number(row.count); grouped.set(String(row.id), item);
    }
    const lines = [...grouped.values()].sort((a, b) => b.count - a.count).slice(0, 20).map(item => item.label + "：" + item.count + " 次观察");
    return ["运行黑匣子（本地保留文件；7 天按文件更新时间清理；观察次数不等于失败请求数）", ...lines, formatToolFailureChains([...latest.values()]), formatRuntimeSamples(summaries), formatContextProjections(summaries), formatProviderObservations([...requests, ...summaries]), lines.length ? "现场：.pi/diagnostics/runtime.jsonl（含 .1 备份）" : "暂无已记录问题，不代表运行无故障。", incomplete || writer.failed || writer.dropped ? "记录不完整：存在读取/写入失败、截断或丢弃（evidenceTruncated 仅表示有界现场省略，不表示请求失败）。" : ""].filter(Boolean).join("\n");
  }
  return { observe, report, flush: () => writer.flush() };
}
function readExtensionVersion() {
  try {
    const { version } = createRequire(import.meta.url)("../package.json");
    return typeof version === "string" ? version : undefined;
  } catch { return undefined; }
}
