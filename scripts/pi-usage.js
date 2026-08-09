import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const DUCKDB_PACKAGE = "@duckdb/node-api";
const DUCKDB_VERSION = "1.5.5-r.3";
const FIELDS = ["input", "output", "cacheRead", "cacheWrite"];
const ACTIVE_GAP_MS = 5 * 60 * 1000;
const MODEL_WAIT_GAP_MS = 30 * 60 * 1000;

function emptyUsage() {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0 };
}

function localDateString(date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
    .join("-");
}

function dateRange(value) {
  const parts = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (value && !parts) throw new Error("日期必须是 YYYY-MM-DD");
  const date = parts
    ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
    : new Date();
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

function scanFile(file, events, activityEvents) {
  let cwd = "";
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber];
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session" && entry.cwd) {
      cwd = String(entry.cwd);
    }
    const activityEvent = parseActivityEvent(entry, file, lineNumber, cwd);
    if (activityEvent) activityEvents.push(activityEvent);
    const event = parseUsageEvent(entry, file, lineNumber, cwd);
    if (event) events.push(event);
  }
}

function scanDirectory(directory, events, activityEvents) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) scanDirectory(file, events, activityEvents);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) scanFile(file, events, activityEvents);
  }
}

function collectUsageEvents(sessionsDirectory) {
  const events = [];
  const activityEvents = [];
  scanDirectory(sessionsDirectory, events, activityEvents);
  return { events, activityEvents };
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
    CREATE TABLE IF NOT EXISTS code_changes (
      report_date VARCHAR,
      repository VARCHAR,
      commits INTEGER,
      committed_files INTEGER,
      committed_insertions BIGINT,
      committed_deletions BIGINT,
      uncommitted_files INTEGER,
      uncommitted_insertions BIGINT,
      uncommitted_deletions BIGINT,
      PRIMARY KEY (report_date, repository)
    )
  `);
}

async function refreshUsageEvents(connection, events) {
  await connection.run("DELETE FROM usage_events");
  for (const event of events) {
    await connection.run(
      `
        INSERT INTO usage_events VALUES (
          $source_file, $entry_key, $event_timestamp, $event_date, $model,
          $input_tokens, $output_tokens, $cache_read_tokens, $cache_write_tokens,
          $total_tokens, $cost, $cwd
        )
      `,
      {
        source_file: event.sourceFile,
        entry_key: event.entryKey,
        event_timestamp: event.eventTimestamp,
        event_date: event.eventDate,
        model: event.model,
        input_tokens: event.input,
        output_tokens: event.output,
        cache_read_tokens: event.cacheRead,
        cache_write_tokens: event.cacheWrite,
        total_tokens: event.tokens,
        cost: event.cost,
        cwd: event.cwd,
      },
    );
  }
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

function runGit(repository, args) {
  try {
    return execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function gitRoot(directory) {
  return directory ? runGit(directory, ["rev-parse", "--show-toplevel"]) : undefined;
}

function parseNumstat(output) {
  const result = { files: 0, insertions: 0, deletions: 0 };
  for (const line of (output ?? "").split(/\r?\n/)) {
    const [insertions, deletions] = line.split("\t");
    if (deletions === undefined) continue;
    result.files += 1;
    if (insertions !== "-") result.insertions += Number(insertions) || 0;
    if (deletions !== "-") result.deletions += Number(deletions) || 0;
  }
  return result;
}

function collectGitChanges(repository, range) {
  const commits = Number(
    runGit(repository, [
      "rev-list",
      "--count",
      `--since=${range.start.toISOString()}`,
      `--until=${range.end.toISOString()}`,
      "HEAD",
    ]) ?? 0,
  );
  const committed = parseNumstat(
    runGit(repository, [
      "log",
      "--format=",
      "--numstat",
      `--since=${range.start.toISOString()}`,
      `--until=${range.end.toISOString()}`,
    ]),
  );
  const uncommitted = parseNumstat(runGit(repository, ["diff", "HEAD", "--numstat"]));
  const status = runGit(repository, ["status", "--porcelain"]);
  return {
    repository,
    commits,
    committedFiles: committed.files,
    committedInsertions: committed.insertions,
    committedDeletions: committed.deletions,
    uncommittedFiles: status ? status.split(/\r?\n/).filter(Boolean).length : 0,
    uncommittedInsertions: uncommitted.insertions,
    uncommittedDeletions: uncommitted.deletions,
  };
}

async function refreshCodeChanges(connection, range, directories) {
  const repositories = new Set();
  for (const directory of directories) {
    const root = gitRoot(directory);
    if (root) repositories.add(root);
  }
  await connection.run("DELETE FROM code_changes WHERE report_date = $date", { date: range.date });
  for (const repository of repositories) {
    const change = collectGitChanges(repository, range);
    await connection.run(
      `
        INSERT INTO code_changes VALUES (
          $report_date, $repository, $commits, $committed_files,
          $committed_insertions, $committed_deletions, $uncommitted_files,
          $uncommitted_insertions, $uncommitted_deletions
        )
      `,
      {
        report_date: range.date,
        repository: change.repository,
        commits: change.commits,
        committed_files: change.committedFiles,
        committed_insertions: change.committedInsertions,
        committed_deletions: change.committedDeletions,
        uncommitted_files: change.uncommittedFiles,
        uncommitted_insertions: change.uncommittedInsertions,
        uncommitted_deletions: change.uncommittedDeletions,
      },
    );
  }
}

function numberValue(value) {
  return Number(value) || 0;
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
  const sessionsReader = await connection.runAndReadAll(
    "SELECT COUNT(DISTINCT source_file) AS sessions FROM usage_events WHERE event_date = $date",
    { date: range.date },
  );
  const durationReader = await connection.runAndReadAll(
    "SELECT * FROM duration_summaries WHERE report_date = $date AND scope = 'overall'",
    { date: range.date },
  );
  const codeReader = await connection.runAndReadAll(
    "SELECT * FROM code_changes WHERE report_date = $date ORDER BY repository",
    { date: range.date },
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
  }));
  const durationRow = durationReader.getRowObjects()[0];
  const duration = {
    sessions: numberValue(durationRow?.sessions),
    activeSeconds: numberValue(durationRow?.active_seconds),
    modelWaitSeconds: numberValue(durationRow?.model_wait_seconds),
    sessionSpanSeconds: numberValue(durationRow?.session_span_seconds),
  };
  const codeChanges = codeReader.getRowObjects().map((row) => ({
    repository: row.repository,
    commits: numberValue(row.commits),
    committedFiles: numberValue(row.committed_files),
    committedInsertions: numberValue(row.committed_insertions),
    committedDeletions: numberValue(row.committed_deletions),
    uncommittedFiles: numberValue(row.uncommitted_files),
    uncommittedInsertions: numberValue(row.uncommitted_insertions),
    uncommittedDeletions: numberValue(row.uncommitted_deletions),
  }));
  return {
    date: range.date,
    sessions: numberValue(sessionsReader.getRowObjects()[0]?.sessions),
    rows,
    duration,
    codeChanges,
  };
}

async function closeDatabase(connection, instance) {
  connection.disconnectSync?.();
  connection.closeSync?.();
  instance.closeSync?.();
}

export async function summarizeUsage(
  sessionsDirectory,
  date,
  databasePath = path.join(os.homedir(), ".pi", "agent", "pi-usage.duckdb"),
  runtimeDirectory = path.join(os.homedir(), ".pi", "agent", "pi-usage-runtime"),
) {
  const range = dateRange(date);
  const { events, activityEvents } = collectUsageEvents(sessionsDirectory);
  const duration = calculateDuration(activityEvents, range);
  const directories = [
    ...new Set(events.filter((event) => event.eventDate === range.date).map((event) => event.cwd).filter(Boolean)),
  ];
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const duckdb = await loadDuckDb(runtimeDirectory);
  const instance = await duckdb.DuckDBInstance.create(databasePath);
  const connection = await instance.connect();
  try {
    await initializeDatabase(connection);
    await refreshUsageEvents(connection, events);
    await refreshDurationSummary(connection, range, duration);
    await refreshCodeChanges(connection, range, directories);
    return await readSummary(connection, range);
  } finally {
    await closeDatabase(connection, instance);
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCost(value) {
  return `$${value.toFixed(4)}`;
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

function paint(value, code, enabled) {
  return enabled ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function supportsColor() {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb");
}

function formatTable(rows, headers, alignments = []) {
  const values = rows.map((row) => row.map(String));
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...values.map((row) => row[index].length)),
  );
  const line = (row) =>
    row
      .map((value, index) => {
        if (index === row.length - 1) return value;
        const align = alignments[index] ?? (index === 0 ? "left" : "right");
        return align === "left" ? value.padEnd(widths[index]) : value.padStart(widths[index]);
      })
      .join("  ");
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...values.map(line)].join("\n");
}

function formatUsageTable(rows) {
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
    ]),
    ["Model", "Calls", "Input", "Output", "Cache R", "Cache W", "Total", "Cost"],
  );
}

function displayRepository(repository) {
  const normalized = repository.replaceAll("\\\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : normalized;
}

function codeChangeRow(change) {
  return [
    change.repository === "Total" ? "Total" : displayRepository(change.repository),
    formatNumber(change.commits),
    `${formatNumber(change.committedFiles)} files +${formatNumber(change.committedInsertions)}/-${formatNumber(change.committedDeletions)}`,
    `${formatNumber(change.uncommittedFiles)} files +${formatNumber(change.uncommittedInsertions)}/-${formatNumber(change.uncommittedDeletions)}`,
  ];
}

function formatCodeChanges(changes, color) {
  if (changes.length === 0) return [paint("Git changes", "35;1", color), "No repositories found."].join("\n");
  const total = changes.reduce(
    (result, change) => {
      for (const field of [
        "commits",
        "committedFiles",
        "committedInsertions",
        "committedDeletions",
        "uncommittedFiles",
        "uncommittedInsertions",
        "uncommittedDeletions",
      ]) {
        result[field] += change[field];
      }
      return result;
    },
    {
      commits: 0,
      committedFiles: 0,
      committedInsertions: 0,
      committedDeletions: 0,
      uncommittedFiles: 0,
      uncommittedInsertions: 0,
      uncommittedDeletions: 0,
    },
  );
  return [
    paint("Git changes", "35;1", color),
    formatTable(
      [...changes, { repository: "Total", ...total }].map(codeChangeRow),
      ["Repository", "Commits", "Selected-day commits", "Current working tree"],
      ["left", "right", "left", "left"],
    ),
    "Selected-day commits; working tree = current tracked uncommitted diff.",
  ].join("\n");
}

export function formatReport(summary, options = {}) {
  const color = options.color ?? false;
  const total = summary.rows.reduce((result, row) => {
    for (const field of ["calls", ...FIELDS, "tokens", "cost"]) result[field] += row[field];
    return result;
  }, emptyUsage());
  const usage = summary.rows.length
    ? formatUsageTable([...summary.rows, { model: "Total", ...total }])
    : "No usage recorded.";
  const duration = summary.duration ?? {
    activeSeconds: 0,
    modelWaitSeconds: 0,
    sessionSpanSeconds: 0,
  };
  return [
    paint(`Pi usage · ${summary.date}`, "36;1", color),
    `${summary.sessions} session${summary.sessions === 1 ? "" : "s"}`,
    "",
    paint("Models", "34;1", color),
    usage,
    "",
    `${paint("Time", "32;1", color)}  Active ${paint(formatDuration(duration.activeSeconds), "32", color)} · Model wait ${paint(formatDuration(duration.modelWaitSeconds), "33", color)} · Session span ${formatDuration(duration.sessionSpanSeconds)}`,
    "",
    formatCodeChanges(summary.codeChanges ?? [], color),
  ].join("\n");
}

function parseArguments(args, agentDir) {
  let date;
  let databasePath = process.env.PI_USAGE_DB || path.join(agentDir, "pi-usage.duckdb");
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--db") {
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
  return { date, databasePath };
}

async function main() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const { date, databasePath } = parseArguments(process.argv.slice(2), agentDir);
  const sessionsDirectory = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDir, "sessions");
  if (process.stderr.isTTY) console.error("正在扫描 session、更新 DuckDB 和 Git 统计...");
  const summary = await summarizeUsage(
    sessionsDirectory,
    date,
    databasePath,
    path.join(agentDir, "pi-usage-runtime"),
  );
  console.log(formatReport(summary, { color: supportsColor() }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
