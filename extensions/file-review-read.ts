import { inspectProjectFile, type FileSnapshot } from "../src/file-review.ts";

export const FILE_REVIEW_READ_DEFAULT_LINES = 100;
export const FILE_REVIEW_READ_MAX_LINES = 200;
export const FILE_REVIEW_READ_MAX_BYTES = 16 * 1024;

type ReadFailure = { ok: false; code: string; message: string };
type ReadPage = {
  ok: true;
  file: FileSnapshot;
  text: string;
  offset: number;
  endLine: number;
  nextOffset: number | null;
  eof: boolean;
  outputBytes: number;
  byteLimited: boolean;
};

export function parseReviewTarget(input: Record<string, unknown>, requireFingerprint: boolean):
  { ok: true; path: string; fingerprint: string | undefined } | ReadFailure {
  if (input.path === undefined) return { ok: false, code: "MISSING_PATH", message: "read/complete 必须提供 path。" };
  if (typeof input.path !== "string") return { ok: false, code: "INVALID_PATH_TYPE", message: "path 必须是字符串。" };
  if (!input.path.trim()) return { ok: false, code: "EMPTY_PATH", message: "path 不能是空字符串或纯空白。" };
  const fingerprint = input.fingerprint;
  if (fingerprint === undefined) {
    if (requireFingerprint) return { ok: false, code: "MISSING_FINGERPRINT", message: "complete 必须提供当前 fingerprint；从 read/list 结果获取，且须读全该版本原文。" };
  } else {
    if (typeof fingerprint !== "string") return { ok: false, code: "INVALID_FINGERPRINT_TYPE", message: "fingerprint 必须是字符串。" };
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) return { ok: false, code: "INVALID_FINGERPRINT_FORMAT", message: "fingerprint 必须是工具返回的 64 位小写十六进制 SHA-256。" };
  }
  return { ok: true, path: input.path, fingerprint };
}

/** Returns only complete, unmodified lines. A single oversized line is never credited. */
export async function readReviewPage(
  projectRoot: string,
  input: Record<string, unknown>,
): Promise<ReadPage | ReadFailure> {
  const target = parseReviewTarget(input, false);
  if (!target.ok) return target;
  const offset = input.offset === undefined ? 1 : input.offset;
  const limit = input.limit === undefined ? FILE_REVIEW_READ_DEFAULT_LINES : input.limit;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 1
    || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > FILE_REVIEW_READ_MAX_LINES) {
    return { ok: false, code: "INVALID_PAGINATION", message: `read 的 offset 为从 1 开始的安全整数，limit 为 1-${FILE_REVIEW_READ_MAX_LINES} 的整数。` };
  }
  const inspected = await inspectProjectFile(projectRoot, target.path);
  if (!inspected.ok) return { ok: false, ...inspected.error };
  const { file, content } = inspected;
  if (target.fingerprint !== undefined && target.fingerprint !== file.fingerprint) {
    return { ok: false, code: "STALE_VERSION", message: "文件指纹已变化；请从最新版本重新读取。" };
  }
  if (file.lineCount === 0 && offset === 1) {
    return { ok: true, file, text: "", offset, endLine: 0, nextOffset: null, eof: true, outputBytes: 0, byteLimited: false };
  }
  if (offset > file.lineCount) {
    return { ok: false, code: "OFFSET_OUT_OF_RANGE", message: `offset 超出文件行数 ${file.lineCount}。` };
  }
  // Match countPhysicalLines, preserving CRLF, CR, LF and a final unterminated line.
  const lines = content.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  const selected: string[] = [];
  let outputBytes = 0;
  let byteLimited = false;
  for (let index = offset - 1; index < Math.min(lines.length, offset - 1 + limit); index += 1) {
    const line = lines[index];
    const bytes = Buffer.byteLength(line, "utf8");
    if (outputBytes + bytes > FILE_REVIEW_READ_MAX_BYTES) {
      byteLimited = true;
      break;
    }
    selected.push(line);
    outputBytes += bytes;
  }
  if (selected.length === 0) {
    return { ok: false, code: "LINE_TOO_LONG", message: `第 ${offset} 行超过 ${FILE_REVIEW_READ_MAX_BYTES} UTF-8 字节上限；未返回截断行，未登记覆盖。` };
  }
  const endLine = offset + selected.length - 1;
  const eof = endLine === file.lineCount;
  return { ok: true, file, text: selected.join(""), offset, endLine,
    nextOffset: eof ? null : endLine + 1, eof, outputBytes, byteLimited };
}
