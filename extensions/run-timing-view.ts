import { getRunTimingDuration, isExternalRunSource } from "../src/run-timing.ts";

export type RunTimingValue =
  | { kind: "available"; milliseconds: number }
  | { kind: "unavailable"; reason: "missing-or-invalid" };

export type RunTimingView = {
  source: "interactive" | "rpc" | "unknown";
  startedAt: RunTimingValue;
  completedAt: RunTimingValue;
  duration: RunTimingValue;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function timingValue(value: unknown): RunTimingValue {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) {
    return { kind: "unavailable", reason: "missing-or-invalid" };
  }
  return { kind: "available", milliseconds: value };
}

export function createRunTimingView(data: unknown): RunTimingView {
  const record = isRecord(data) ? data : {};
  const duration = getRunTimingDuration(data);
  return {
    source: isExternalRunSource(record.source) ? record.source : "unknown",
    startedAt: timingValue(record.startedAt),
    completedAt: timingValue(record.completedAt),
    duration: duration === undefined
      ? { kind: "unavailable", reason: "missing-or-invalid" }
      : { kind: "available", milliseconds: duration },
  };
}
