import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { withDiagnosticLock } from "./diagnostic-storage.ts";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// Deliberately omit dynamic messages, stacks, codes and payloads rather than attempt
// best-effort redaction. This is not a host-wide exception or telemetry collector.
const categories = new Map([
  ["pi-init.initialization_failed", "initialization"],
  ["pi-init.command_failed", "command"],
  ["pi-init.role_failed", "role-switch"],
  ["pi-init.workflow_failed", "workflow-control"],
  ["runtime.failure", "runtime-recovery"],
  ["workflow.action_rejected", "workflow-rejection"],
  ["role.handoff_dispatch_unknown", "outcome-unknown"],
  ["workflow.delivery.fallback_failed", "delivery"],
]);
export function isGlobalDiagnosticEvent(event: string) { return categories.has(event); }
const hash = (domain: string, value: string) => createHash("sha256").update(domain + "\0" + value).digest("hex");
const errorCode = (error: unknown) => error && typeof error === "object" && "code" in error ? error.code : undefined;

export function createGlobalDiagnostics(options: {
  agentDir?: () => string; maxBytes?: number; retentionMs?: number; now?: () => number;
  io?: typeof fs;
} = {}) {
  const io = options.io ?? fs;
  const maxBytes = Math.max(1024, Math.min(options.maxBytes ?? 1024 * 1024, 4 * 1024 * 1024));
  const retentionMs = Math.max(1, Math.min(options.retentionMs ?? 7 * 86400000, 30 * 86400000));
  const now = options.now ?? Date.now;
  const runtimeId = randomUUID();
  let tail = Promise.resolve();
  let pending = 0;
  let written = 0;
  let dropped = 0;
  let failure: "storage" | "lock-busy" | "queue-full" | undefined;
  let warned = false;

  function fail(ctx: ExtensionContext, kind: NonNullable<typeof failure>) {
    failure = kind;
    dropped++;
    if (warned) return;
    warned = true;
    try { ctx.ui.notify("全局本地诊断写入失败，部分故障未记录；不影响任务执行。可查看运行诊断中的写入状态。", "warning"); } catch { /* UI failure must not recurse. */ }
  }

  async function append(line: string) {
    const directory = join((options.agentDir ?? getAgentDir)(), "diagnostics", "pi-init");
    await io.mkdir(directory, { recursive: true, mode: 0o700 });
    await withDiagnosticLock(directory, async () => {
      const file = join(directory, "runtime.jsonl");
      const backup = file + ".1";
      for (const path of [file, backup]) {
        try {
          const info = await io.lstat(path);
          if (!info.isFile()) throw new Error("diagnostic target is not a regular file");
          if (now() - info.mtimeMs > retentionMs || info.size > maxBytes) await io.unlink(path);
        } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
      }
      let size = 0;
      try { size = (await io.lstat(file)).size; } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
      if (size + Buffer.byteLength(line) > maxBytes) {
        try { await io.unlink(backup); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
        await io.rename(file, backup);
      }
      const handle = await io.open(file, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { await handle.writeFile(line, "utf8"); } finally { await handle.close(); }
    }, io);
  }

  function observe(ctx: ExtensionContext, event: string) {
    if (!categories.has(event)) return undefined;
    try {
      if (!ctx.isProjectTrusted()) return undefined;
      const projectId = hash("pi-init-project-v1", resolve(ctx.cwd));
      const sessionId = hash("pi-init-session-v1", projectId + "\0" + ctx.sessionManager.getSessionId());
      const correlation = { diagnosticEventId: randomUUID(), diagnosticProjectId: projectId, diagnosticSessionId: sessionId };
      const line = JSON.stringify({ version: 1, timestamp: new Date(now()).toISOString(), runtimeId, ...correlation, event, category: categories.get(event) }) + "\n";
      if (failure === "storage" || failure === "lock-busy") { fail(ctx, failure); return correlation; }
      if (pending >= 128) { fail(ctx, "queue-full"); return correlation; }
      pending++;
      tail = tail.then(async () => {
        try {
          if (failure === "storage" || failure === "lock-busy") { fail(ctx, failure); return; }
          await append(line); written++;
        }
        catch (error) { fail(ctx, errorCode(error) === "DIAGNOSTIC_LOCK_BUSY" ? "lock-busy" : "storage"); }
        finally { pending--; }
      });
      return correlation;
    } catch { fail(ctx, "storage"); return undefined; }
  }
  return {
    observe, flush: () => tail,
    status: () => ({ written, dropped, pending, failure }),
    report: () => `全局本地诊断：已写入 ${written}，未记录 ${dropped}，待写入 ${pending}；${failure ? "写入异常（" + failure + "）" : "尚未观察到写入失败"}。仅包含 pi-init 可观测的自身故障，不覆盖扩展加载前或宿主未暴露的故障。`,
  };
}
