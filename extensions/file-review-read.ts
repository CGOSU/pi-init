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

/** Returns only complete, unmodified lines. A single oversized line is never credited. */
export async function readReviewPage(
  projectRoot: string,
  input: Record<string, unknown>,
): Promise<ReadPage | ReadFailure> {
  if (typeof input.path !== "string" || !input.path.trim()) {
    return { ok: false, code: "INVALID_PATH", message: "read 需要非空代码文件路径。" };
  }
  const offset = input.offset === undefined ? 1 : input.offset;
  const limit = input.limit === undefined ? FILE_REVIEW_READ_DEFAULT_LINES : input.limit;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 1
    || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > FILE_REVIEW_READ_MAX_LINES) {
    return { ok: false, code: "INVALID_PAGINATION", message: `read 的 offset 为从 1 开始的安全整数，limit 为 1-${FILE_REVIEW_READ_MAX_LINES} 的整数。` };
  }
  const inspected = await inspectProjectFile(projectRoot, input.path);
  if (!inspected.ok) return { ok: false, ...inspected.error };
  const { file, content } = inspected;
  if (input.fingerprint !== undefined && input.fingerprint !== file.fingerprint) {
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
