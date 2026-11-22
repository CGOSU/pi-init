import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeSync } from "node:fs";
import { mkdir, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { textOf } from "../../src/error-utils.ts";
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
const TARGET_SCAN_PREFIX_BYTES = 256 * 1024;
export type TransferTargetScan = { found: string; incomplete?: undefined } | { found?: undefined; incomplete?: string };
/**
 * Pi creates a replacement session next to its source, and target setup writes a user message, so a
 * target that received a transfer is persisted in the source's directory with this incoming record.
 */
export function findTransferTarget(sourceFile: string, customType: string, intentId: string): TransferTargetScan {
  const directory = dirname(sourceFile);
  let source: string;
  try { source = realpathSync(sourceFile); }
  catch (error) { return { incomplete: "无法核对来源会话文件：" + textOf(error) }; }
  let names: string[];
  try { names = readdirSync(directory).filter(name => name.endsWith(".jsonl")); }
  catch (error) { return { incomplete: "无法列出会话目录：" + textOf(error) }; }
  if (names.length > TARGET_SCAN_MAX_FILES) return { incomplete: `会话目录超过 ${TARGET_SCAN_MAX_FILES} 个文件，未逐一检查` };
  const unread: string[] = [];
  for (const name of names) {
    const file = join(directory, name);
    try {
      const stats = lstatSync(file);
      if (!stats.isFile() || stats.nlink !== 1) { unread.push(name); continue; }
      if (realpathSync(file) === source) continue;
      const targetBytes = Math.min(stats.size, TARGET_SCAN_PREFIX_BYTES);
      const buffer = Buffer.allocUnsafe(targetBytes);
      let bytesRead = 0;
      const fd = openSync(file, "r");
      try {
        while (bytesRead < targetBytes) {
          const chunk = readSync(fd, buffer, bytesRead, targetBytes - bytesRead, bytesRead);
          if (chunk === 0) break;
          bytesRead += chunk;
        }
      } finally { closeSync(fd); }
      let text = buffer.toString("utf8", 0, bytesRead);
      if (stats.size > bytesRead) {
        const lastNewline = text.lastIndexOf("\n");
        if (lastNewline < 0) { unread.push(name); continue; }
        text = text.slice(0, lastNewline);
      }
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

const TRANSFER_COORDINATION_DIR = ".pi-init-transfers";
const TRANSFER_DECISION_MAX_BYTES = 16 * 1024;
const TRANSFER_LOCK_ATTEMPTS = 100;
const TRANSFER_LOCK_DELAY_MS = 20;

export type TransferCoordinationKey = {
  sourceFile: string;
  customType: string;
  sourceSessionId: string;
  intentId: string;
};

export type TransferDecision =
  | { version: 1; customType: string; id: string; sourceSessionId: string; decision: "activated"; targetSessionId: string; targetFile?: string; decidedAt: number }
  | { version: 1; customType: string; id: string; sourceSessionId: string; decision: "cancelled"; decidedAt: number };

export type TransferDecisionReadResult =
  | { ok: true; decision?: TransferDecision }
  | { ok: false; code: string; message: string };

export type TransferDecisionCommitResult =
  | { ok: true; decision: TransferDecision }
  | { ok: false; code: string; message: string; existing?: TransferDecision };

type TransferDecisionPayload =
  | { decision: "activated"; targetSessionId: string; targetFile?: string }
  | { decision: "cancelled" };

function fsErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";
}

function resolveCoordinationPaths(key: TransferCoordinationKey) {
  const sourceReal = realpathSync(key.sourceFile);
  const coordDir = join(dirname(sourceReal), TRANSFER_COORDINATION_DIR);
  const digest = createHash("sha256")
    .update(JSON.stringify([key.customType, key.sourceSessionId, key.intentId]))
    .digest("hex");
  return {
    coordDir,
    lockPath: join(coordDir, `${digest}.lock`),
    decisionPath: join(coordDir, `${digest}.decision.json`),
  };
}

function ensureSafeCoordDir(coordDir: string, create: boolean): boolean {
  if (create) {
    try { mkdirSync(coordDir, { mode: 0o700 }); }
    catch (error) { if (fsErrorCode(error) !== "EEXIST") throw error; }
  }
  let info;
  try { info = lstatSync(coordDir); }
  catch (error) {
    if (!create && fsErrorCode(error) === "ENOENT") return false;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw Object.assign(new Error("交接协调目录不是普通目录，拒绝跟随链接"), { code: "UNSAFE_TRANSFER_LOCK_PATH" });
  }
  return true;
}

async function releaseTransferLock(lockPath: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await rmdir(lockPath); return; }
    catch (error) {
      const code = fsErrorCode(error);
      if (code === "ENOENT") return;
      if (attempt < 2 && (code === "EBUSY" || code === "EPERM")) {
        await new Promise(resolve => setTimeout(resolve, 15));
        continue;
      }
      return;
    }
  }
}

/** Cross-process per-intent mutual exclusion lock next to the persisted source session. */
export async function withTransferLock<T>(
  key: TransferCoordinationKey,
  action: () => Promise<T> | T,
  options?: { attempts?: number; delayMs?: number },
): Promise<T> {
  const { coordDir, lockPath } = resolveCoordinationPaths(key);
  ensureSafeCoordDir(coordDir, true);
  const attempts = Math.max(1, options?.attempts ?? TRANSFER_LOCK_ATTEMPTS);
  const delayMs = Math.max(1, options?.delayMs ?? TRANSFER_LOCK_DELAY_MS);
  let acquired = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await mkdir(lockPath, { mode: 0o700 }); acquired = true; break; }
    catch (error) { if (fsErrorCode(error) !== "EEXIST") throw error; }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  if (!acquired) {
    throw Object.assign(new Error("交接互斥锁正被占用或存在遗留锁，来源保持冻结：" + lockPath), { code: "TRANSFER_LOCK_BUSY" });
  }
  try { return await action(); }
  finally { await releaseTransferLock(lockPath); }
}

function parseTransferDecision(raw: unknown, key: TransferCoordinationKey): TransferDecision | undefined {
  if (!isRecord(raw) || raw.version !== 1 || raw.customType !== key.customType
    || raw.id !== key.intentId || raw.sourceSessionId !== key.sourceSessionId
    || typeof raw.decidedAt !== "number" || !Number.isFinite(raw.decidedAt)) return undefined;
  if (raw.decision === "cancelled") {
    if ("targetSessionId" in raw && raw.targetSessionId !== undefined) return undefined;
    return {
      version: 1,
      customType: raw.customType,
      id: raw.id,
      sourceSessionId: raw.sourceSessionId,
      decision: "cancelled",
      decidedAt: raw.decidedAt,
    };
  }
  if (raw.decision === "activated" && typeof raw.targetSessionId === "string" && raw.targetSessionId.length > 0
    && (raw.targetFile === undefined || (typeof raw.targetFile === "string" && raw.targetFile.length > 0))) {
    return {
      version: 1,
      customType: raw.customType,
      id: raw.id,
      sourceSessionId: raw.sourceSessionId,
      decision: "activated",
      targetSessionId: raw.targetSessionId,
      ...(raw.targetFile !== undefined ? { targetFile: raw.targetFile } : {}),
      decidedAt: raw.decidedAt,
    };
  }
  return undefined;
}

/** Read and verify the one-shot per-intent coordination decision record, failing closed on corruption or symlinks. */
export function readTransferDecision(key: TransferCoordinationKey): TransferDecisionReadResult {
  let paths;
  try {
    paths = resolveCoordinationPaths(key);
    if (!ensureSafeCoordDir(paths.coordDir, false)) return { ok: true, decision: undefined };
  } catch (error) {
    const code = fsErrorCode(error);
    return {
      ok: false,
      code: code === "UNSAFE_TRANSFER_LOCK_PATH" ? code : "TRANSFER_COORDINATION_UNAVAILABLE",
      message: "无法核对交接协调目录：" + textOf(error),
    };
  }
  let info;
  try { info = lstatSync(paths.decisionPath); }
  catch (error) {
    if (fsErrorCode(error) === "ENOENT") return { ok: true, decision: undefined };
    return { ok: false, code: "TRANSFER_DECISION_CORRUPT", message: "无法检查交接裁决文件：" + textOf(error) };
  }
  if (!info.isFile() || info.nlink !== 1) {
    return { ok: false, code: "UNSAFE_TRANSFER_LOCK_PATH", message: "交接裁决文件不是普通独立文件，拒绝跟随链接" };
  }
  try {
    const fd = openSync(paths.decisionPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const current = fstatSync(fd);
      if (!current.isFile() || current.nlink !== 1) {
        return { ok: false, code: "UNSAFE_TRANSFER_LOCK_PATH", message: "交接裁决文件不是普通独立文件" };
      }
      if (current.size > TRANSFER_DECISION_MAX_BYTES) {
        return { ok: false, code: "TRANSFER_DECISION_CORRUPT", message: "交接裁决文件超过大小上限" };
      }
      const buffer = Buffer.allocUnsafe(TRANSFER_DECISION_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const bytesRead = readSync(fd, buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > TRANSFER_DECISION_MAX_BYTES) {
        return { ok: false, code: "TRANSFER_DECISION_CORRUPT", message: "交接裁决文件超过大小上限" };
      }
      const parsed = parseTransferDecision(JSON.parse(buffer.toString("utf8", 0, length)), key);
      if (!parsed) return { ok: false, code: "TRANSFER_DECISION_CORRUPT", message: "交接裁决记录损坏或身份不匹配" };
      return { ok: true, decision: parsed };
    } finally { closeSync(fd); }
  } catch (error) {
    const code = fsErrorCode(error);
    return {
      ok: false,
      code: code === "UNSAFE_TRANSFER_LOCK_PATH" ? code : "TRANSFER_DECISION_CORRUPT",
      message: "交接裁决记录读取或解析失败：" + textOf(error),
    };
  }
}

function matchExistingDecision(existing: TransferDecisionReadResult, payload: TransferDecisionPayload): TransferDecisionCommitResult | undefined {
  if (!existing.ok) return existing;
  const current = existing.decision;
  if (!current) return undefined;
  if (payload.decision === "cancelled" && current.decision === "cancelled") return { ok: true, decision: current };
  if (payload.decision === "activated" && current.decision === "activated" && current.targetSessionId === payload.targetSessionId) {
    return { ok: true, decision: current };
  }
  return current.decision === "activated"
    ? { ok: false, code: "TRANSFER_ALREADY_ACTIVATED", message: "该交接已由目标会话激活：" + (current.targetFile ?? current.targetSessionId), existing: current }
    : { ok: false, code: "TRANSFER_ALREADY_CANCELLED", message: "来源交接已取消，禁止激活目标会话", existing: current };
}

/**
 * Atomically commit the immutable per-intent outcome (`activated` or `cancelled`).
 * Must be invoked while holding `withTransferLock(key)`.
 */
export function commitTransferDecision(key: TransferCoordinationKey, payload: TransferDecisionPayload): TransferDecisionCommitResult {
  const preCheck = matchExistingDecision(readTransferDecision(key), payload);
  if (preCheck) return preCheck;
  let paths;
  try {
    paths = resolveCoordinationPaths(key);
    ensureSafeCoordDir(paths.coordDir, true);
  } catch (error) {
    const code = fsErrorCode(error);
    return {
      ok: false,
      code: code === "UNSAFE_TRANSFER_LOCK_PATH" ? code : "TRANSFER_DECISION_PERSIST_FAILED",
      message: "无法准备交接协调目录：" + textOf(error),
    };
  }
  const decision: TransferDecision = payload.decision === "activated"
    ? {
      version: 1,
      customType: key.customType,
      id: key.intentId,
      sourceSessionId: key.sourceSessionId,
      decision: "activated",
      targetSessionId: payload.targetSessionId,
      ...(payload.targetFile ? { targetFile: payload.targetFile } : {}),
      decidedAt: Date.now(),
    }
    : {
      version: 1,
      customType: key.customType,
      id: key.intentId,
      sourceSessionId: key.sourceSessionId,
      decision: "cancelled",
      decidedAt: Date.now(),
    };
  const encoded = Buffer.from(JSON.stringify(decision) + "\n", "utf8");
  try {
    const fd = openSync(paths.decisionPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      let written = 0;
      while (written < encoded.length) {
        written += writeSync(fd, encoded, written, encoded.length - written);
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    return { ok: true, decision };
  } catch (error) {
    if (fsErrorCode(error) === "EEXIST") {
      return matchExistingDecision(readTransferDecision(key), payload)
        ?? { ok: false, code: "TRANSFER_DECISION_PERSIST_FAILED", message: "交接裁决文件并发创建冲突" };
    }
    return { ok: false, code: "TRANSFER_DECISION_PERSIST_FAILED", message: "写入交接裁决记录失败：" + textOf(error) };
  }
}

export type StalledCancelOutcome =
  | { ok: true }
  | { ok: false; level: "warning" | "error"; message: string };

/** Validate that the coordination record does not prohibit target activation for `targetSessionId`. */
export function verifyTargetActivationDecision(
  key: TransferCoordinationKey,
  targetSessionId: string,
): { ok: true } | { ok: false; message: string } {
  const existing = readTransferDecision(key);
  if (!existing.ok) return { ok: false, message: "交接互斥记录异常：" + existing.message };
  if (existing.decision?.decision === "cancelled") return { ok: false, message: "来源交接已取消，禁止激活目标会话" };
  if (existing.decision?.decision === "activated" && existing.decision.targetSessionId !== targetSessionId) {
    return { ok: false, message: "该交接已由其他目标会话激活：" + existing.decision.targetSessionId };
  }
  return { ok: true };
}

/** Check coordination record before user abandon confirmation or inside the cancel lock. */
export function preflightTransferAbandon(key: TransferCoordinationKey):
  | { status: "clear" | "already-cancelled" }
  | { status: "blocked"; level: "warning" | "error"; message: string } {
  const decision = readTransferDecision(key);
  if (!decision.ok) {
    return { status: "blocked", level: "error", message: `[TRANSFER_PENDING] 交接互斥记录异常，来源保持冻结：${decision.message}` };
  }
  if (decision.decision?.decision === "activated") {
    return {
      status: "blocked",
      level: "warning",
      message: `[TRANSFER_PENDING] 该交接已由目标会话激活（${decision.decision.targetFile ?? decision.decision.targetSessionId}）。请在该会话继续，不在来源放弃或重建。`,
    };
  }
  return { status: decision.decision?.decision === "cancelled" ? "already-cancelled" : "clear" };
}

/** Check sibling session directory for an existing or unverified target; fails closed on incomplete scan. */
export function scanTransferAbandonBlocker(key: TransferCoordinationKey): { level: "warning"; message: string } | undefined {
  const scan = findTransferTarget(key.sourceFile, key.customType, key.intentId);
  if (scan.found) {
    return {
      level: "warning",
      message: `[TRANSFER_PENDING] 已找到接收此交接的会话：${scan.found}。请在该会话执行 /pi-init fresh 核对，不在来源放弃或重建。`,
    };
  }
  if (scan.incomplete) {
    return {
      level: "warning",
      message: `[TRANSFER_PENDING] 无法完整核对会话目录（${scan.incomplete}），来源保持冻结。请先清理或手工核对目标会话后再试。`,
    };
  }
  return undefined;
}

/** Record an explicit before-setup native replacement cancel under the shared per-intent mutex. */
export async function abortPreparedTransfer(key: TransferCoordinationKey, appendCancelled: () => void) {
  await withTransferLock(key, () => {
    const committed = commitTransferDecision(key, { decision: "cancelled" });
    if (!committed.ok) throw new Error(committed.message);
    appendCancelled();
  });
}

/** Serialize stalled-transfer abandonment against target activation and incomplete-scan races. */
export async function cancelTransferUnderLock(options: {
  key: TransferCoordinationKey;
  isUnchanged: () => boolean;
  appendCancelled: () => void;
}): Promise<StalledCancelOutcome> {
  if (!options.isUnchanged()) {
    return { ok: false, level: "warning", message: "确认期间会话或交接记录已变化；来源保持冻结，请重新执行 /pi-init fresh。" };
  }
  try {
    return await withTransferLock(options.key, () => {
      if (!options.isUnchanged()) {
        return { ok: false, level: "warning", message: "确认期间会话或交接记录已变化；来源保持冻结，请重新执行 /pi-init fresh。" };
      }
      const preflight = preflightTransferAbandon(options.key);
      if (preflight.status === "blocked") return { ok: false, level: preflight.level, message: preflight.message };
      if (preflight.status !== "already-cancelled") {
        const blocker = scanTransferAbandonBlocker(options.key);
        if (blocker) return { ok: false, ...blocker };
        const committed = commitTransferDecision(options.key, { decision: "cancelled" });
        if (!committed.ok) {
          return { ok: false, level: "warning", message: `[TRANSFER_PENDING] ${committed.message}；来源保持冻结。` };
        }
      }
      options.appendCancelled();
      return { ok: true };
    });
  } catch (error) {
    return { ok: false, level: "error", message: "放弃记录未保存，来源保持冻结：" + textOf(error) };
  }
}

type ReplacementContext = Parameters<NonNullable<NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>["withSession"]>>[0];

/** One replacement lifecycle for both background and workflow transfers. Never use the old context after replacement. */
export async function replaceHandoffSession(ctx: ExtensionCommandContext, options: {
  sourceFile: string;
  setup: (manager: SessionManager) => Promise<void> | void;
  activate: (ctx: ReplacementContext) => Promise<void>;
  cancel: () => Promise<void> | void;
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
    if (result.cancelled && !setupRan) { await options.cancel(); return; }
    if (!setupRan || !activated) options.uncertain();
  } catch { options.uncertain(); }
}
