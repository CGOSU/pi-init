import { mkdirSync } from "node:fs";
import path from "node:path";
import { loadDuckDb, localDateString } from "./core.js";

export const USAGE_SCHEMA_VERSION = 3;
const APPENDER_BATCH_SIZE = 1024;

function numberValue(value) {
  return Number(value) || 0;
}

export async function initializeDatabase(connection) {
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

export async function clearDerivedData(connection) {
  for (const table of [
    "usage_events",
    "activity_events",
    "speed_events",
    "duration_summaries",
    "session_files",
  ]) {
    await connection.run(`DELETE FROM ${table}`);
  }
}

export async function readUsageState(connection) {
  const reader = await connection.runAndReadAll(
    "SELECT checked_ms, checked_date FROM usage_state WHERE state_key = 'refresh'",
  );
  const row = reader.getRowObjects()[0];
  return row
    ? { checkedMs: Number(row.checked_ms), checkedDate: row.checked_date }
    : undefined;
}

export async function readUsageSchemaVersion(connection) {
  const reader = await connection.runAndReadAll(
    "SELECT schema_version FROM usage_schema WHERE schema_key = 'usage'",
  );
  const row = reader.getRowObjects()[0];
  return row ? numberValue(row.schema_version) : undefined;
}

export async function hasStoredSessionFiles(connection) {
  const reader = await connection.runAndReadAll("SELECT COUNT(*) AS count FROM session_files");
  return numberValue(reader.getRowObjects()[0]?.count) > 0;
}

export async function markUsageChecked(connection, now = new Date()) {
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

export async function readEventDates(connection, sourceFile) {
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

export async function withTransaction(connection, callback) {
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

export async function insertUsageEvents(connection, events) {
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

export async function insertActivityEvents(connection, events) {
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

export async function insertSpeedEvents(connection, speedEvents) {
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


async function closeDatabase(connection, instance) {
  connection.disconnectSync?.();
  connection.closeSync?.();
  instance.closeSync?.();
}

export async function withDatabase(databasePath, runtimeDirectory, callback) {
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

