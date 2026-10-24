import { createHmac, randomBytes } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionRuntimeState } from "./runtime-state.ts";

type Data = Record<string, unknown>;
type Count = { state: string; tokens?: number; message?: string };
type Usage = { state: string; read: Count; write: Count };
type ActiveRequest = {
  cwd: string; sessionId: string; scope: string; provider?: string; model?: string;
  data: Data; streamObserved: boolean; responseId?: string; assistantId?: string;
  usage: Usage; usageEvents: number; lastUsage?: string; terminalUsage?: string; responseStarted?: boolean;
};

// This is also the persistence allowlist. Neither payloads nor arbitrary stream fields cross it.
export const cacheDiagnosticFields = [
  "requestNumber", "requestStage", "usageStage", "normalizedStage", "fingerprintScheme", "transport", "requestForm",
  "profileProvider", "profileModel", "profileRole", "profileThinkingLevel", "contextGeneration", "roleTransitionGeneration",
  "compactionPhase", "compactionInFlight", "compactionFingerprint", "handoffFingerprint", "cacheKeyPresence",
  "systemFingerprint", "contextFingerprint", "toolsFingerprint", "promptFingerprint", "responseFingerprint",
  "streamHook", "rawApi", "rawEvent", "rawUsageState", "rawReadState", "rawReadTokens", "rawWriteState", "rawWriteTokens",
  "normalizedReadState", "normalizedReadTokens", "normalizedWriteState", "normalizedWriteTokens", "readComparison",
  "correlation", "cacheConclusion", "cacheOutcome", "duplicateUsageEvents", "usageEvents", "observationError",
] as const;

function object(value: unknown): Data {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
}
function count(value: unknown): Count {
  if (value === undefined) return { state: "missing", message: "Cache token count was not supplied." };
  if (typeof value !== "number") return { state: "invalid-type", message: "Cache token count must be numeric." };
  if (!Number.isFinite(value)) return { state: "invalid-format", message: "Cache token count must be finite." };
  if (value < 0) return { state: "invalid-range", message: "Cache token count must be nonnegative." };
  if (!Number.isInteger(value)) return { state: "invalid-precision", message: "Cache token count must be integral." };
  if (!Number.isSafeInteger(value)) return { state: "invalid-overflow", message: "Cache token count exceeds the safe integer range." };
  return { state: value === 0 ? "zero" : "positive", tokens: value };
}
function usage(value: unknown, readKey: string, writeKey: string): Usage {
  const fields = object(value);
  const state = value === undefined ? "missing" : value === null || typeof value !== "object" || Array.isArray(value) ? "invalid" : "observed";
  return { state, read: count(fields[readKey]), write: count(fields[writeKey]) };
}
function emptyUsage(): Usage { return usage(undefined, "", ""); }

function createFingerprinter() {
  const secret = randomBytes(32);
  return (value: unknown): string => {
    if (value === undefined) return "missing";
    const hash = createHmac("sha256", secret);
    let bytes = 0, nodes = 0;
    function append(text: string) {
      if (text.length > 256 * 1024 || (bytes += Buffer.byteLength(text)) > 256 * 1024) throw new Error("budget");
      hash.update(text);
    }
    function visit(item: unknown, depth: number) {
      if (++nodes > 4096 || depth > 20) throw new Error("budget");
      if (item === undefined) { append("undefined;"); return; }
      if (item === null || typeof item === "boolean" || typeof item === "number") { append(JSON.stringify(item) + ";"); return; }
      if (typeof item === "string") {
        // Check before JSON escaping to avoid allocating a second unbounded string.
        if (item.length > 256 * 1024) throw new Error("budget");
        append(JSON.stringify(item) + ";"); return;
      }
      if (Array.isArray(item)) {
        if (item.length > 4096) throw new Error("budget");
        append("["); for (const child of item) visit(child, depth + 1); append("]"); return;
      }
      if (typeof item !== "object") throw new Error("invalid");
      append("{");
      // Stop enumeration at the budget, rather than allocating Object.keys for a huge object.
      for (const key in item as Data) {
        if (!Object.hasOwn(item, key)) continue;
        visit(key, depth + 1); visit((item as Data)[key], depth + 1);
      }
      append("}");
    }
    try { visit(value, 0); return "hmac:" + hash.digest("hex").slice(0, 32); }
    catch (error) { return error instanceof Error && error.message === "budget" ? "unavailable-budget" : "unavailable-invalid"; }
  };
}

/** Read-only observations, not a transport interceptor or proof of a server-side cache cause. */
export function createCacheRequestDiagnostics(state: ExtensionRuntimeState, emit: (ctx: ExtensionContext, event: string, data: Data) => void) {
  const fingerprint = createFingerprinter();
  let active: ActiveRequest | undefined;
  let streamHook = "not-observed-or-unsupported";
  const completedResponses = new Set<string>();
  let lastAssistant: string | undefined;
  let blockedUntilBoundary = false;

  function scope(ctx: ExtensionContext) {
    return JSON.stringify([ctx.cwd, ctx.sessionManager.getSessionId(), state.roleContextGeneration, state.roleTransitionGeneration,
      state.activeRole, ctx.model?.provider, ctx.model?.id]);
  }
  function current(ctx: ExtensionContext) {
    if (active && (active.cwd !== ctx.cwd || active.sessionId !== ctx.sessionManager.getSessionId())) active = undefined;
    if (active && active.scope !== scope(ctx)) active.data.correlation = "unknown-boundary-change";
    return active;
  }
  function safe(ctx: ExtensionContext, action: () => void) {
    try {
      if (!ctx.isProjectTrusted()) { active = undefined; return; }
      action();
    } catch { if (active) active.data.observationError = true; }
  }
  function remember(id: string | undefined) {
    if (!id) return;
    completedResponses.add(id);
    if (completedResponses.size > 64) completedResponses.delete(completedResponses.values().next().value!);
  }
  function finish(ctx: ExtensionContext, outcome: string, normalized: Usage = emptyUsage()) {
    const request = current(ctx);
    if (!request) return;
    active = undefined;
    const raw = request.usage;
    const associated = request.data.correlation === "ordered-hooks" && request.data.observationError !== true;
    const usable = associated && outcome === "assistant" && raw.state === "observed";
    const rawState = request.data.observationError === true ? "observation-error" : !associated ? "association-unknown"
      : !request.streamObserved ? "no-observation" : raw.state;
    remember(request.responseId);
    emit(ctx, "cache.request", { ...request.data, streamHook: request.streamObserved ? "observed" : streamHook,
      responseFingerprint: request.responseId, rawUsageState: rawState,
      rawReadState: raw.read.state, rawReadTokens: raw.read.tokens, rawWriteState: raw.write.state, rawWriteTokens: raw.write.tokens,
      normalizedStage: "message_end", normalizedReadState: normalized.read.state, normalizedReadTokens: normalized.read.tokens,
      normalizedWriteState: normalized.write.state, normalizedWriteTokens: normalized.write.tokens,
      readComparison: usable && raw.read.tokens !== undefined && normalized.read.tokens !== undefined ? raw.read.tokens === normalized.read.tokens ? "equal" : "different" : "unknown",
      cacheConclusion: usable && raw.read.tokens !== undefined ? raw.read.tokens === 0 ? "raw-read-zero" : "raw-read-positive" : "unknown",
      cacheOutcome: outcome, usageEvents: request.usageEvents });
  }
  function boundary(ctx: ExtensionContext, reason: string) {
    safe(ctx, () => { finish(ctx, reason); blockedUntilBoundary = false; lastAssistant = undefined; });
  }
  function request(ctx: ExtensionContext, payload: unknown, requestNumber: number, thinkingLevel: string) {
    safe(ctx, () => {
      const previous = current(ctx);
      if (previous) { finish(ctx, "superseded"); blockedUntilBoundary = true; }
      active = { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), scope: scope(ctx), provider: ctx.model?.provider, model: ctx.model?.id,
        data: { requestNumber, requestStage: "before_provider_request", usageStage: "provider_stream_event:parsed-before-normalization",
          fingerprintScheme: "runtime-hmac-sha256-selected-v1", transport: "unavailable", requestForm: "unavailable",
          profileProvider: ctx.model?.provider, profileModel: ctx.model?.id, profileRole: state.activeRole?.role ?? "session", profileThinkingLevel: thinkingLevel,
          contextGeneration: state.roleContextGeneration, roleTransitionGeneration: state.roleTransitionGeneration,
          compactionPhase: state.roleCompactionPhase, compactionInFlight: state.roleCompactionInFlight,
          compactionFingerprint: fingerprint(state.roleCompactionOperationId), handoffFingerprint: fingerprint(state.workflowState?.handoff?.handoffId ?? state.pendingRoleCompaction?.budget?.roleHandoffId),
          correlation: blockedUntilBoundary ? "unknown-overlap" : "ordered-hooks" }, streamObserved: false, usage: emptyUsage(), usageEvents: 0 };
      const fields = object(payload);
      const system = fingerprint(fields.instructions ?? fields.system);
      const context = fingerprint(fields.input ?? fields.messages);
      const tools = fingerprint(fields.tools);
      Object.assign(active.data, { cacheKeyPresence: payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? Object.hasOwn(fields, "prompt_cache_key") ? "present" : "absent" : "payload-unavailable",
      systemFingerprint: system, contextFingerprint: context, toolsFingerprint: tools,
      promptFingerprint: [system, context, tools].some(value => value.startsWith("unavailable")) ? "unavailable-partial" : fingerprint([system, context, tools]) });
    });
  }
  function bindResponse(request: ActiveRequest, value: unknown) {
    if (value === undefined) return;
    if (typeof value !== "string" || !value || value.length > 512) { request.data.correlation = "unknown-response-id"; return; }
    const id = fingerprint(value);
    if (completedResponses.has(id) || request.responseId && request.responseId !== id) request.data.correlation = "unknown-response-id";
    else request.responseId = id;
  }
  function observeUsage(request: ActiveRequest, raw: Usage, event: string, terminal = false) {
    const signature = JSON.stringify([event, raw]);
    if (signature === request.lastUsage) {
      request.data.duplicateUsageEvents = Math.min(1024, Number(request.data.duplicateUsageEvents ?? 0) + 1); return;
    }
    if (++request.usageEvents > 16) { request.data.correlation = "unknown-usage-budget"; request.usageEvents = 17; return; }
    if (terminal && request.terminalUsage && request.terminalUsage !== signature) request.data.correlation = "unknown-conflicting-usage";
    if (terminal) request.terminalUsage = signature;
    request.lastUsage = signature;
    request.data.rawEvent = event;
    // Anthropic deltas can omit counters supplied by message_start. Do not erase them.
    request.usage = { state: raw.state === "missing" && request.usage.state === "observed" ? "observed" : raw.state,
      read: raw.read.state === "missing" ? request.usage.read : raw.read,
      write: raw.write.state === "missing" ? request.usage.write : raw.write };
  }
  function stream(ctx: ExtensionContext, event: { provider: string; model: string; api: string; data: unknown }) {
    safe(ctx, () => {
      const request = current(ctx);
      if (!request) return;
      request.streamObserved = true;
      if (request.provider !== event.provider || request.model !== event.model) { request.data.correlation = "unknown-model"; return; }
      const raw = object(event.data);
      const api = event.api;
      if (["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(api)) {
        request.data.rawApi = api;
        const response = object(raw.response);
        bindResponse(request, response.id);
        if (raw.type === "response.created" && request.responseId) request.responseStarted = true;
        if (["response.completed", "response.done", "response.incomplete", "response.failed"].includes(String(raw.type))) {
          if (!request.responseStarted) request.data.correlation = "unknown-response-start";
          const original = object(response.usage);
          const parsed = usage(original.input_tokens_details, "cached_tokens", "cache_write_tokens");
          parsed.state = response.usage === undefined ? "missing" : response.usage === null || typeof response.usage !== "object" || Array.isArray(response.usage) ? "invalid" : "observed";
          observeUsage(request, parsed, String(raw.type), true);
          if (raw.type === "response.failed") request.data.correlation = "unknown-provider-failure";
        }
      } else if (api === "anthropic-messages") {
        request.data.rawApi = api;
        const message = object(raw.message);
        if (raw.type === "message_start") {
          bindResponse(request, message.id);
          if (request.responseId) request.responseStarted = true;
          else request.data.correlation = "unknown-response-start";
          observeUsage(request, usage(message.usage, "cache_read_input_tokens", "cache_creation_input_tokens"), "message_start");
        }
        if (raw.type === "message_delta") {
          if (!request.responseStarted) request.data.correlation = "unknown-response-start";
          observeUsage(request, usage(raw.usage, "cache_read_input_tokens", "cache_creation_input_tokens"), "message_delta");
        }
        if (raw.type === "error") request.data.correlation = "unknown-provider-failure";
      } else { request.usage.state = "unsupported-api"; }
    });
  }
  function assistantStart(ctx: ExtensionContext, message: Data) {
    safe(ctx, () => {
      const request = current(ctx);
      if (!request || message.role !== "assistant") return;
      const id = fingerprint([message.provider, message.model, message.timestamp]);
      if (request.assistantId && request.assistantId !== id || lastAssistant === id) request.data.correlation = "unknown-assistant-id";
      request.assistantId = id;
    });
  }
  function assistant(ctx: ExtensionContext, message: Data) {
    safe(ctx, () => {
      const request = current(ctx);
      if (!request) return;
      if (!request.provider || !request.model || request.provider !== message.provider || request.model !== message.model) request.data.correlation = "unknown-model";
      const id = fingerprint([message.provider, message.model, message.timestamp]);
      if (request.assistantId && request.assistantId !== id || lastAssistant === id) request.data.correlation = "unknown-assistant-id";
      lastAssistant = id;
      bindResponse(request, message.responseId);
      const outcome = ["stop", "length", "toolUse"].includes(String(message.stopReason)) ? "assistant" : message.stopReason === "error" ? "failed" : message.stopReason === "aborted" ? "aborted" : "unknown-assistant-outcome";
      finish(ctx, outcome, usage(message.usage, "cacheRead", "cacheWrite"));
    });
  }
  return { request, stream, assistantStart, assistant, boundary,
    streamUnavailable() { streamHook = "unavailable"; },
    response(ctx: ExtensionContext, status: number) { safe(ctx, () => { const request = current(ctx); if (request && status >= 400) request.data.correlation = "unknown-http-failure"; }); },
    settle(ctx: ExtensionContext, aborted: boolean) { boundary(ctx, aborted ? "aborted" : "settled-without-assistant"); } };
}
