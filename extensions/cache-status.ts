import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActivityStatusCache, ActivityStatusCacheError, ActivityStatusReporter } from "./activity-status.ts";

type CacheField = "cacheRead" | "cacheWrite";
type CacheFieldFailure = "missing" | "type" | "format" | "range" | "precision" | "overflow";
type CacheUsageErrorCode =
  | "usage-missing"
  | "usage-type"
  | "message-end-missing"
  | `${"cache-read" | "cache-write"}-${CacheFieldFailure}`;
type CacheUsageError = ActivityStatusCacheError & { code: CacheUsageErrorCode };
type CacheUsageValue = Extract<ActivityStatusCache, { kind: "reported" | "zero-unconfirmed" }>;
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
type CacheResult = ActivityStatusCache;

function fieldError(field: CacheField, reason: CacheFieldFailure): CacheUsageError {
  const fieldId = field === "cacheRead" ? "cache-read" : "cache-write";
  const messages: Record<CacheFieldFailure, string> = {
    missing: `${field} 计数缺失。`,
    type: `${field} 必须是数字。`,
    format: `${field} 必须是有限数字。`,
    range: `${field} 不能小于零。`,
    precision: `${field} 必须是整数 token 数。`,
    overflow: `${field} 超出安全整数范围。`,
  };
  return { code: `${fieldId}-${reason}` as CacheUsageErrorCode, message: messages[reason] };
}

function parseCacheCount(value: unknown, field: CacheField): Result<number, CacheUsageError> {
  if (value === undefined) return { ok: false, error: fieldError(field, "missing") };
  if (typeof value !== "number") return { ok: false, error: fieldError(field, "type") };
  if (!Number.isFinite(value)) return { ok: false, error: fieldError(field, "format") };
  if (value < 0) return { ok: false, error: fieldError(field, "range") };
  if (!Number.isInteger(value)) return { ok: false, error: fieldError(field, "precision") };
  if (!Number.isSafeInteger(value)) return { ok: false, error: fieldError(field, "overflow") };
  return { ok: true, value };
}

export function parseCacheUsage(usage: unknown): Result<CacheUsageValue, CacheUsageError> {
  if (usage === undefined || usage === null) {
    return { ok: false, error: { code: "usage-missing", message: "Provider usage 未提供。" } };
  }
  if (typeof usage !== "object" || Array.isArray(usage)) {
    return { ok: false, error: { code: "usage-type", message: "Provider usage 必须是对象。" } };
  }

  const fields = usage as Record<string, unknown>;
  const read = parseCacheCount(fields.cacheRead, "cacheRead");
  if (!read.ok) return read;
  const write = parseCacheCount(fields.cacheWrite, "cacheWrite");
  if (!write.ok) return write;
  if (read.value === 0 && write.value === 0) {
    return { ok: true, value: { kind: "zero-unconfirmed", read: 0, write: 0 } };
  }
  return { ok: true, value: { kind: "reported", read: read.value, write: write.value } };
}

export function createCacheStatus(pi: ExtensionAPI, activityStatus: ActivityStatusReporter) {
  let requestActive = false;
  let lastResult: CacheResult | undefined;

  function publish(ctx: ExtensionContext) {
    if (!lastResult) {
      activityStatus.setCache(ctx, undefined);
      return;
    }
    activityStatus.setCache(ctx, lastResult);
  }

  function reset(ctx: ExtensionContext) {
    requestActive = false;
    lastResult = undefined;
    publish(ctx);
  }

  function beginRequest(ctx: ExtensionContext) {
    requestActive = true;
    lastResult = undefined;
    publish(ctx);
  }

  function finishRequest(ctx: ExtensionContext, message: AssistantMessage) {
    requestActive = false;
    if (message.stopReason === "aborted") {
      lastResult = { kind: "aborted" };
    } else if (message.stopReason === "error") {
      lastResult = { kind: "request-error" };
    } else {
      const parsed = parseCacheUsage(message.usage);
      if (parsed.ok) {
        lastResult = parsed.value;
      } else {
        const isMissing = parsed.error.code === "usage-missing" || parsed.error.code.endsWith("-missing");
        lastResult = isMissing
          ? { kind: "unreported", error: parsed.error }
          : { kind: "invalid", error: parsed.error };
      }
    }
    publish(ctx);
  }

  pi.on("session_start", async (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", async (_event, ctx) => reset(ctx));
  pi.on("session_tree", async (_event, ctx) => reset(ctx));
  pi.on("model_select", async (_event, ctx) => reset(ctx));
  pi.on("before_provider_request", async (_event, ctx) => beginRequest(ctx));
  pi.on("message_end", async (event, ctx) => {
    if (requestActive && event.message.role === "assistant") finishRequest(ctx, event.message);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (requestActive) {
      requestActive = false;
      lastResult ??= {
        kind: "unreported",
        error: { code: "message-end-missing", message: "Provider message_end event was not received." },
      };
    }
    publish(ctx);
  });
}
