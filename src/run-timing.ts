const EXTERNAL_RUN_SOURCES: ReadonlySet<string> = new Set(["interactive", "rpc"]);

export type ExternalRunSource = "interactive" | "rpc";
export type RunTimingStart = {
  source: ExternalRunSource;
  startedAt: number;
};

type RunTimingCandidate = {
  source?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  [key: string]: unknown;
};

type CompletedRunTiming = RunTimingCandidate & {
  source: ExternalRunSource;
  startedAt: number;
  completedAt: number;
};

function isValidTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRunTimingCandidate(value: unknown): value is RunTimingCandidate {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function hasValidRunInterval(run: unknown): run is CompletedRunTiming {
  if (!isRunTimingCandidate(run)) return false;
  const { source, startedAt, completedAt } = run;
  return isExternalRunSource(source)
    && isValidTimestamp(startedAt)
    && isValidTimestamp(completedAt)
    && completedAt >= startedAt;
}

export function isExternalRunSource(source: unknown): source is ExternalRunSource {
  return typeof source === "string" && EXTERNAL_RUN_SOURCES.has(source);
}

export function createRunTiming(source: unknown, startedAt: unknown = Date.now()): RunTimingStart | undefined {
  if (!isExternalRunSource(source) || !isValidTimestamp(startedAt)) return undefined;
  return { source, startedAt };
}

export function completeRunTiming(run: unknown, completedAt: unknown = Date.now()): CompletedRunTiming | undefined {
  if (!isRunTimingCandidate(run)) return undefined;
  const { source, startedAt } = run;
  if (
    !isExternalRunSource(source)
    || !isValidTimestamp(startedAt)
    || !isValidTimestamp(completedAt)
    || completedAt < startedAt
  ) {
    return undefined;
  }
  return { ...run, source, startedAt, completedAt };
}

export function getRunTimingDuration(run: unknown): number | undefined {
  if (!hasValidRunInterval(run)) return undefined;
  return run.completedAt - run.startedAt;
}
