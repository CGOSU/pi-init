import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isExternalRunSource } from "../src/run-timing.ts";
import { fingerprint } from "./handoff-tool-diagnostics.ts";
import { createWorkflowProgressTracker } from "../src/workflow-progress.ts";
import type { ExtensionRuntimeState, WorkflowState } from "./runtime-state.ts";

export function createWorkflowProgressObserver(pi: ExtensionAPI, state: ExtensionRuntimeState) {
  const tracker = createWorkflowProgressTracker();
  const pendingStatusCalls = new Set<string>();
  function observe(workflow: WorkflowState | undefined = state.workflowState, kind: "state" | "status-query" | "automatic-turn" = "state") {
    state.workflowProgressObservation = workflow ? tracker.observe(workflow, kind) : undefined;
  }
  function reset(workflow: WorkflowState | undefined = state.workflowState) {
    tracker.reset();
    pendingStatusCalls.clear();
    state.workflowProgressObservation = undefined;
    observe(workflow);
  }
  pi.on("tool_call", event => {
    if (event.toolName !== "task_workflow" || event.input?.action !== "status" || !event.toolCallId) return;
    pendingStatusCalls.add(event.toolCallId);
    while (pendingStatusCalls.size > 32) pendingStatusCalls.delete(pendingStatusCalls.values().next().value!);
  });
  pi.on("tool_result", event => {
    if (pendingStatusCalls.delete(event.toolCallId)) {
      if (!event.isError) observe(undefined, "status-query");
      return;
    }
    if (event.toolName === "task_workflow" || !event.toolName) return;
    state.workflowProgressObservation = tracker.observeActivity(state.workflowState,
      `${event.toolName}${event.isError ? "（失败）" : ""}`);
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
      coordination: state.coordinationRuntimeState, role: state.activeRole, contextGeneration: state.roleContextGeneration,
      roleTransitionGeneration: state.roleTransitionGeneration, roleRecoveryPending: state.roleRecoveryPending,
      roleRecoveryPersistenceFailed: state.roleRecoveryPersistenceFailed, pendingWorkflowRecovery: state.pendingWorkflowRecovery,
      workflowRestoreError: state.workflowRestoreError, coordinationRestoreError: state.coordinationRestoreError });
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
