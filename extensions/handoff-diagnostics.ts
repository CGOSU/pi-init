import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { fingerprint, summarizeToolInput, summarizeToolResult } from "./handoff-tool-diagnostics.ts";
import { createRuntimeDiagnostics } from "./runtime-diagnostics.ts";

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_PENDING = 128;
const routingTools = new Set(["switch_role", "task_workflow"]);
const fileQueues = new Map<string, Promise<void>>();

function routingFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ["action", "role", "workflowId", "planVersion", "sessionId", "recoveryGeneration", "revisionId", "taskId", "attemptId", "handoffId", "coordinationId", "coordinationVersion", "requestId", "questionId", "reportId", "reviewId", "decision", "code"]) {
    const item = source[key];
    if (typeof item === "string") result[key] = item.slice(0, 256);
    else if (typeof item === "number" || typeof item === "boolean") result[key] = item;
  }
  for (const key of ["question", "scope", "gaps", "reason", "direction", "clarification", "error"]) {
    if (source[key] !== undefined) result[key + "Hash"] = fingerprint(source[key]);
  }
  for (const key of ["request", "report", "review", "identity"]) {
    if (source[key] && typeof source[key] === "object") result[key] = routingFields(source[key]);
  }
  return result;
}

function handoffSnapshot(state: ExtensionRuntimeState) {
  const workflow = state.workflowState;
  const task = workflow?.tasks.find((item) => item.id === workflow.currentTaskId);
  const coordination = state.coordinationRuntimeState;
  const request = coordination?.coordination.requests.at(-1);
  const review = coordination?.coordination.reviews.at(-1);
  return {
    role: state.activeRole?.role,
    model: state.activeRole ? { provider: state.activeRole.provider, id: state.activeRole.model, thinkingLevel: state.activeRole.thinkingLevel } : undefined,
    contextGeneration: state.roleContextGeneration,
    roleTransitionGeneration: state.roleTransitionGeneration,
    workflow: workflow ? {
      workflowId: workflow.workflowId, planVersion: workflow.planVersion, recoveryGeneration: workflow.recoveryGeneration,
      status: workflow.status, pauseReason: workflow.pauseReason, taskPauseReasonHash: fingerprint(workflow.taskPauseReason),
      currentTaskId: workflow.currentTaskId, nudgeCount: workflow.nudgeCount,
      tasks: workflow.tasks.slice(0, 64).map((item) => ({ id: item.id, role: item.role, status: item.status, outcomeUnknown: item.outcomeUnknown, executionStartedAt: item.executionStartedAt })),
      taskCount: workflow.tasks.length,
      clarification: task?.clarification ? { issueId: task.clarification.issueId, category: task.clarification.category, questionHash: fingerprint(task.clarification.question) } : undefined,
      handoff: workflow.handoff, continuation: workflow.continuation,
      revisionId: workflow.pendingRevision?.revisionId, directionHash: fingerprint(workflow.pendingRevision?.direction), revisionCount: workflow.revisions.length,
    } : undefined,
    coordination: coordination ? {
      coordinationId: coordination.coordination.coordinationId, version: coordination.coordination.version,
      recoveryGeneration: coordination.recoveryGeneration, phase: coordination.coordination.phase,
      workflowLink: coordination.coordination.workflowLink,
      handoff: coordination.handoff ? { ...routingFields(coordination.handoff), phase: coordination.handoff.phase, kind: coordination.handoff.kind, failureCode: coordination.handoff.failure?.code } : undefined,
      request: request ? { requestId: request.requestId, questionId: request.questionId, round: request.round, status: request.status, followUpOfRequestId: request.followUpOfRequestId, questionHash: fingerprint(request.question), scopeHash: fingerprint(request.scope) } : undefined,
      review: review ? { reportId: review.reportId, decision: review.decision, gapsHash: fingerprint(review.gaps) } : undefined,
    } : undefined,
    compaction: { phase: state.roleCompactionPhase, operationId: state.roleCompactionOperationId, startedAt: state.roleCompactionStartedAt,
      pending: state.pendingRoleCompaction ? { fromRole: state.pendingRoleCompaction.fromRole, toRole: state.pendingRoleCompaction.toRole, continuationKind: state.pendingRoleCompaction.continuation?.kind } : undefined },
    locks: { dispatch: state.workflowDispatchInFlight, compaction: state.roleCompactionInFlight, continuationPending: state.internalContinuationPending, roleRecovery: state.roleRecoveryPending, roleRecoveryPersistenceFailed: state.roleRecoveryPersistenceFailed, pendingWorkflowRecovery: Boolean(state.pendingWorkflowRecovery) },
    restoreErrorCode: state.workflowRestoreError?.code ?? state.coordinationRestoreError?.code,
  };
}

export function createHandoffDiagnostics(pi: ExtensionAPI, state: ExtensionRuntimeState, options: { enabled?: boolean; mode?: "automatic" | "verbose" | "off"; maxBytes?: number } = {}) {
  const mode = options.mode ?? (options.enabled !== undefined ? options.enabled ? "verbose" : "off" : process.env.PI_INIT_HANDOFF_LOG === "0" ? "off" : process.env.PI_INIT_HANDOFF_LOG === "1" ? "verbose" : "automatic");
  const enabled = mode === "verbose";
  const blackbox = createRuntimeDiagnostics(() => handoffSnapshot(state), { maxBytes: options.maxBytes });
  const flush = async () => { await tail; await blackbox.flush(); };
  const report = (ctx: ExtensionContext) => mode === "off" ? Promise.resolve("运行黑匣子已关闭。") : blackbox.report(ctx);
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
  const runtimeId = randomUUID();
  let sequence = 0;
  let run = 0;
  let requestNumber = 0;
  let pendingProviderHeaders: string | undefined;
  let providerRequest: { requestNumber: number; startedAt: number; cwd: string; sessionId: string; run: number; headersObserved?: boolean; responseObserved?: boolean; status?: number } | undefined;
  let pending = 0;
  let dropped = 0;
  let writeFailed = false;
  let lastRuntimeFailure: string | undefined;
  let lastLoop: string | undefined;
  let tail = Promise.resolve();

  function observeSignals(ctx: ExtensionContext) {
    const code = state.workflowRestoreError?.code ?? state.coordinationRestoreError?.code ?? (state.roleRecoveryPersistenceFailed ? "ROLE_RECOVERY_PERSISTENCE_FAILED" : undefined);
    const failure = code ? JSON.stringify([ctx.cwd, ctx.sessionManager.getSessionId(), code]) : undefined;
    if (failure && failure !== lastRuntimeFailure) blackbox.observe(ctx, "runtime.failure", { code });
    lastRuntimeFailure = failure;
    const progress = state.workflowProgressObservation;
    const suspicion = progress?.status === "suspected-loop" ? progress.suspicion : undefined;
    const workflow = suspicion ? state.workflowState : undefined;
    const loop = suspicion && workflow && ["running", "replanning"].includes(workflow.status) ? JSON.stringify([ctx.cwd, ctx.sessionManager.getSessionId(), workflow.workflowId, suspicion.kind, progress?.lastVerifiedProgress?.taskId]) : undefined;
    if (loop && loop !== lastLoop) {
      const codes = { "repeated-state": "WORKFLOW_REPEATED_STATE", "repeated-revision": "WORKFLOW_REPEATED_REVISION", "state-cycle": "WORKFLOW_STATE_CYCLE" };
      blackbox.observe(ctx, "workflow.suspected_loop", { code: codes[suspicion!.kind], workflowId: workflow!.workflowId, suspicionKind: suspicion!.kind, windowSize: progress?.windowSize, historyLimit: progress?.historyLimit });
    }
    lastLoop = loop;
  }

  function trace(ctx: ExtensionContext, event: string, data: Record<string, unknown> = {}) {
    try {
      if (mode === "off" || writeFailed || !ctx.isProjectTrusted()) return;
      if (!enabled) {
        if (event === "session.start" || event === "session.tree") { lastLoop = undefined; lastRuntimeFailure = undefined; }
        const closing = event === "agent.settled" || event === "session.shutdown";
        if (closing) observeSignals(ctx);
        const profile = { provider: ctx.model?.provider, model: ctx.model?.id, role: state.activeRole?.role ?? "session", thinkingLevel: pi.getThinkingLevel?.() ?? state.activeRole?.thinkingLevel ?? "unknown" };
        blackbox.observe(ctx, event, { ...data, profile });
        if (!closing) observeSignals(ctx);
        return;
      }
      if (pending >= MAX_PENDING) { dropped++; return; }
      const path = join(ctx.cwd, ".pi", "logs", "handoff.jsonl");
      const line = JSON.stringify({ version: 1, timestamp: new Date().toISOString(), runtimeId, sequence: ++sequence,
        sessionId: ctx.sessionManager.getSessionId(), run, event, dropped, data, snapshot: handoffSnapshot(state) }) + "\n";
      dropped = 0;
      pending++;
      const previous = fileQueues.get(path) ?? Promise.resolve();
      const write = previous.then(async () => {
        await mkdir(join(ctx.cwd, ".pi", "logs"), { recursive: true });
        let size = 0;
        try { size = (await stat(path)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (size + Buffer.byteLength(line) > maxBytes) {
          await rm(path + ".1", { force: true });
          if (size > 0) await rename(path, path + ".1");
        }
        await appendFile(path, line, { mode: 0o600 });
      }).catch(() => {
        if (!writeFailed) {
          writeFailed = true;
          try { ctx.ui.notify("角色交接诊断日志写入失败；已停用日志，不影响任务执行。", "warning"); } catch {}
        }
      }).finally(() => { pending--; });
      fileQueues.set(path, write);
      void write.then(() => { if (fileQueues.get(path) === write) fileQueues.delete(path); });
      tail = Promise.all([tail, write]).then(() => {});
    } catch {
      // Diagnostics must never change routing or task execution.
    }
  }

  if (mode === "off") return { trace, flush, report };
  state.traceHandoff = trace;
  pi.on("input", (event, ctx) => { trace(ctx, "input", { source: event.source, textHash: enabled ? fingerprint(event.text) : undefined }); });
  pi.on("before_agent_start", (_event, ctx) => { pendingProviderHeaders = undefined; run++; trace(ctx, "agent.before_start", { degraded: Boolean(state.workflowRestoreError || state.coordinationRestoreError || state.roleRecoveryPersistenceFailed || state.workflowProgressObservation?.status === "suspected-loop"), profile: { provider: ctx.model?.provider, model: ctx.model?.id, role: state.activeRole?.role ?? "session", thinkingLevel: pi.getThinkingLevel?.() ?? state.activeRole?.thinkingLevel ?? "unknown" } }); });
  pi.on("agent_start", (_event, ctx) => { trace(ctx, "agent.start"); });
  pi.on("agent_end", (_event, ctx) => { trace(ctx, "agent.end"); });
  function providerFields(ctx: ExtensionContext) {
    if (providerRequest?.cwd !== ctx.cwd || providerRequest?.sessionId !== ctx.sessionManager.getSessionId() || providerRequest?.run !== run) providerRequest = undefined;
    return providerRequest ? { requestNumber: providerRequest.requestNumber, observedElapsedMs: Math.max(0, performance.now() - providerRequest.startedAt) } : {};
  }
  function finishProvider(ctx: ExtensionContext, outcome: string, errorCodeHint?: string) {
    const fields = providerFields(ctx);
    if (!providerRequest) return;
    if (!enabled) trace(ctx, "provider.request_summary", { ...fields, status: providerRequest.status,
      headersObserved: providerRequest.headersObserved === true, responseObserved: providerRequest.responseObserved === true,
      assistantObserved: outcome === "assistant", outcome, errorCodeHint });
    providerRequest = undefined;
  }
  pi.on("before_provider_request", (_event, ctx) => {
    try {
      if (writeFailed || !ctx.isProjectTrusted()) { pendingProviderHeaders = undefined; providerRequest = undefined; return; }
      providerFields(ctx);
      if (providerRequest) { trace(ctx, "provider.unfinished", { ...providerFields(ctx), reason: "superseded" }); finishProvider(ctx, "superseded"); }
      providerRequest = { requestNumber: ++requestNumber, startedAt: performance.now(), cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), run,
        headersObserved: pendingProviderHeaders === JSON.stringify([ctx.cwd, ctx.sessionManager.getSessionId(), run]) };
      pendingProviderHeaders = undefined;
      trace(ctx, "provider.request", { requestNumber });
    } catch {}
  });
  pi.on("before_provider_headers", (_event, ctx) => {
    try {
      if (writeFailed || !ctx.isProjectTrusted()) { pendingProviderHeaders = undefined; providerRequest = undefined; return; }
      const fields = providerFields(ctx);
      if (providerRequest) providerRequest.headersObserved = true;
      else pendingProviderHeaders = JSON.stringify([ctx.cwd, ctx.sessionManager.getSessionId(), run]);
      trace(ctx, "provider.headers", fields);
    } catch {}
  });
  pi.on("after_provider_response", (event, ctx) => {
    try { const fields = providerFields(ctx); if (providerRequest) { providerRequest.responseObserved = true; providerRequest.status = event.status; } trace(ctx, "provider.response", { ...fields, status: event.status }); } catch {}
  });
  pi.on("agent_settled", (event, ctx) => {
    try {
      if (providerRequest) trace(ctx, "provider.unfinished", { ...providerFields(ctx), reason: event.aborted ? "aborted" : "settled-without-assistant" });
      finishProvider(ctx, event.aborted ? "aborted" : "settled-without-assistant");
      pendingProviderHeaders = undefined;
      trace(ctx, "agent.settled", { aborted: event.aborted });
    } catch {}
  });
  async function observeTool(ctx: ExtensionContext, event: string, toolName: string, toolCallId: string, input: unknown, extra: Record<string, unknown> = {}, inspectFiles = false) {
    try {
      if (writeFailed || !ctx.isProjectTrusted()) return;
      const summary = enabled ? await summarizeToolInput(ctx.cwd, input, inspectFiles) : {};
      trace(ctx, event, { toolName, toolCallId, ...summary, ...extra });
    } catch {
      // A malformed diagnostic payload must not interrupt a tool.
    }
  }
  pi.on("tool_call", async (event, ctx) => {
    await observeTool(ctx, routingTools.has(event.toolName) ? "routing.tool_call" : "tool.call", event.toolName, event.toolCallId, event.input,
      { parentToolCallId: event.parentToolCallId, ...(routingTools.has(event.toolName) ? routingFields(event.input) : {}) }, true);
  });
  pi.on("tool_result", async (event, ctx) => {
    await observeTool(ctx, routingTools.has(event.toolName) ? "routing.tool_result" : "tool.result", event.toolName, event.toolCallId, event.input,
      { parentToolCallId: event.parentToolCallId, isError: event.isError, ...summarizeToolResult(event, enabled), ...(routingTools.has(event.toolName) ? routingFields(event.details) : {}) }, true);
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    await observeTool(ctx, "tool.execution_start", event.toolName, event.toolCallId, event.args, { parentToolCallId: event.parentToolCallId });
  });
  pi.on("tool_execution_end", (event, ctx) => {
    try {
      trace(ctx, "tool.execution_end", { toolName: event.toolName, toolCallId: event.toolCallId, parentToolCallId: event.parentToolCallId,
        durationMs: event.durationMs, isError: event.isError, ...summarizeToolResult(event.result, enabled) });
    } catch {
      // Diagnostics must never change execution results.
    }
  });
  pi.on("message_start", (event, ctx) => {
    const message = event.message as unknown as Record<string, unknown>;
    if (message.role === "custom" && typeof message.customType === "string" && message.customType.startsWith("pi-init-")) {
      trace(ctx, "handoff.message_consumed", { customType: message.customType, ...routingFields(message.details) });
    }
  });
  pi.on("message_end", async (event, ctx) => {
    const message = event.message as unknown as Record<string, unknown>;
    if (message.role !== "assistant") return;
    try {
      const usage = message.usage && typeof message.usage === "object" ? message.usage as Record<string, unknown> : {};
      const tokens: Record<string, number> = {};
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
        if (typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0) tokens[key] = usage[key];
      }
      trace(ctx, "assistant.result", { ...providerFields(ctx),
        stopReason: ["stop", "length", "toolUse", "error", "aborted"].includes(String(message.stopReason)) ? message.stopReason : undefined,
        errorHash: enabled ? fingerprint(message.errorMessage) : undefined,
        errorCodeHint: providerErrorHint(message.errorMessage),
        durationMs: typeof message.durationMs === "number" && Number.isFinite(message.durationMs) && message.durationMs >= 0 ? message.durationMs : undefined,
        tokens });
      finishProvider(ctx, "assistant", providerErrorHint(message.errorMessage));
    } catch {}
    if (!Array.isArray(message.content)) return;
    for (const item of message.content) {
      if (item.type === "toolCall") {
        await observeTool(ctx, routingTools.has(item.name) ? "routing.model_proposed" : "tool.model_proposed", item.name, item.id, item.arguments,
          routingTools.has(item.name) ? routingFields(item.arguments) : {});
      }
    }
  });
  pi.on("session_before_compact", (_event, ctx) => { trace(ctx, "compaction.before"); });
  pi.on("session_compact", (_event, ctx) => { trace(ctx, "compaction.event"); });
  pi.on("session_start", (event, ctx) => { providerRequest = undefined; pendingProviderHeaders = undefined; trace(ctx, "session.start", { reason: event.reason }); });
  pi.on("session_tree", (_event, ctx) => { providerRequest = undefined; pendingProviderHeaders = undefined; trace(ctx, "session.tree"); });
  pi.on("model_select", (_event, ctx) => { trace(ctx, "role.model_selected"); });
  pi.on("session_shutdown", async (_event, ctx) => { pendingProviderHeaders = undefined; trace(ctx, "session.shutdown"); await flush(); });
  return { trace, flush, report };
}
function providerErrorHint(value: unknown) {
  if (value && typeof value === "object") {
    const error = value as Record<string, unknown>;
    return providerErrorHint(error.code);
  }
  if (typeof value !== "string") return undefined;
  const words = new Set(value.toUpperCase().split(/[^A-Z0-9_]+/));
  return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]
    .find(code => words.has(code));
}
