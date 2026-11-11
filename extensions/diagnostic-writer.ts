import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendDiagnosticRecord, captureDiagnosticScope, diagnosticDirectory, diagnosticErrorCode,
  matchesDiagnosticScope, probeDiagnosticFile, withDiagnosticLock, type DiagnosticResumeResult,
} from "./diagnostic-storage.ts";

type Data = Record<string, unknown>;
type WriterOptions = {
  file: string; maxBytes: number; maxPending: number; warning: string;
  retentionMs?: number; rejectOversize?: boolean; directoryMode?: number;
  directory?: (ctx: ExtensionContext) => Promise<string>;
  queueKey?: (ctx: ExtensionContext) => string;
  io?: typeof fs; now?: () => number; discardOversize?: boolean; warnOnDrop?: boolean;
};

const queues = new Map<string, Promise<void>>();

export function createDiagnosticWriter(options: WriterOptions) {
  const io = options.io ?? fs;
  let failed = false, recovering = false, warned = false, queueFull = false;
  let pending = 0, dropped = 0, totalDropped = 0, written = 0;
  let failureCode: string | undefined;
  let tail = Promise.resolve();
  const directory = options.directory ?? ((ctx: ExtensionContext) => diagnosticDirectory(ctx.cwd,
    [".pi", ...dirname(options.file).split(/[\\/]/).filter(part => part !== ".")], true, io, options.directoryMode));
  const filename = options.directory ? options.file : options.file.split(/[\\/]/).at(-1)!;
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
      const writeContext = { ...ctx, cwd: ctx.cwd };
      const current = () => ctx.isProjectTrusted();
      const line = JSON.stringify(record(dropped)) + "\n";
      if (options.rejectOversize && Buffer.byteLength(line) > options.maxBytes) { drop(); return false; }
      const key = options.queueKey?.(writeContext) ?? join(writeContext.cwd, ".pi", options.file);
      dropped = 0; pending++;
      const work = (queues.get(key) ?? Promise.resolve()).then(async () => {
        if (failed || !current()) { drop(); return; }
        const target = await directory(writeContext);
        await withDiagnosticLock(target, async () => {
          if (!current()) { drop(); return; }
          if (await directory(writeContext) !== target) throw Object.assign(new Error("诊断目录已变化"), { code: "DIAGNOSTIC_SCOPE_CHANGED" });
          await appendDiagnosticRecord(join(target, filename), line, { ...options, io });
          written++;
        }, io);
      }).catch(error => { recordFailure(ctx, error); }).finally(() => { pending--; });
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
      const target = await directory(ctx);
      await withDiagnosticLock(target, async () => {
        if (!matchesDiagnosticScope(ctx, scope) || await directory(ctx) !== target) {
          throw Object.assign(new Error("诊断恢复范围已变化"), { code: "DIAGNOSTIC_SCOPE_CHANGED" });
        }
        await probeDiagnosticFile(join(target, filename), options.maxBytes, io);
      }, io);
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
