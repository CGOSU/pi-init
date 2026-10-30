import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionRuntimeState } from "./runtime-state.ts";

type CapacityModel = { provider: string; id: string; api?: string; contextWindow?: number };
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

type CapacityUsage = ReturnType<ExtensionContext["getContextUsage"]>;

// Use the same host observation as the footer; never tokenize serialized messages.
export function evaluateContextCapacity(usage: CapacityUsage, model: CapacityModel | undefined) {
  const window = model?.api !== "pi-virtual" && positive(model?.contextWindow) ? model.contextWindow : null;
  const valid = window !== null && usage?.contextWindow === window
    && typeof usage.percent === "number" && Number.isFinite(usage.percent) && usage.percent >= 0;
  const percent = valid ? usage!.percent! : null;
  return {
    model: model ? `${model.provider}/${model.id}` : null,
    contextWindow: window, percent,
    method: "host-getContextUsage", hardLimit: "unknown",
    status: percent === null ? "unknown"
      : percent > 100 ? "estimated-overflow" : percent >= 70 ? "soft-pressure" : "below-soft-threshold-estimate",
    reason: model?.api === "pi-virtual" ? "next-physical-route-unknown" : window === null ? "model-window-unknown"
      : usage && usage.contextWindow !== window ? "usage-window-mismatch" : percent === null ? "host-usage-unavailable" : "host-context-usage",
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
  function observe(ctx: ExtensionContext, readUsage: boolean, stage: string, model = ctx.model) {
    if (state.runtimeDisposed) return;
    let usage: CapacityUsage;
    try { if (readUsage) usage = ctx.getContextUsage(); } catch { /* Unavailable is not zero. */ }
    const capacity = evaluateContextCapacity(usage, model);
    const nextIdentity = key(ctx, model);
    if (identity !== nextIdentity) { identity = nextIdentity; notified = false; }
    pressured = capacity.status === "soft-pressure" || capacity.status === "estimated-overflow";
    const workflow = state.workflowState?.sessionId === ctx.sessionManager.getSessionId()
      && state.workflowState.status !== "completed" && state.workflowState.status !== "cancelled";
    try {
      state.traceHandoff?.(ctx, "context.capacity", { ...capacity, stage,
        scope: workflow ? "workflow" : "ordinary" });
    } catch { /* Trace availability must not suppress the reminder. */ }
    try {
      ctx.ui.setStatus("pi-init-capacity", capacity.percent === null ? "容量：未知（宿主用量暂不可用）" : `容量：${capacity.percent.toFixed(1)}%（与状态栏同源）`);
      if (pressured && !notified) {
        ctx.ui.notify("宿主上下文用量已达70%软提醒线（与状态栏同源），不代表请求一定超限。"
          + (workflow
            ? "当前任务继续；先保存必要进度，仅在完成交付物且满足安全交接条件时手动换会话。本提醒不授权恢复或重放。"
            : "先保存目标、约束、完成情况和未完成事项，待当前执行结束后可手动 /new；新会话不会自动继承任务进度或全部历史。"), "info");
        notified = true;
      }
    } catch { /* Diagnostics must not block, mutate, or retry a request. */ }
  }
  pi.on("context_with_system", (_event, ctx) => { observe(ctx, true, "context-with-system-observed"); });
  pi.on("agent_settled", (_event, ctx) => { observe(ctx, true, "agent-settled"); });
  // Transition callbacks may still expose old-model/pre-compaction usage.
  pi.on("model_select", (event, ctx) => { observe(ctx, false, "model-selection-preflight", event.model); });
  pi.on("session_compact", (_event, ctx) => { notified = false; observe(ctx, false, "post-compaction"); });
  pi.on("session_start", (_event, ctx) => { notified = false; observe(ctx, false, "session-start"); });
}
