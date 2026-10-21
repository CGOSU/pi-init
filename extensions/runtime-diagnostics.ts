import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fingerprint } from "./handoff-tool-diagnostics.ts";
import { createRequire } from "node:module";
const extensionVersion = readExtensionVersion();


type Data = Record<string, unknown>;
type Observation = { sequence: number; timestamp: string; event: string; data: Data };
type Issue = { id: string; category: string; code: string; stage: string; toolName?: string; count: number; firstSeen: string; lastSeen: string; events: Observation[]; snapshot: unknown; incomplete: boolean; dirty: boolean };
const queues = new Map<string, Promise<void>>();
const RETENTION_MS = 7 * 86400000;
const MAX_RING_BYTES = 32 * 1024;
const MAX_ISSUES = 24;
const MAX_PENDING = 32;
const fields = new Set(["toolName", "toolCallId", "parentToolCallId", "action", "code", "status", "isError", "businessOk", "exitCode", "durationMs", "observedElapsedMs", "requestNumber", "stopReason", "errorCodeHint", "source", "aborted", "failed", "operationId", "workflowId", "taskId", "handoffId", "recoveryGeneration"]);
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
  if (event === "runtime.failure") return { category: "runtime-failure", code };
  if (event === "role.handoff_dispatch_unknown") return { category: "outcome-unknown", code: "HANDOFF_DISPATCH_UNKNOWN" };
  if (event === "workflow.delivery.fallback_failed") return { category: "delivery-failure", code: "FALLBACK_FAILED" };
  if (event === "compaction.long_wait") return { category: "suspected-stall", code: "COMPACTION_LONG_WAIT" };
  return undefined;
}

export function createRuntimeDiagnostics(snapshot: () => unknown, options: { maxBytes?: number } = {}) {
  const maxBytes = Math.max(128 * 1024, Math.min(options.maxBytes ?? 2 * 1024 * 1024, 2 * 1024 * 1024));
  const runtimeId = randomUUID();
  let scope = "";
  let captureId = randomUUID();
  let sequence = 0;
  let run = 0;
  let ring: Observation[] = [];
  let ringBytes = 0;
  let issues = new Map<string, Issue>();
  let failed = false;
  let pending = 0;
  let dropped = 0;
  let tail = Promise.resolve();
  let startedAt: number | undefined;
  let toolCalls = 0;
  let providerRequests = 0;
  let tokens: Record<string, number> = {};
  let issueOccurrences = 0;
  let overflow = 0;
  const seen = new Set<string>();
  function write(ctx: ExtensionContext, record: Data) {
    if (failed || !ctx.isProjectTrusted()) return;
    if (pending >= MAX_PENDING) { dropped++; return; }
    const path = join(ctx.cwd, ".pi", "diagnostics", "runtime.jsonl");
    const line = JSON.stringify({ version: 1, extensionVersion, runtimeId, captureId, sessionId: ctx.sessionManager.getSessionId(), run, dropped, ...record }) + "\n";
    if (Buffer.byteLength(line) > maxBytes) { dropped++; return; }
    dropped = 0;
    pending++;
    const write = (queues.get(path) ?? Promise.resolve()).then(async () => {
      if (failed) return;
      await mkdir(join(ctx.cwd, ".pi", "diagnostics"), { recursive: true, mode: 0o700 });
      let size = 0;
      let expired = false;
      try { const info = await stat(path); size = info.size; expired = Date.now() - info.mtimeMs > RETENTION_MS; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      try { if (Date.now() - (await stat(path + ".1")).mtimeMs > RETENTION_MS) await rm(path + ".1", { force: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (expired) { await rm(path, { force: true }); size = 0; }
      if (size + Buffer.byteLength(line) > maxBytes) {
        await rm(path + ".1", { force: true });
        if (size) await rename(path, path + ".1");
      }
      await appendFile(path, line, { mode: 0o600 });
    }).catch(() => {
      if (!failed) {
        failed = true;
        try { ctx.ui.notify("运行黑匣子写入失败；已停用记录，不影响任务执行。", "warning"); } catch {}
      }
    }).finally(() => { pending--; });
    queues.set(path, write);
    void write.then(() => { if (queues.get(path) === write) queues.delete(path); });
    tail = Promise.all([tail, write]).then(() => {});
  }
  function save(ctx: ExtensionContext, issue: Issue) {
    if (!issue.dirty) return;
    write(ctx, { kind: "issue", ...issue, dirty: undefined });
    issue.dirty = false;
  }
  function observe(ctx: ExtensionContext, event: string, raw: Data = {}) {
    try {
      if (failed || !ctx.isProjectTrusted()) { ring = []; ringBytes = 0; issues.clear(); scope = ""; return; }
      const nextScope = JSON.stringify([ctx.cwd, ctx.sessionManager.getSessionId()]);
      if (scope !== nextScope || event === "session.tree" || event === "session.start") {
        ring = []; ringBytes = 0; issues = new Map(); seen.clear(); startedAt = undefined; tokens = {}; toolCalls = 0; providerRequests = 0; issueOccurrences = 0; overflow = 0;
        scope = nextScope; captureId = randomUUID();
      }
      const now = new Date().toISOString();
      const row = { sequence: ++sequence, timestamp: now, event, data: metadata(raw) };
      const bytes = Buffer.byteLength(JSON.stringify(row));
      ring.push(row); ringBytes += bytes;
      while (ring.length > 64 || ringBytes > MAX_RING_BYTES) ringBytes -= Buffer.byteLength(JSON.stringify(ring.shift()));
      for (const issue of issues.values()) {
        if (issue.events.length < 32) { issue.events.push(row); issue.dirty = true; }
        else if (!issue.incomplete) { issue.incomplete = true; issue.dirty = true; }
      }
      if (event === "agent.before_start") {
        run++; startedAt = performance.now(); toolCalls = 0; providerRequests = 0; tokens = {}; issueOccurrences = 0; overflow = 0; seen.clear();
      }
      if (event === "tool.call" || event === "routing.tool_call") toolCalls++;
      if (event === "provider.request") providerRequests++;
      if (event === "assistant.result" && raw.tokens && typeof raw.tokens === "object") {
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
          const value = (raw.tokens as Data)[key];
          if (typeof value === "number" && Number.isFinite(value) && value >= 0) tokens[key] = (tokens[key] ?? 0) + value;
        }
      }
      const problem = classify(event, raw);
      if (problem) {
        const stage = problem.category === "business-rejection" ? "business" : event;
        const toolName = typeof row.data.toolName === "string" ? row.data.toolName : undefined;
        const id = fingerprint([problem.category, problem.code, stage, toolName])!;
        const occurrence = raw.toolCallId ? id + ":" + raw.toolCallId : undefined;
        if (!occurrence || !seen.has(occurrence)) {
          if (occurrence && seen.size < 128) seen.add(occurrence);
          issueOccurrences++;
          let issue = issues.get(id);
          if (!issue && issues.size < MAX_ISSUES) {
            let state: unknown;
            try { state = snapshot(); } catch { state = { omitted: true, reason: "snapshot-unavailable" }; }
            if (Buffer.byteLength(JSON.stringify(state) ?? "") > 8192) state = { omitted: true, reason: "snapshot-budget" };
            issue = { id, ...problem, stage, toolName, count: 0, firstSeen: now, lastSeen: now, events: ring.slice(-16), snapshot: state, incomplete: ring.length > 16, dirty: true };
            issues.set(id, issue);
            try { ctx.ui.notify("运行黑匣子已发现新问题：" + problem.category + "/" + problem.code + "。使用 /blackbox 查看。", "info"); } catch {}
          }
          if (issue) { issue.count++; issue.lastSeen = now; issue.dirty = true; if (issue.count === 1) save(ctx, issue); }
          else overflow++;
        }
      }
      if (event === "agent.settled" || event === "session.shutdown") {
        for (const issue of issues.values()) save(ctx, issue);
        if (startedAt !== undefined) {
          write(ctx, { kind: "summary", timestamp: now, durationMs: Math.max(0, performance.now() - startedAt), toolCalls, providerRequests, tokens, issueOccurrences, overflow, aborted: raw.aborted === true, incomplete: event !== "agent.settled" });
          startedAt = undefined;
        }
      }
    } catch {
      // Observation must never affect task execution.
    }
  }
  async function report(ctx: ExtensionContext) {
    if (!ctx.isProjectTrusted()) return "运行黑匣子：未信任项目，不读取诊断。";
    await tail;
    const latest = new Map<string, Data>();
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
    return ["运行黑匣子（本地保留文件；7 天按文件更新时间清理；观察次数不等于失败请求数）", ...lines, lines.length ? "现场：.pi/diagnostics/runtime.jsonl（含 .1 备份）" : "暂无已记录问题，不代表运行无故障。", incomplete || failed || dropped ? "记录不完整：存在读取/写入失败、截断或丢弃。" : ""].filter(Boolean).join("\n");
  }
  return { observe, report, flush: () => tail };
}
function readExtensionVersion() {
  try {
    const { version } = createRequire(import.meta.url)("../package.json");
    return typeof version === "string" ? version : undefined;
  } catch { return undefined; }
}
