import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CACHE_MISS_NOTICE = "pi-init-cache-miss-reminder";
export const CACHE_MISS_THRESHOLD_USD = 0.50;
type Result<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
type Sample = { prompt: number; read: number; paidRate: number; readRate: number; reportedCache: boolean };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Uses observed usage prices, not account billing. Missing prices must never become zero-price guesses. */
export function cacheMissSample(message: AssistantMessage, ctx: ExtensionContext): Result<Sample> {
  const usage = message.usage;
  if (!record(usage) || !record(usage.cost)) return { ok: false, code: "MISSING", message: "缺少用量或成本明细" };
  const counts = [usage.input, usage.cacheRead, usage.cacheWrite];
  if (!counts.every(v => typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) return { ok: false, code: "COUNTS", message: "token计数缺失或无效" };
  const costs = [usage.cost.input, usage.cost.cacheWrite, usage.cost.cacheRead];
  if (!costs.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)) return { ok: false, code: "PRICES", message: "成本明细缺失或无效" };
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  if (!Number.isSafeInteger(prompt) || prompt <= 0) return { ok: false, code: "PROMPT", message: "输入规模无效" };
  const paid = usage.input + usage.cacheWrite;
  const model = ctx.model?.provider === message.provider && ctx.model.id === message.model ? ctx.model : undefined;
  const readRate = usage.cacheRead > 0 ? usage.cost.cacheRead / usage.cacheRead : model?.cost?.cacheRead === undefined ? undefined : model.cost.cacheRead / 1_000_000;
  if (readRate === undefined || !Number.isFinite(readRate) || readRate < 0) return { ok: false, code: "READ_PRICE", message: "缓存读取价格不可确认" };
  const paidRate = paid > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paid : 0;
  if (!Number.isFinite(paidRate)) return { ok: false, code: "PRICES", message: "输入价格溢出" };
  return { ok: true, value: { prompt, read: usage.cacheRead, paidRate, readRate, reportedCache: usage.cacheRead + usage.cacheWrite > 0 } };
}

export function createCacheMissReminder(pi: ExtensionAPI, setCount: (ctx: ExtensionContext, count: number | undefined) => void) {
  let sessionId: string | undefined;
  let previous: Sample | undefined;
  let suppressed = false;
  let count = 0;
  function publish(ctx: ExtensionContext) {
    setCount(ctx, count > 0 ? count : undefined);
  }
  function restore(ctx: ExtensionContext) {
    sessionId = ctx.sessionManager.getSessionId();
    previous = undefined;
    const entries = ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch();
    const entry = entries.findLast(e => e.type === "custom" && e.customType === CACHE_MISS_NOTICE && record(e.data) && e.data.sessionId === sessionId);
    suppressed = entry?.type === "custom";
    count = entry?.type === "custom" && record(entry.data) && entry.data.phase === "sent" ? 1 : 0;
    publish(ctx);
  }
  function observe(ctx: ExtensionContext, message: AssistantMessage) {
    if (sessionId !== ctx.sessionManager.getSessionId()) restore(ctx);
    if (!["stop", "toolUse", "length"].includes(message.stopReason)) { previous = undefined; return; }
    const sample = cacheMissSample(message, ctx);
    if (!sample.ok) { previous = undefined; return; }
    const prior = previous;
    sample.value.reportedCache ||= prior?.reportedCache ?? false;
    previous = sample.value;
    if (!prior || suppressed || !ctx.hasUI || !ctx.isProjectTrusted()) return;
    if (!prior.reportedCache && !sample.value.reportedCache) return;
    const missed = Math.min(prior.prompt, sample.value.prompt) - sample.value.read;
    const extra = missed * Math.max(0, sample.value.paidRate - sample.value.readRate);
    if (missed <= 1024 || !Number.isFinite(extra) || extra < CACHE_MISS_THRESHOLD_USD) return;
    // Persist suppression first. An interrupted notification must not be replayed after reload.
    const data = { sessionId, thresholdUsd: CACHE_MISS_THRESHOLD_USD };
    try { pi.appendEntry(CACHE_MISS_NOTICE, { ...data, phase: "notifying" }); }
    catch { return; }
    suppressed = true;
    try {
      ctx.ui.notify(`Miss：估算额外成本约 $${extra.toFixed(2)}（非账单金额）。建议在当前执行结束后让执行角色用 session_handoff 准备短交接，再运行 /pi-init fresh 预览确认。不会自动准备、切换或暂停任务；本会话仅提醒一次。`, "warning");
    } catch { return; }
    count = 1;
    try { pi.appendEntry(CACHE_MISS_NOTICE, { ...data, phase: "sent" }); }
    catch { /* The persisted notifying marker still prevents duplicate notices; delivery count is unknown after reload. */ }
    publish(ctx);
  }
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_compact", (_event, ctx) => { previous = undefined; publish(ctx); });
  pi.on("session_shutdown", (_event, ctx) => { previous = undefined; setCount(ctx, undefined); });
  return { observe };
}
