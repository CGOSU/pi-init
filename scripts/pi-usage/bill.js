import { calculateCacheRatio, formatNumber } from "./report.js";

const BILL_WIDTH = 750;
const SIDE_PADDING = 54;
const RIGHT_EDGE = BILL_WIDTH - SIDE_PADDING;
const FONT_FAMILY = "-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif";
const MONO_FONT_FAMILY = "SFMono-Regular,Consolas,Liberation Mono,monospace";

function numberValue(value) {
  return Number(value) || 0;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function text(value, x, y, attributes = "") {
  return `<text x="${x}" y="${y}" ${attributes}>${escapeXml(value)}</text>`;
}

function line(y) {
  return `<line x1="${SIDE_PADDING}" y1="${y}" x2="${RIGHT_EDGE}" y2="${y}" class="separator" />`;
}

function trimDecimal(value, digits = 2) {
  return value.toFixed(digits).replace(/\.?(0+)$/, "");
}

function formatCompactNumber(value) {
  const amount = numberValue(value);
  const absolute = Math.abs(amount);
  if (absolute >= 100_000_000) return `${trimDecimal(amount / 100_000_000)}亿`;
  if (absolute >= 10_000) return `${trimDecimal(amount / 10_000)}万`;
  return formatNumber(Math.round(amount));
}

function formatCost(value) {
  return `US$${numberValue(value).toFixed(2)}`;
}

function formatTotalCost(value) {
  return `US$${Math.round(numberValue(value))}`;
}

function formatBillDate(value) {
  const match = String(value ?? "未知").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(value ?? "未知").replaceAll(" → ", " 至 ");
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return { date: "未知", time: "未知" };
  return {
    date: `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`,
    time: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
  };
}

function splitModel(value) {
  const model = String(value ?? "unknown");
  const separator = model.indexOf("/");
  if (separator < 0) return { client: "UNKNOWN", model };
  return {
    client: model.slice(0, separator) || "UNKNOWN",
    model: model.slice(separator + 1) || "unknown",
  };
}

function formatClient(value) {
  return String(value).replaceAll(/[-_]+/g, " ").toUpperCase();
}

function truncate(value, maxLength = 34) {
  const characters = [...String(value)];
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength - 1).join("")}…`
    : characters.join("");
}

function calculateTotal(rows) {
  return rows.reduce(
    (total, row) => {
      for (const field of ["calls", "input", "output", "cacheRead", "cacheWrite", "tokens", "cost"]) {
        total[field] += numberValue(row?.[field]);
      }
      return total;
    },
    { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0 },
  );
}

function modelRows(summary, total) {
  if (!summary.rows?.length) return [{ empty: true, cost: total.cost }];
  return summary.rows.map((row) => {
    const model = splitModel(row.model);
    return {
      client: formatClient(model.client),
      model: truncate(model.model),
      cost: numberValue(row.cost),
    };
  });
}

function renderModels(rows, startY) {
  if (rows[0]?.empty) {
    return text("暂无模型用量记录", SIDE_PADDING, startY + 24, 'class="body muted"');
  }
  return rows
    .map((row, index) => {
      const y = startY + index * 76;
      return [
        text(row.client, SIDE_PADDING, y, 'class="model-client"'),
        text(formatCost(row.cost), RIGHT_EDGE, y, 'class="body mono" text-anchor="end"'),
        text(row.model, SIDE_PADDING + 58, y + 34, 'class="model-name"'),
      ].join("");
    })
    .join("");
}

function renderStats(summary, total, startY) {
  const cache = calculateCacheRatio(total);
  const sessions = summary.sessions ?? summary.duration?.sessions ?? 0;
  const rows = [
    ["总 Token 数", formatCompactNumber(total.tokens)],
    ["输入", formatCompactNumber(total.input)],
    ["输出", formatCompactNumber(total.output)],
    ["缓存命中率", `${Math.round(cache.ratio * 100)}%`],
    ["会话数", formatNumber(numberValue(sessions))],
  ];
  return rows
    .map(([label, value], index) => {
      const y = startY + index * 47;
      return [
        text(label, SIDE_PADDING, y, 'class="body"'),
        text(value, RIGHT_EDGE, y, 'class="body mono" text-anchor="end"'),
      ].join("");
    })
    .join("");
}

export function createBillSvg(summary, options = {}) {
  const rows = Array.isArray(summary?.rows) ? summary.rows : [];
  const total = calculateTotal(rows);
  const issuedAt = formatDateTime(options.generatedAt ?? new Date());
  const dateLabel = formatBillDate(summary?.date);
  const modelItems = modelRows(summary ?? {}, total);
  const modelStartY = 650;
  const modelEndY = modelStartY + modelItems.length * 76 + 10;
  const statsStartY = modelEndY + 64;
  const statsEndY = statsStartY + 4 * 47 + 18;
  const footerStartY = statsEndY + 62;
  const height = footerStartY + 178;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BILL_WIDTH}" height="${height}" viewBox="0 0 ${BILL_WIDTH} ${height}">`,
    `<rect width="100%" height="100%" fill="#f7f4ed" />`,
    `<style>
      .title { font: 800 52px ${FONT_FAMILY}; fill: #1f2022; letter-spacing: 3px; }
      .subtitle { font: 20px ${MONO_FONT_FAMILY}; fill: #343638; letter-spacing: 1px; }
      .label { font: 700 23px ${FONT_FAMILY}; fill: #292b2d; }
      .meta { font: 700 23px ${MONO_FONT_FAMILY}; fill: #292b2d; }
      .section { font: 700 25px ${MONO_FONT_FAMILY}; fill: #303234; letter-spacing: 4px; }
      .amount { font: 800 86px ${MONO_FONT_FAMILY}; fill: #202123; letter-spacing: -3px; }
      .note { font: 700 18px ${MONO_FONT_FAMILY}; fill: #4e5052; letter-spacing: 1px; }
      .column { font: 700 22px ${FONT_FAMILY}; fill: #686a6a; }
      .model-client { font: 800 22px ${MONO_FONT_FAMILY}; fill: #232527; letter-spacing: 1px; }
      .model-name { font: 700 20px ${MONO_FONT_FAMILY}; fill: #292b2d; }
      .body { font: 700 23px ${FONT_FAMILY}; fill: #303234; }
      .mono { font-family: ${MONO_FONT_FAMILY}; }
      .muted { fill: #717270; }
      .footer { font: 700 18px ${MONO_FONT_FAMILY}; fill: #4c4e4f; letter-spacing: 1px; }
      .footer-strong { font: 800 20px ${MONO_FONT_FAMILY}; fill: #292b2d; letter-spacing: 1px; }
      .separator { stroke: #8f908d; stroke-width: 3; stroke-dasharray: 11 10; }
    </style>`,
    text("每日 AI 对账单", BILL_WIDTH / 2, 96, 'class="title" text-anchor="middle"'),
    text("Vibe something wonderful.", BILL_WIDTH / 2, 133, 'class="subtitle" text-anchor="middle"'),
    text("日期", SIDE_PADDING, 206, 'class="label"'),
    text(dateLabel, RIGHT_EDGE, 206, 'class="meta" text-anchor="end"'),
    text("出单时间", SIDE_PADDING, 253, 'class="label"'),
    text(`${issuedAt.date} ${issuedAt.time}`, RIGHT_EDGE, 253, 'class="meta" text-anchor="end"'),
    line(305),
    text("API 总费用", BILL_WIDTH / 2, 371, 'class="section" text-anchor="middle"'),
    text(formatTotalCost(total.cost), BILL_WIDTH / 2, 462, 'class="amount" text-anchor="middle"'),
    text("API 等值估算 · 非实际账单", BILL_WIDTH / 2, 501, 'class="note" text-anchor="middle"'),
    line(552),
    text("客户端 / 模型", SIDE_PADDING, 598, 'class="column"'),
    text("费用", RIGHT_EDGE, 598, 'class="column" text-anchor="end"'),
    renderModels(modelItems, modelStartY),
    line(modelEndY),
    renderStats(summary ?? {}, total, statsStartY),
    line(statsEndY),
    text("由 CGOSU 依法消费", BILL_WIDTH / 2, footerStartY + 44, 'class="footer" text-anchor="middle"'),
    text("持续创造，留下凭证。", BILL_WIDTH / 2, footerStartY + 92, 'class="footer-strong" text-anchor="middle"'),
    text("— 每日用量对账 —", BILL_WIDTH / 2, footerStartY + 137, 'class="footer" text-anchor="middle"'),
    "</svg>",
  ].join("\n");
}
