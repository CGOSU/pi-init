import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type DiagnosticScope = "project" | "global" | "handoff";
export type DiagnosticResumeResult =
  | { ok: true; value: { alreadyEnabled: boolean } }
  | { ok: false; code: string; message: string; causeCode?: string };

export function captureDiagnosticScope(ctx: ExtensionContext) {
  return { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId?.() };
}
export function matchesDiagnosticScope(ctx: ExtensionContext, scope: ReturnType<typeof captureDiagnosticScope>) {
  return ctx.isProjectTrusted() && ctx.cwd === scope.cwd && ctx.sessionManager.getSessionId() === scope.sessionId
    && ctx.sessionManager.getLeafId?.() === scope.leafId;
}


export const diagnosticErrorCode = (error: unknown) => error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";

// All current writers and maintenance operations share this cross-process lock.
// Never steal a lock: an abandoned lock requires manual inspection.
export async function withDiagnosticLock<T>(directory: string, action: () => Promise<T>, io: typeof fs = fs): Promise<T> {
  const lock = join(directory, "runtime.lock");
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await io.mkdir(lock, { mode: 0o700 }); acquired = true; break; }
    catch (error) { if (diagnosticErrorCode(error) !== "EEXIST") throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (!acquired) throw Object.assign(new Error("诊断文件正在使用或存在遗留锁，请核对后再试"), { code: "DIAGNOSTIC_LOCK_BUSY" });
  try { return await action(); } finally { await io.rmdir(lock); }
}

// Resolve the configured root once; reject symlinks in all function-owned descendants.
export async function diagnosticDirectory(root: string, parts: string[], create = false, io: typeof fs = fs, mode = 0o700) {
  if (create) await io.mkdir(root, { recursive: true, mode });
  let directory = await io.realpath(root);
  for (const part of parts) {
    directory = join(directory, part);
    if (create) await io.mkdir(directory, { mode }).catch(error => { if (diagnosticErrorCode(error) !== "EEXIST") throw error; });
    const info = await io.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error("诊断目录不是普通目录，拒绝跟随链接"), { code: "UNSAFE_DIAGNOSTIC_PATH" });
  }
  return directory;
}

async function diagnosticFileInfo(file: string, io: typeof fs) {
  try {
    const info = await io.lstat(file);
    if (!info.isFile()) throw Object.assign(new Error("诊断文件不是普通文件，拒绝跟随链接"), { code: "UNSAFE_DIAGNOSTIC_PATH" });
    return info;
  } catch (error) { if (diagnosticErrorCode(error) !== "ENOENT") throw error; }
}

export async function probeDiagnosticFile(file: string, maxBytes: number, io: typeof fs = fs) {
  await diagnosticFileInfo(file, io);
  await diagnosticFileInfo(file + ".1", io);
  let handle = await io.open(file, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw Object.assign(new Error("诊断文件不是普通文件"), { code: "UNSAFE_DIAGNOSTIC_PATH" });
    if (info.size) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, info.size - 1);
      if (last[0] !== 10) {
        if (info.size >= maxBytes) {
          await handle.close();
          await io.rm(file + ".1", { force: true });
          await io.rename(file, file + ".1");
          handle = await io.open(file, constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
        } else await handle.writeFile("\n", "utf8");
      }
    }
  } finally { await handle.close(); }
}

export async function appendDiagnosticRecord(file: string, line: string, options: {
  maxBytes: number; retentionMs?: number; discardOversize?: boolean; now?: () => number; io?: typeof fs;
}) {
  const io = options.io ?? fs;
  const files = [file, file + ".1"];
  const infos = await Promise.all(files.map(path => diagnosticFileInfo(path, io)));
  let size = infos[0]?.size ?? 0;
  for (let index = 0; index < files.length; index++) {
    const info = infos[index];
    if (!info) continue;
    const expired = options.retentionMs !== undefined && (options.now ?? Date.now)() - info.mtimeMs > options.retentionMs;
    if (expired || options.discardOversize && info.size > options.maxBytes) {
      await io.unlink(files[index]);
      if (index === 0) size = 0;
    }
  }
  if (size + Buffer.byteLength(line) > options.maxBytes) {
    await io.rm(file + ".1", { force: true });
    if (size) await io.rename(file, file + ".1");
  }
  const handle = await io.open(file, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(line, "utf8"); } finally { await handle.close(); }
}

export async function readDiagnosticText(file: string, maxBytes: number) {
  const info = await fs.lstat(file);
  if (!info.isFile()) throw Object.assign(new Error("诊断文件不是普通文件"), { code: "UNSAFE_DIAGNOSTIC_PATH" });
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (!current.isFile()) throw Object.assign(new Error("诊断文件不是普通文件"), { code: "UNSAFE_DIAGNOSTIC_PATH" });
    if (current.size > maxBytes) throw Object.assign(new Error("诊断文件超过读取上限"), { code: "DIAGNOSTIC_TOO_LARGE" });
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw Object.assign(new Error("诊断文件超过读取上限"), { code: "DIAGNOSTIC_TOO_LARGE" });
    return buffer.toString("utf8", 0, length);
  } finally { await handle.close(); }
}
