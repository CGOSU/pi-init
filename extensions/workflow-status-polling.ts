import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fingerprint } from "./handoff-tool-diagnostics.ts";
import { createWorkflowProgressTracker } from "../src/workflow-progress.ts";
import {
  executingWorkflowTask,
  isExecutionBlockedState,
  onLifecycleReset,
  type ExtensionRuntimeState,
  type WorkflowState,
} from "./runtime-state.ts";
import { workflowHandoffMessageOnBranch } from "../src/workflow-handoff.ts";
import { createCurrentWorkflowStatusView } from "./workflow-status-view.ts";

type ObservationScope = { id: string; canPause: boolean };
type PendingReadCall = { scope: string; tool: string; input: string; canPause: boolean; eligible: boolean; branchAnchor?: string };
type PendingFailureCall = { scope: string; tool: string; input: string; editPath?: string; eligible: boolean; branchAnchor?: string };

const WORKFLOW_REPEATED_READ_HINT = "WORKFLOW_REPEATED_READ：相同范围的只读观察连续重复，未发现新信息。请依据已有事实推进或说明阻塞；持续重复将请求暂停。";
const SESSION_REPEATED_READ_HINT = "WORKFLOW_REPEATED_READ：相同范围的只读观察连续重复，未发现新信息。请依据已有事实直接推进、收敛结论，或在准备 session_handoff 时将已排除方向记入 approachesTried。";
const REPEATED_EDIT_ERROR_HINT = "WORKFLOW_REPEATED_TOOL_ERROR：同一目标的 edit 连续失败。请停止盲目微调替换文本，先用 read 重新核对目标文件的当前完整片段与唯一上下文；若当前修改方案不可行，请改换实现路径，或在阻塞/交接时将已试错路径记入 blockReason 或 approachesTried。";
const REPEATED_TOOL_ERROR_HINT = "WORKFLOW_REPEATED_TOOL_ERROR：相同工具调用连续返回相同错误。请停止原样重试，先核对前置假设、参数或环境状态并改换排查/实现路径；若确认外部阻塞或方案不可行，请如实报告阻塞或在准备交接时记入 blockReason 或 approachesTried。";

export function createWorkflowProgressObserver(pi: ExtensionAPI, state: ExtensionRuntimeState,
  options: { onRepeatedRead?: (ctx: ExtensionContext) => void | Promise<void> } = {}) {
  const tracker = createWorkflowProgressTracker();
  const pendingStatusCalls = new Set<string>();
  const reads = new Set(["read", "grep", "find", "ls"]);
  const routingTools = new Set(["task_workflow", "switch_role", "session_handoff"]);
  const pendingReads = new Map<string, PendingReadCall>();
  const pendingFailures = new Map<string, PendingFailureCall>();
  const nonReadInFlight = new Set<string>();
  let ambiguousActivity = false;
  let readScope: string | undefined;
  let previousRead: string | undefined;
  let repeats = 0;
  let paused = false;
  let failureScope: string | undefined;
  let previousFailure: string | undefined;
  let failureRepeats = 0;
  let failureHinted = false;
  function clearReads() {
    pendingReads.clear(); previousRead = undefined; repeats = 0; paused = false; readScope = undefined;
  }
  function clearFailures() {
    pendingFailures.clear(); previousFailure = undefined; failureRepeats = 0; failureHinted = false; failureScope = undefined;
  }
  function hasBranchAnchor(ctx: ExtensionContext, anchor: string | undefined): anchor is string {
    return anchor !== undefined && ctx.sessionManager.getBranch().some(entry => entry.id === anchor);
  }
  function trackBoundedCall<T>(map: Map<string, T>, toolCallId: string, entry: T, clear: () => void) {
    map.set(toolCallId, entry);
    if (map.size > 32) clear();
  }
  function popPendingCall<T extends { branchAnchor?: string }>(map: Map<string, T>, toolCallId: string, ctx: ExtensionContext, clear: () => void) {
    const call = map.get(toolCallId);
    map.delete(toolCallId);
    if (call?.branchAnchor !== undefined && !hasBranchAnchor(ctx, call.branchAnchor)) clear();
    return call;
  }
  function stagePendingCall<T extends { eligible: boolean }>(
    map: Map<string, T>, toolCallId: string, input: string | undefined,
    entry: Omit<T, "eligible">, eligibleWhenNoOverlap: boolean, resetStreak: () => void, clear: () => void,
  ) {
    // Concurrent observations are ambiguous: never count them toward a pause or hint.
    const overlap = map.size > 0;
    if (overlap) {
      resetStreak();
      for (const call of map.values()) call.eligible = false;
    }
    if (input) trackBoundedCall(map, toolCallId, { ...entry, eligible: !overlap && eligibleWhenNoOverlap } as T, clear);
  }
  function isEligibleScopedCall<T extends { eligible: boolean; scope: string; tool: string; branchAnchor?: string }>(
    call: T | undefined, currentScope: ObservationScope | undefined, toolName: string, ctx: ExtensionContext,
  ): call is T {
    return Boolean(call?.eligible && currentScope && call.scope === currentScope.id && call.tool === toolName && hasBranchAnchor(ctx, call.branchAnchor));
  }
  function resolveScope(ctx: ExtensionContext): ObservationScope | undefined {
    if (!ctx?.isProjectTrusted?.() || isExecutionBlockedState(state)) return undefined;
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!state.workflowState) {
      if (typeof sessionId !== "string" || !sessionId.trim()) return undefined;
      const id = fingerprint(["ordinary-session", sessionId, state.activeRole ?? null,
        state.roleContextGeneration, state.roleTransitionGeneration]);
      return id ? { id, canPause: false } : undefined;
    }
    const active = executingWorkflowTask(state, sessionId);
    if (!active || active.task.delegation || active.workflow.continuation || active.workflow.pendingRevision
      || !workflowHandoffMessageOnBranch(ctx, active.handoff)) return undefined;
    const id = fingerprint([active.workflow.workflowId, active.workflow.planVersion, active.workflow.sessionId,
      active.workflow.recoveryGeneration, active.task.id, active.handoff.attemptId, active.handoff.handoffId,
      state.activeRole, state.roleContextGeneration, state.roleTransitionGeneration]);
    return id ? { id, canPause: true } : undefined;
  }
  function syncScope(ctx: ExtensionContext) {
    const next = resolveScope(ctx);
    if (!next || next.id !== readScope) { clearReads(); readScope = next?.id; }
    if (!next || next.id !== failureScope) { clearFailures(); failureScope = next?.id; }
    return next;
  }
  function observe(workflow: WorkflowState | undefined = state.workflowState, kind: "state" | "status-query" | "automatic-turn" = "state") {
    state.workflowProgressObservation = workflow ? tracker.observe(workflow, kind) : undefined;
  }
  function reset(workflow: WorkflowState | undefined = state.workflowState) {
    tracker.reset();
    clearReads();
    clearFailures();
    nonReadInFlight.clear(); ambiguousActivity = false;
    pendingStatusCalls.clear();
    state.workflowProgressObservation = undefined;
    observe(workflow);
  }
  pi.on("tool_call", (event, ctx) => {
    const currentScope = syncScope(ctx);
    if (!reads.has(event.toolName) && event.toolName !== "task_workflow") {
      if (nonReadInFlight.size < 32 && event.toolCallId) nonReadInFlight.add(event.toolCallId);
      else ambiguousActivity = true;
    }
    if (reads.has(event.toolName) && !event.parentToolCallId && currentScope && event.toolCallId) {
      const input = fingerprint(event.input);
      stagePendingCall(pendingReads, event.toolCallId, input,
        { scope: currentScope.id, tool: event.toolName, input: input!, canPause: currentScope.canPause, branchAnchor: ctx.sessionManager.getBranch().at(-1)?.id },
        !ambiguousActivity && nonReadInFlight.size === 0,
        () => { previousRead = undefined; repeats = 0; paused = false; }, clearReads);
    } else if (event.toolName !== "task_workflow" && !event.parentToolCallId) clearReads();
    if (!routingTools.has(event.toolName) && Boolean(event.toolName) && !event.parentToolCallId) {
      if (currentScope && event.toolCallId) {
        const input = fingerprint(event.input);
        const rawPath = event.toolName === "edit" && event.input && typeof event.input === "object"
          ? (event.input as Record<string, unknown>).path
          : undefined;
        const editPath = typeof rawPath === "string" && rawPath.trim() ? rawPath.trim() : undefined;
        stagePendingCall(pendingFailures, event.toolCallId, input,
          { scope: currentScope.id, tool: event.toolName, input: input!, ...(editPath ? { editPath } : {}), branchAnchor: ctx.sessionManager.getBranch().at(-1)?.id },
          true,
          () => { previousFailure = undefined; failureRepeats = 0; failureHinted = false; }, clearFailures);
      } else {
        clearFailures();
      }
    }
    if (event.toolName !== "task_workflow" || event.input?.action !== "status" || !event.toolCallId) return;
    pendingStatusCalls.add(event.toolCallId);
    while (pendingStatusCalls.size > 32) pendingStatusCalls.delete(pendingStatusCalls.values().next().value!);
  });
  pi.on("tool_result", async (event, ctx) => {
    const currentScope = syncScope(ctx);
    nonReadInFlight.delete(event.toolCallId);
    const call = popPendingCall(pendingReads, event.toolCallId, ctx, clearReads);
    const failureCall = popPendingCall(pendingFailures, event.toolCallId, ctx, clearFailures);
    let hintText: string | undefined;
    if (reads.has(event.toolName)) {
      if (event.isError) clearReads();
      else if (isEligibleScopedCall(call, currentScope, event.toolName, ctx)) {
        const output = fingerprint([event.content, event.details]);
        const key = output && fingerprint([call.tool, call.input, output]);
        if (!key || key !== previousRead) { previousRead = key; repeats = 0; paused = false; }
        else {
          repeats++;
          const hint = repeats === 3;
          const shouldPause = call.canPause && repeats === 6 && !paused;
          if (hint || shouldPause) {
            state.traceHandoff?.(ctx, "workflow.suspected_loop", {
              code: "WORKFLOW_REPEATED_READ", scopeHash: currentScope!.id,
              inputHash: call.input, outputHash: output, repeats,
            });
          }
          if (hint) hintText = call.canPause ? WORKFLOW_REPEATED_READ_HINT : SESSION_REPEATED_READ_HINT;
          if (shouldPause) {
            paused = true;
            await options.onRepeatedRead?.(ctx);
          }
        }
      }
    } else if (event.toolName !== "task_workflow" && !event.parentToolCallId) clearReads();
    if (!routingTools.has(event.toolName) && Boolean(event.toolName) && !event.parentToolCallId) {
      if (!event.isError) clearFailures();
      else if (isEligibleScopedCall(failureCall, currentScope, event.toolName, ctx)
        && ((Array.isArray(event.content) && event.content.length > 0) || event.details !== undefined)) {
        const output = fingerprint([event.content, event.details]);
        const targetHash = (failureCall.editPath && fingerprint(failureCall.editPath)) || failureCall.input;
        const key = failureCall.editPath
          ? targetHash && output && fingerprint(["edit-error", targetHash])
          : output && fingerprint(["tool-error", failureCall.tool, failureCall.input, output]);
        if (!key || key !== previousFailure) {
          previousFailure = key;
          failureRepeats = key ? 1 : 0;
          failureHinted = false;
        } else {
          failureRepeats++;
          if (failureRepeats === 3 && !failureHinted) {
            failureHinted = true;
            state.traceHandoff?.(ctx, "workflow.suspected_loop", {
              code: "WORKFLOW_REPEATED_TOOL_ERROR",
              toolName: failureCall.tool,
              scopeHash: currentScope!.id,
              inputHash: targetHash,
              outputHash: output,
              repeats: failureRepeats,
            });
            hintText = failureCall.tool === "edit" ? REPEATED_EDIT_ERROR_HINT : REPEATED_TOOL_ERROR_HINT;
          }
        }
      } else {
        clearFailures();
      }
    }
    if (pendingStatusCalls.delete(event.toolCallId)) {
      if (!event.isError) observe(undefined, "status-query");
      return;
    }
    if (event.toolName === "task_workflow" || !event.toolName) return;
    state.workflowProgressObservation = tracker.observeActivity(state.workflowState,
      `${event.toolName}${event.isError ? "（失败）" : ""}`);
    if (hintText) {
      return {
        content: [...(Array.isArray(event.content) ? event.content : []), { type: "text" as const, text: hintText }],
        ...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
      };
    }
  });
  pi.on("agent_settled", () => observe(undefined, "automatic-turn"));
  onLifecycleReset(pi, () => reset(undefined), {
    externalInput: () => reset(),
    branchMove: "changed-only",
    onUnchangedBranch: () => observe(),
  });
  return { observe, reset };
}

export function createWorkflowStatusPollingGuard(pi: ExtensionAPI, state: ExtensionRuntimeState) {
  let previousKey: string | undefined;
  let previousCallId: string | undefined;
  let stopped = false;
  let fullObserved = false;
  let sourcesObserved = false;
  function reset() { previousKey = undefined; previousCallId = undefined; stopped = false; fullObserved = false; sourcesObserved = false; }
  function observe(toolCallId: string, ctx: ExtensionContext, request: { detail?: unknown; evidenceIds?: readonly string[] } = {}) {
    const view = createCurrentWorkflowStatusView(state);
    const waiting = view.kind === "restore-error" || view.kind === "workflow"
      && ["paused", "execution-blocked", "waiting-dispatch", "waiting-task", "compaction-stalled"].includes(view.activity);
    if (state.runtimeDisposed || !waiting
      || state.workflowState && state.workflowState.sessionId !== ctx.sessionManager.getSessionId()) {
      reset(); return { stop: false as const };
    }
    const key = fingerprint({ sessionId: ctx.sessionManager.getSessionId(), workflow: state.workflowState,
      role: state.activeRole, contextGeneration: state.roleContextGeneration,
      roleTransitionGeneration: state.roleTransitionGeneration, roleRecoveryPending: state.roleRecoveryPending,
      roleRecoveryPersistenceFailed: state.roleRecoveryPersistenceFailed, pendingWorkflowRecovery: state.pendingWorkflowRecovery,
      workflowRestoreError: state.workflowRestoreError, userStopRequested: state.userStopRequested,
      workflowDispatchInFlight: state.workflowDispatchInFlight, internalContinuationPending: state.internalContinuationPending,
      roleCompactionPhase: state.roleCompactionPhase, pendingRoleCompaction: state.pendingRoleCompaction,
      activeRoleCompaction: state.activeRoleCompaction });
    if (!key) { reset(); return { stop: false as const }; }
    const full = request.detail === "full";
    const sources = Array.isArray(request.evidenceIds) && request.evidenceIds.length > 0 && request.evidenceIds.length <= 8
      && request.evidenceIds.every(id => typeof id === "string" && id.trim().length > 0 && id.length <= 256);
    if (key !== previousKey) {
      previousKey = key; previousCallId = toolCallId; stopped = false;
      fullObserved = full; sourcesObserved = sources;
      return { stop: false as const };
    }
    if (previousCallId === toolCallId && !stopped) return { stop: false as const };
    // An explicit detail/source read provides new content once per scope. Switching query
    // shapes or source IDs repeatedly must not reset the no-progress budget.
    if (!stopped && (full && !fullObserved || sources && !sourcesObserved)) {
      fullObserved ||= full; sourcesObserved ||= sources; previousCallId = toolCallId;
      return { stop: false as const };
    }
    const firstStop = !stopped;
    previousCallId = toolCallId;
    stopped = true;
    return { stop: true as const, firstStop, code: "WORKFLOW_STATUS_NO_PROGRESS" as const };
  }
  onLifecycleReset(pi, reset, { agentStart: true, modelSelect: true, externalInput: true });
  return { observe };
}
export function createRepeatedRejectionGuard(pi: ExtensionAPI, state: ExtensionRuntimeState) {
  const counts = new Map<string, { count: number; calls: Set<string> }>();
  let scope: string | undefined;
  function reset() { counts.clear(); scope = undefined; }
  function observe(event: { toolName: string; toolCallId: string; action?: unknown; role?: unknown; code: string }, ctx: ExtensionContext) {
    const workflow = state.workflowState;
    const task = workflow?.tasks.find(item => item.id === workflow.currentTaskId);
    const identity = fingerprint({ sessionId: ctx.sessionManager.getSessionId(), workflowId: workflow?.workflowId, taskId: task?.id, status: workflow?.status, taskStatus: task?.status, outcomeUnknown: task?.outcomeUnknown, handoff: workflow?.handoff, recoveryGeneration: workflow?.recoveryGeneration, role: state.activeRole, contextGeneration: state.roleContextGeneration });
    if (scope !== identity) { reset(); scope = identity; }
    if (!workflow || !task || !["running", "replanning", "paused"].includes(workflow.status)) return { stop: false as const };
    const key = fingerprint([event.toolName, event.action, event.role, event.code])!;
    const entry = counts.get(key) ?? { count: 0, calls: new Set<string>() };
    if (!entry.calls.has(event.toolCallId)) { entry.count++; if (entry.calls.size < 32) entry.calls.add(event.toolCallId); }
    counts.set(key, entry);
    if (counts.size > 32) counts.delete(counts.keys().next().value!);
    return { stop: entry.count >= 3, firstStop: entry.count === 3, code: "WORKFLOW_REJECTION_NO_PROGRESS" as const };
  }
  onLifecycleReset(pi, reset, { externalInput: true });
  return { observe, reset };
}
