import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";

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
