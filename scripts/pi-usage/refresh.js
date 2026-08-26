export { USAGE_SCHEMA_VERSION } from "./database.js";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { calculateDuration, dateRange, hashCheckpointTail, listSessionFiles, parseUsageRange, readByte, scanSessionFile, shouldRefreshUsage } from "./core.js";
import { USAGE_SCHEMA_VERSION, clearDerivedData, insertActivityEvents, insertSpeedEvents, insertUsageEvents, markUsageChecked, readEventDates, readUsageSchemaVersion, readUsageState, withDatabase, withTransaction } from "./database.js";

function emitRefreshProgress(options, event) {
  if (typeof options.onProgress === "function") options.onProgress(event);
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

async function insertSessionCheckpoint(connection, parsed) {
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
}

async function rebuildSessionFiles(connection, sessionsDirectory, options = {}) {
  const files = listSessionFiles(sessionsDirectory);
  const parsedFiles = [];
  const affectedDates = new Set();
  const stats = {
    filesSeen: files.length,
    filesSkipped: 0,
    filesChanged: files.length,
    filesAppended: 0,
    filesRebuilt: files.length,
    filesRemoved: 0,
    bytesRead: 0,
    events: 0,
  };
  for (const file of files) {
    const parsed = await scanSessionFile(file);
    parsedFiles.push(parsed);
    for (const event of [...parsed.events, ...parsed.activityEvents, ...parsed.speedEvents]) {
      affectedDates.add(event.eventDate);
    }
    stats.bytesRead += parsed.checkpoint.importedOffset;
    stats.events += parsed.events.length + parsed.activityEvents.length + parsed.speedEvents.length;
  }

  await withTransaction(connection, async () => {
    await clearDerivedData(connection);
    for (const parsed of parsedFiles) {
      await insertUsageEvents(connection, parsed.events);
      await insertActivityEvents(connection, parsed.activityEvents);
      await insertSpeedEvents(connection, parsed.speedEvents);
      await insertSessionCheckpoint(connection, parsed);
    }
    for (const date of [...affectedDates].sort()) {
      await refreshDerivedSummaries(connection, dateRange(date));
    }
    await markUsageChecked(connection);
  });
  files.forEach((file, index) => {
    emitRefreshProgress(options, { type: "file", file, mode: "rebuilt", index: index + 1, total: files.length });
  });
  return { affectedDates, stats };
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
      await insertSessionCheckpoint(connection, parsed);
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
      WITH unique_events AS (
        SELECT source_file, entry_key, event_timestamp, event_date, event_type, model, cwd,
          ROW_NUMBER() OVER (PARTITION BY entry_key ORDER BY source_file) AS occurrence
        FROM activity_events
      )
      SELECT source_file, entry_key, event_timestamp, event_date, event_type, model, cwd
      FROM unique_events
      WHERE occurrence = 1 AND event_date = $date
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
      WITH unique_events AS (
        SELECT model, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, total_tokens, cost, entry_key, event_date,
          ROW_NUMBER() OVER (PARTITION BY entry_key ORDER BY source_file) AS occurrence
        FROM usage_events
      )
      SELECT model, COUNT(*) AS calls,
        COALESCE(SUM(input_tokens), 0) AS input,
        COALESCE(SUM(output_tokens), 0) AS output,
        COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
        COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(SUM(cost), 0) AS cost
      FROM unique_events
      WHERE occurrence = 1 AND event_date >= $start_date AND event_date <= $end_date
      GROUP BY model
      ORDER BY cost DESC
    `,
    { start_date: range.startDate, end_date: range.endDate },
  );
  const speedReader = await connection.runAndReadAll(
    `
      WITH unique_events AS (
        SELECT model, output_tokens, generation_seconds, event_date, entry_key,
          ROW_NUMBER() OVER (PARTITION BY entry_key ORDER BY source_file) AS occurrence
        FROM speed_events
      )
      SELECT model,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(generation_seconds), 0) AS generation_seconds
      FROM unique_events
      WHERE occurrence = 1 AND event_date >= $start_date AND event_date <= $end_date
      GROUP BY model
    `,
    { start_date: range.startDate, end_date: range.endDate },
  );
  const sessionsReader = await connection.runAndReadAll(
    `
      WITH unique_events AS (
        SELECT source_file, event_date, entry_key,
          ROW_NUMBER() OVER (PARTITION BY entry_key ORDER BY source_file) AS occurrence
        FROM usage_events
      )
      SELECT COUNT(DISTINCT source_file) AS sessions
      FROM unique_events
      WHERE occurrence = 1 AND event_date >= $start_date AND event_date <= $end_date
    `,
    { start_date: range.startDate, end_date: range.endDate },
  );
  const durationReader = await connection.runAndReadAll(
    `
      SELECT
        COALESCE(SUM(active_seconds), 0) AS active_seconds,
        COALESCE(SUM(model_wait_seconds), 0) AS model_wait_seconds,
        COALESCE(SUM(session_span_seconds), 0) AS session_span_seconds
      FROM duration_summaries
      WHERE report_date >= $start_date AND report_date <= $end_date AND scope = 'overall'
    `,
    { start_date: range.startDate, end_date: range.endDate },
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
    sessions: numberValue(sessionsReader.getRowObjects()[0]?.sessions),
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


async function refreshUsage(connection, sessionsDirectory, range, options = {}) {
  emitRefreshProgress(options, { type: "start", date: range.date });
  const schemaVersion = await readUsageSchemaVersion(connection);
  const schemaMigrated = schemaVersion !== USAGE_SCHEMA_VERSION;
  if (schemaMigrated) {
    const { affectedDates, stats } = await rebuildSessionFiles(connection, sessionsDirectory, options);
    const dates = [...affectedDates].sort();
    const result = { ...stats, durationDates: dates, schemaMigrated };
    emitRefreshProgress(options, { type: "complete", date: range.date, stats: result });
    return result;
  }
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
  const range = parseUsageRange(date);
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
  const range = parseUsageRange(date);
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
