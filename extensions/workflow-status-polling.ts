import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isExternalRunSource } from "../src/run-timing.ts";
import { fingerprint } from "./handoff-tool-diagnostics.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";

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
  pi.on("tool_result", event => { if (event.toolName !== "task_workflow" && event.toolName !== "switch_role") reset(); });
  return { observe };
}
