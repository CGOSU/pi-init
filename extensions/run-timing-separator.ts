import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getRunTimingDuration } from "../src/run-timing.js";
import type { ReportTheme, RunTimingEntryData } from "./contracts.ts";

function formatCompactDuration(milliseconds: number | undefined) {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function renderRunTimingSeparator(data: RunTimingEntryData, theme: ReportTheme) {
  const elapsed = formatCompactDuration(getRunTimingDuration(data));
  const label = elapsed ? `─ Worked for ${elapsed} ` : "─ Worked for unavailable ";
  return {
    render(width: number) {
      if (width <= 0) return [];
      const safeWidth = Math.floor(width);
      const line = `${label}${"─".repeat(Math.max(0, safeWidth - visibleWidth(label)))}`;
      return [theme.fg("dim", truncateToWidth(line, safeWidth, ""))];
    },
    invalidate() {},
  };
}
