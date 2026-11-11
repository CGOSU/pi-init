import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeRunTiming, createRunTiming, isExternalRunSource, type ExternalRunSource } from "../src/run-timing.ts";
const RUN_TIMING_ENTRY_TYPE = "pi-init-run-timing";
// Keep basic total timing for Worked for; detailed Provider/tool lifecycle diagnostics are disabled.

export function createRunTimingDiagnostics(pi: ExtensionAPI, isWorkflowActive: () => boolean) {
  let pendingSource: ExternalRunSource | undefined;
  let acceptedSource: ExternalRunSource | undefined;
  let activeTiming: ReturnType<typeof createRunTiming>;

  function clearProbes() {
    pendingSource = undefined;
    acceptedSource = undefined;
  }

  function captureInput(source: unknown) {
    if (!isExternalRunSource(source)) return false;
    if (isWorkflowActive()) {
      clearProbes();
      return true;
    }
    if (!activeTiming && !pendingSource) pendingSource = source;
    return true;
  }

  function beforeAgentStart(internalContinuationPending: boolean) {
    if (internalContinuationPending || activeTiming || isWorkflowActive()) {
      clearProbes();
      return;
    }
    if (!pendingSource) return;
    acceptedSource = pendingSource;
    pendingSource = undefined;
  }

  function agentStart() {
    const source = acceptedSource;
    clearProbes();
    if (isWorkflowActive()) {
      activeTiming = undefined;
      return;
    }
    if (!activeTiming && source) activeTiming = createRunTiming(source);
  }

  function reset() {
    activeTiming = undefined;
    clearProbes();
  }

  function settle() {
    const timing = activeTiming;
    const settledAt = Date.now();
    reset();
    if (!timing || isWorkflowActive()) return;
    const completed = completeRunTiming(timing, settledAt);
    if (completed) pi.appendEntry(RUN_TIMING_ENTRY_TYPE, completed);
  }

  return { captureInput, beforeAgentStart, agentStart, settle, reset };
}
