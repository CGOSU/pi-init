function validTimestamp(value) {
  return Number.isFinite(value);
}

function validTotalMilliseconds(value) {
  return validTimestamp(value) && value >= 0;
}

export function createSessionWorkTime(totalMilliseconds = 0) {
  return {
    totalMilliseconds: validTotalMilliseconds(totalMilliseconds) ? totalMilliseconds : 0,
    activeStartedAt: undefined,
  };
}

export function startSessionWorkTime(state, startedAt = Date.now()) {
  if (!validTimestamp(startedAt) || validTimestamp(state?.activeStartedAt)) return state;
  return { ...state, activeStartedAt: startedAt };
}

export function completeSessionWorkTime(state, completedAt = Date.now()) {
  if (
    !validTotalMilliseconds(state?.totalMilliseconds)
    || !validTimestamp(state?.activeStartedAt)
    || !validTimestamp(completedAt)
    || completedAt < state.activeStartedAt
  ) return state;

  return {
    totalMilliseconds: state.totalMilliseconds + completedAt - state.activeStartedAt,
    activeStartedAt: undefined,
  };
}

export function getSessionWorkTime(state, now = Date.now()) {
  if (!validTotalMilliseconds(state?.totalMilliseconds)) return 0;
  if (!validTimestamp(state.activeStartedAt) || !validTimestamp(now) || now < state.activeStartedAt) {
    return state.totalMilliseconds;
  }
  return state.totalMilliseconds + now - state.activeStartedAt;
}

export function formatSessionWorkTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(milliseconds) ? milliseconds : 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}
