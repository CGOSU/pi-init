import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeRunTiming, createRunTiming, isExternalRunSource } from "../src/run-timing.js";
import type { RunTimingEntryData } from "./contracts.ts";

const RUN_TIMING_ENTRY_TYPE = "pi-init-run-timing";

type PendingProbe = {
  source: string;
  inputAt: number;
};

type AcceptedProbe = PendingProbe & {
  beforeAgentStartAt: number;
};

type ActiveTiming = NonNullable<ReturnType<typeof createRunTiming>> & RunTimingEntryData;

export function createRunTimingDiagnostics(
  pi: ExtensionAPI,
  isWorkflowActive: () => boolean,
) {
  let pendingProbe: PendingProbe | undefined;
  let acceptedProbe: AcceptedProbe | undefined;
  let activeTiming: ActiveTiming | undefined;

  function clearProbes() {
    pendingProbe = undefined;
    acceptedProbe = undefined;
  }

  function captureInput(source: unknown) {
    if (!isExternalRunSource(source)) return false;
    if (isWorkflowActive()) {
      clearProbes();
      return true;
    }
    if (!activeTiming && !pendingProbe) {
      pendingProbe = { source, inputAt: Date.now() };
    }
    return true;
  }

  function beforeAgentStart(internalContinuationPending: boolean) {
    if (internalContinuationPending) {
      clearProbes();
      return;
    }
    if (!pendingProbe) return;
    if (activeTiming || isWorkflowActive()) {
      clearProbes();
      return;
    }
    acceptedProbe = { ...pendingProbe, beforeAgentStartAt: Date.now() };
    pendingProbe = undefined;
  }

  function agentStart() {
    const probe = acceptedProbe;
    acceptedProbe = undefined;
    pendingProbe = undefined;
    if (isWorkflowActive()) {
      activeTiming = undefined;
      return;
    }
    if (activeTiming || !probe) return;
    const timing = createRunTiming(probe.source);
    if (timing) activeTiming = { ...timing, ...probe };
  }

  function settle() {
    const timing = activeTiming;
    activeTiming = undefined;
    clearProbes();
    if (!timing || isWorkflowActive()) return;
    const settledAt = Date.now();
    timing.settledAt = settledAt;
    const completed = completeRunTiming(timing, settledAt);
    if (completed) pi.appendEntry(RUN_TIMING_ENTRY_TYPE, completed);
  }

  function reset() {
    activeTiming = undefined;
    clearProbes();
  }

  pi.on("before_provider_request", () => {
    if (activeTiming && activeTiming.beforeProviderRequestAt === undefined) {
      activeTiming.beforeProviderRequestAt = Date.now();
    }
  });

  pi.on("message_update", (event) => {
    if (
      activeTiming
      && activeTiming.firstMessageUpdateAt === undefined
      && event.message?.role === "assistant"
    ) {
      activeTiming.firstMessageUpdateAt = Date.now();
    }
  });

  return { captureInput, beforeAgentStart, agentStart, settle, reset };
}
