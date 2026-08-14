const EXTERNAL_RUN_SOURCES = new Set(["interactive", "rpc"]);

function isValidTimestamp(value) {
  return Number.isFinite(value);
}

function hasValidRunInterval(run) {
  return (
    isExternalRunSource(run?.source) &&
    isValidTimestamp(run?.startedAt) &&
    isValidTimestamp(run?.completedAt) &&
    run.completedAt >= run.startedAt
  );
}

export function isExternalRunSource(source) {
  return EXTERNAL_RUN_SOURCES.has(source);
}

export function createRunTiming(source, startedAt = Date.now()) {
  if (!isExternalRunSource(source) || !isValidTimestamp(startedAt)) return undefined;
  return { source, startedAt };
}

export function completeRunTiming(run, completedAt = Date.now()) {
  if (
    !isExternalRunSource(run?.source) ||
    !isValidTimestamp(run.startedAt) ||
    !isValidTimestamp(completedAt) ||
    completedAt < run.startedAt
  ) {
    return undefined;
  }
  return { ...run, completedAt };
}

export function getRunTimingDuration(run) {
  if (!hasValidRunInterval(run)) return undefined;
  return run.completedAt - run.startedAt;
}
