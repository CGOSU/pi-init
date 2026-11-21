import * as fs from "node:fs/promises";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { diagnosticKeys, diagnosticLocation, DIAGNOSTIC_MAX_BYTES, withDiagnosticLocation, writableDiagnosticFile } from "./diagnostic-layout.ts";
import {
  appendDiagnosticRecord, captureDiagnosticScope, diagnosticErrorCode, matchesDiagnosticScope,
  probeDiagnosticFile, type DiagnosticResumeResult, type DiagnosticScope,
} from "./diagnostic-storage.ts";

type Data = Record<string, unknown>;
type WriterOptions = {
  scope: DiagnosticScope; maxBytes: number; maxPending: number; warning: string;
  retentionMs?: number; agentDir?: () => string;
  io?: typeof fs; now?: () => number; discardOversize?: boolean; warnOnDrop?: boolean;
};

const queues = new Map<string, Promise<void>>();

export function createDiagnosticWriter(options: WriterOptions) {
  const io = options.io ?? fs;
  let failed = false, recovering = false, warned = false, queueFull = false;
  let pending = 0, dropped = 0, totalDropped = 0, written = 0;
  let failureCode: string | undefined;
  let tail = Promise.resolve();
  const maxBytes = options.scope === "global" ? options.maxBytes : Math.min(DIAGNOSTIC_MAX_BYTES, options.maxBytes);
  const locate = ({ cwd, sessionId }: { cwd: string; sessionId: string }) =>
    diagnosticLocation((options.agentDir ?? getAgentDir)(), options.scope, cwd, diagnosticKeys(cwd, sessionId).sessionKey);
  function warn(ctx: ExtensionContext) {
    if (warned) return;
    warned = true;
    try { ctx.ui.notify(options.warning, "warning"); } catch { /* Logging must not fail business execution. */ }
  }
  function fail(ctx: ExtensionContext, error: unknown) {
    failed = true;
    const code = diagnosticErrorCode(error);
    failureCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "UNKNOWN";
    warn(ctx);
  }
  function drop() { dropped++; totalDropped++; }
  function recordFailure(ctx: ExtensionContext, error: unknown) { drop(); fail(ctx, error); }
  function write(ctx: ExtensionContext, record: (dropped: number) => Data) {
    try {
      if (!ctx.isProjectTrusted()) return false;
      if (failed || recovering) { drop(); return false; }
      if (pending >= options.maxPending) {
        drop(); queueFull = true;
        if (options.warnOnDrop) warn(ctx);
        return false;
      }
      // Context can switch sessions while queued. Only trust is rechecked; never recompute the destination.
      const location = locate(captureDiagnosticScope(ctx));
      const current = () => ctx.isProjectTrusted();
      const line = JSON.stringify(record(dropped)) + "\n";
      if (Buffer.byteLength(line) > maxBytes) { drop(); return false; }
      const key = JSON.stringify([location.root, location.lock]);
      dropped = 0; pending++;
      const work = (queues.get(key) ?? Promise.resolve()).then(async () => {
        if (failed || !current()) { drop(); return; }
        await withDiagnosticLocation(location, { create: true, io, current }, async root => {
          const target = await writableDiagnosticFile(location, root, io);
          if (!current()) { drop(); return; }
          await appendDiagnosticRecord(target, line, { ...options, maxBytes, io });
          written++;
        });
      }).catch(error => {
        if (diagnosticErrorCode(error) === "DIAGNOSTIC_SCOPE_CHANGED" && !current()) drop();
        else recordFailure(ctx, error);
      }).finally(() => { pending--; });
      queues.set(key, work);
      void work.then(() => { if (queues.get(key) === work) queues.delete(key); });
      tail = Promise.all([tail, work]).then(() => { });
      return true;
    } catch (error) { recordFailure(ctx, error); return false; }
  }
  async function resume(ctx: ExtensionContext): Promise<DiagnosticResumeResult> {
    if (!ctx.isProjectTrusted()) return { ok: false, code: "DIAGNOSTIC_UNTRUSTED_PROJECT", message: "项目未受信任，不能恢复诊断记录" };
    if (recovering) return { ok: false, code: "DIAGNOSTIC_RESUME_BUSY", message: "诊断记录器正在恢复，请等待当前操作结束" };
    const scope = captureDiagnosticScope(ctx);
    recovering = true;
    try {
      await tail;
      if (!matchesDiagnosticScope(ctx, scope)) return { ok: false, code: "DIAGNOSTIC_SCOPE_CHANGED", message: "项目、会话或分支已变化，未恢复诊断记录" };
      const alreadyEnabled = !failed;
      const location = locate(scope);
      const current = () => matchesDiagnosticScope(ctx, scope);
      await withDiagnosticLocation(location, { create: true, io, current }, async root => {
        const target = await writableDiagnosticFile(location, root, io);
        if (!current()) throw Object.assign(new Error("诊断恢复范围已变化"), { code: "DIAGNOSTIC_SCOPE_CHANGED" });
        await probeDiagnosticFile(target, maxBytes, io);
      });
      if (!matchesDiagnosticScope(ctx, scope)) return { ok: false, code: "DIAGNOSTIC_SCOPE_CHANGED", message: "项目、会话或分支已变化，未恢复诊断记录" };
      failed = false; failureCode = undefined; warned = false; queueFull = false;
      return { ok: true, value: { alreadyEnabled } };
    } catch (error) {
      if (diagnosticErrorCode(error) === "DIAGNOSTIC_SCOPE_CHANGED") return { ok: false, code: "DIAGNOSTIC_SCOPE_CHANGED", message: "诊断路径或会话范围已变化，未恢复诊断记录" };
      fail(ctx, error);
      return { ok: false, code: "DIAGNOSTIC_RESUME_FAILED", causeCode: failureCode, message: "诊断存储仍不可用或锁未释放，记录器未恢复；未重放任何事件" };
    } finally { recovering = false; }
  }
  return {
    write, resume, recordFailure, flush: () => tail,
    get failed() { return failed; }, get recovering() { return recovering; },
    get dropped() { return dropped; }, get totalDropped() { return totalDropped; },
    get pending() { return pending; }, get written() { return written; },
    get failureCode() { return failureCode; }, get queueFull() { return queueFull; },
  };
}
