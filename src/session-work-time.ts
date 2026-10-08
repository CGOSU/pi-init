export type SessionWorkTimeState = {
  totalMilliseconds: number;
  activeStartedAt: number | undefined;
};

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validTotalMilliseconds(value: unknown): value is number {
  return validTimestamp(value) && value >= 0;
}

export function createSessionWorkTime(totalMilliseconds: unknown = 0): SessionWorkTimeState {
  return {
    totalMilliseconds: validTotalMilliseconds(totalMilliseconds) ? totalMilliseconds : 0,
    activeStartedAt: undefined,
  };
}

export function startSessionWorkTime(
  state: SessionWorkTimeState,
  startedAt: unknown = Date.now(),
): SessionWorkTimeState {
  if (!validTimestamp(startedAt) || validTimestamp(state?.activeStartedAt)) return state;
  return { ...state, activeStartedAt: startedAt };
}

export function completeSessionWorkTime(
  state: SessionWorkTimeState,
  completedAt: unknown = Date.now(),
): SessionWorkTimeState {
  const totalMilliseconds = state?.totalMilliseconds;
  const activeStartedAt = state?.activeStartedAt;
  if (
    !validTotalMilliseconds(totalMilliseconds)
    || !validTimestamp(activeStartedAt)
    || !validTimestamp(completedAt)
    || completedAt < activeStartedAt
  ) return state;

  return {
    totalMilliseconds: totalMilliseconds + completedAt - activeStartedAt,
    activeStartedAt: undefined,
  };
}

export function getSessionWorkTime(state: SessionWorkTimeState, now: unknown = Date.now()): number {
  const totalMilliseconds = state?.totalMilliseconds;
  if (!validTotalMilliseconds(totalMilliseconds)) return 0;
  const activeStartedAt = state.activeStartedAt;
  if (!validTimestamp(activeStartedAt) || !validTimestamp(now) || now < activeStartedAt) {
    return totalMilliseconds;
  }
  return totalMilliseconds + now - activeStartedAt;
}

export function formatSessionWorkTime(milliseconds: unknown): string {
  const safeMilliseconds = typeof milliseconds === "number" && Number.isFinite(milliseconds)
    ? milliseconds
    : 0;
  const totalSeconds = Math.max(0, Math.floor(safeMilliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}
