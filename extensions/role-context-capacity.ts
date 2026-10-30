import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionRuntimeState } from "./runtime-state.ts";

type CapacityModel = { provider: string; id: string; api?: string; contextWindow?: number };
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

// No tokenizer or provider output settings are exposed by this hook. This is a
// text-size heuristic, never a hard-fit decision or a provider payload counter.
export function estimateContextCapacity(messages: readonly unknown[] | undefined, model: CapacityModel | undefined) {
  const window = model?.api !== "pi-virtual" && positive(model?.contextWindow) ? model.contextWindow : null;
  let serializedChars: number | null = null;
  try { if (messages) serializedChars = JSON.stringify(messages).length; } catch { /* Unknown, not zero. */ }
  const estimatedInputTokens = serializedChars === null ? null : Math.ceil(serializedChars / 4);
  const policyOutputReserve = window === null ? null : Math.ceil(window * 0.1);
  const policySafetyMargin = window === null ? null : Math.ceil(window * 0.05);
  const estimatedTotal = estimatedInputTokens === null || policyOutputReserve === null || policySafetyMargin === null
    ? null : estimatedInputTokens + policyOutputReserve + policySafetyMargin;
  return {
    model: model ? `${model.provider}/${model.id}` : null,
    contextWindow: window, serializedChars, estimatedInputTokens,
    method: "serialized-hook-messages-chars/4", accuracy: "heuristic-no-tokenizer-or-multimodal-accounting",
    policyOutputReserve, policySafetyMargin, actualOutputReserve: null,
    hardLimit: "unknown", // An estimate cannot establish a hard overflow or guarantee fit.
    status: window === null || estimatedTotal === null ? "unknown"
      : estimatedTotal > window ? "estimated-overflow" : estimatedTotal >= window * 0.7 ? "soft-pressure" : "below-soft-threshold-estimate",
    reason: model?.api === "pi-virtual" ? "next-physical-route-unknown" : window === null ? "model-window-unknown" : messages ? "hook-estimate-only" : "projection-unavailable",
  };
}

// Only the current hook observation is retained; never retain the transcript.
const boundaryHints = new WeakMap<ExtensionRuntimeState, (ctx: ExtensionContext) => void>();
export function showCapacityHandoffHint(ctx: ExtensionContext, state: ExtensionRuntimeState) {
  boundaryHints.get(state)?.(ctx);
}

export function registerContextCapacity(pi: ExtensionAPI, state: ExtensionRuntimeState) {
  let identity = "";
  let notified = false;
  let pressured = false;
  const key = (ctx: ExtensionContext, model = ctx.model) => JSON.stringify([
    ctx.sessionManager.getSessionId(), model?.provider, model?.id, model?.api, model?.contextWindow,
  ]);
  boundaryHints.set(state, ctx => {
    if (!state.runtimeDisposed && pressured && identity === key(ctx)) {
      try {
        ctx.ui.setStatus("pi-init-capacity", "容量估算偏高；手动交接入口：/pi-init workflow fresh（仅在安全交接条件仍满足时可用，确认后创建新会话）。队列不会自动暂停；开始下一任务后须重新满足交接条件。");
      } catch { /* A hint cannot block scheduling. */ }
    }
  });
  function observe(ctx: ExtensionContext, messages: readonly unknown[] | undefined, stage: string, model = ctx.model) {
    if (state.runtimeDisposed) return;
    const capacity = estimateContextCapacity(messages, model);
    const nextIdentity = key(ctx, model);
    if (identity !== nextIdentity) { identity = nextIdentity; notified = false; }
    pressured = capacity.status === "soft-pressure" || capacity.status === "estimated-overflow";
    const workflow = state.workflowState?.sessionId === ctx.sessionManager.getSessionId()
      && state.workflowState.status !== "completed" && state.workflowState.status !== "cancelled";
    // Usage is intentionally not used: it may refer to the old model or a
    // pre-projection transcript, and becomes null after native compaction.
    try {
      state.traceHandoff?.(ctx, "context.capacity", { ...capacity, stage,
        scope: workflow ? "workflow" : "ordinary" });
    } catch { /* Trace availability must not suppress the reminder. */ }
    try {
      ctx.ui.setStatus("pi-init-capacity", `容量${capacity.status === "unknown" ? "未知" : "估算"}: ${capacity.status}`);
      if (pressured && !notified) {
        ctx.ui.notify("当前模型窗口的启发式容量估算（含10%输出、5%安全策略余量，非实际预留）已达70%软提醒线，不代表精确用量或硬上限。"
          + (workflow
            ? "当前任务继续；先保存必要进度，仅在完成交付物且满足安全交接条件时手动换会话。本提醒不授权恢复或重放。"
            : "先保存目标、约束、完成情况和未完成事项，待当前执行结束后可手动 /new；新会话不会自动继承任务进度或全部历史。"), "info");
        notified = true;
      }
    } catch { /* Diagnostics must not block, mutate, or retry a request. */ }
  }
  pi.on("context_with_system", (event, ctx) => { observe(ctx, event.messages, "context-with-system-observed"); });
  // No previous-model percentage or cached transcript is valid for this target.
  // The next request hook supplies the fresh projection, including role switches.
  pi.on("model_select", (event, ctx) => { observe(ctx, undefined, "model-selection-preflight", event.model); });
  pi.on("session_compact", (_event, ctx) => { notified = false; observe(ctx, undefined, "post-compaction"); });
  pi.on("session_start", (_event, ctx) => { notified = false; observe(ctx, undefined, "session-start"); });
}
