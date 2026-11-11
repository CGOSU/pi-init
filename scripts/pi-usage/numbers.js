export function numberValue(value) {
  return Number(value) || 0;
}

export function averageTps(speed) {
  if (!speed || speed.outputTokens <= 0 || speed.generationSeconds <= 0) return null;
  return speed.outputTokens / speed.generationSeconds;
}
