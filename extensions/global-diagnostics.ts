import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { diagnosticDirectory } from "./diagnostic-storage.ts";
import { createDiagnosticWriter } from "./diagnostic-writer.ts";
import { loadedRuntimeIdentity } from "./runtime-identity.ts";
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

export function createGlobalDiagnostics(options: {
  agentDir?: () => string; maxBytes?: number; retentionMs?: number; now?: () => number;
  io?: typeof fs;
} = {}) {
  const io = options.io ?? fs;
  const maxBytes = Math.max(1024, Math.min(options.maxBytes ?? 1024 * 1024, 4 * 1024 * 1024));
  const retentionMs = Math.max(1, Math.min(options.retentionMs ?? 7 * 86400000, 30 * 86400000));
  const now = options.now ?? Date.now;
  const runtimeId = randomUUID();
  const writer = createDiagnosticWriter({
    file: "runtime.jsonl", maxBytes, maxPending: 128, retentionMs, now, io,
    rejectOversize: true, discardOversize: true, warnOnDrop: true,
    directory: () => diagnosticDirectory((options.agentDir ?? getAgentDir)(), ["diagnostics", "pi-init"], true, io),
    queueKey: () => join((options.agentDir ?? getAgentDir)(), "diagnostics", "pi-init", "runtime.jsonl"),
    warning: "全局本地诊断写入失败，部分故障未记录；不影响任务执行。可查看运行诊断中的写入状态。",
  });
  function observe(ctx: ExtensionContext, event: string) {
    try {
      if (!categories.has(event) || !ctx.isProjectTrusted()) return undefined;
      const projectId = hash("pi-init-project-v1", resolve(ctx.cwd));
      const sessionId = hash("pi-init-session-v1", projectId + "\0" + ctx.sessionManager.getSessionId());
      const correlation = { diagnosticEventId: randomUUID(), diagnosticProjectId: projectId, diagnosticSessionId: sessionId };
      writer.write(ctx, () => ({ version: 1, timestamp: new Date(now()).toISOString(), runtimeIdentity: loadedRuntimeIdentity, runtimeId, ...correlation, event, category: categories.get(event) }));
      return correlation;
    } catch (error) { writer.recordFailure(ctx, error); return undefined; }
  }
  const status = () => ({
    written: writer.written, dropped: writer.totalDropped, pending: writer.pending,
    failure: writer.failed ? writer.failureCode === "DIAGNOSTIC_LOCK_BUSY" ? "lock-busy" : "storage" : writer.queueFull ? "queue-full" : undefined
  });
  return {
    observe, flush: writer.flush, resume: writer.resume, status,
    report: () => {
      const current = status();
      return `全局本地诊断：已写入 ${current.written}，未记录 ${current.dropped}，待写入 ${current.pending}；${current.failure ? "写入异常（" + current.failure + "）" : "当前未停录"}。仅包含 pi-init 可观测的自身故障，不覆盖扩展加载前或宿主未暴露的故障。`;
    },
  };
}
