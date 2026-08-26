import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const DUCKDB_PACKAGE = "@duckdb/node-api";
const DUCKDB_VERSION = "1.5.5-r.3";
export const FIELDS = ["input", "output", "cacheRead", "cacheWrite"];
const ACTIVE_GAP_MS = 5 * 60 * 1000;
const MODEL_WAIT_GAP_MS = 30 * 60 * 1000;
const AUTO_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
export const MODEL_BAR_WIDTH = 24;
export const MODEL_BAR_SEGMENTS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
export const MODEL_BAR_RESOLUTION = MODEL_BAR_SEGMENTS.length - 1;
const TOKEN_SPEED_CUSTOM_TYPE = "pi-token-speed";
const USAGE_SCHEMA_VERSION = 2;
const CHECKPOINT_TAIL_BYTES = 64 * 1024;
const APPENDER_BATCH_SIZE = 1024;


function emptyUsage() {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0 };
}

export function localDateString(date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
    .join("-");
}

export function shouldRefreshUsage(state, now = new Date()) {
  if (!state || !Number.isFinite(state.checkedMs)) return true;
  return (
    state.checkedDate !== localDateString(now) ||
    now.getTime() - state.checkedMs >= AUTO_REFRESH_INTERVAL_MS
  );
}

export function dateRange(value) {
  const parts = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (value && !parts) throw new Error("日期必须是 YYYY-MM-DD");
  const date = parts
    ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
    : new Date();
  if (!parts) date.setHours(0, 0, 0, 0);
  if (
    Number.isNaN(date.getTime()) ||
    (parts &&
      (date.getFullYear() !== Number(parts[1]) ||
        date.getMonth() !== Number(parts[2]) - 1 ||
        date.getDate() !== Number(parts[3])))
  ) {
    throw new Error("日期必须是 YYYY-MM-DD");
  }
  const dateValue = localDateString(date);
  const end = new Date(date);
  end.setDate(end.getDate() + 1);
  return { date: dateValue, startDate: dateValue, endDate: dateValue, start: date, end };
}

function combineDateRanges(startRange, endRange) {
  const end = new Date(endRange.start);
  end.setDate(end.getDate() + 1);
  const label =
    startRange.date === endRange.date ? startRange.date : `${startRange.date} → ${endRange.date}`;
  return {
    date: label,
    startDate: startRange.date,
    endDate: endRange.date,
    start: new Date(startRange.start),
    end,
  };
}

function parseMonth(value) {
  const parts = value.match(/^(\d{4})-(\d{2})$/);
  if (!parts) return undefined;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const start = new Date(year, month - 1, 1);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1) {
    throw new Error("月份必须是 YYYY-MM");
  }
  const end = new Date(year, month, 0);
  return combineDateRanges(dateRange(localDateString(start)), dateRange(localDateString(end)));
}

export function parseUsageRange(values) {
  const argumentsList = Array.isArray(values) ? values : values === undefined ? [] : [values];
  if (argumentsList.length > 2) throw new Error("最多指定两个日期");
  if (argumentsList.length === 2) {
    const [start, end] = argumentsList.map((value) => dateRange(value));
    if (start.start > end.start) throw new Error("开始日期不能晚于结束日期");
    return combineDateRanges(start, end);
  }
  if (argumentsList.length === 0) return combineDateRanges(dateRange(), dateRange());

  const value = argumentsList[0].toLowerCase();
  if (value === "yesterday") {
    const end = dateRange();
    const start = new Date(end.start);
    start.setDate(start.getDate() - 1);
    const day = dateRange(localDateString(start));
    return combineDateRanges(day, day);
  }
  const days = value.match(/^(\d+)d$/);
  if (days) {
    const count = Number(days[1]);
    if (count < 1) throw new Error("天数必须是正整数，例如 7d");
    const end = dateRange();
    const start = new Date(end.start);
    start.setDate(start.getDate() - count + 1);
    return combineDateRanges(dateRange(localDateString(start)), end);
  }
  return parseMonth(value) ?? combineDateRanges(dateRange(value), dateRange(value));
}

function entryDate(entry) {
  const timestamp = entry.timestamp ?? entry.message?.timestamp;
  if (timestamp === undefined) return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function usageForEntry(entry) {
  if (entry.type === "message" && entry.message?.role === "assistant") {
    return {
      model: `${entry.message.provider ?? "unknown"}/${entry.message.responseModel ?? entry.message.model ?? "unknown"}`,
      usage: entry.message.usage,
    };
  }
  if (entry.type === "message" && entry.message?.role === "toolResult") {
    return { model: "Tools/summaries", usage: entry.message.usage };
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return { model: "Tools/summaries", usage: entry.usage };
  }
  return undefined;
}

function stableEntryKey(entry, lineNumber) {
  if (entry.id !== undefined && entry.id !== null && String(entry.id)) {
    return `id:${String(entry.id)}`;
  }
  const serialized = JSON.stringify(entry) ?? "";
  return `legacy:${createHash("sha256").update(`${lineNumber}:${serialized}`).digest("hex")}`;
}

function parseActivityEvent(entry, sourceFile, lineNumber, cwd) {
  if (entry.type === "custom" && entry.customType === TOKEN_SPEED_CUSTOM_TYPE) return undefined;
  const date = entryDate(entry);
  if (!date) return undefined;
  const message = entry.message;
  const role = message?.role;
  const model =
    role === "assistant"
      ? `${message.provider ?? "unknown"}/${message.responseModel ?? message.model ?? "unknown"}`
      : "";
  return {
    sourceFile,
    entryKey: stableEntryKey(entry, lineNumber),
    eventTimestamp: date.toISOString(),
    eventDate: localDateString(date),
    eventType: role || entry.type || "unknown",
    model,
    cwd,
  };
}

function parseUsageEvent(entry, sourceFile, lineNumber, cwd) {
  const date = entryDate(entry);
  const value = usageForEntry(entry);
  if (!date || !value?.usage) return undefined;
  const usage = value.usage;
  const fields = Object.fromEntries(FIELDS.map((field) => [field, Number(usage[field]) || 0]));
  return {
    sourceFile,
    entryKey: stableEntryKey(entry, lineNumber),
    eventTimestamp: date.toISOString(),
    eventDate: localDateString(date),
    model: value.model,
    ...fields,
    tokens: FIELDS.reduce((total, field) => total + fields[field], 0),
    cost: Number(usage.cost?.total) || 0,
    cwd,
  };
}

function parseSpeedEvent(entry, sourceFile, lineNumber, cwd) {
  if (entry.type !== "custom" || entry.customType !== TOKEN_SPEED_CUSTOM_TYPE) return undefined;
  const date = entryDate(entry);
  const data = entry.data;
  if (!date || !data || typeof data !== "object") return undefined;
  const provider = typeof data.provider === "string" ? data.provider.trim() : "";
  const model = typeof data.model === "string" ? data.model.trim() : "";
  const outputTokens = Number(data.outputTokens);
  const elapsedMs = Number(data.elapsedMs);
  if (
    data.version !== 1 ||
    !provider ||
    !model ||
    !Number.isFinite(outputTokens) ||
    outputTokens <= 0 ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0
  ) {
    return undefined;
  }
  return {
    sourceFile,
    entryKey: stableEntryKey(entry, lineNumber),
    eventTimestamp: date.toISOString(),
    eventDate: localDateString(date),
    model: `${provider}/${model}`,
    outputTokens,
    generationSeconds: elapsedMs / 1000,
    cwd,
  };
}

async function* readJsonlLines(file, startOffset = 0, startLineNumber = 0) {
  const stream = createReadStream(file, startOffset > 0 ? { start: startOffset } : undefined);
  let pending = Buffer.alloc(0);
  let offset = startOffset;
  let lineNumber = startLineNumber;
  try {
    for await (const chunk of stream) {
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      let newlineIndex;
      while ((newlineIndex = pending.indexOf(0x0a)) !== -1) {
        const rawLine = pending.subarray(0, newlineIndex);
        pending = pending.subarray(newlineIndex + 1);
        const line = rawLine[rawLine.length - 1] === 0x0d
          ? rawLine.subarray(0, rawLine.length - 1).toString("utf8")
          : rawLine.toString("utf8");
        offset += newlineIndex + 1;
        yield { line, lineNumber, endOffset: offset, terminated: true };
        lineNumber += 1;
      }
    }
    if (pending.length > 0) {
      yield {
        line: pending.toString("utf8"),
        lineNumber,
        endOffset: offset + pending.length,
        terminated: false,
      };
    }
  } finally {
    stream.destroy();
  }
}

export async function hashCheckpointTail(file, endOffset) {
  const hash = createHash("sha256");
  if (endOffset <= 0) return hash.digest("hex");
  const start = Math.max(0, endOffset - CHECKPOINT_TAIL_BYTES);
  const stream = createReadStream(file, { start, end: endOffset - 1 });
  try {
    for await (const chunk of stream) hash.update(chunk);
  } finally {
    stream.destroy();
  }
  return hash.digest("hex");
}

export async function readByte(file, offset) {
  const stream = createReadStream(file, { start: offset, end: offset });
  try {
    for await (const chunk of stream) return chunk[0];
  } finally {
    stream.destroy();
  }
  return undefined;
}

async function scanFile(file, options = {}) {
  const events = [];
  const activityEvents = [];
  const speedEvents = [];
  let cwd = String(options.cwd ?? "");
  let committedOffset = options.startOffset ?? 0;
  let nextLineNumber = options.nextLineNumber ?? 0;
  let lastLineTerminated = true;
  let hasIncompleteTail = false;
  for await (const record of readJsonlLines(file, committedOffset, nextLineNumber)) {
    let entry;
    try {
      entry = JSON.parse(record.line);
    } catch {
      if (!record.terminated) {
        hasIncompleteTail = true;
        break;
      }
      committedOffset = record.endOffset;
      nextLineNumber = record.lineNumber + 1;
      lastLineTerminated = true;
      continue;
    }
    if (entry.type === "session" && entry.cwd) {
      cwd = String(entry.cwd);
    }
    const activityEvent = parseActivityEvent(entry, file, record.lineNumber, cwd);
    if (activityEvent) activityEvents.push(activityEvent);
    const event = parseUsageEvent(entry, file, record.lineNumber, cwd);
    if (event) events.push(event);
    const speedEvent = parseSpeedEvent(entry, file, record.lineNumber, cwd);
    if (speedEvent) speedEvents.push(speedEvent);
    committedOffset = record.endOffset;
    nextLineNumber = record.lineNumber + 1;
    lastLineTerminated = record.terminated;
  }
  const metadata = statSync(file);
  return {
    metadata: { sourceFile: file, fileSize: metadata.size, modifiedMs: metadata.mtimeMs },
    checkpoint: {
      importedOffset: committedOffset,
      nextLineNumber,
      cwd,
      tailHash: await hashCheckpointTail(file, committedOffset),
      lastLineTerminated,
      hasIncompleteTail,
    },
    events,
    activityEvents,
    speedEvents,
  };
}

export function listSessionFiles(directory, files = []) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) listSessionFiles(file, files);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
  }
  return files;
}

function resolveDuckDb(runtimeDirectory) {
  const requireFromSource = createRequire(import.meta.url);
  try {
    return requireFromSource.resolve(DUCKDB_PACKAGE);
  } catch {
    // Continue with the per-user runtime installation.
  }
  const requireFromRuntime = createRequire(path.join(runtimeDirectory, "loader.cjs"));
  try {
    return requireFromRuntime.resolve(DUCKDB_PACKAGE);
  } catch {
    return undefined;
  }
}

function installDuckDb(runtimeDirectory) {
  mkdirSync(runtimeDirectory, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  console.error(`未检测到 DuckDB，正在安装 ${DUCKDB_PACKAGE}@${DUCKDB_VERSION}...`);
  try {
    const args = [
      "install",
      "--prefix",
      runtimeDirectory,
      "--no-save",
      "--no-package-lock",
      "--no-fund",
      "--no-audit",
      `${DUCKDB_PACKAGE}@${DUCKDB_VERSION}`,
    ];
    execFileSync(
      process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : npm,
      process.platform === "win32" ? ["/d", "/s", "/c", npm, ...args] : args,
      { stdio: "inherit" },
    );
  } catch (error) {
    throw new Error(`DuckDB 自动安装失败，请手动执行 npm install ${DUCKDB_PACKAGE}: ${error.message}`);
  }
  const modulePath = resolveDuckDb(runtimeDirectory);
  if (!modulePath) throw new Error("DuckDB 安装完成但仍无法加载，请重新运行 pi-usage");
  return modulePath;
}

export async function loadDuckDb(runtimeDirectory) {
  const modulePath = resolveDuckDb(runtimeDirectory) ?? installDuckDb(runtimeDirectory);
  return import(pathToFileURL(modulePath).href);
}

export function calculateDuration(activityEvents, range) {
  const sessions = new Map();
  for (const event of activityEvents) {
    if (event.eventDate !== range.date) continue;
    const timestamp = Date.parse(event.eventTimestamp);
    if (!Number.isFinite(timestamp)) continue;
    const session = sessions.get(event.sourceFile) ?? [];
    session.push({ ...event, timestamp });
    sessions.set(event.sourceFile, session);
  }

  let activeSeconds = 0;
  let sessionSpanSeconds = 0;
  const modelWaitSeconds = new Map();
  for (const session of sessions.values()) {
    session.sort((left, right) => left.timestamp - right.timestamp);
    if (session.length > 1) {
      sessionSpanSeconds += (session.at(-1).timestamp - session[0].timestamp) / 1000;
    }
    for (let index = 1; index < session.length; index += 1) {
      const previous = session[index - 1];
      const current = session[index];
      const gap = current.timestamp - previous.timestamp;
      if (gap > 0 && gap <= ACTIVE_GAP_MS) activeSeconds += gap / 1000;
      if (
        current.eventType === "assistant" &&
        previous.eventType !== "assistant" &&
        current.model &&
        gap > 0 &&
        gap <= MODEL_WAIT_GAP_MS
      ) {
        modelWaitSeconds.set(
          current.model,
          (modelWaitSeconds.get(current.model) ?? 0) + gap / 1000,
        );
      }
    }
  }

  return {
    sessions: sessions.size,
    activeSeconds,
    sessionSpanSeconds,
    modelWaitSeconds: [...modelWaitSeconds.entries()].map(([model, seconds]) => ({ model, seconds })),
    modelWaitTotalSeconds: [...modelWaitSeconds.values()].reduce((total, seconds) => total + seconds, 0),
  };
}

export async function scanSessionFile(file, options = {}) {
  return scanFile(file, options);
}

export async function scanSpeedEvents(file) {
  const parsed = await scanSessionFile(file);
  return parsed.speedEvents;
}
