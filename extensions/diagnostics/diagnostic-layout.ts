import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
  diagnosticLocation, isDiagnosticSessionKey, SIDECAR_LIMIT, DIAGNOSTIC_BASE as base,
  DIAGNOSTIC_STREAMS as streams, DIAGNOSTIC_FILENAME as filenamePattern, DIAGNOSTIC_ENTRY_LIMIT,
} from "../../src/diagnostic-paths.ts";
import { diagnosticDirectory, diagnosticErrorCode, diagnosticFileInfo, withDiagnosticLock } from "./diagnostic-storage.ts";

export { diagnosticKeys, diagnosticLocation, isDiagnosticSessionKey, DIAGNOSTIC_MAX_BYTES, SIDECAR_LIMIT } from "../../src/diagnostic-paths.ts";

type Location = ReturnType<typeof diagnosticLocation>;
export type DiagnosticFile = { path: string; sessionKey?: string; rotated: boolean; mtimeMs: number; size: number };

export async function withDiagnosticLocation<T>(location: Location, options: {
  create?: boolean; io?: typeof fs; current: () => boolean;
}, action: (root: string) => Promise<T>) {
  const io = options.io ?? fs;
  const root = await diagnosticDirectory(location.root, base, options.create ?? false, io);
  return withDiagnosticLock(root, async () => {
    if (!options.current() || await diagnosticDirectory(location.root, base, false, io) !== root) {
      throw Object.assign(new Error("诊断存储或会话范围已变化"), { code: "DIAGNOSTIC_SCOPE_CHANGED" });
    }
    return action(root);
  }, io, location.lock);
}

async function optional<T>(read: () => Promise<T>) {
  try { return await read(); }
  catch (error) { if (diagnosticErrorCode(error) !== "ENOENT") throw error; }
}

function quotaError() {
  return Object.assign(new Error("诊断侧车达到留存或扫描上限，需显式清理后恢复"), { code: "DIAGNOSTIC_QUOTA_EXCEEDED" });
}

async function* boundedEntries(directory: string, io: typeof fs) {
  const entries = await io.opendir(directory);
  let count = 0;
  for await (const entry of entries) {
    if (++count > DIAGNOSTIC_ENTRY_LIMIT) throw quotaError();
    yield entry;
  }
}

// Only run admission discovery for a new stream, under the shared Agent lock.
// Each stream reserves both rotation slots; separately bound even empty project dirs.
async function admitSidecar(root: string, directoryExists: boolean, io: typeof fs) {
  let streamCount = 0, directoryCount = 0;
  for (const group of Object.values(streams)) {
    const directory = await optional(() => diagnosticDirectory(root, [group], false, io));
    if (!directory) continue;
    for await (const project of boundedEntries(directory, io)) {
      if (!isDiagnosticSessionKey(project.name)) continue;
      if (++directoryCount > SIDECAR_LIMIT) throw quotaError();
      const projectDirectory = await diagnosticDirectory(directory, [project.name], false, io);
      const keys = new Set<string>();
      for await (const file of boundedEntries(projectDirectory, io)) {
        const key = filenamePattern.exec(file.name)?.[1];
        if (key && !keys.has(key)) {
          keys.add(key);
          if (++streamCount >= SIDECAR_LIMIT) throw quotaError();
        }
      }
    }
  }
  if (!directoryExists && directoryCount >= SIDECAR_LIMIT) throw quotaError();
}

// Call while holding the shared lock; neither probe nor append may skip admission.
export async function writableDiagnosticFile(location: Location, root: string, io: typeof fs = fs) {
  if (!location.name) throw new Error("Missing diagnostic stream name");
  const parts = location.parts.slice(base.length);
  if (!parts.length) return join(root, location.name);
  const directory = await optional(() => diagnosticDirectory(root, parts, false, io));
  const file = directory && join(directory, location.name);
  if (file && (await diagnosticFileInfo(file, io) || await diagnosticFileInfo(file + ".1", io))) return file;
  await admitSidecar(root, directory !== undefined, io);
  return join(directory ?? await diagnosticDirectory(root, parts, true, io), location.name);
}

export async function findDiagnosticFiles(location: Location, root: string): Promise<DiagnosticFile[]> {
  const directory = await optional(() => diagnosticDirectory(root, location.parts.slice(base.length)));
  if (!directory) return [];
  const files: DiagnosticFile[] = [];
  async function add(name: string) {
    const path = join(directory!, name);
    const info = await diagnosticFileInfo(path, fs);
    if (info) files.push({ path, sessionKey: filenamePattern.exec(name)?.[1], rotated: name.endsWith(".1"), mtimeMs: info.mtimeMs, size: info.size });
  }
  if (location.name) {
    await add(location.name + ".1");
    await add(location.name);
  } else {
    for await (const entry of boundedEntries(directory, fs)) {
      if (filenamePattern.test(entry.name)) await add(entry.name);
    }
  }
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs || Number(b.rotated) - Number(a.rotated) || a.path.localeCompare(b.path));
}

// Reports and export read the most recent bounded window, never the entire store.
export function recentDiagnosticFiles(files: DiagnosticFile[], maxBytes: number) {
  let remaining = 8 * 1024 * 1024;
  const selected: DiagnosticFile[] = [];
  for (let index = files.length - 1; index >= 0; index--) {
    const file = files[index];
    if (file.size > maxBytes || file.size > remaining || selected.length >= 16) break;
    remaining -= file.size;
    selected.push(file);
  }
  return { files: selected.reverse(), limited: selected.length < files.length };
}

export async function removeEmptyDiagnosticProject(location: Location, root: string) {
  if (location.scope === "global") return;
  const directory = await optional(() => diagnosticDirectory(root, location.parts.slice(base.length)));
  if (directory) await fs.rmdir(directory).catch(error => {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(diagnosticErrorCode(error))) throw error;
  });
}
