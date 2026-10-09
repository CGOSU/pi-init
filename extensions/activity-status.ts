import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatSessionWorkTime } from "../src/session-work-time.ts";
import type { WorkflowActionIdentity, WorkflowHandoffIdentity, WorkflowReplanIdentity } from "../src/workflow-types.ts";

export const ACTIVITY_STATUS_KEY = "pi-init-activity";

export type ActivityStatusRole = {
  mode: string;
  role?: string;
  model?: string;
};

export type ActivityStatusWorkflowNoticeSource = {
  kind: "paused" | "replanning" | "restore-error";
  sessionId: string;
  contextGeneration: number;
  workflowIdentity?: WorkflowActionIdentity;
  handoffIdentity?: WorkflowHandoffIdentity;
  replanIdentity?: WorkflowReplanIdentity;
  cause?: {
    code?: string;
    message: string;
    sourceEntryId?: string;
    blockedTasks?: Array<{ taskId: string; reason: string; outcomeUnknown: boolean }>;
  };
};

export type ActivityStatusWorkflow = {
  text: string;
  color: "accent" | "warning" | "error";
  notice?: {
    source: ActivityStatusWorkflowNoticeSource;
    sourceKey: string;
    summary: string;
    acknowledged: boolean;
  };
};

export type ActivityStatusOperation =
  | { kind: "provider"; phase: "request" | "streaming"; startedAt: number }
  | { kind: "tool"; label: string; count: number; startedAt: number };

export type ActivityStatusAlert = {
  text: string;
  tone: "warning" | "error";
};

export type ActivityStatusCacheError = {
  code: string;
  message: string;
};

export type ActivityStatusCache =
  | { kind: "reported"; read: number; write: number }
  | { kind: "zero-unconfirmed"; read: 0; write: 0 }
  | { kind: "unreported"; error: ActivityStatusCacheError }
  | { kind: "invalid"; error: ActivityStatusCacheError }
  | { kind: "request-error" }
  | { kind: "aborted" };

export type ActivityStatusSnapshot = {
  role?: ActivityStatusRole;
  workflow?: ActivityStatusWorkflow;
  compaction?: "compacting" | "stalled";
  operation?: ActivityStatusOperation;
  alert?: ActivityStatusAlert;
  cache?: ActivityStatusCache;
  workTimeMilliseconds?: number;
};

type ActivityStatusTone = "accent" | "warning" | "error" | "success" | "muted";
type ActivityStatusSegment = { text: string; tone: ActivityStatusTone };
type ActivityStatusOptions = {
  now?: () => number;
  refreshIntervalMs?: number;
};

export type ActivityStatusReporter = ReturnType<typeof createActivityStatus>;

function formatTokens(value: number) {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if (value < 1000) return String(Math.floor(value));
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function cacheCountsText(read: number, write: number) {
  const counts = [
    read > 0 ? `R${formatTokens(read)}` : undefined,
    write > 0 ? `W${formatTokens(write)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return counts.length > 0 ? `缓存 ${counts.join("/")}` : undefined;
}

function roleSegments(role: ActivityStatusRole | undefined): ActivityStatusSegment[] {
  if (!role) return [];
  return [role.role, role.mode, role.model]
    .filter((text): text is string => Boolean(text))
    .map((text) => ({ text, tone: "muted" }));
}

function cacheResultSegment(cache: ActivityStatusCache | undefined): ActivityStatusSegment | undefined {
  if (!cache) return undefined;
  if (cache.kind === "request-error") return { text: "✕ 请求失败", tone: "error" };
  if (cache.kind === "aborted") return { text: "! 请求已中止", tone: "warning" };
  if (cache.kind === "zero-unconfirmed") return { text: "缓存 0（来源未确认）", tone: "muted" };
  if (cache.kind === "invalid") return { text: "缓存 usage 无效", tone: "warning" };
  if (cache.kind === "unreported") {
    const text = cache.error.code === "message-end-missing"
      ? "缓存结果未到达"
      : cache.error.code === "usage-missing"
        ? "缓存 usage 未提供"
        : "缓存 usage 字段不完整";
    return { text, tone: "muted" };
  }
  const counts = cacheCountsText(cache.read, cache.write);
  return counts ? { text: counts, tone: "success" } : undefined;
}

function shortDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
}

function operationSegment(operation: ActivityStatusOperation | undefined, now: number): ActivityStatusSegment | undefined {
  if (!operation) return undefined;
  const label = operation.kind === "provider"
    ? operation.phase === "streaming" ? "↓ 模型响应" : "↑ 等待模型"
    : operation.count > 1 ? `${operation.label} ×${operation.count}` : operation.label;
  const elapsedSeconds = Number.isFinite(operation.startedAt)
    ? Math.max(0, Math.floor((now - operation.startedAt) / 1000))
    : 0;
  return {
    text: `${label}${elapsedSeconds > 0 ? ` · ${shortDuration(elapsedSeconds)}` : ""}`,
    tone: "accent",
  };
}

export function activityStatusSegments(state: ActivityStatusSnapshot, now = Date.now()): ActivityStatusSegment[] {
  const workflowAcknowledged = state.workflow?.notice?.acknowledged === true;
  const workflow = state.workflow
    ? {
        text: workflowAcknowledged && state.workflow.notice
          ? state.workflow.notice.summary
          : state.workflow.text,
        tone: workflowAcknowledged ? "muted" as const : state.workflow.color,
      }
    : undefined;
  const workflowNeedsAttention = Boolean(workflow && !workflowAcknowledged
    && (workflow.tone === "warning" || workflow.tone === "error"));
  const compaction = state.compaction === "stalled"
    ? { text: "⚠ 压缩等待异常", tone: "warning" as const }
    : state.compaction === "compacting"
      ? { text: "◌ 正在压缩上下文", tone: "accent" as const }
      : undefined;
  const alert = state.alert
    ? { text: state.alert.text, tone: state.alert.tone }
    : undefined;
  const operation = operationSegment(state.operation, now);
  const cacheResult = cacheResultSegment(state.cache);
  const urgentCacheResult = cacheResult?.tone === "error" || cacheResult?.tone === "warning"
    ? cacheResult
    : undefined;
  const primary = compaction?.tone === "warning"
    ? compaction
    : workflowNeedsAttention
      ? workflow
      : alert
          ?? urgentCacheResult
          ?? compaction
          ?? operation
          ?? workflow
          ?? cacheResult;

  const segments: ActivityStatusSegment[] = [];
  if (primary) segments.push(primary);
  if (workflow && primary !== workflow) segments.push(workflow);
  segments.push(...roleSegments(state.role));
  if (operation && primary !== operation) segments.push(operation);
  if (cacheResult && primary !== cacheResult) segments.push(cacheResult);

  if (state.workTimeMilliseconds !== undefined && Number.isFinite(state.workTimeMilliseconds)) {
    segments.push({ text: `⏱ 累计 ${formatSessionWorkTime(state.workTimeMilliseconds)}`, tone: "muted" });
  }

  return segments;
}

function joinSegments(segments: ActivityStatusSegment[]) {
  return segments.map(({ text }) => text).join(" · ");
}

export function formatActivityStatusText(state: ActivityStatusSnapshot, maxWidth = 120, now = Date.now()) {
  const text = joinSegments(activityStatusSegments(state, now));
  return text ? truncateToWidth(text, Math.max(1, maxWidth), "…") : undefined;
}

export function renderActivityStatus(
  state: ActivityStatusSnapshot,
  width: number,
  theme: Pick<Theme, "fg">,
  now = Date.now(),
) {
  const safeWidth = Math.floor(width);
  if (safeWidth < 1) return [];

  const segments = activityStatusSegments(state, now);
  if (segments.length === 0) return [];

  let line = "";
  for (const segment of segments) {
    const styled = theme.fg(segment.tone, segment.text);
    const candidate = line ? `${line} · ${styled}` : styled;
    if (visibleWidth(candidate) <= safeWidth) {
      line = candidate;
      continue;
    }
    if (!line) line = truncateToWidth(styled, safeWidth, "…");
  }

  return line ? [truncateToWidth(line, safeWidth, "")] : [];
}

export function createActivityStatus(options: ActivityStatusOptions = {}) {
  let snapshot: ActivityStatusSnapshot = {};
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshContext: ExtensionContext | undefined;
  let requestTuiRender: (() => void) | undefined;
  const now = options.now ?? Date.now;
  const refreshIntervalMs = options.refreshIntervalMs ?? 1000;

  function stopRefreshTimer() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    refreshContext = undefined;
  }

  function render(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (ctx.mode === "tui") {
      if (activityStatusSegments(snapshot, now()).length === 0) {
        requestTuiRender = undefined;
        ctx.ui.setWidget(ACTIVITY_STATUS_KEY, undefined);
        return;
      }
      ctx.ui.setWidget(ACTIVITY_STATUS_KEY, (tui, theme) => {
        const requestRender = () => tui.requestRender();
        requestTuiRender = requestRender;
        return {
          render: (width: number) => renderActivityStatus(snapshot, width, theme, now()),
          invalidate: () => {},
          dispose: () => {
            if (requestTuiRender === requestRender) requestTuiRender = undefined;
          },
        };
      }, { placement: "belowEditor" });
      return;
    }
    ctx.ui.setStatus(ACTIVITY_STATUS_KEY, formatActivityStatusText(snapshot, 120, now()));
  }

  function startRefreshTimer(ctx: ExtensionContext) {
    if (!snapshot.operation || !ctx.hasUI) {
      stopRefreshTimer();
      return;
    }
    if (refreshTimer) return;
    refreshContext = ctx;
    refreshTimer = setInterval(() => {
      const current = refreshContext;
      if (!current || !snapshot.operation) {
        stopRefreshTimer();
        return;
      }
      if (current.mode === "tui" && requestTuiRender) requestTuiRender();
      else render(current);
    }, refreshIntervalMs);
    refreshTimer.unref?.();
  }

  function update<K extends keyof ActivityStatusSnapshot>(
    ctx: ExtensionContext,
    key: K,
    value: ActivityStatusSnapshot[K],
  ) {
    if (JSON.stringify(snapshot[key]) === JSON.stringify(value)) return;
    snapshot = { ...snapshot, [key]: value };
    render(ctx);
    if (key === "operation") startRefreshTimer(ctx);
  }

  return {
    setRole: (ctx: ExtensionContext, value: ActivityStatusRole | undefined) => update(ctx, "role", value),
    setWorkflow: (ctx: ExtensionContext, value: ActivityStatusWorkflow | undefined) => update(ctx, "workflow", value),
    setCompaction: (ctx: ExtensionContext, value: ActivityStatusSnapshot["compaction"]) => update(ctx, "compaction", value),
    setOperation: (ctx: ExtensionContext, value: ActivityStatusOperation | undefined) => update(ctx, "operation", value),
    setAlert: (ctx: ExtensionContext, value: ActivityStatusAlert | undefined) => update(ctx, "alert", value),
    setCache: (ctx: ExtensionContext, value: ActivityStatusCache | undefined) => update(ctx, "cache", value),
    setWorkTime: (ctx: ExtensionContext, value: number | undefined) => update(ctx, "workTimeMilliseconds", value),
    clear: (ctx: ExtensionContext) => {
      if (Object.keys(snapshot).length === 0) return;
      stopRefreshTimer();
      requestTuiRender = undefined;
      snapshot = {};
      render(ctx);
    },
    getSnapshot: () => ({ ...snapshot }),
  };
}

export function registerActivityStatus(pi: ExtensionAPI) {
  const activityStatus = createActivityStatus();
  pi.on("session_start", (_event, ctx) => activityStatus.clear(ctx));
  pi.on("session_shutdown", (_event, ctx) => activityStatus.clear(ctx));
  return activityStatus;
}
