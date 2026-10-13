import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionRuntimeState } from "./runtime-state.ts";

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_PENDING = 128;
const routingTools = new Set(["switch_role", "task_workflow"]);
const fileQueues = new Map<string, Promise<void>>();

function fingerprint(value: unknown) {
  return value === undefined ? undefined : createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

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
      tasks: workflow.tasks.slice(0, 64).map((item) => ({ id: item.id, role: item.role, status: item.status })),
      taskCount: workflow.tasks.length,
      clarification: task?.clarification ? { issueId: task.clarification.issueId, category: task.clarification.category, questionHash: fingerprint(task.clarification.question) } : undefined,
      handoff: workflow.handoff, continuation: workflow.continuation,
      revisionId: workflow.pendingRevision?.revisionId, directionHash: fingerprint(workflow.pendingRevision?.direction), revisionCount: workflow.revisions.length,
    } : undefined,
    coordination: coordination ? {
      coordinationId: coordination.coordination.coordinationId, version: coordination.coordination.version,
      recoveryGeneration: coordination.recoveryGeneration, phase: coordination.coordination.phase,
      handoff: coordination.handoff ? { ...routingFields(coordination.handoff), phase: coordination.handoff.phase, kind: coordination.handoff.kind, failureCode: coordination.handoff.failure?.code } : undefined,
      request: request ? { requestId: request.requestId, questionId: request.questionId, round: request.round, status: request.status, followUpOfRequestId: request.followUpOfRequestId, questionHash: fingerprint(request.question), scopeHash: fingerprint(request.scope) } : undefined,
      review: review ? { reportId: review.reportId, decision: review.decision, gapsHash: fingerprint(review.gaps) } : undefined,
    } : undefined,
    compaction: { phase: state.roleCompactionPhase, operationId: state.roleCompactionOperationId, startedAt: state.roleCompactionStartedAt,
      pending: state.pendingRoleCompaction ? { fromRole: state.pendingRoleCompaction.fromRole, toRole: state.pendingRoleCompaction.toRole, continuationKind: state.pendingRoleCompaction.continuation?.kind } : undefined },
    locks: { dispatch: state.workflowDispatchInFlight, compaction: state.roleCompactionInFlight, continuationPending: state.internalContinuationPending, roleRecovery: state.roleRecoveryPending },
    restoreErrorCode: state.workflowRestoreError?.code ?? state.coordinationRestoreError?.code,
  };
}

export function createHandoffDiagnostics(pi: ExtensionAPI, state: ExtensionRuntimeState, options: { enabled?: boolean; maxBytes?: number } = {}) {
  const enabled = options.enabled ?? process.env.PI_INIT_HANDOFF_LOG === "1";
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
  const runtimeId = randomUUID();
  let sequence = 0;
  let run = 0;
  let pending = 0;
  let dropped = 0;
  let writeFailed = false;
  let tail = Promise.resolve();

  function trace(ctx: ExtensionContext, event: string, data: Record<string, unknown> = {}) {
    try {
      if (!enabled || writeFailed || !ctx.isProjectTrusted()) return;
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

  if (!enabled) return { trace, flush: () => tail };
  state.traceHandoff = trace;
  pi.on("input", (event, ctx) => { trace(ctx, "input", { source: event.source, textHash: fingerprint(event.text) }); });
  pi.on("before_agent_start", (_event, ctx) => { run++; trace(ctx, "agent.before_start"); });
  pi.on("agent_start", (_event, ctx) => { trace(ctx, "agent.start"); });
  pi.on("agent_end", (_event, ctx) => { trace(ctx, "agent.end"); });
  pi.on("agent_settled", (_event, ctx) => { trace(ctx, "agent.settled"); });
  pi.on("tool_call", (event, ctx) => {
    if (routingTools.has(event.toolName)) trace(ctx, "routing.tool_call", { toolName: event.toolName, toolCallId: event.toolCallId, ...routingFields(event.input) });
  });
  pi.on("tool_result", (event, ctx) => {
    if (routingTools.has(event.toolName)) trace(ctx, "routing.tool_result", { toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError, errorHash: event.isError ? fingerprint(event.content) : undefined, ...routingFields(event.details) });
  });
  pi.on("message_start", (event, ctx) => {
    const message = event.message as unknown as Record<string, unknown>;
    if (message.role === "custom" && typeof message.customType === "string" && message.customType.startsWith("pi-init-")) {
      trace(ctx, "handoff.message_consumed", { customType: message.customType, ...routingFields(message.details) });
    }
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message as unknown as Record<string, unknown>;
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    for (const item of message.content) {
      if (item.type === "toolCall" && routingTools.has(item.name)) {
        trace(ctx, "routing.model_proposed", { toolName: item.name, toolCallId: item.id, ...routingFields(item.arguments) });
      }
    }
  });
  pi.on("session_before_compact", (_event, ctx) => { trace(ctx, "compaction.before"); });
  pi.on("session_compact", (_event, ctx) => { trace(ctx, "compaction.event"); });
  pi.on("session_start", (event, ctx) => { trace(ctx, "session.start", { reason: event.reason }); });
  pi.on("session_tree", (_event, ctx) => { trace(ctx, "session.tree"); });
  pi.on("model_select", (_event, ctx) => { trace(ctx, "role.model_selected"); });
  pi.on("session_shutdown", async (_event, ctx) => { trace(ctx, "session.shutdown"); await tail; });
  return { trace, flush: () => tail };
}
