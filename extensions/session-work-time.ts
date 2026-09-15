import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getRunTimingDuration } from "../src/run-timing.js";
import {
  completeSessionWorkTime,
  createSessionWorkTime,
  formatSessionWorkTime,
  getSessionWorkTime,
  startSessionWorkTime,
} from "../src/session-work-time.js";
import type { RunTimingEntryData } from "./contracts.ts";

const SESSION_WORK_TIME_WIDGET_KEY = "pi-init-session-work-time";
const SESSION_WORK_TIME_ENTRY_TYPE = "pi-init-session-work-time";
const RUN_TIMING_ENTRY_TYPE = "pi-init-run-timing";
type SessionWorkTimeTheme = { fg: (color: string, text: string) => string };

type SessionWorkTimeEntryData = {
  totalMilliseconds?: unknown;
  lastStartedAt?: unknown;
  lastCompletedAt?: unknown;
};

type SessionWorkTimeBranchEntry = {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
};

type WorkInterval = { startedAt: number; completedAt: number };

function canRender(ctx: ExtensionContext) {
  return ctx.hasUI && ctx.mode === "tui";
}

function validNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validWorkInterval(startedAt: unknown, completedAt: unknown): WorkInterval | undefined {
  if (!validNonNegativeNumber(startedAt) || !validNonNegativeNumber(completedAt) || completedAt < startedAt) return undefined;
  return { startedAt, completedAt };
}

function persistedWorkTime(ctx: ExtensionContext) {
  let sessionEntryFound = false;
  let sessionTotalMilliseconds = 0;
  let sessionLastRun: WorkInterval | undefined;
  let legacyTotalMilliseconds = 0;
  let legacyLastRun: WorkInterval | undefined;
  for (const entry of ctx.sessionManager.getBranch() as SessionWorkTimeBranchEntry[]) {
    if (entry.type !== "custom") continue;
    if (entry.customType === SESSION_WORK_TIME_ENTRY_TYPE) {
      const data = entry.data as SessionWorkTimeEntryData;
      if (validNonNegativeNumber(data?.totalMilliseconds)) {
        sessionEntryFound = true;
        sessionTotalMilliseconds = Math.max(sessionTotalMilliseconds, data.totalMilliseconds);
      }
      const interval = validWorkInterval(data?.lastStartedAt, data?.lastCompletedAt);
      if (interval) {
        sessionEntryFound = true;
        sessionLastRun = interval;
      }
      continue;
    }
    if (entry.customType !== RUN_TIMING_ENTRY_TYPE) continue;
    const data = entry.data as RunTimingEntryData;
    const duration = getRunTimingDuration(data);
    const interval = validWorkInterval(data?.startedAt, data?.completedAt);
    if (duration === undefined || !interval) continue;
    legacyTotalMilliseconds += duration;
    legacyLastRun = interval;
  }
  return sessionEntryFound
    ? { totalMilliseconds: sessionTotalMilliseconds, hasWork: true, lastRun: sessionLastRun }
    : { totalMilliseconds: legacyTotalMilliseconds, hasWork: legacyLastRun !== undefined, lastRun: legacyLastRun };
}

function formatSessionTimestamp(value: number) {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
}

function renderWorkedFor(width: number, duration: number, lastRun: WorkInterval | undefined, theme: SessionWorkTimeTheme) {
  const safeWidth = Math.max(1, Math.floor(width));
  const label = `─ Worked for ${formatSessionWorkTime(duration)} `;
  const line = `${label}${"─".repeat(Math.max(0, safeWidth - visibleWidth(label)))}`;
  const lines = [theme.fg("dim", truncateToWidth(line, safeWidth, ""))];
  if (lastRun) {
    lines.push(theme.fg("dim", truncateToWidth(`  本轮开始时间：${formatSessionTimestamp(lastRun.startedAt)}`, safeWidth, "")));
    lines.push(theme.fg("dim", truncateToWidth(`  本轮结束时间：${formatSessionTimestamp(lastRun.completedAt)}`, safeWidth, "")));
  }
  return lines;
}

export function createSessionWorkTimeTracker(now = () => Date.now()) {
  let workTime = createSessionWorkTime();
  let hasCompletedWork = false;
  let lastCompletedWork: WorkInterval | undefined;
  let lastPersistedTotalMilliseconds: number | undefined;
  let lastPersistedCompletedAt: number | undefined;

  function clear(ctx: ExtensionContext) {
    if (canRender(ctx)) ctx.ui.setWidget(SESSION_WORK_TIME_WIDGET_KEY, undefined);
  }

  function restore(ctx: ExtensionContext) {
    const persisted = persistedWorkTime(ctx);
    workTime = createSessionWorkTime(persisted.totalMilliseconds);
    hasCompletedWork = persisted.hasWork;
    lastCompletedWork = persisted.lastRun;
    lastPersistedTotalMilliseconds = persisted.hasWork ? persisted.totalMilliseconds : undefined;
    lastPersistedCompletedAt = persisted.lastRun?.completedAt;
    clear(ctx);
    show(ctx);
  }

  function reset(ctx: ExtensionContext) {
    workTime = createSessionWorkTime();
    hasCompletedWork = false;
    lastCompletedWork = undefined;
    lastPersistedTotalMilliseconds = undefined;
    lastPersistedCompletedAt = undefined;
    clear(ctx);
  }

  function start(ctx: ExtensionContext) {
    workTime = startSessionWorkTime(workTime, now());
    clear(ctx);
  }

  function complete(ctx: ExtensionContext) {
    const startedAt = workTime.activeStartedAt;
    const completedAt = now();
    workTime = completeSessionWorkTime(workTime, completedAt);
    const interval = validWorkInterval(startedAt, completedAt);
    if (interval && !Number.isFinite(workTime.activeStartedAt)) {
      hasCompletedWork = true;
      lastCompletedWork = interval;
    }
    clear(ctx);
  }

  function snapshot(ctx: ExtensionContext) {
    if (Number.isFinite(workTime.activeStartedAt)) complete(ctx);
    if (!hasCompletedWork) return undefined;
    const result = {
      totalMilliseconds: getSessionWorkTime(workTime, now()),
      ...(lastCompletedWork
        ? { lastStartedAt: lastCompletedWork.startedAt, lastCompletedAt: lastCompletedWork.completedAt }
        : {}),
    } satisfies SessionWorkTimeEntryData;
    if (
      result.totalMilliseconds === lastPersistedTotalMilliseconds
      && result.lastCompletedAt === lastPersistedCompletedAt
    ) return undefined;
    lastPersistedTotalMilliseconds = result.totalMilliseconds;
    lastPersistedCompletedAt = result.lastCompletedAt;
    return result;
  }

  function show(ctx: ExtensionContext) {
    if (!canRender(ctx) || !hasCompletedWork || !ctx.isIdle()) return;
    const duration = getSessionWorkTime(workTime, now());
    const lastRun = lastCompletedWork;
    ctx.ui.setWidget(SESSION_WORK_TIME_WIDGET_KEY, (_tui, theme) => ({
      render: (width: number) => renderWorkedFor(width, duration, lastRun, theme),
      invalidate: () => {},
    }));
  }

  function shutdown(ctx: ExtensionContext) {
    reset(ctx);
  }

  return { restore, reset, start, complete, snapshot, show, shutdown };
}

export function registerSessionWorkTime(pi: ExtensionAPI) {
  const tracker = createSessionWorkTimeTracker();
  pi.registerEntryRenderer<SessionWorkTimeEntryData>(SESSION_WORK_TIME_ENTRY_TYPE, () => ({
    render: () => [],
    invalidate: () => {},
  }));
  pi.on("session_start", (_event, ctx) => tracker.restore(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    const snapshot = tracker.snapshot(ctx);
    if (snapshot) pi.appendEntry(SESSION_WORK_TIME_ENTRY_TYPE, snapshot);
    tracker.shutdown(ctx);
  });
  pi.on("session_tree", (_event, ctx) => tracker.restore(ctx));
  pi.on("agent_start", (_event, ctx) => tracker.start(ctx));
  pi.on("agent_settled", (_event, ctx) => {
    tracker.complete(ctx);
    const snapshot = tracker.snapshot(ctx);
    if (snapshot) pi.appendEntry(SESSION_WORK_TIME_ENTRY_TYPE, snapshot);
    tracker.show(ctx);
  });
}
