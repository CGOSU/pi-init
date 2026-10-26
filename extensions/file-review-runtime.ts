import { Type } from "typebox";
import {
  isBashToolResult,
  isEditToolResult,
  isPowerShellToolResult,
  isReadToolResult,
  isWriteToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolResultEvent,
  type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  FILE_REVIEW_ENTRY_TYPE,
  FILE_REVIEW_POLICY_VERSION,
  FILE_REVIEW_THRESHOLD,
  normalizeFileReviewError,
  inspectProjectFile,
  normalizeReviewPath,
  readFileReviewState,
  recordFileReview,
  scanProjectFiles,
  type FileReviewListScope,
  type FileScanError,
  type FileScanResult,
  type FileSnapshot,
  type PersistedFileReviewState,
  type StateReadResult,
} from "../src/file-review.ts";
import { buildReviewCandidateQueue, type ReviewCandidateQueueError } from "../src/review-candidates.ts";
import {
  createIncrementalReviewState,
  markIncrementalReviewNotified,
  observeIncrementalReviewFiles,
  refreshIncrementalReviewCandidates,
  unnotifiedIncrementalReviewCandidates,
  type IncrementalReviewCandidate,
  type IncrementalReviewState,
} from "../src/review-incremental.ts";
import { registerLargeCommand, type LargeReviewSnapshot } from "./large-command.ts";
import { hasCompleteCoverage, mergeCoverage, pathKey, type FileCoverage } from "./file-review-coverage.ts";
import type { ActiveRole } from "./runtime-state.ts";

const DEFAULT_LIST_FILES = 10;
const MAX_LIST_FILES = 50;

function branchEntryIds(ctx: ExtensionContext) {
  return ctx.sessionManager.getBranch().map((entry) => entry.id);
}

function branchIdsContinue(currentIds: readonly string[], previousIds: readonly string[]) {
  return previousIds.length <= currentIds.length
    && previousIds.every((entryId, index) => currentIds[index] === entryId);
}

function branchContinuesFrom(ctx: ExtensionContext, previousIds: readonly string[]) {
  return branchIdsContinue(branchEntryIds(ctx), previousIds);
}

type ReviewDiagnostic = { code: string; path: string; message: string };
type ReviewSession = {
  generation: number;
  projectRoot: string;
  sessionId: string;
  branchIds: string[];
  inventory: Map<string, FileSnapshot>;
  errors: ReviewDiagnostic[];
  scanErrors: FileScanError[];
  fileReviewState: StateReadResult;
  readCoverage: Map<string, FileCoverage>;
  incremental: IncrementalReviewState;
};
type ReviewDependencies = {
  getActiveRole: (ctx: ExtensionContext) => ActiveRole | undefined;
  canReview: () => boolean;
  roleRecoveryPending: () => boolean;
  getDispatchBlockReason: (ctx: ExtensionContext) => string | undefined;
};

const reviewToolParameters = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("complete")], { description: "list paginates the project inventory; complete records a review for path." }),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_FILES })),
  path: Type.Optional(Type.String({ description: "Used only by complete. Ignored by list, which always returns project-wide candidates." })),
  fingerprint: Type.Optional(Type.String()),
  conclusion: Type.Optional(Type.Union([
    Type.Literal("keep"),
    Type.Literal("recommend-split"),
  ])),
  rationale: Type.Optional(Type.String()),
});

function content(text: string) {
  return [{ type: "text" as const, text }];
}

function failure(code: string, message: string, isError = false) {
  return {
    content: content(`[${code}] ${message}`),
    details: { ok: false, code, message },
    ...(isError ? { isError: true } : {}),
  };
}

function success(message: string, details: Record<string, unknown>) {
  return { content: content(message), details: { ok: true, ...details } };
}

function persistedState(session: ReviewSession): PersistedFileReviewState {
  return {
    schemaVersion: 1,
    policyVersion: FILE_REVIEW_POLICY_VERSION,
    projectRoot: session.projectRoot,
    sessionId: session.sessionId,
    decisions: session.fileReviewState.ok ? session.fileReviewState.value.decisions : [],
  };
}

function emptyFileReviewState(projectRoot: string, sessionId: string): StateReadResult {
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      policyVersion: FILE_REVIEW_POLICY_VERSION,
      projectRoot,
      sessionId,
      decisions: [],
    },
  };
}

export function createFileReviewRuntime(pi: ExtensionAPI, deps: ReviewDependencies) {
  let session: ReviewSession | undefined;
  let generation = 0;

  function candidateQueue(current = session) {
    if (!current) return undefined;
    const scan: FileScanResult = {
      ok: true,
      projectRoot: current.projectRoot,
      files: [...current.inventory.values()],
      errors: [...current.scanErrors],
    };
    const queue = buildReviewCandidateQueue(scan, current.fileReviewState);
    refreshIncrementalReviewCandidates(current.incremental, queue, FILE_REVIEW_POLICY_VERSION);
    return queue;
  }

  function candidateErrorDiagnostics(errors: readonly ReviewCandidateQueueError[]): ReviewDiagnostic[] {
    return errors.map((error) => ({
      code: error.code,
      path: "cause" in error ? error.cause.path : "diagnostics" in error ? error.diagnostics[0]?.path ?? "." : ".",
      message: error.message,
    }));
  }

  function pending(current = session) {
    return candidateQueue(current)?.structuralCandidates ?? [];
  }

  function unnotifiedCandidates(current: ReviewSession, queue: ReturnType<typeof candidateQueue>) {
    return unnotifiedIncrementalReviewCandidates(current.incremental, Boolean(queue?.structuralConfirmed));
  }

  function formatIncrementalCandidate(candidate: IncrementalReviewCandidate) {
    return `[结构] ${candidate.file.path} · ${candidate.file.lineCount} 行 · version ${candidate.file.fingerprint}`;
  }

  function incrementalNotice(candidates: readonly IncrementalReviewCandidate[]) {
    if (candidates.length === 0) return undefined;
    return `[pi-init 增量审阅候选]\n${candidates.map(formatIncrementalCandidate).join("\n")}\n${STRUCTURE_REVIEW_GUIDANCE}`;
  }

  function markNotified(current: ReviewSession, candidates: readonly IncrementalReviewCandidate[]) {
    markIncrementalReviewNotified(current.incremental, candidates);
  }

  function persist(sessionToSave: ReviewSession) {
    try {
      pi.appendEntry(FILE_REVIEW_ENTRY_TYPE, persistedState(sessionToSave));
      return { ok: true as const };
    } catch (error) {
      return {
        ok: false as const,
        code: "PERSIST_FAILED",
        message: normalizeFileReviewError(error),
      };
    }
  }

  async function scanCurrent(
    ctx: ExtensionContext,
    forcePaths: readonly string[] = [],
    forceAll = false,
  ): Promise<{ ok: true; added: FileSnapshot[] } | { ok: false; code: string; message: string; added: FileSnapshot[] }> {
    const current = session;
    if (!current || current.generation !== generation) {
      return { ok: false, code: "SESSION_NOT_READY", message: "当前 Pi session 尚未完成项目扫描", added: [] };
    }
    const previousFiles = [...current.inventory.values()];
    const branchIds = branchEntryIds(ctx);
    if (!branchIdsContinue(branchIds, current.branchIds)) {
      return { ok: false, code: "STALE_SESSION", message: "当前 session branch 已变化，扫描结果未应用", added: [] };
    }
    const before = new Set(pending(current).map((file) => pathKey(file.path, file.fingerprint)));
    const result = await scanProjectFiles(current.projectRoot, { previous: previousFiles, forcePaths, forceAll });
    if (session !== current || current.generation !== generation || ctx.sessionManager.getSessionId() !== current.sessionId
      || !branchContinuesFrom(ctx, branchIds) || !branchContinuesFrom(ctx, current.branchIds)) {
      return { ok: false, code: "STALE_SESSION", message: "扫描期间 Pi session 已变化，结果未应用", added: [] };
    }
    if (!result.ok) {
      current.errors = [result.error];
      current.scanErrors = [result.error];
      return { ok: false, code: result.error.code, message: result.error.message, added: [] };
    }

    const next = new Map(current.inventory);
    if (result.errors.length === 0) next.clear();
    for (const file of result.files) {
      const previous = current.inventory.get(file.path);
      if (previous && previous.fingerprint !== file.fingerprint) current.readCoverage.delete(file.path);
      next.set(file.path, file);
    }
    if (result.errors.length === 0) {
      for (const filePath of next.keys()) {
        if (!result.files.some((file) => file.path === filePath)) next.delete(filePath);
      }
    }
    current.inventory = next;
    current.errors = result.errors;
    current.scanErrors = result.errors;
    observeIncrementalReviewFiles(current.incremental, result.files, result.errors.length === 0);
    const added = pending(current).filter((file) => !before.has(pathKey(file.path, file.fingerprint)));
    return result.errors.length === 0
      ? { ok: true, added }
      : { ok: false, code: "PARTIAL_SCAN", message: `${result.errors.length} 个路径无法扫描`, added };
  }

  async function restore(ctx: ExtensionContext) {
    const thisGeneration = ++generation;
    session = undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const branchIds = branchEntryIds(ctx);
    const scan = await scanProjectFiles(ctx.cwd);
    if (thisGeneration !== generation || ctx.sessionManager.getSessionId() !== sessionId
      || !branchContinuesFrom(ctx, branchIds)) return;
    if (!scan.ok) {
      session = {
        generation: thisGeneration,
        projectRoot: ctx.cwd,
        sessionId,
        branchIds,
        inventory: new Map(),
        errors: [scan.error],
        scanErrors: [scan.error],
        fileReviewState: emptyFileReviewState(ctx.cwd, sessionId),
        readCoverage: new Map(),
        incremental: createIncrementalReviewState([], false),
      };
      return;
    }

    const branch = ctx.sessionManager.getBranch();
    const entry = branch.findLast(
      (item) => item.type === "custom" && item.customType === FILE_REVIEW_ENTRY_TYPE,
    );
    const entryData = entry?.type === "custom" ? entry.data : undefined;
    const restored = readFileReviewState(entryData, scan.projectRoot, sessionId);
    const sameSessionRecord = entryData && typeof entryData === "object"
      && (entryData as { projectRoot?: unknown }).projectRoot === scan.projectRoot
      && (entryData as { sessionId?: unknown }).sessionId === sessionId;
    const fileReviewState = restored.ok || sameSessionRecord
      ? restored
      : emptyFileReviewState(scan.projectRoot, sessionId);
    session = {
      generation: thisGeneration,
      projectRoot: scan.projectRoot,
      sessionId,
      branchIds,
      inventory: new Map(scan.files.map((file) => [file.path, file])),
      fileReviewState,
      errors: [
        ...scan.errors,
        ...(!restored.ok && sameSessionRecord ? [{ code: restored.code, path: ".", message: restored.message }] : []),
      ],
      scanErrors: scan.errors,
      readCoverage: new Map(),
      incremental: createIncrementalReviewState(scan.files, scan.errors.length === 0),
    };
  }

  async function refreshSpecificFile(ctx: ExtensionContext, pathInput: string) {
    const current = session;
    if (!current || current.generation !== generation) {
      return { ok: false as const, code: "SESSION_NOT_READY", message: "当前 Pi session 尚未完成项目扫描", added: [] as FileSnapshot[] };
    }
    const branchIds = branchEntryIds(ctx);
    if (!branchIdsContinue(branchIds, current.branchIds)) {
      return { ok: false as const, code: "STALE_SESSION", message: "当前 session branch 已变化，检查结果未应用", added: [] as FileSnapshot[] };
    }
    const inspected = await inspectProjectFile(current.projectRoot, pathInput);
    if (session !== current || current.generation !== generation || ctx.sessionManager.getSessionId() !== current.sessionId
      || !branchContinuesFrom(ctx, branchIds) || !branchContinuesFrom(ctx, current.branchIds)) {
      return { ok: false as const, code: "STALE_SESSION", message: "检查期间 Pi session 已变化，结果未应用", added: [] as FileSnapshot[] };
    }
    if (!inspected.ok) {
      current.errors = [...current.errors.filter((error) => error.path !== inspected.error.path), inspected.error];
      current.scanErrors = [...current.scanErrors.filter((error) => error.path !== inspected.error.path), inspected.error];
      return { ok: false as const, code: inspected.error.code, message: inspected.error.message, added: [] as FileSnapshot[] };
    }
    const before = new Set(pending().map((file) => pathKey(file.path, file.fingerprint)));
    const previous = current.inventory.get(inspected.file.path);
    if (previous && previous.fingerprint !== inspected.file.fingerprint) current.readCoverage.delete(inspected.file.path);
    current.inventory.set(inspected.file.path, inspected.file);
    observeIncrementalReviewFiles(current.incremental, [inspected.file], false);
    current.errors = current.errors.filter((error) => error.path !== inspected.file.path);
    current.scanErrors = current.scanErrors.filter((error) => error.path !== inspected.file.path);
    const added = pending().filter((file) => !before.has(pathKey(file.path, file.fingerprint)));
    return { ok: true as const, added, file: inspected.file };
  }

  async function handleReadResult(
    event: Extract<ToolResultEvent, { toolName: "read" }>,
    ctx: ExtensionContext,
  ): Promise<ToolResultEventResult | undefined> {
    if (event.isError || !session || typeof event.input.path !== "string") return undefined;
    if (!normalizeReviewPath(session.projectRoot, event.input.path).ok) return undefined;
    const refreshed = await refreshSpecificFile(ctx, event.input.path);
    if (!refreshed.ok) {
      return appendToolNotice(event, `[pi-init 大文件审阅] 文件读取状态未确认 ${refreshed.code}：${refreshed.message}`);
    }
    const current = refreshed.file;
    const truncation = event.details?.truncation;
    const start = Number.isInteger(event.input.offset) && Number(event.input.offset) > 0 ? Number(event.input.offset) : 1;
    const requestedLimit = Number.isInteger(event.input.limit) && Number(event.input.limit) > 0
      ? Number(event.input.limit)
      : truncation?.maxLines ?? 2000;
    const outputLines = truncation?.outputLines ?? Math.min(requestedLimit, current.lineCount - start + 1);
    const partialLines = truncation?.lastLinePartial ? 1 : 0;
    const currentSession = session;
    if (!currentSession) return undefined;
    mergeCoverage(currentSession.readCoverage, current, start, Math.min(current.lineCount, start + outputLines - partialLines - 1));
    const notices = unnotifiedCandidates(currentSession, candidateQueue(currentSession));
    const notice = incrementalNotice(notices);
    if (!notice) return undefined;
    const result = appendToolNotice(event, notice);
    markNotified(currentSession, notices);
    return result;
  }

  async function handleToolResult(event: ToolResultEvent, ctx: ExtensionContext) {
    if (isReadToolResult(event)) return handleReadResult(event, ctx);
    const isMutationOrShell = isEditToolResult(event) || isWriteToolResult(event)
      || isBashToolResult(event) || isPowerShellToolResult(event);
    if (!isMutationOrShell || !session) return undefined;

    const isDirectFileTool = isEditToolResult(event) || isWriteToolResult(event);
    if (isDirectFileTool && typeof event.input.path === "string"
      && !normalizeReviewPath(session.projectRoot, event.input.path).ok) return undefined;
    const result = isDirectFileTool && typeof event.input.path === "string"
      ? await refreshSpecificFile(ctx, event.input.path)
      : await scanCurrent(ctx, [], true);
    if (!result.ok && result.code !== "PARTIAL_SCAN") {
      return appendToolNotice(event, `[pi-init 大文件审阅] 扫描失败 ${result.code}：${result.message}；状态未标记为已审。`);
    }
    const notices: string[] = [];
    if (!result.ok) notices.push(`[pi-init 大文件审阅] 扫描不完整：${result.message}；候选列表可能不完整。`);
    const current = session;
    const queue = current ? candidateQueue(current) : undefined;
    const incrementalCandidates = current ? unnotifiedCandidates(current, queue) : [];
    const incremental = incrementalNotice(incrementalCandidates);
    if (incremental) notices.push(incremental);
    if (notices.length === 0) return undefined;
    const output = appendToolNotice(event, notices.join("\n\n"));
    if (current && incrementalCandidates.length > 0) markNotified(current, incrementalCandidates);
    return output;
  }

  function appendToolNotice(event: ToolResultEvent, notice: string) {
    const nextContent = [...event.content, { type: "text" as const, text: notice }];
    return event.structuredContent === undefined
      ? { content: nextContent }
      : { content: nextContent, structuredContent: event.structuredContent };
  }

  function completeReadEvidence(file: FileSnapshot) {
    return hasCompleteCoverage(session?.readCoverage.get(file.path), file);
  }

  function hasUnsupportedReviewKind(input: Record<string, unknown>) {
    return input.reviewKind !== undefined && input.reviewKind !== "structure";
  }

  function structureListItems(offset: number, limit: number, candidates: readonly FileSnapshot[]) {
    return candidates.slice(offset, offset + limit).map((file) => ({
      path: file.path,
      lineCount: file.lineCount,
      fingerprint: file.fingerprint,
    }));
  }

  async function completeStructureReview(
    input: Record<string, unknown>,
    ctx: ExtensionContext,
    current: ReviewSession,
    refreshed: { ok: true; added: FileSnapshot[] } | { ok: false; code: string; message: string; added: FileSnapshot[] },
  ) {
    if (!refreshed.ok) return failure(refreshed.code, `${refreshed.message}；保留队列但不能登记完成审阅。`, true);
    const pathInput = input.path;
    const fingerprintInput = input.fingerprint;
    const conclusion = input.conclusion;
    const rationale = typeof input.rationale === "string" ? input.rationale.trim() : "";
    if (
      typeof pathInput !== "string" ||
      typeof fingerprintInput !== "string" ||
      (conclusion !== "keep" && conclusion !== "recommend-split") ||
      rationale.length < 12 || rationale.length > 2000
    ) {
      return failure("INVALID_REVIEW", "结构 complete 需要路径、当前 fingerprint、keep/recommend-split 结论及 12-2000 字符理由。");
    }
    const normalized = normalizeReviewPath(current.projectRoot, pathInput);
    if (!normalized.ok) return failure(normalized.code, normalized.message);

    const latest = await scanCurrent(ctx, [normalized.path]);
    if (!latest.ok) return failure(latest.code, latest.message);
    if (!current.fileReviewState.ok && current.fileReviewState.code !== "POLICY_MISMATCH") {
      return failure(current.fileReviewState.code, `结构审阅状态无法确认：${current.fileReviewState.message}`);
    }
    const file = session?.inventory.get(normalized.path);
    if (!file) return failure("FILE_NOT_FOUND", "文件不存在或不在当前项目的审阅范围内。");
    if (file.lineCount <= FILE_REVIEW_THRESHOLD) return failure("BELOW_THRESHOLD", "该文件当前不超过审阅阈值。");
    if (file.fingerprint !== fingerprintInput) return failure("STALE_VERSION", "文件内容已变化；请读取最新版本并重新审阅。");
    if (!candidateQueue(current)?.structuralCandidates.some((candidate) =>
      candidate.path === file.path && candidate.fingerprint === file.fingerprint,
    )) return failure("ALREADY_REVIEWED", "该内容版本已经审阅；只有内容变化后才需要重新提交结论。");
    if (!completeReadEvidence(file)) return failure("FILE_NOT_FULLY_READ", "尚未通过 Pi read 工具读取该版本的全部行；分段读取后再提交审阅结论。");

    const next = recordFileReview(persistedState(current), file, conclusion, rationale);
    const saved = persist({ ...current, fileReviewState: { ok: true, value: next } });
    if (!saved.ok) return failure(saved.code, `审阅结果未保存：${saved.message}`, true);
    current.fileReviewState = { ok: true, value: next };
    current.readCoverage.delete(file.path);
    return success(`${file.path} 已记录为 ${conclusion === "keep" ? "保留" : "建议拆分"}；该结果只适用于当前内容版本。`, {
      reviewKind: "structure",
      path: file.path,
      fingerprint: file.fingerprint,
      lineCount: file.lineCount,
      conclusion,
      rationale,
    });
  }

  async function executeReviewTool(input: Record<string, unknown>, ctx: ExtensionContext) {
    const current = session;
    if (!current) return failure("SESSION_NOT_READY", "当前 Pi session 尚未完成大文件扫描", true);
    if (!deps.canReview()) {
      return failure("ROLE_RECOVERY_PENDING", "职责恢复或工具安全门尚未解除；请先完成角色确认。");
    }
    if (deps.getActiveRole(ctx)?.role === "architect") {
      return failure("ARCHITECT_CANNOT_REVIEW", "architect 不读取或审阅代码；请交给 developer-test 或 docs-commit。");
    }
    if (hasUnsupportedReviewKind(input)) {
      return failure("TEST_VALUE_REVIEW_REMOVED", "测试价值审阅已退役；file_review 仅支持结构审阅。");
    }
    const refreshed = await scanCurrent(ctx, [], true);
    if (!refreshed.ok && refreshed.code !== "PARTIAL_SCAN") return failure(refreshed.code, refreshed.message, true);
    const queue = candidateQueue(current);
    if (!queue) return failure("SESSION_NOT_READY", "结构审阅候选状态无法确认", true);
    const candidates = queue.structuralCandidates;

    if (input.action === "list") {
      const offset = Number(input.offset ?? 0);
      const limit = Number(input.limit ?? DEFAULT_LIST_FILES);
      const items = structureListItems(offset, limit, candidates);
      const scanStatus = refreshed.ok ? "" : "扫描不完整；以下仅为已发现候选。";
      const summary = !queue.structuralConfirmed
        ? `结构候选状态无法确认；当前已发现 ${candidates.length} 个候选。`
        : items.length > 0
          ? `结构待审 ${offset + 1}-${offset + items.length}/${candidates.length}`
          : `没有该页已发现的结构候选；总数 ${candidates.length}`;
      const scope: FileReviewListScope = {
        scope: "project",
        ...(typeof input.path === "string" ? { ignoredPath: input.path } : {}),
      };
      const scopeNotice = scope.ignoredPath !== undefined
        ? `path=${JSON.stringify(scope.ignoredPath)} ignored: list returns project-wide inventory, not path-specific results. `
        : "Project-wide inventory. ";
      return success(`${scopeNotice}${scanStatus}${summary}`, {
        ...scope,
        candidates: items,
        total: candidates.length,
        structuralComplete: queue.structuralConfirmed,
        offset,
        reviewKind: "structure",
        scanComplete: refreshed.ok,
        errors: current.errors,
        candidateErrors: queue.errors,
      });
    }

    return completeStructureReview(input, ctx, current, refreshed);
  }

  registerLargeCommand(pi, {
    scan: (ctx) => scanCurrent(ctx, [], true),
    getSnapshot: (): LargeReviewSnapshot | undefined => {
      const current = session;
      if (!current) return undefined;
      const files = [...current.inventory.values()]
        .filter((file) => file.lineCount > FILE_REVIEW_THRESHOLD)
        .sort((left, right) => left.path.localeCompare(right.path));
      const queue = candidateQueue(current);
      const errors = [...current.errors];
      for (const error of candidateErrorDiagnostics(queue?.errors ?? [])) {
        if (!errors.some((existing) => existing.code === error.code && existing.path === error.path && existing.message === error.message)) {
          errors.push(error);
        }
      }
      return {
        generation: current.generation,
        sessionId: current.sessionId,
        files,
        candidates: queue?.candidates ?? [],
        structuralConfirmed: queue?.structuralConfirmed ?? false,
        errors,
      };
    },
    getActiveRole: deps.getActiveRole,
    roleRecoveryPending: deps.roleRecoveryPending,
    canReview: deps.canReview,
    getDispatchBlockReason: deps.getDispatchBlockReason,
  });

  pi.registerTool({
    name: "file_review",
    label: "Review Files",
    description: "List paginates the project-wide inventory of pending structural candidates in supported code files over the review threshold, not a path-specific review. Path is used only by complete and ignored by list. Complete records a reasoned keep/split conclusion for the exact current file version after reading it. Markdown is not supported.",
    promptSnippet: "Review large files without treating line count as a hard limit",
    promptGuidelines: [
      `${FILE_REVIEW_THRESHOLD} lines identifies candidates, not a mandatory review for every edit; it is not a rule to split or reject edits.`,
      STRUCTURE_REVIEW_GUIDANCE,
      "Query current inventory on demand with file_review(action=\"list\", offset=...) or /large; incremental notices cover observed changes since the session/branch baseline, not an exact task Git diff.",
      "list is project inventory pagination via offset/limit, not a review of the supplied path. path is used only by complete; list discloses any ignored path and still returns global candidates.",
      "Only supported code files are reviewed; Markdown is excluded. A list result is not evidence that a supplied path was reviewed.",
      "Read the full current file using read before submitting a review; use offset/limit chunks when needed.",
      "Omit reviewKind or use reviewKind=\"structure\"; conclusions are keep/recommend-split.",
      "A review applies to the current content fingerprint only. Do not claim a recommendation has been implemented.",
    ],
    parameters: reviewToolParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeReviewTool(params as Record<string, unknown>, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (event, ctx) => {
    if (event.oldLeafId !== event.newLeafId) await restore(ctx);
  });
  pi.on("session_shutdown", () => {
    generation += 1;
    session = undefined;
  });
  pi.on("tool_result", handleToolResult);
  pi.on("agent_settled", async (_event, ctx) => {
    const result = await scanCurrent(ctx, [], true);
    if (!result.ok) {
      ctx.ui.notify(`大文件扫描未完成：${result.message}；不会将未扫描部分标记为已检查。`, "warning");
      return;
    }
    const queue = candidateQueue();
    if (!queue) {
      ctx.ui.notify("统一审阅候选状态无法确认；不会据此宣布没有待审项。", "warning");
      return;
    }
    const notices: string[] = [];
    if (!queue.structuralConfirmed) {
      const error = queue.structuralError;
      notices.push(`结构候选无法确认${error ? `（${error.code}）：${error.message}` : ""}；不会推断为没有结构候选。`);
    }
    const current = session;
    const incrementalCandidates = current ? unnotifiedCandidates(current, queue) : [];
    const incremental = incrementalNotice(incrementalCandidates);
    if (incremental) notices.push(incremental);
    if (notices.length > 0) {
      ctx.ui.notify(notices.join("\n"), "warning");
      if (current && incrementalCandidates.length > 0) markNotified(current, incrementalCandidates);
    }
  });

  return {
    getPending: pending,
    executeReviewTool,
    getState: () => session,
  };
}

export type FileReviewRuntime = ReturnType<typeof createFileReviewRuntime>;
const STRUCTURE_REVIEW_GUIDANCE = "行数只标记候选，不等于本次任务必须审阅。明确局部、低风险且不改变职责结构的展示默认值/文案调整，不必仅因行数触发全文件读取或新增结构审阅；候选保持未审。新增职责、跨模块耦合、结构复杂度变化、用户明确要求或验收确需时再审阅，不能借小改动掩盖结构问题。";