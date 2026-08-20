import { PI_USAGE_VERSION } from "./version.js";
import { FIELDS, MODEL_BAR_RESOLUTION, MODEL_BAR_SEGMENTS, MODEL_BAR_WIDTH } from "./core.js";

function emptyUsage() {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0 };
}

function numberValue(value) {
  return Number(value) || 0;
}

function averageTps(speed) {
  if (!speed || speed.outputTokens <= 0 || speed.generationSeconds <= 0) return null;
  return speed.outputTokens / speed.generationSeconds;
}

export function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCost(value) {
  return `$${value.toFixed(4)}`;
}

function formatTps(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value.toFixed(1)
    : "--";
}

function formatDuration(seconds) {
  let remaining = Math.max(0, Math.round(seconds));
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  const rest = remaining % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

export function calculateCacheRatio(usage) {
  const cacheTokens = numberValue(usage?.cacheRead) + numberValue(usage?.cacheWrite);
  const totalTokens = numberValue(usage?.tokens);
  return {
    cacheTokens,
    totalTokens,
    ratio: totalTokens > 0 ? cacheTokens / totalTokens : 0,
  };
}

function formatPercentage(ratio) {
  return `${(ratio * 100).toFixed(1)}%`;
}

function paint(value, code, enabled) {
  return enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
}

export function supportsColor() {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb");
}

function formatTable(rows, headers, alignments = [], options = {}) {
  const values = rows.map((row) => row.map(String));
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...values.map((row) => row[index].length)),
  );
  const border = (left, middle, right) =>
    left + widths.map((width) => "─".repeat(width + 2)).join(middle) + right;
  const line = (row) =>
    `│ ${row
      .map((value, index) => {
        const align = alignments[index] ?? (index === 0 ? "left" : "right");
        return align === "left" ? value.padEnd(widths[index]) : value.padStart(widths[index]);
      })
      .join(" │ ")} │`;
  const lines = [
    border("┌", "┬", "┐"),
    line(headers),
    border("├", "┼", "┤"),
    ...values.map(line),
    border("└", "┴", "┘"),
  ];
  return lines
    .map((value, index) => {
      if (!options.color) return value;
      if (index === 1) return paint(value, "36;1", true);
      if (index === 2) return paint(value, "90", true);
      if (options.highlightLast && values.length > 0 && index === lines.length - 2) {
        return paint(value, "33;1", true);
      }
      return value;
    })
    .join("\n");
}

function formatOverviewTable(summary, total, color) {
  const cache = calculateCacheRatio(total);
  return formatTable(
    [
      ["Sessions", formatNumber(summary.sessions)],
      ["Total tokens", formatNumber(total.tokens)],
      [
        "Cache ratio",
        `${formatNumber(cache.cacheTokens)} / ${formatNumber(cache.totalTokens)} (${formatPercentage(cache.ratio)})`,
      ],
    ],
    ["Metric", "Value"],
    ["left", "right"],
    { color },
  );
}

function formatUsageTable(rows, color) {
  return formatTable(
    rows.map((row) => [
      row.model,
      formatNumber(row.calls),
      formatNumber(row.input),
      formatNumber(row.output),
      formatNumber(row.cacheRead),
      formatNumber(row.cacheWrite),
      formatNumber(row.tokens),
      formatCost(row.cost),
      formatTps(row.avgTps),
    ]),
    ["Model", "Calls", "Input", "Output", "Cache R", "Cache W", "Total", "Cost", "Avg TPS"],
    [],
    { color, highlightLast: true },
  );
}

function formatDurationTable(duration, color) {
  return formatTable(
    [
      ["Active", formatDuration(duration.activeSeconds)],
      ["Model wait", formatDuration(duration.modelWaitSeconds)],
      ["Session span", formatDuration(duration.sessionSpanSeconds)],
    ],
    ["Metric", "Duration"],
    ["left", "right"],
    { color },
  );
}

function formatModelUsageChart(rows, color) {
  if (rows.length === 0) return "No model usage recorded.";
  const chartRows = [...rows].sort((left, right) => right.tokens - left.tokens);
  const labelWidth = Math.max(...chartRows.map((row) => row.model.length));
  const maxTokens = Math.max(...chartRows.map((row) => row.tokens));
  return chartRows
    .map((row) => {
      const barUnits =
        maxTokens > 0 && row.tokens > 0
          ? Math.max(
              1,
              Math.round((row.tokens / maxTokens) * MODEL_BAR_WIDTH * MODEL_BAR_RESOLUTION),
            )
          : 0;
      const fullBlocks = Math.floor(barUnits / MODEL_BAR_RESOLUTION);
      const partialBlock = MODEL_BAR_SEGMENTS[barUnits % MODEL_BAR_RESOLUTION];
      const bar = `${"█".repeat(fullBlocks)}${partialBlock}`.padEnd(MODEL_BAR_WIDTH);
      return `${row.model.padEnd(labelWidth)} ${paint(bar, "34", color)} ${formatNumber(row.tokens)}`;
    })
    .join("\n");
}

export function formatReport(summary, options = {}) {
  const color = options.color ?? false;
  const total = summary.rows.reduce((result, row) => {
    for (const field of ["calls", ...FIELDS, "tokens", "cost"]) result[field] += row[field];
    return result;
  }, emptyUsage());
  const totalSpeed = summary.speed ?? { outputTokens: 0, generationSeconds: 0 };
  const usage = summary.rows.length
    ? formatUsageTable(
        [...summary.rows, { model: "Total", ...total, avgTps: averageTps(totalSpeed) }],
        color,
      )
    : "No usage recorded. Run `pi-usage --update` to import session JSONL.";
  const duration = summary.duration ?? {
    activeSeconds: 0,
    modelWaitSeconds: 0,
    sessionSpanSeconds: 0,
  };
  return [
    paint(`Pi usage · ${summary.date} · v${PI_USAGE_VERSION}`, "36;1", color),
    "",
    paint("Overview", "33;1", color),
    formatOverviewTable(summary, total, color),
    "",
    paint("Models", "34;1", color),
    usage,
    "",
    paint("Model usage (tokens)", "34;1", color),
    formatModelUsageChart(summary.rows, color),
    "",
    paint("Time", "32;1", color),
    formatDurationTable(duration, color),
  ].join("\n");
}
