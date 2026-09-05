import type { AssistantMessage, AssistantMessageEvent, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "pi-cache";
type ActivePhase = "input" | "output";
type ResultKind = "reported" | "unreported" | "error" | "aborted";
type CacheCounts = { read: number; write: number };
type CacheResult = CacheCounts & { kind: ResultKind };

type MessageUpdateEvent = {
  message?: AssistantMessage;
  assistantMessageEvent?: AssistantMessageEvent;
};

function positiveNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function countsFromUsage(usage: Partial<Usage> | undefined): CacheCounts {
  return {
    read: positiveNumber(usage?.cacheRead),
    write: positiveNumber(usage?.cacheWrite),
  };
}

function formatTokens(value: number) {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1000000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1000000).toFixed(1)}M`;
}

function style(ctx: ExtensionContext, color: "accent" | "success" | "warning" | "error" | "muted", text: string, bold = false) {
  const themed = ctx.ui.theme.fg(color, text);
  return bold && typeof ctx.ui.theme.bold === "function" ? ctx.ui.theme.bold(themed) : themed;
}

function hasCacheCounts(counts: CacheCounts) {
  return counts.read > 0 || counts.write > 0;
}

function formatConfirmedCounts(ctx: ExtensionContext, counts: CacheCounts) {
  const parts: string[] = [];
  if (counts.read > 0) parts.push(style(ctx, "success", `R缓存读 ${formatTokens(counts.read)}`));
  if (counts.write > 0) parts.push(style(ctx, "success", `W缓存写 ${formatTokens(counts.write)}`));
  return parts.join(" · ");
}

function isOutputDelta(event: MessageUpdateEvent) {
  const type = event.assistantMessageEvent?.type;
  return type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta";
}

export function createCacheStatus(pi: ExtensionAPI) {
  let activePhase: ActivePhase | undefined;
  let activeCounts: CacheCounts = { read: 0, write: 0 };
  let requestActive = false;
  let lastResult: CacheResult | undefined;
  let lastRendered: string | undefined;

  function setStatus(ctx: ExtensionContext, text: string | undefined) {
    if (text === lastRendered) return;
    lastRendered = text;
    ctx.ui.setStatus(STATUS_KEY, text);
  }

  function renderIdle(ctx: ExtensionContext) {
    setStatus(ctx, style(ctx, "muted", "缓存 · 等待请求"));
  }

  function renderActive(ctx: ExtensionContext) {
    const phase = activePhase === "output" ? "↓Output" : "↑Input";
    const phaseText = style(ctx, "accent", phase, true);
    const confirmed = formatConfirmedCounts(ctx, activeCounts);
    const cacheText = confirmed
      ? `${confirmed} · ${style(ctx, "warning", "◌ 缓存判定中")}`
      : style(ctx, "warning", "◌ 缓存判定中");
    setStatus(ctx, `${phaseText} · ${cacheText}`);
  }

  function renderResult(ctx: ExtensionContext) {
    if (!lastResult) {
      renderIdle(ctx);
      return;
    }
    if (lastResult.kind === "error") {
      setStatus(ctx, style(ctx, "error", "✕ 上轮请求失败 · 缓存未报告"));
      return;
    }
    if (lastResult.kind === "aborted") {
      setStatus(ctx, style(ctx, "warning", "! 上轮请求已中止 · 缓存未报告"));
      return;
    }
    if (!hasCacheCounts(lastResult)) {
      setStatus(ctx, style(ctx, "muted", "– 上轮缓存未报告"));
      return;
    }
    setStatus(ctx, `${style(ctx, "success", "✓ 上轮")} · ${formatConfirmedCounts(ctx, lastResult)}`);
  }

  function reset(ctx: ExtensionContext) {
    activePhase = undefined;
    activeCounts = { read: 0, write: 0 };
    requestActive = false;
    lastResult = undefined;
    lastRendered = undefined;
    renderIdle(ctx);
  }

  function beginRequest(ctx: ExtensionContext) {
    activePhase = "input";
    activeCounts = { read: 0, write: 0 };
    requestActive = true;
    lastResult = undefined;
    renderActive(ctx);
  }

  function updatePartial(ctx: ExtensionContext, event: MessageUpdateEvent) {
    if (!requestActive || event.message?.role !== "assistant") return;
    const partial = event.assistantMessageEvent?.partial;
    const incoming = countsFromUsage(partial?.usage ?? event.message.usage);
    activeCounts = {
      read: Math.max(activeCounts.read, incoming.read),
      write: Math.max(activeCounts.write, incoming.write),
    };
    if (isOutputDelta(event)) activePhase = "output";
    renderActive(ctx);
  }

  function finishRequest(ctx: ExtensionContext, message: AssistantMessage) {
    const counts = countsFromUsage(message.usage);
    const kind: ResultKind = message.stopReason === "aborted"
      ? "aborted"
      : message.stopReason === "error"
        ? "error"
        : hasCacheCounts(counts)
          ? "reported"
          : "unreported";
    activePhase = undefined;
    activeCounts = { read: 0, write: 0 };
    requestActive = false;
    lastResult = { ...counts, kind };
    renderResult(ctx);
  }

  pi.on("session_start", async (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    activePhase = undefined;
    activeCounts = { read: 0, write: 0 };
    requestActive = false;
    lastResult = undefined;
    lastRendered = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
  pi.on("model_select", async (_event, ctx) => reset(ctx));
  pi.on("before_provider_request", async (_event, ctx) => beginRequest(ctx));
  pi.on("message_update", async (event, ctx) => updatePartial(ctx, event as MessageUpdateEvent));
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role === "assistant") finishRequest(ctx, event.message);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (requestActive) {
      requestActive = false;
      activePhase = undefined;
      activeCounts = { read: 0, write: 0 };
      lastResult ??= { read: 0, write: 0, kind: "unreported" };
    }
    renderResult(ctx);
  });
}
