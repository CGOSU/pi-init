import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const DUCKDB_PACKAGE = "@duckdb/node-api";
const DUCKDB_VERSION = "1.5.5-r.3";
const FIELDS = ["input", "output", "cacheRead", "cacheWrite"];
const ACTIVE_GAP_MS = 5 * 60 * 1000;
const MODEL_WAIT_GAP_MS = 30 * 60 * 1000;
const AUTO_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const MODEL_BAR_WIDTH = 24;
const MODEL_BAR_SEGMENTS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
const MODEL_BAR_RESOLUTION = MODEL_BAR_SEGMENTS.length - 1;
const TOKEN_SPEED_CUSTOM_TYPE = "pi-token-speed";
const USAGE_SCHEMA_VERSION = 2;
const CHECKPOINT_TAIL_BYTES = 64 * 1024;
const APPENDER_BATCH_SIZE = 1024;

function emptyUsage() {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0 };
}

function localDateString(date) {
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
  const end = new Date(date);
  end.setDate(end.getDate() + 1);
  return { date: localDateString(date), start: date, end };
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
    entryKey: String(lineNumber),
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
    entryKey: String(lineNumber),
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
    entryKey: String(lineNumber),
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

async function hashCheckpointTail(file, endOffset) {
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

async function readByte(file, offset) {
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

function listSessionFiles(directory, files = []) {
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

async function loadDuckDb(runtimeDirectory) {
  const modulePath = resolveDuckDb(runtimeDirectory) ?? installDuckDb(runtimeDirectory);
  return import(pathToFileURL(modulePath).href);
}

function calculateDuration(activityEvents, range) {
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

async function initializeDatabase(connection) {
  await connection.run(`
    CREATE TABLE IF NOT EXISTS usage_state (
      state_key VARCHAR PRIMARY KEY,
      checked_ms BIGINT,
      checked_date VARCHAR
    )
  `);
  await connection.run(`
    CREATE TABLE IF NOT EXISTS session_files (
      source_file VARCHAR PRIMARY KEY,
      file_size BIGINT,
      modified_ms DOUBLE,
      imported_offset BIGINT,
      next_line_number BIGINT,
      checkpoint_cwd VARCHAR,
      tail_hash VARCHAR,
      last_line_terminated BOOLEAN,
      has_incomplete_tail BOOLEAN
    )
  `);
  for (const column of [
    "imported_offset BIGINT",
    "next_line_number BIGINT",
    "checkpoint_cwd VARCHAR",
    "tail_hash VARCHAR",
    "last_line_terminated BOOLEAN",
    "has_incomplete_tail BOOLEAN",
  ]) {
    await connection.run(`ALTER TABLE session_files ADD COLUMN IF NOT EXISTS ${column}`);
  }
  await connection.run(`
    CREATE TABLE IF NOT EXISTS activity_events (
      source_file VARCHAR,
      entry_key VARCHAR,
      event_timestamp VARCHAR,
      event_date VARCHAR,
      event_type VARCHAR,
      model VARCHAR,
      cwd VARCHAR,
      PRIMARY KEY (source_file, entry_key)
    )
  `);
  await connection.run(`
    CREATE TABLE IF NOT EXISTS usage_events (
      source_file VARCHAR,
      entry_key VARCHAR,
      event_timestamp VARCHAR,
      event_date VARCHAR,
      model VARCHAR,
      input_tokens BIGINT,
      output_tokens BIGINT,
      cache_read_tokens BIGINT,
      cache_write_tokens BIGINT,
      total_tokens BIGINT,
      cost DOUBLE,
      cwd VARCHAR,
      PRIMARY KEY (source_file, entry_key)
    )
  `);
  await connection.run(`
    CREATE TABLE IF NOT EXISTS duration_summaries (
      report_date VARCHAR,
      scope VARCHAR,
      model VARCHAR,
      sessions INTEGER,
      active_seconds DOUBLE,
      model_wait_seconds DOUBLE,
      session_span_seconds DOUBLE,
      PRIMARY KEY (report_date, scope, model)
    )
  `);
  await connection.run(`
    CREATE TABLE IF NOT EXISTS speed_events (
      source_file VARCHAR,
      entry_key VARCHAR,
      event_timestamp VARCHAR,
      event_date VARCHAR,
      model VARCHAR,
      output_tokens DOUBLE,
      generation_seconds DOUBLE,
      cwd VARCHAR,
      PRIMARY KEY (source_file, entry_key)
    )
  `);
  await connection.run(`
    CREATE TABLE IF NOT EXISTS usage_schema (
      schema_key VARCHAR PRIMARY KEY,
      schema_version INTEGER
    )
  `);
}

async function scanSessionFile(file, options = {}) {
  return scanFile(file, options);
}

async function scanSpeedEvents(file) {
  const parsed = await scanSessionFile(file);
  return parsed.speedEvents;
}

async function readUsageState(connection) {
  const reader = await connection.runAndReadAll(
    "SELECT checked_ms, checked_date FROM usage_state WHERE state_key = 'refresh'",
  );
  const row = reader.getRowObjects()[0];
  return row
    ? { checkedMs: Number(row.checked_ms), checkedDate: row.checked_date }
    : undefined;
}

async function readUsageSchemaVersion(connection) {
  const reader = await connection.runAndReadAll(
    "SELECT schema_version FROM usage_schema WHERE schema_key = 'usage'",
  );
  const row = reader.getRowObjects()[0];
  return row ? numberValue(row.schema_version) : undefined;
}

async function hasStoredSessionFiles(connection) {
  const reader = await connection.runAndReadAll("SELECT COUNT(*) AS count FROM session_files");
  return numberValue(reader.getRowObjects()[0]?.count) > 0;
}

async function markUsageChecked(connection, now = new Date()) {
  await connection.run(
    `
      INSERT OR REPLACE INTO usage_state VALUES ('refresh', $checked_ms, $checked_date)
    `,
    { checked_ms: now.getTime(), checked_date: localDateString(now) },
  );
  await connection.run(
    `
      INSERT OR REPLACE INTO usage_schema VALUES ('usage', $schema_version)
    `,
    { schema_version: USAGE_SCHEMA_VERSION },
  );
}

async function readEventDates(connection, sourceFile) {
  const reader = await connection.runAndReadAll(
    `
      SELECT event_date FROM usage_events WHERE source_file = $source_file
      UNION
      SELECT event_date FROM activity_events WHERE source_file = $source_file
      UNION
      SELECT event_date FROM speed_events WHERE source_file = $source_file
    `,
    { source_file: sourceFile },
  );
  return reader.getRowObjects().map((row) => row.event_date).filter(Boolean);
}

async function withTransaction(connection, callback) {
  await connection.run("BEGIN TRANSACTION");
  try {
    const result = await callback();
    await connection.run("COMMIT");
    return result;
  } catch (error) {
    try {
      await connection.run("ROLLBACK");
    } catch {
      // Keep the original error; the connection is closed by the caller.
    }
    throw error;
  }
}

function appendBigInt(appender, value) {
  appender.appendBigInt(BigInt(Math.trunc(Number(value) || 0)));
}

async function appendRows(connection, tableName, rows, appendRow) {
  if (rows.length === 0) return;
  const appender = await connection.createAppender(tableName);
  try {
    for (let index = 0; index < rows.length; index += 1) {
      appendRow(appender, rows[index]);
      appender.endRow();
      if ((index + 1) % APPENDER_BATCH_SIZE === 0) appender.flushSync();
    }
    appender.flushSync();
  } finally {
    appender.closeSync();
  }
}

async function insertUsageEvents(connection, events) {
  await appendRows(connection, "usage_events", events, (appender, event) => {
    appender.appendVarchar(event.sourceFile);
    appender.appendVarchar(event.entryKey);
    appender.appendVarchar(event.eventTimestamp);
    appender.appendVarchar(event.eventDate);
    appender.appendVarchar(event.model);
    appendBigInt(appender, event.input);
    appendBigInt(appender, event.output);
    appendBigInt(appender, event.cacheRead);
    appendBigInt(appender, event.cacheWrite);
    appendBigInt(appender, event.tokens);
    appender.appendDouble(event.cost);
    appender.appendVarchar(event.cwd);
  });
}

async function insertActivityEvents(connection, events) {
  await appendRows(connection, "activity_events", events, (appender, event) => {
    appender.appendVarchar(event.sourceFile);
    appender.appendVarchar(event.entryKey);
    appender.appendVarchar(event.eventTimestamp);
    appender.appendVarchar(event.eventDate);
    appender.appendVarchar(event.eventType);
    appender.appendVarchar(event.model);
    appender.appendVarchar(event.cwd);
  });
}

async function insertSpeedEvents(connection, speedEvents) {
  await appendRows(connection, "speed_events", speedEvents, (appender, event) => {
    appender.appendVarchar(event.sourceFile);
    appender.appendVarchar(event.entryKey);
    appender.appendVarchar(event.eventTimestamp);
    appender.appendVarchar(event.eventDate);
    appender.appendVarchar(event.model);
    appender.appendDouble(event.outputTokens);
    appender.appendDouble(event.generationSeconds);
    appender.appendVarchar(event.cwd);
  });
}

function emitRefreshProgress(options, event) {
  if (typeof options.onProgress === "function") options.onProgress(event);
}

async function refreshSpeedEvents(connection, sessionsDirectory) {
  await withTransaction(connection, async () => {
    await connection.run("DELETE FROM speed_events");
    for (const file of listSessionFiles(sessionsDirectory)) {
      await insertSpeedEvents(connection, await scanSpeedEvents(file));
    }
  });
}

async function canIncrementallyScan(file, metadata, previous) {
  if (
    previous.importedOffset === undefined ||
    previous.nextLineNumber === undefined ||
    !previous.tailHash ||
    metadata.size < previous.importedOffset ||
    metadata.size < previous.fileSize
  ) {
    return false;
  }
  if (metadata.size === previous.fileSize && metadata.mtimeMs !== previous.modifiedMs) {
    return false;
  }
  if (
    metadata.size > previous.fileSize &&
    previous.importedOffset === previous.fileSize &&
    previous.lastLineTerminated === false &&
    (await readByte(file, previous.importedOffset)) !== 0x0a
  ) {
    return false;
  }
  return (await hashCheckpointTail(file, previous.importedOffset)) === previous.tailHash;
}

function sessionCheckpointParameters(parsed) {
  return {
    source_file: parsed.metadata.sourceFile,
    file_size: parsed.metadata.fileSize,
    modified_ms: parsed.metadata.modifiedMs,
    imported_offset: parsed.checkpoint.importedOffset,
    next_line_number: parsed.checkpoint.nextLineNumber,
    checkpoint_cwd: parsed.checkpoint.cwd,
    tail_hash: parsed.checkpoint.tailHash,
    last_line_terminated: parsed.checkpoint.lastLineTerminated,
    has_incomplete_tail: parsed.checkpoint.hasIncompleteTail,
  };
}

async function refreshSessionFiles(connection, sessionsDirectory, options = {}) {
  const storedReader = await connection.runAndReadAll(
    `
      SELECT source_file, file_size, modified_ms, imported_offset,
        next_line_number, checkpoint_cwd, tail_hash,
        last_line_terminated, has_incomplete_tail
      FROM session_files
    `,
  );
  const stored = new Map(
    storedReader.getRowObjects().map((row) => [
      row.source_file,
      {
        fileSize: numberValue(row.file_size),
        modifiedMs: numberValue(row.modified_ms),
        importedOffset: finiteNumber(row.imported_offset),
        nextLineNumber: finiteNumber(row.next_line_number),
        cwd: row.checkpoint_cwd ?? "",
        tailHash: row.tail_hash,
        lastLineTerminated:
          row.last_line_terminated === null || row.last_line_terminated === undefined
            ? undefined
            : Boolean(row.last_line_terminated),
        hasIncompleteTail:
          row.has_incomplete_tail === null || row.has_incomplete_tail === undefined
            ? undefined
            : Boolean(row.has_incomplete_tail),
      },
    ]),
  );
  const files = listSessionFiles(sessionsDirectory);
  const seen = new Set(files);
  const affectedDates = new Set();
  const stats = {
    filesSeen: files.length,
    filesSkipped: 0,
    filesChanged: 0,
    filesAppended: 0,
    filesRebuilt: 0,
    filesRemoved: 0,
    bytesRead: 0,
    events: 0,
  };
  for (const file of files) {
    const metadata = statSync(file);
    const previous = stored.get(file);
    const unchanged = previous && previous.fileSize === metadata.size && previous.modifiedMs === metadata.mtimeMs;
    if (unchanged && previous.importedOffset === undefined) {
      stats.filesSkipped += 1;
      emitRefreshProgress(options, { type: "file", file, mode: "skipped", index: stats.filesSkipped, total: files.length });
      continue;
    }
    if (
      unchanged &&
      previous.tailHash &&
      (previous.importedOffset === metadata.size || previous.hasIncompleteTail === true) &&
      (await hashCheckpointTail(file, previous.importedOffset)) === previous.tailHash
    ) {
      stats.filesSkipped += 1;
      emitRefreshProgress(options, { type: "file", file, mode: "skipped", index: stats.filesSkipped, total: files.length });
      continue;
    }
    const incremental = previous ? await canIncrementallyScan(file, metadata, previous) : false;
    if (!incremental) {
      for (const date of await readEventDates(connection, file)) affectedDates.add(date);
    }
    const startOffset = incremental ? previous.importedOffset : 0;
    const parsed = await scanSessionFile(
      file,
      incremental
        ? {
            startOffset,
            nextLineNumber: previous.nextLineNumber,
            cwd: previous.cwd,
          }
        : undefined,
    );
    for (const event of [
      ...parsed.events,
      ...parsed.activityEvents,
      ...parsed.speedEvents,
    ]) {
      affectedDates.add(event.eventDate);
    }
    await withTransaction(connection, async () => {
      if (!incremental) {
        await connection.run("DELETE FROM usage_events WHERE source_file = $source_file", { source_file: file });
        await connection.run("DELETE FROM activity_events WHERE source_file = $source_file", { source_file: file });
        await connection.run("DELETE FROM speed_events WHERE source_file = $source_file", { source_file: file });
      }
      await insertUsageEvents(connection, parsed.events);
      await insertActivityEvents(connection, parsed.activityEvents);
      await insertSpeedEvents(connection, parsed.speedEvents);
      await connection.run(
        `
          INSERT OR REPLACE INTO session_files (
            source_file, file_size, modified_ms, imported_offset,
            next_line_number, checkpoint_cwd, tail_hash,
            last_line_terminated, has_incomplete_tail
          ) VALUES (
            $source_file, $file_size, $modified_ms, $imported_offset,
            $next_line_number, $checkpoint_cwd, $tail_hash,
            $last_line_terminated, $has_incomplete_tail
          )
        `,
        sessionCheckpointParameters(parsed),
      );
    });
    stats.filesChanged += 1;
    if (incremental) stats.filesAppended += 1;
    else stats.filesRebuilt += 1;
    stats.bytesRead += Math.max(0, parsed.checkpoint.importedOffset - startOffset);
    stats.events += parsed.events.length + parsed.activityEvents.length + parsed.speedEvents.length;
    emitRefreshProgress(options, {
      type: "file",
      file,
      mode: incremental ? "appended" : "rebuilt",
      index: stats.filesChanged + stats.filesSkipped,
      total: files.length,
    });
  }
  for (const sourceFile of stored.keys()) {
    if (seen.has(sourceFile)) continue;
    for (const date of await readEventDates(connection, sourceFile)) affectedDates.add(date);
    await connection.run("DELETE FROM usage_events WHERE source_file = $source_file", { source_file: sourceFile });
    await connection.run("DELETE FROM activity_events WHERE source_file = $source_file", { source_file: sourceFile });
    await connection.run("DELETE FROM speed_events WHERE source_file = $source_file", { source_file: sourceFile });
    await connection.run("DELETE FROM session_files WHERE source_file = $source_file", { source_file: sourceFile });
    stats.filesRemoved += 1;
    emitRefreshProgress(options, { type: "file", file: sourceFile, mode: "removed", total: files.length });
  }
  return { affectedDates, stats };
}

async function refreshDurationSummary(connection, range, duration) {
  await connection.run("DELETE FROM duration_summaries WHERE report_date = $date", { date: range.date });
  const insert = async (scope, model, values) => {
    await connection.run(
      `
        INSERT INTO duration_summaries VALUES (
          $report_date, $scope, $model, $sessions,
          $active_seconds, $model_wait_seconds, $session_span_seconds
        )
      `,
      {
        report_date: range.date,
        scope,
        model,
        sessions: duration.sessions,
        active_seconds: values.activeSeconds,
        model_wait_seconds: values.modelWaitSeconds,
        session_span_seconds: values.sessionSpanSeconds,
      },
    );
  };
  await insert("overall", "", {
    activeSeconds: duration.activeSeconds,
    modelWaitSeconds: duration.modelWaitTotalSeconds,
    sessionSpanSeconds: duration.sessionSpanSeconds,
  });
  for (const model of duration.modelWaitSeconds) {
    await insert("model", model.model, {
      activeSeconds: 0,
      modelWaitSeconds: model.seconds,
      sessionSpanSeconds: 0,
    });
  }
}


function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function numberValue(value) {
  return Number(value) || 0;
}

function averageTps(speed) {
  if (!speed || speed.outputTokens <= 0 || speed.generationSeconds <= 0) return null;
  return speed.outputTokens / speed.generationSeconds;
}

async function readActivityEvents(connection, range) {
  const reader = await connection.runAndReadAll(
    `
      SELECT source_file, entry_key, event_timestamp, event_date, event_type, model, cwd
      FROM activity_events
      WHERE event_date = $date
      ORDER BY source_file, event_timestamp, entry_key
    `,
    { date: range.date },
  );
  return reader.getRowObjects().map((row) => ({
    sourceFile: row.source_file,
    entryKey: row.entry_key,
    eventTimestamp: row.event_timestamp,
    eventDate: row.event_date,
    eventType: row.event_type,
    model: row.model,
    cwd: row.cwd,
  }));
}

async function refreshDerivedSummaries(connection, range) {
  const duration = calculateDuration(await readActivityEvents(connection, range), range);
  await refreshDurationSummary(connection, range, duration);
}

async function readSummary(connection, range) {
  const rowsReader = await connection.runAndReadAll(
    `
      SELECT model, COUNT(*) AS calls,
        COALESCE(SUM(input_tokens), 0) AS input,
        COALESCE(SUM(output_tokens), 0) AS output,
        COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
        COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(SUM(cost), 0) AS cost
      FROM usage_events
      WHERE event_date = $date
      GROUP BY model
      ORDER BY cost DESC
    `,
    { date: range.date },
  );
  const speedReader = await connection.runAndReadAll(
    `
      SELECT model,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(generation_seconds), 0) AS generation_seconds
      FROM speed_events
      WHERE event_date = $date
      GROUP BY model
    `,
    { date: range.date },
  );
  const sessionsReader = await connection.runAndReadAll(
    "SELECT COUNT(DISTINCT source_file) AS sessions FROM usage_events WHERE event_date = $date",
    { date: range.date },
  );
  const durationReader = await connection.runAndReadAll(
    "SELECT * FROM duration_summaries WHERE report_date = $date AND scope = 'overall'",
    { date: range.date },
  );
  const speedByModel = new Map(
    speedReader.getRowObjects().map((row) => [
      row.model,
      {
        outputTokens: numberValue(row.output_tokens),
        generationSeconds: numberValue(row.generation_seconds),
      },
    ]),
  );
  const rows = rowsReader.getRowObjects().map((row) => ({
    model: row.model,
    calls: numberValue(row.calls),
    input: numberValue(row.input),
    output: numberValue(row.output),
    cacheRead: numberValue(row.cacheRead),
    cacheWrite: numberValue(row.cacheWrite),
    tokens: numberValue(row.tokens),
    cost: numberValue(row.cost),
    avgTps: averageTps(speedByModel.get(row.model)),
  }));
  const speed = [...speedByModel.values()].reduce(
    (total, value) => ({
      outputTokens: total.outputTokens + value.outputTokens,
      generationSeconds: total.generationSeconds + value.generationSeconds,
    }),
    { outputTokens: 0, generationSeconds: 0 },
  );
  const durationRow = durationReader.getRowObjects()[0];
  const duration = {
    sessions: numberValue(durationRow?.sessions),
    activeSeconds: numberValue(durationRow?.active_seconds),
    modelWaitSeconds: numberValue(durationRow?.model_wait_seconds),
    sessionSpanSeconds: numberValue(durationRow?.session_span_seconds),
  };
  return {
    date: range.date,
    sessions: numberValue(sessionsReader.getRowObjects()[0]?.sessions),
    rows,
    speed: { ...speed, avgTps: averageTps(speed) },
    duration,
  };
}

async function closeDatabase(connection, instance) {
  connection.disconnectSync?.();
  connection.closeSync?.();
  instance.closeSync?.();
}

async function withDatabase(databasePath, runtimeDirectory, callback) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const duckdb = await loadDuckDb(runtimeDirectory);
  const instance = await duckdb.DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  try {
    await initializeDatabase(connection);
    return await callback(connection);
  } finally {
    await closeDatabase(connection, instance);
  }
}

async function refreshUsage(connection, sessionsDirectory, range, options = {}) {
  emitRefreshProgress(options, { type: "start", date: range.date });
  const schemaVersion = await readUsageSchemaVersion(connection);
  const schemaMigrated = schemaVersion !== USAGE_SCHEMA_VERSION && (await hasStoredSessionFiles(connection));
  if (schemaMigrated) await refreshSpeedEvents(connection, sessionsDirectory);
  const { affectedDates, stats } = await refreshSessionFiles(connection, sessionsDirectory, options);
  const dates = [...affectedDates].sort();
  for (const date of dates) {
    await refreshDerivedSummaries(connection, dateRange(date));
  }
  await markUsageChecked(connection);
  const result = { ...stats, durationDates: dates, schemaMigrated };
  emitRefreshProgress(options, { type: "complete", date: range.date, stats: result });
  return result;
}

export async function summarizeUsage(
  sessionsDirectory,
  date,
  databasePath = path.join(os.homedir(), ".pi", "agent", "pi-usage.duckdb"),
  runtimeDirectory = path.join(os.homedir(), ".pi", "agent", "pi-usage-runtime"),
  options = {},
) {
  const range = dateRange(date);
  return withDatabase(databasePath, runtimeDirectory, async (connection) => {
    await refreshUsage(connection, sessionsDirectory, range, options);
    return readSummary(connection, range);
  });
}

export async function queryUsage(
  date,
  databasePath,
  runtimeDirectory,
  sessionsDirectory,
  options = {},
) {
  const range = dateRange(date);
  return withDatabase(databasePath, runtimeDirectory, async (connection) => {
    const state = await readUsageState(connection);
    const schemaVersion = await readUsageSchemaVersion(connection);
    if (
      sessionsDirectory &&
      (schemaVersion !== USAGE_SCHEMA_VERSION || shouldRefreshUsage(state))
    ) {
      await refreshUsage(connection, sessionsDirectory, range, options);
    }
    return readSummary(connection, range);
  });
}

function formatNumber(value) {
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

function supportsColor() {
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
    paint(`Pi usage · ${summary.date}`, "36;1", color),
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

function parseArguments(args, agentDir) {
  let date;
  let update = false;
  let databasePath = process.env.PI_USAGE_DB || path.join(agentDir, "pi-usage.duckdb");
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--update") {
      update = true;
    } else if (argument === "--db") {
      databasePath = args[++index];
      if (!databasePath) throw new Error("--db 需要数据库路径");
    } else if (argument.startsWith("--")) {
      throw new Error(`未知参数：${argument}`);
    } else if (date) {
      throw new Error("只能指定一个日期");
    } else {
      date = argument;
    }
  }
  return { date, databasePath, update };
}

function createRefreshProgressReporter() {
  return (event) => {
    if (event.type === "start") {
      console.error("正在扫描 session、增量更新 DuckDB...");
      return;
    }
    if (event.type !== "complete") return;
    const stats = event.stats;
    const dates = stats.durationDates.length ? stats.durationDates.join(", ") : "无";
    console.error(
      `刷新完成：扫描 ${formatNumber(stats.filesSeen)} 个文件，跳过 ${formatNumber(stats.filesSkipped)} 个，` +
        `追加 ${formatNumber(stats.filesAppended)} 个，重建 ${formatNumber(stats.filesRebuilt)} 个，` +
        `移除 ${formatNumber(stats.filesRemoved)} 个，读取 ${formatNumber(stats.bytesRead)} 字节，` +
        `重算日期：${dates}。`,
    );
  };
}

async function main() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const { date, databasePath, update } = parseArguments(process.argv.slice(2), agentDir);
  const sessionsDirectory = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDir, "sessions");
  const runtimeDirectory = path.join(agentDir, "pi-usage-runtime");
  const options = process.stderr.isTTY ? { onProgress: createRefreshProgressReporter() } : {};
  const summary = update
    ? await summarizeUsage(sessionsDirectory, date, databasePath, runtimeDirectory, options)
    : await queryUsage(date, databasePath, runtimeDirectory, sessionsDirectory, options);
  console.log(formatReport(summary, { color: supportsColor() }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
