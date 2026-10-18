import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_FILES = 16;

export function fingerprint(value: unknown) {
    try {
        return value === undefined ? undefined : createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
      } catch {
        return undefined;
      }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function fileSummary(cwd: string, input: Record<string, unknown>, inspect: boolean) {
  const path = input.path;
  if (typeof path !== "string") return {};
  const absolute = resolve(cwd, path);
  const local = relative(cwd, absolute);
  const outside = isAbsolute(local) || local === ".." || local.startsWith(".." + sep);
  const summary: Record<string, unknown> = outside ? { pathHash: fingerprint(absolute), outsideProject: true } : { path: local.split(sep).join("/") || "." };
  for (const key of ["offset", "limit"]) {
    if (typeof input[key] === "number" && Number.isFinite(input[key])) summary[key] = input[key];
  }
  if (typeof summary.path === "string" && summary.path.length > 256) {
    delete summary.path;
    summary.pathHash = fingerprint(absolute);
  }
  if (Array.isArray(input.ranges)) {
    summary.ranges = input.ranges.slice(0, MAX_FILES).map(value => {
      const range = record(value);
      return { start: typeof range.start === "number" ? range.start : undefined, end: typeof range.end === "number" ? range.end : undefined };
    });
    summary.rangesTruncated = input.ranges.length > MAX_FILES;
  }
  if (!inspect || outside) return summary;
  try {
    const info = await stat(absolute, { bigint: true });
    summary.versionKind = "stat";
    summary.version = fingerprint([info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String));
    summary.bytes = Number(info.size);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    summary.statCode = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "UNKNOWN";
  }
  return summary;
}

export async function summarizeToolInput(cwd: string, value: unknown, inspectFiles = false) {
  const input = record(value);
  const summary: Record<string, unknown> = { inputHash: fingerprint(value) };
  if (typeof input.command === "string") summary.commandHash = fingerprint(input.command);
  if (typeof input.timeout === "number" && Number.isFinite(input.timeout)) summary.timeout = input.timeout;
  if (typeof input.action === "string" && /^[a-z][a-z-]{0,63}$/.test(input.action)) summary.action = input.action;
  if (Array.isArray(input.edits)) summary.editCount = input.edits.length;
  const files = typeof input.path === "string" ? [input] : Array.isArray(input.files) ? input.files.map(record).filter(file => typeof file.path === "string") : [];
  if (files.length) {
    summary.files = await Promise.all(files.slice(0, MAX_FILES).map(file => fileSummary(cwd, file, inspectFiles)));
    summary.fileCount = files.length;
    summary.filesTruncated = files.length > MAX_FILES;
  }
  return summary;
}

export function summarizeToolResult(value: unknown) {
  const result = record(value);
  const details = result.details === undefined ? record(result.structuredContent) : record(result.details);
  const summary: Record<string, unknown> = { outputHash: fingerprint(result.content) };
  if (result.isError === true) summary.errorHash = summary.outputHash;
  if (Array.isArray(result.content)) {
    summary.contentParts = result.content.length;
    summary.textChars = result.content.reduce((total, item) => total + (typeof record(item).text === "string" ? (record(item).text as string).length : 0), 0);
  }
  if (typeof details.exitCode === "number") summary.exitCode = details.exitCode;
  if (typeof details.ok === "boolean") summary.businessOk = details.ok;
  if (typeof details.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(details.code)) summary.code = details.code;
  const truncation = record(details.truncation);
  for (const key of ["outputLines", "totalLines", "outputBytes", "totalBytes", "truncated", "lastLinePartial"]) {
    const item = truncation[key];
    if (typeof item === "number" || typeof item === "boolean") summary[key] = item;
  }
  return summary;
}
