import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isExternalRunSource } from "../src/run-timing.ts";
import { fingerprint } from "./handoff-tool-diagnostics.ts";
import { createWorkflowProgressTracker } from "../src/workflow-progress.ts";
import type { ExtensionRuntimeState, WorkflowState } from "./runtime-state.ts";
import { workflowHandoffMessageOnBranch } from "../src/workflow-handoff.ts";

export function createWorkflowProgressObserver(pi: ExtensionAPI, state: ExtensionRuntimeState,
  options: { onRepeatedRead?: (ctx: ExtensionContext) => void | Promise<void> } = {}) {
  const tracker = createWorkflowProgressTracker();
  const pendingStatusCalls = new Set<string>();
  const reads = new Set(["read", "grep", "find", "ls"]);
  const pendingReads = new Map<string, { scope: string; tool: string; input: string; eligible: boolean; branchAnchor?: string }>();
  const nonReadInFlight = new Set<string>();
  let ambiguousActivity = false;
  let readScope: string | undefined;
  let previousRead: string | undefined;
  let repeats = 0;
  let paused = false;
  function clearReads() {
    pendingReads.clear(); previousRead = undefined; repeats = 0; paused = false; readScope = undefined;
  }
  function scope(ctx: ExtensionContext) {
    if (!ctx?.isProjectTrusted?.()) return undefined;
    const w = state.workflowState, h = w?.handoff;
    const task = w?.tasks.find(item => item.id === w.currentTaskId);
    if (!w || !h || !task || w.status !== "running" || h.phase !== "executing"
      || task.status !== "in_progress" || task.outcomeUnknown || task.delegation
      || !state.activeRole || task.role !== state.activeRole.role
      || state.runtimeDisposed || state.userStopRequested || state.roleRecoveryPending
      || state.roleRecoveryPersistenceFailed || state.pendingWorkflowRecovery || state.workflowRestoreError
      || state.pendingRoleCompaction || state.roleCompactionInFlight || state.activeRoleCompaction
      || w.continuation || w.pendingRevision
      || !w.workflowId || !h.attemptId || !h.handoffId || h.taskId !== task.id
      || h.workflowId !== w.workflowId || h.planVersion !== w.planVersion
      || h.recoveryGeneration !== w.recoveryGeneration || h.sessionId !== w.sessionId
      || w.sessionId !== ctx.sessionManager.getSessionId() || !workflowHandoffMessageOnBranch(ctx, h)) return undefined;
    return fingerprint([w.workflowId, w.planVersion, w.sessionId, w.recoveryGeneration,
      task.id, h.attemptId, h.handoffId, state.activeRole,
      state.roleContextGeneration, state.roleTransitionGeneration]);
  }
  function syncScope(ctx: ExtensionContext) {
    const next = scope(ctx);
    if (!next || next !== readScope) { clearReads(); readScope = next; }
    return next;
  }
  function observe(workflow: WorkflowState | undefined = state.workflowState, kind: "state" | "status-query" | "automatic-turn" = "state") {
    state.workflowProgressObservation = workflow ? tracker.observe(workflow, kind) : undefined;
  }
  function reset(workflow: WorkflowState | undefined = state.workflowState) {
    tracker.reset();
    clearReads();
    nonReadInFlight.clear(); ambiguousActivity = false;
    pendingStatusCalls.clear();
    state.workflowProgressObservation = undefined;
    observe(workflow);
  }
  pi.on("tool_call", (event, ctx) => {
    const identity = syncScope(ctx);
    if (!reads.has(event.toolName) && event.toolName !== "task_workflow") {
      if (nonReadInFlight.size < 32 && event.toolCallId) nonReadInFlight.add(event.toolCallId);
      else ambiguousActivity = true;
    }
    if (reads.has(event.toolName) && identity && event.toolCallId) {
      const input = fingerprint(event.input);
      // Concurrent observations are ambiguous: never count them toward a pause.
      const overlap = pendingReads.size > 0;
      if (overlap) {
        previousRead = undefined; repeats = 0; paused = false;
        for (const call of pendingReads.values()) call.eligible = false;
      }
      if (input) pendingReads.set(event.toolCallId, { scope: identity, tool: event.toolName, input, branchAnchor: ctx.sessionManager.getBranch().at(-1)?.id, eligible: !overlap && !ambiguousActivity && nonReadInFlight.size === 0 });
      if (pendingReads.size > 32) clearReads();
    } else if (event.toolName !== "task_workflow") clearReads();
    if (event.toolName !== "task_workflow" || event.input?.action !== "status" || !event.toolCallId) return;
    pendingStatusCalls.add(event.toolCallId);
    while (pendingStatusCalls.size > 32) pendingStatusCalls.delete(pendingStatusCalls.values().next().value!);
  });
  pi.on("tool_result", async (event, ctx) => {
    const identity = syncScope(ctx);
    nonReadInFlight.delete(event.toolCallId);
    const call = pendingReads.get(event.toolCallId);
    pendingReads.delete(event.toolCallId);
          if (call?.branchAnchor && !ctx.sessionManager.getBranch().some(entry => entry.id === call.branchAnchor)) clearReads();
      let hint = false;
    if (reads.has(event.toolName)) {
      if (event.isError) clearReads();
      else if (call?.eligible && identity && call.scope === identity && call.tool === event.toolName && call.branchAnchor !== undefined && ctx.sessionManager.getBranch().some(entry => entry.id === call.branchAnchor)) {
        const output = fingerprint([event.content, event.details]);
        const key = output && fingerprint([call.tool, call.input, output]);
        if (!key || key !== previousRead) { previousRead = key; repeats = 0; paused = false; }
        else {
          repeats++;
          hint = repeats === 3;
          if (hint || (repeats === 6 && !paused)) {
            state.traceHandoff?.(ctx, "workflow.suspected_loop", {
              code: "WORKFLOW_REPEATED_READ", scopeHash: identity,
              inputHash: call.input, outputHash: output, repeats,
            });
          }
          if (repeats === 6 && !paused) {
            paused = true;
            await options.onRepeatedRead?.(ctx);
          }
        }
      }
    } else if (event.toolName !== "task_workflow") clearReads();
    if (pendingStatusCalls.delete(event.toolCallId)) {
      if (!event.isError) observe(undefined, "status-query");
      return;
    }
    if (event.toolName === "task_workflow" || !event.toolName) return;
    state.workflowProgressObservation = tracker.observeActivity(state.workflowState,
      `${event.toolName}${event.isError ? "（失败）" : ""}`);
    if (hint) return { content: [...event.content, { type: "text" as const,
      text: "WORKFLOW_REPEATED_READ：相同范围的只读观察连续重复，未发现新信息。请依据已有事实推进或说明阻塞；持续重复将请求暂停。" }] };
  });
  pi.on("agent_settled", () => observe(undefined, "automatic-turn"));
  pi.on("session_start", () => reset(undefined));
  pi.on("session_tree", event => {
    if (event.oldLeafId !== event.newLeafId) reset(undefined);
    else observe();
  });
  pi.on("session_shutdown", () => reset(undefined));
  pi.on("input", event => {
    if (isExternalRunSource(event.source)) reset();
  });
  return { observe, reset };
}

export function createPausedStatusGuard(pi: ExtensionAPI, state: ExtensionRuntimeState) {
  let previousKey: string | undefined;
  let previousCallId: string | undefined;
  let stopped = false;
  function reset() { previousKey = undefined; previousCallId = undefined; stopped = false; }
  function observe(toolCallId: string, ctx: ExtensionContext) {
    if (state.runtimeDisposed || state.workflowState?.status !== "paused") { reset(); return { stop: false as const }; }
    const key = fingerprint({ sessionId: ctx.sessionManager.getSessionId(), workflow: state.workflowState,
 role: state.activeRole, contextGeneration: state.roleContextGeneration,
      roleTransitionGeneration: state.roleTransitionGeneration, roleRecoveryPending: state.roleRecoveryPending,
      roleRecoveryPersistenceFailed: state.roleRecoveryPersistenceFailed, pendingWorkflowRecovery: state.pendingWorkflowRecovery,
      workflowRestoreError: state.workflowRestoreError });
    if (!key) { reset(); return { stop: false as const }; }
    if (key !== previousKey) { previousKey = key; previousCallId = toolCallId; stopped = false; return { stop: false as const }; }
    if (previousCallId === toolCallId && !stopped) return { stop: false as const };
    const firstStop = !stopped;
    previousCallId = toolCallId;
    stopped = true;
    return { stop: true as const, firstStop, code: "WORKFLOW_STATUS_NO_PROGRESS" as const };
  }
  pi.on("agent_start", reset);
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);
  pi.on("model_select", reset);
  pi.on("input", event => { if (isExternalRunSource(event.source)) reset(); });
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
  pi.on("input", event => { if (isExternalRunSource(event.source)) reset(); });
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);
  return { observe, reset };
}
