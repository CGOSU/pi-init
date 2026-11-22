import { readdirSync, realpathSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../role/role-context-protocol.ts";
import type { HandoffResult } from "../../src/general-session-handoff.ts";

export function readHandoffArchive(file: string, root: string, sessionId: string): HandoffResult<SessionManager> {
  const fail = (code: string, message: string): HandoffResult<never> => ({ ok: false, code, message });
  try {
    const stats = statSync(file);
    if (!stats.isFile()) return fail("FILE_TYPE", "来源不是普通session文件");
    if (stats.size === 0) return fail("EMPTY", "来源session文件为空");
    const text = readFileSync(file, "utf8");
    let entries;
    try { entries = text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line)); }
    catch { return fail("PARSE", "session JSONL解析失败，可能尚未完整保存"); }
    const header = entries[0];
    if (!isRecord(header) || header.type !== "session" || header.id !== sessionId || typeof header.cwd !== "string") return fail("IDENTITY", "来源session身份不匹配");
    if (realpathSync(header.cwd) !== root) return fail("PROJECT", "来源session项目不匹配");
    return { ok: true, value: SessionManager.inMemory(root, undefined, entries) };
  } catch (error) { return fail("PERSISTENCE", "无法读取session文件：" + String(error)); }
}

const TARGET_SCAN_MAX_FILES = 500;
const TARGET_SCAN_MAX_BYTES = 64 * 1024 * 1024;
export type TransferTargetScan = { found: string; incomplete?: undefined } | { found?: undefined; incomplete?: string };
/**
 * Pi creates a replacement session next to its source, and target setup writes a user message, so a
 * target that received a transfer is persisted in the source's directory with this incoming record.
 */
export function findTransferTarget(sourceFile: string, customType: string, intentId: string): TransferTargetScan {
  const directory = dirname(sourceFile);
  let names: string[];
  try { names = readdirSync(directory).filter(name => name.endsWith(".jsonl")); }
  catch (error) { return { incomplete: "无法列出会话目录：" + String(error) }; }
  if (names.length > TARGET_SCAN_MAX_FILES) return { incomplete: `会话目录超过 ${TARGET_SCAN_MAX_FILES} 个文件，未逐一检查` };
  const unread: string[] = [];
  const source = realpathSync(sourceFile);
  for (const name of names) {
    const file = join(directory, name);
    try {
      if (realpathSync(file) === source) continue;
      const stats = statSync(file);
      if (!stats.isFile() || stats.size > TARGET_SCAN_MAX_BYTES) { unread.push(name); continue; }
      const text = readFileSync(file, "utf8");
      if (!text.includes(intentId)) continue;
      for (const line of text.split("\n")) {
        if (!line.includes(intentId)) continue;
        let entry: unknown;
        try { entry = JSON.parse(line); } catch { unread.push(name); continue; }
        if (isRecord(entry) && entry.type === "custom" && entry.customType === customType
          && isRecord(entry.data) && entry.data.kind === "incoming" && entry.data.id === intentId) return { found: file };
      }
    } catch { unread.push(name); }
  }
  return unread.length ? { incomplete: `${unread.length} 个会话文件无法读取或解析：${unread.slice(0, 3).join("、")}` } : {};
}

const ARCHIVE_CACHE_LIMIT = 4;
const archiveCache = new Map<string, { stamp: string; value: SessionManager }>();
/**
 * readHandoffArchive for repeated read-only lookups (historical evidence). The manager is shared
 * between calls and must not be modified; any change to the file's identity, size or mtime re-reads it.
 * Transfer safety checks keep using the uncached reader.
 */
export function readHandoffArchiveCached(file: string, root: string, sessionId: string): HandoffResult<SessionManager> {
  let stamp: string;
  try { const stats = statSync(file); stamp = [stats.dev, stats.ino, stats.size, stats.mtimeMs].join(":"); }
  catch { return readHandoffArchive(file, root, sessionId); }
  const key = JSON.stringify([file, root, sessionId]);
  const hit = archiveCache.get(key);
  archiveCache.delete(key);
  if (hit?.stamp === stamp) { archiveCache.set(key, hit); return { ok: true, value: hit.value }; }
  const result = readHandoffArchive(file, root, sessionId);
  if (result.ok) {
    archiveCache.set(key, { stamp, value: result.value });
    for (const oldest of archiveCache.keys()) { if (archiveCache.size <= ARCHIVE_CACHE_LIMIT) break; archiveCache.delete(oldest); }
  }
  return result;
}

type ReplacementContext = Parameters<NonNullable<NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>["withSession"]>>[0];

/** One replacement lifecycle for both background and workflow transfers. Never use the old context after replacement. */
export async function replaceHandoffSession(ctx: ExtensionCommandContext, options: {
  sourceFile: string;
  setup: (manager: SessionManager) => Promise<void> | void;
  activate: (ctx: ReplacementContext) => Promise<void>;
  cancel: () => void;
  uncertain: () => void;
}) {
  let setupRan = false;
  let activated = false;
  try {
    const result = await ctx.newSession({
      parentSession: options.sourceFile,
      setup: async manager => { setupRan = true; await options.setup(manager); },
      withSession: async next => { await options.activate(next); activated = true; },
    });
    if (result.cancelled && !setupRan) { options.cancel(); return; }
    if (!setupRan || !activated) options.uncertain();
  } catch { options.uncertain(); }
}
