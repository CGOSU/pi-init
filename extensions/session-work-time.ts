import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getRunTimingDuration } from "../src/run-timing.ts";
import {
  completeSessionWorkTime,
  createSessionWorkTime,
  getSessionWorkTime,
  startSessionWorkTime,
} from "../src/session-work-time.ts";
import type { RunTimingEntryData } from "./contracts.ts";
import type { ActivityStatusReporter } from "./activity-status.ts";

const SESSION_WORK_TIME_ENTRY_TYPE = "pi-init-session-work-time";
const RUN_TIMING_ENTRY_TYPE = "pi-init-run-timing";
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

export function createSessionWorkTimeTracker(
  now = () => Date.now(),
  activityStatus?: ActivityStatusReporter,
) {
  let workTime = createSessionWorkTime();
  let hasCompletedWork = false;
  let lastCompletedWork: WorkInterval | undefined;
  let lastPersistedTotalMilliseconds: number | undefined;
  let lastPersistedCompletedAt: number | undefined;

  function clear(ctx: ExtensionContext) {
    activityStatus?.setWorkTime(ctx, undefined);
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
    if (!hasCompletedWork || !ctx.isIdle()) return;
    activityStatus?.setWorkTime(ctx, getSessionWorkTime(workTime, now()));
  }

  function shutdown(ctx: ExtensionContext) {
    reset(ctx);
  }

  return { restore, reset, start, complete, snapshot, show, shutdown };
}

export function registerSessionWorkTime(pi: ExtensionAPI, activityStatus: ActivityStatusReporter) {
  const tracker = createSessionWorkTimeTracker(Date.now, activityStatus);
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
