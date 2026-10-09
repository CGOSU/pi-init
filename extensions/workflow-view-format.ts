export function formatWorkflowTimestamp(value: unknown, unavailableText: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) return unavailableText;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return unavailableText;
  const pad = (part: number) => String(part).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
}

export function formatWorkflowDuration(milliseconds: number | undefined, unavailableText: string) {
  if (milliseconds === undefined) return unavailableText;
  if (milliseconds < 1000) return `${milliseconds} 毫秒`;

  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分钟`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} 秒`);
  const remainingMilliseconds = milliseconds % 1000;
  if (remainingMilliseconds > 0) parts.push(`${remainingMilliseconds} 毫秒`);
  return parts.join(" ");
}
