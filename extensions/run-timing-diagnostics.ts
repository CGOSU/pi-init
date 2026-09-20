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
  const toolStarts = new Map<string, number>();

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
    if (activeTiming) {
      activeTiming.agentStartCount = (activeTiming.agentStartCount as number ?? 0) + 1;
      return;
    }
    if (!probe) return;
    const timing = createRunTiming(probe.source);
    if (timing) activeTiming = { ...timing, ...probe, agentStartCount: 1 };
  }

  function settle() {
    const timing = activeTiming;
    activeTiming = undefined;
    toolStarts.clear();
    clearProbes();
    if (!timing || isWorkflowActive()) return;
    const settledAt = Date.now();
    timing.settledAt = settledAt;
    const completed = completeRunTiming(timing, settledAt);
    if (completed) pi.appendEntry(RUN_TIMING_ENTRY_TYPE, completed);
  }

  function reset() {
    activeTiming = undefined;
    toolStarts.clear();
    clearProbes();
  }

  pi.on("before_provider_request", () => {
    if (!activeTiming) return;
    const requestedAt = Date.now();
    activeTiming.beforeProviderRequestAt ??= requestedAt;
    activeTiming.lastProviderRequestAt = requestedAt;
    activeTiming.providerRequestCount = (activeTiming.providerRequestCount as number ?? 0) + 1;
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

  pi.on("message_end", (event) => {
    if (!activeTiming || event.message?.role !== "assistant") return;
    activeTiming.assistantMessageEndAt = Date.now();
    activeTiming.assistantMessageEndCount = (activeTiming.assistantMessageEndCount as number ?? 0) + 1;
  });

  pi.on("agent_end", () => {
    if (!activeTiming) return;
    activeTiming.agentEndAt = Date.now();
    activeTiming.agentEndCount = (activeTiming.agentEndCount as number ?? 0) + 1;
  });

  pi.on("tool_execution_start", (event) => {
    if (!activeTiming) return;
    const startedAt = Date.now();
    toolStarts.set(event.toolCallId, startedAt);
    activeTiming.toolExecutionStartAt ??= startedAt;
    activeTiming.toolExecutionCount = (activeTiming.toolExecutionCount as number ?? 0) + 1;
    const names = Array.isArray(activeTiming.toolNames) ? activeTiming.toolNames : [];
    if (typeof event.toolName === "string" && names.length < 8 && !names.includes(event.toolName)) names.push(event.toolName);
    activeTiming.toolNames = names;
  });

  pi.on("tool_execution_end", (event) => {
    if (!activeTiming) return;
    const endedAt = Date.now();
    activeTiming.toolExecutionEndAt = endedAt;
    const startedAt = toolStarts.get(event.toolCallId);
    if (startedAt !== undefined) {
      activeTiming.toolExecutionDurationMs = (activeTiming.toolExecutionDurationMs as number ?? 0) + endedAt - startedAt;
      toolStarts.delete(event.toolCallId);
    }
  });

  return { captureInput, beforeAgentStart, agentStart, settle, reset };
}
