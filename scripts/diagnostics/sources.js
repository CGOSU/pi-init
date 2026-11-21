import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import { DIAGNOSTIC_MAX_BYTES } from "../../src/diagnostic-paths.ts";

export const SOURCE_LIMITS = Object.freeze({ files: 32, fileBytes: 64 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024, lineBytes: 2 * 1024 * 1024, records: 100000 });

// Capture only the byte range present when each file is opened. This is an
// offline read, not a lock on Pi's writer or an atomic snapshot of all sources.
export async function readSources(inputs, limits = SOURCE_LIMITS) {
  if (!inputs.length || inputs.length > limits.files) throw new Error(`请指定 1–${limits.files} 个日志文件`);
  const sources = [];
  const unavailable = [];
  const records = { runtime: [], session: [], handoff: [] };
  let totalBytes = 0;
  let recordCount = 0;
  for (const [index, input] of inputs.entries()) {
    if (!Object.hasOwn(records, input.kind)) throw new Error("不支持的日志来源类型");
    const sourceId = `source-${index + 1}`;
    const path = resolve(input.path);
    let sample;
    try { sample = await captureSource(path, input.managed, sourceId, limits, totalBytes); }
    catch (error) {
      if (!input.managed) throw error;
      unavailable.push({ sourceId, kind: input.kind, path, code: safeCode(error) });
      continue;
    }
    const { before, after, captured } = sample;
    totalBytes += before.size;
    const length = captured.length;
    const manifest = { sourceId, kind: input.kind, path, selection: input.managed ? "discovered" : "explicit",
      capturedAt: new Date().toISOString(),
      sha256: createHash("sha256").update(captured).digest("hex"),
      byteRange: { start: 0, endExclusive: length }, sizeAtOpen: before.size,
      sizeAfterRead: after.size, modifiedAtOpen: before.mtime.toISOString(),
      changedDuringRead: before.size !== after.size || before.mtimeMs !== after.mtimeMs || length !== before.size,
      unterminatedTail: length > 0 && captured[length - 1] !== 10,
      lines: 0, parsed: 0, invalidLines: 0, oversizedLines: 0, omittedRecords: 0,
      problemLines: [] };
    let start = 0;
    while (start < length) {
      let end = captured.indexOf(10, start);
      if (end < 0) end = length;
      const line = ++manifest.lines;
      const lineBytes = captured.subarray(start, end);
      start = end + 1;
      if (lineBytes.length > limits.lineBytes) {
        manifest.oversizedLines++;
        if (manifest.problemLines.length < 32) manifest.problemLines.push(line);
        continue;
      }
      const text = lineBytes.toString("utf8").trim();
      if (!text) continue;
      if (recordCount >= limits.records) { manifest.omittedRecords++; continue; }
      try {
        const row = JSON.parse(text);
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("record");
        records[input.kind].push({ row, sourceId, line });
        manifest.parsed++; recordCount++;
      } catch {
        manifest.invalidLines++;
        if (manifest.problemLines.length < 32) manifest.problemLines.push(line);
      }
    }
    sources.push(manifest);
  }
  return { sources, records, unavailable };
}

function checkManaged(info, expected) {
  if (!info.isFile() || info.nlink !== 1 || info.dev !== expected.dev || info.ino !== expected.ino) {
    throw Object.assign(new Error("发现的诊断文件已变化或不是独立普通文件"), { code: "UNSAFE_OR_CHANGED_SOURCE" });
  }
}

async function captureSource(path, managed, sourceId, limits, usedBytes) {
  if (managed) checkManaged(await lstat(path), managed);
  let file;
  try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    throw Object.assign(new Error(`${sourceId} 无法读取（${safeCode(error)}）`), managed ? { code: safeCode(error) } : {});
  }
  try {
    const before = await file.stat();
    if (managed) checkManaged(before, managed);
    if (!before.isFile()) throw new Error(`${sourceId} 必须是普通文件`);
    const maxBytes = managed ? Math.min(limits.fileBytes, DIAGNOSTIC_MAX_BYTES) : limits.fileBytes;
    if (before.size > maxBytes || usedBytes + before.size > limits.totalBytes) {
      throw Object.assign(new Error(`${sourceId} 超过采集字节上限；请指定更小的日志样本`),
        managed ? { code: "DIAGNOSTIC_BYTE_LIMIT" } : {});
    }
    const bytes = Buffer.alloc(before.size);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await file.stat();
    if (managed) checkManaged(after, managed);
    return { before, after, captured: bytes.subarray(0, length) };
  } finally { await file.close(); }
}

export function safeCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : "READ_FAILED";
}
