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
  let providerRequestStartedAt: number | undefined;
  const toolStarts = new Map<string, { name: string; startedAt: number }>();

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
      providerRequestStartedAt = undefined;
      toolStarts.clear();
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

  function finishProviderRequest(endedAt: number) {
    if (!activeTiming || providerRequestStartedAt === undefined || endedAt < providerRequestStartedAt) return;
    const durations = Array.isArray(activeTiming.providerRequestDurations)
      ? activeTiming.providerRequestDurations.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      : [];
    if (durations.length < 8) durations.push(endedAt - providerRequestStartedAt);
    activeTiming.providerRequestDurations = durations;
    providerRequestStartedAt = undefined;
  }

  function settle() {
    const timing = activeTiming;
    const settledAt = Date.now();
    finishProviderRequest(settledAt);
    activeTiming = undefined;
    providerRequestStartedAt = undefined;
    toolStarts.clear();
    clearProbes();
    if (!timing || isWorkflowActive()) return;
    timing.settledAt = settledAt;
    const completed = completeRunTiming(timing, settledAt);
    if (completed) pi.appendEntry(RUN_TIMING_ENTRY_TYPE, completed);
  }

  function reset() {
    activeTiming = undefined;
    providerRequestStartedAt = undefined;
    toolStarts.clear();
    clearProbes();
  }

  pi.on("before_provider_request", () => {
    if (!activeTiming) return;
    const requestedAt = Date.now();
    finishProviderRequest(requestedAt);
    providerRequestStartedAt = requestedAt;
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
    const endedAt = Date.now();
    finishProviderRequest(endedAt);
    activeTiming.assistantMessageEndAt = endedAt;
    activeTiming.assistantMessageEndCount = (activeTiming.assistantMessageEndCount as number ?? 0) + 1;
  });

  pi.on("agent_end", () => {
    if (!activeTiming) return;
    const endedAt = Date.now();
    finishProviderRequest(endedAt);
    activeTiming.agentEndAt = endedAt;
    activeTiming.agentEndCount = (activeTiming.agentEndCount as number ?? 0) + 1;
  });

  pi.on("tool_execution_start", (event) => {
    if (!activeTiming) return;
    const startedAt = Date.now();
    toolStarts.set(event.toolCallId, { name: event.toolName, startedAt });
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
    const started = toolStarts.get(event.toolCallId);
    if (started !== undefined) {
      const durationMs = Math.max(0, endedAt - started.startedAt);
      activeTiming.toolExecutionDurationMs = (activeTiming.toolExecutionDurationMs as number ?? 0) + durationMs;
      const durations = Array.isArray(activeTiming.toolDurations) ? activeTiming.toolDurations : [];
      if (durations.length < 8) durations.push({ name: started.name, durationMs });
      activeTiming.toolDurations = durations;
      toolStarts.delete(event.toolCallId);
    }
  });

  return { captureInput, beforeAgentStart, agentStart, settle, reset };
}
