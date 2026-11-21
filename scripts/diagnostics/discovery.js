import { lstat, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  diagnosticKeys, diagnosticLocation, diagnosticProjectKey, DIAGNOSTIC_ENTRY_LIMIT,
  DIAGNOSTIC_FILENAME, DIAGNOSTIC_MAX_BYTES,
} from "../../src/diagnostic-paths.ts";
import { safeCode, SOURCE_LIMITS } from "./sources.js";

const units = Object.freeze({ m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 });

export function parseSince(value) {
  const match = /^([1-9][0-9]*)([mhdw])$/.exec(value);
  const durationMs = match ? Number(match[1]) * units[match[2]] : NaN;
  if (!Number.isSafeInteger(durationMs) || durationMs > 8.64e15) {
    return { ok: false, code: "INVALID_SINCE", message: "--since 需要正整数和 m/h/d/w 单位，例如 48h 或 7d" };
  }
  return { ok: true, value: durationMs };
}

// Match the standard Pi agent root and its supported local path forms without loading the SDK.
function agentRoot() {
  let path = process.env.PI_CODING_AGENT_DIR;
  if (!path) return join(homedir(), ".pi", "agent");
  if (process.platform === "win32" && !path.includes("\\")) {
    const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
    if (drive) path = `${drive[1].toUpperCase()}:\\${(drive[2] ?? "").replaceAll("/", "\\")}`;
  }
  if (path === "~") return homedir();
  if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) return join(homedir(), path.slice(2));
  return /^file:\/\//.test(path) ? fileURLToPath(path) : resolve(path);
}

function discoveryError(code) { return Object.assign(new Error(code), { code }); }

async function managedDirectory(root, parts) {
  let directory = await realpath(root);
  for (const part of parts) {
    directory = join(directory, part);
    if (!(await lstat(directory)).isDirectory()) throw discoveryError("UNSAFE_DIAGNOSTIC_PATH");
  }
  return directory;
}

async function* segmentNames(directory, name) {
  if (name) {
    yield name + ".1";
    yield name;
    return;
  }
  let count = 0;
  for await (const entry of await opendir(directory)) {
    if (++count > DIAGNOSTIC_ENTRY_LIMIT) throw discoveryError("DIAGNOSTIC_SCAN_LIMIT");
    if (DIAGNOSTIC_FILENAME.test(entry.name)) yield entry.name;
  }
}

async function discoverStream(root, options, sessionKey, cutoff, scope, kind) {
  const location = diagnosticLocation(root, scope, options.project, sessionKey);
  const stream = { kind, directory: "present", candidates: 0, excludedByTime: 0, selected: 0, omittedByBudget: 0, warnings: {} };
  const candidates = [];
  function warn(code) { stream.warnings[code] = (stream.warnings[code] ?? 0) + 1; }
  let directory;
  try { directory = await managedDirectory(location.root, location.parts); }
  catch (error) {
    stream.directory = error?.code === "ENOENT" ? "missing" : "unavailable";
    if (stream.directory === "unavailable") warn(safeCode(error));
    return { candidates, stream };
  }
  try {
    for await (const name of segmentNames(directory, location.name)) {
      const path = join(directory, name);
      try {
        const info = await lstat(path);
        stream.candidates++;
        if (!info.isFile() || info.nlink !== 1) warn("UNSAFE_DIAGNOSTIC_PATH");
        else if (info.mtimeMs < cutoff) stream.excludedByTime++;
        else if (info.size > DIAGNOSTIC_MAX_BYTES) warn("DIAGNOSTIC_TOO_LARGE");
        else candidates.push({ kind, path, managed: { dev: info.dev, ino: info.ino }, mtimeMs: info.mtimeMs,
          rotated: name.endsWith(".1"), stream });
      } catch (error) {
        // Missing filenames are normal for an exact session lookup. A listed file disappearing is a gap.
        if (!location.name || error?.code !== "ENOENT") warn(safeCode(error));
      }
    }
  } catch (error) {
    stream.directory = "incomplete";
    warn(safeCode(error));
    // Directory iteration order isn't a valid fallback when the scan limit is reached.
    candidates.length = 0;
  }
  return { candidates, stream };
}

export async function discoverDiagnosticSources(options, explicitCount) {
  const root = agentRoot();
  const projectKey = diagnosticProjectKey(options.project);
  const sessionKey = options.sessionId === undefined ? undefined : diagnosticKeys(options.project, options.sessionId).sessionKey;
  const cutoff = options.sinceMs === undefined ? -Infinity : Date.now() - options.sinceMs;
  const results = await Promise.all([
    discoverStream(root, options, sessionKey, cutoff, "project", "runtime"),
    discoverStream(root, options, sessionKey, cutoff, "handoff", "handoff"),
  ]);
  const candidates = results.flatMap(result => result.candidates).sort((a, b) =>
    b.mtimeMs - a.mtimeMs || Number(a.rotated) - Number(b.rotated) || a.path.localeCompare(b.path));
  const inputs = [];
  for (const { kind, path, managed, stream } of candidates) {
    if (inputs.length + explicitCount >= SOURCE_LIMITS.files) stream.omittedByBudget++;
    else {
      stream.selected++;
      inputs.push({ kind, path, managed });
    }
  }
  return { inputs: inputs.reverse(), selection: {
    projectKey, sessionKey, since: Number.isFinite(cutoff) ? new Date(cutoff).toISOString() : null,
    timeBasis: "file-mtime", maxEntriesPerStream: DIAGNOSTIC_ENTRY_LIMIT, maxSegmentBytes: DIAGNOSTIC_MAX_BYTES,
    streams: results.map(result => result.stream),
  } };
}
