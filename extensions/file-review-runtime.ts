import { Type } from "typebox";
import {
  isBashToolResult,
  isEditToolResult,
  isPowerShellToolResult,
  isReadToolResult,
  isWriteToolResult,
  type BeforeAgentStartEvent,
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
  type FileScanError,
  type FileScanResult,
  type FileSnapshot,
  type PersistedFileReviewState,
  type StateReadResult,
} from "../src/file-review.ts";
import {
  isTestValueCandidatePath,
  readTestValueReviewState,
  TEST_VALUE_REVIEW_POLICY_VERSION,
  type TestValueReviewDecision,
  type TestValueStateReadResult,
} from "../src/test-value-review.ts";
import { buildReviewCandidateQueue, type ReviewCandidateQueueError } from "../src/review-candidates.ts";
import type { PendingTestValueReview } from "../src/test-value-review.ts";
import {
  createIncrementalReviewState,
  incrementalReviewCandidates,
  markIncrementalReviewNotified,
  observeIncrementalReviewFiles,
  refreshIncrementalReviewCandidates,
  unnotifiedIncrementalReviewCandidates,
  type IncrementalReviewCandidate,
  type IncrementalReviewState,
} from "../src/review-incremental.ts";
import { registerLargeCommand, type LargeReviewSnapshot } from "./large-command.ts";
import { hasCompleteCoverage, mergeCoverage, pathKey, type FileCoverage } from "./file-review-coverage.ts";
import {
  TEST_VALUE_DISCOVERY_LIMITATIONS,
  TEST_VALUE_ENTRY_TYPE,
  recordValueReview,
  restoreTestValueReviewSession,
  testValuePersistedState,
  type ReviewDiagnostic,
} from "./test-value-review-runtime.ts";
import type { ActiveRole } from "./runtime-state.ts";

const REVIEW_SECTION = "pi_init_large_file_review";
const MAX_SECTION_FILES = 10;
const MAX_LIST_FILES = 50;
const VALUE_REVIEW_CONCLUSIONS = ["keep", "merge", "rewrite", "remove"] as const;
type ValueConclusion = (typeof VALUE_REVIEW_CONCLUSIONS)[number];

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

type ReviewSession = {
  generation: number;
  projectRoot: string;
  sessionId: string;
  branchIds: string[];
  inventory: Map<string, FileSnapshot>;
  errors: ReviewDiagnostic[];
  scanErrors: FileScanError[];
  fileReviewState: StateReadResult;
  valueReviewState: TestValueStateReadResult;
  valueAssociationDecisions: TestValueReviewDecision[];
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
  action: Type.Union([Type.Literal("list"), Type.Literal("complete")]),
  reviewKind: Type.Optional(Type.Union([Type.Literal("structure"), Type.Literal("test-value")])),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_FILES })),
  path: Type.Optional(Type.String()),
  fingerprint: Type.Optional(Type.String()),
  conclusion: Type.Optional(Type.Union([
    Type.Literal("keep"),
    Type.Literal("recommend-split"),
    Type.Literal("merge"),
    Type.Literal("rewrite"),
    Type.Literal("remove"),
  ])),
  implementationPaths: Type.Optional(Type.Array(Type.String())),
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

function valueAssociationsForIncremental(
  branch: readonly { type?: string; customType?: string; data?: unknown }[],
  projectRoot: string,
  sessionId: string,
  state: TestValueStateReadResult,
) {
  if (state.ok) return state.value.decisions;
  if (state.code !== "POLICY_MISMATCH") return [];
  const entry = [...branch].reverse().find((item) => item.type === "custom" && item.customType === TEST_VALUE_ENTRY_TYPE);
  if (!entry?.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return [];
  const compatible = readTestValueReviewState(
    { ...entry.data, policyVersion: TEST_VALUE_REVIEW_POLICY_VERSION },
    projectRoot,
    sessionId,
  );
  return compatible.ok ? compatible.value.decisions : [];
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
    const queue = buildReviewCandidateQueue(scan, current.fileReviewState, current.valueReviewState);
    refreshIncrementalReviewCandidates(
      current.incremental,
      queue,
      current.inventory,
      current.valueAssociationDecisions,
      FILE_REVIEW_POLICY_VERSION,
      TEST_VALUE_REVIEW_POLICY_VERSION,
    );
    return queue;
  }

  function candidateErrorDiagnostics(errors: readonly ReviewCandidateQueueError[]): ReviewDiagnostic[] {
    return errors.map((error) => ({
      code: error.code,
      path: "path" in error && typeof error.path === "string" ? error.path : ".",
      message: "message" in error ? error.message : error.cause.message,
    }));
  }

  function pending(current = session) {
    return candidateQueue(current)?.structuralCandidates ?? [];
  }

  function valuePending(queue = candidateQueue()) {
    if (!queue) return { ok: true as const, pending: [] as PendingTestValueReview[] };
    if (queue.testValueConfirmed) return { ok: true as const, pending: queue.testValueCandidates };
    const error = queue.testValueError ?? queue.error;
    return {
      ok: false as const,
      error: error
        ? { code: error.code, message: "message" in error ? error.message : error.cause.message }
        : { code: "TEST_VALUE_CANDIDATES_UNAVAILABLE", message: "测试价值候选状态无法确认" },
    };
  }

  function runtimeSection(ctx: ExtensionContext, queue = candidateQueue()) {
    if (!session) return "审阅增量基线尚未建立；不得断言当前没有新变化。";
    if (!queue) return "统一审阅候选状态无法确认；不得将其视作无候选文件。";
    const candidates = incrementalReviewCandidates(session.incremental);
    const structural = candidates.filter((candidate) => candidate.kind === "structure");
    const valueCandidates = candidates.filter((candidate) => candidate.kind === "test-value");
    const valueResult = valuePending(queue);
    const lines = [
      "[pi-init 增量审阅候选]",
      "日常范围：当前 session/branch 基线后实际观察到的文件变化及显式关联失效测试；不代表精准任务 Git diff。",
      "完整候选库存仍由 file_review(action=\"list\", offset=...) 与 /large 承接。",
      `结构审阅阈值：超过 ${FILE_REVIEW_THRESHOLD} 个物理行进入审阅；这不是文件上限，不自动拆分或拒绝编辑。`,
      `测试价值审阅：独立于行数，按文件约定发现；${TEST_VALUE_DISCOVERY_LIMITATIONS}`,
    ];
    if (session.errors.length > 0) {
      lines.push("扫描或审阅状态不完整；下列结果可能不完整，不能据此断言没有其他待审文件：");
      for (const error of session.errors.slice(0, MAX_SECTION_FILES)) {
        lines.push(`- [${error.code}] ${error.path || "."}: ${error.message}`);
      }
    }
    if (!queue.structuralConfirmed) {
      const error = queue.structuralError;
      lines.push(`结构候选状态无法确认${error ? `（${error.code}）：${"message" in error ? error.message : error.cause.message}` : ""}；不得推断为没有结构候选，保留上次确认的增量上下文。`);
    }
    lines.push(`结构增量待审：${structural.length}${queue.structuralConfirmed ? "" : "（上次确认；当前未确认）"}`);
    for (const candidate of structural.slice(0, MAX_SECTION_FILES)) {
      lines.push(`- ${candidate.file.path} · ${candidate.file.lineCount} 行 · version ${candidate.file.fingerprint}`);
    }
    if (structural.length > MAX_SECTION_FILES) {
      lines.push(`另有 ${structural.length - MAX_SECTION_FILES} 个结构增量候选；调用 file_review(action="list", offset=...) 分批读取完整库存。`);
    }
    lines.push(`测试价值增量待审：${valueResult.ok ? valueCandidates.length : `${valueCandidates.length}（状态未确认）`}`);
    if (!valueResult.ok) {
      lines.push(`测试价值候选无法确认（${valueResult.error.code}）：${valueResult.error.message}；不得推断为没有价值候选。`);
    }
    for (const candidate of valueCandidates.slice(0, MAX_SECTION_FILES)) {
      const reason = candidate.review.invalidations.length > 0
        ? ` · 需重新审阅：${candidate.review.invalidations.map((entry) => `${entry.code}${entry.path ? `(${entry.path})` : ""}`).join(", ")}`
        : "";
      lines.push(`- ${candidate.review.file.path} · version ${candidate.review.file.fingerprint}${reason}`);
    }
    if (valueCandidates.length > MAX_SECTION_FILES) {
      lines.push(`另有 ${valueCandidates.length - MAX_SECTION_FILES} 个价值增量候选；调用 file_review(action="list") 分批读取完整库存。`);
    }
    const hasCandidates = candidates.length > 0 || !queue.structuralConfirmed || !queue.testValueConfirmed || session.errors.length > 0;
    if (hasCandidates) {
      if (!deps.canReview()) {
        lines.push("职责恢复或工具安全门尚未解除；暂不执行审阅操作，先完成当前职责恢复。");
      } else if (deps.getActiveRole(ctx)?.role === "architect") {
        lines.push("当前职责为 architect：不得读取或审阅代码；将审阅工作交给 developer-test 或 docs-commit。");
      } else {
        lines.push("结构审阅：读取文件内容，判断职责是否内聚；调用 file_review(action=\"complete\") 记录有理由的 keep 或 recommend-split。拆分只是建议，不自动修改代码；若内容版本变化，旧审阅失效。");
        lines.push("测试价值审阅：显式给出关联实现路径，完整读取当前测试及各实现版本后，用 reviewKind=\"test-value\" 记录 keep/merge/rewrite/remove 建议；这些建议不会删除、合并或重写任何测试。结构 keep 不代表价值审阅通过。");
      }
      if (session.readCoverage.size > 0) lines.push("只有 Pi read 工具读取覆盖当前完整文件版本后，审阅确认才会被接受；分段读取也可累积完整覆盖。");
    }
    return lines.join("\n");
  }

  function unnotifiedCandidates(current: ReviewSession, queue: ReturnType<typeof candidateQueue>) {
    return unnotifiedIncrementalReviewCandidates(current.incremental, {
      structural: Boolean(queue?.structuralConfirmed),
      testValue: Boolean(queue?.testValueConfirmed),
    });
  }

  function formatIncrementalCandidate(candidate: IncrementalReviewCandidate) {
    if (candidate.kind === "structure") {
      return `[结构] ${candidate.file.path} · ${candidate.file.lineCount} 行 · version ${candidate.file.fingerprint}`;
    }
    const reason = candidate.review.invalidations.length > 0
      ? ` · 需重新审阅：${candidate.review.invalidations.map((entry) => `${entry.code}${entry.path ? `(${entry.path})` : ""}`).join(", ")}`
      : "";
    return `[测试价值] ${candidate.review.file.path} · version ${candidate.review.file.fingerprint}${reason}`;
  }

  function incrementalNotice(candidates: readonly IncrementalReviewCandidate[]) {
    if (candidates.length === 0) return undefined;
    return `[pi-init 增量审阅待处理]\n${candidates.map(formatIncrementalCandidate).join("\n")}\n请先审阅职责边界；结构行数不是拆分命令，测试价值建议不会自动修改测试。`;
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

  function persistValue(sessionToSave: ReviewSession) {
    try {
      pi.appendEntry(
        TEST_VALUE_ENTRY_TYPE,
        testValuePersistedState(
          sessionToSave.projectRoot,
          sessionToSave.sessionId,
          sessionToSave.valueReviewState.ok ? sessionToSave.valueReviewState.value.decisions : [],
        ),
      );
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
        valueReviewState: { ok: true, value: testValuePersistedState(ctx.cwd, sessionId, []) },
        valueAssociationDecisions: [],
        readCoverage: new Map(),
        incremental: createIncrementalReviewState([], false, FILE_REVIEW_POLICY_VERSION, TEST_VALUE_REVIEW_POLICY_VERSION),
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
    const valueRestored = restoreTestValueReviewSession(branch, scan.projectRoot, sessionId);
    const valueReviewState = valueRestored.state
      ?? { ok: true as const, value: testValuePersistedState(scan.projectRoot, sessionId, []) };
    const valueAssociationDecisions = valueAssociationsForIncremental(
      branch,
      scan.projectRoot,
      sessionId,
      valueReviewState,
    );
    session = {
      generation: thisGeneration,
      projectRoot: scan.projectRoot,
      sessionId,
      branchIds,
      inventory: new Map(scan.files.map((file) => [file.path, file])),
      fileReviewState,
      valueReviewState,
      valueAssociationDecisions,
      errors: [
        ...scan.errors,
        ...(!restored.ok && sameSessionRecord ? [{ code: restored.code, path: ".", message: restored.message }] : []),
        ...valueRestored.errors,
      ],
      scanErrors: scan.errors,
      readCoverage: new Map(),
      incremental: createIncrementalReviewState(
        scan.files,
        scan.errors.length === 0,
        FILE_REVIEW_POLICY_VERSION,
        TEST_VALUE_REVIEW_POLICY_VERSION,
      ),
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

  function reviewKindOf(input: Record<string, unknown>): "structure" | "test-value" | "invalid" {
    if (input.reviewKind === undefined || input.reviewKind === "structure") return "structure";
    if (input.reviewKind === "test-value") return "test-value";
    return "invalid";
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

  async function completeValueReview(
    input: Record<string, unknown>,
    ctx: ExtensionContext,
    current: ReviewSession,
  ) {
    const pathInput = input.path;
    const fingerprintInput = input.fingerprint;
    const conclusion = input.conclusion;
    const rationale = typeof input.rationale === "string" ? input.rationale.trim() : "";
    const implementationPaths = input.implementationPaths;
    if (
      typeof pathInput !== "string" ||
      typeof fingerprintInput !== "string" ||
      !VALUE_REVIEW_CONCLUSIONS.includes(conclusion as ValueConclusion) ||
      !Array.isArray(implementationPaths) || implementationPaths.length === 0 ||
      !implementationPaths.every((entry): entry is string => typeof entry === "string") ||
      rationale.length < 12 || rationale.length > 2000
    ) {
      return failure(
        "INVALID_REVIEW",
        "测试价值 complete 需要路径、当前 fingerprint、keep/merge/rewrite/remove 结论、至少一个显式实现路径及 12-2000 字符理由。",
      );
    }
    if (!isTestValueCandidatePath(pathInput)) {
      return failure("NOT_TEST_CANDIDATE", "该路径不符合当前的文件级测试发现约定。");
    }
    const normalizedTest = normalizeReviewPath(current.projectRoot, pathInput);
    if (!normalizedTest.ok) return failure(normalizedTest.code, normalizedTest.message);
    const normalizedImplementations: string[] = [];
    const seenImplementationPaths = new Set<string>();
    for (const implementationPath of implementationPaths) {
      const normalized = normalizeReviewPath(current.projectRoot, implementationPath);
      if (!normalized.ok) return failure(normalized.code, `${implementationPath}: ${normalized.message}`);
      if (seenImplementationPaths.has(normalized.path)) {
        return failure("DUPLICATE_IMPLEMENTATION_PATH", "实现关联中不能重复包含同一路径。");
      }
      seenImplementationPaths.add(normalized.path);
      normalizedImplementations.push(normalized.path);
    }

    const latest = await scanCurrent(ctx, [...normalizedImplementations, normalizedTest.path]);
    if (!latest.ok) return failure(latest.code, latest.message);
    const currentSession = session;
    if (!currentSession) return failure("SESSION_NOT_READY", "当前 Pi session 尚未完成项目扫描", true);
    if (!currentSession.valueReviewState.ok && currentSession.valueReviewState.code !== "POLICY_MISMATCH") {
      return failure(currentSession.valueReviewState.code, `测试价值审阅状态无法确认：${currentSession.valueReviewState.message}`);
    }
    if (currentSession.scanErrors.length > 0) {
      return failure("SCAN_INCOMPLETE", "项目扫描不完整，无法核实测试及其显式关联实现；不得登记价值完成。");
    }
    const scan: { ok: true; projectRoot: string; files: FileSnapshot[]; errors: FileScanError[] } = {
      ok: true,
      projectRoot: currentSession.projectRoot,
      files: [...currentSession.inventory.values()],
      errors: [...currentSession.scanErrors],
    };
    const testFile = currentSession.inventory.get(normalizedTest.path);
    if (!testFile) return failure("TEST_FILE_NOT_FOUND", "当前扫描中没有该测试文件。");
    if (testFile.fingerprint !== fingerprintInput) {
      return failure("STALE_VERSION", "测试内容已变化；请读取最新版本并重新审阅。");
    }
    for (const implementationPath of normalizedImplementations) {
      const implementation = currentSession.inventory.get(implementationPath);
      if (!implementation) return failure("IMPLEMENTATION_FILE_NOT_FOUND", `当前扫描中没有关联实现文件：${implementationPath}`);
      if (!completeReadEvidence(implementation)) {
        return failure("IMPLEMENTATION_NOT_FULLY_READ", `${implementationPath} 尚未通过 Pi read 读取当前版本全部行；请先完整读取。`);
      }
    }
    if (!completeReadEvidence(testFile)) {
      return failure("TEST_NOT_FULLY_READ", `${testFile.path} 尚未通过 Pi read 读取当前版本全部行；请先完整读取。`);
    }

    const valueDecisions = currentSession.valueReviewState.ok
      ? currentSession.valueReviewState.value.decisions
      : [];
    const recorded = recordValueReview(
      valueDecisions,
      scan,
      currentSession.sessionId,
      testFile.path,
      normalizedImplementations,
      conclusion as ValueConclusion,
      rationale,
    );
    if (!recorded.ok) return failure(recorded.error.code, recorded.error.message);
    const saved = persistValue({ ...currentSession, valueReviewState: { ok: true, value: recorded.value } });
    if (!saved.ok) return failure(saved.code, `测试价值审阅结果未保存：${saved.message}`, true);
    currentSession.valueReviewState = { ok: true, value: recorded.value };
    currentSession.valueAssociationDecisions = recorded.value.decisions;
    for (const implementationPath of normalizedImplementations) currentSession.readCoverage.delete(implementationPath);
    currentSession.readCoverage.delete(testFile.path);
    return success(
      `${testFile.path} 已登记测试价值建议 ${conclusion}；仅记录建议，不会自动删除、合并或重写测试。`,
      {
        reviewKind: "test-value",
        path: testFile.path,
        fingerprint: testFile.fingerprint,
        implementationFiles: recorded.value.decisions.at(-1)!.implementationFiles,
        conclusion,
        rationale,
      },
    );
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
    const kind = reviewKindOf(input);
    if (kind === "invalid") {
      return failure("INVALID_REVIEW_KIND", "reviewKind 只能是 structure 或 test-value。");
    }
    const refreshed = await scanCurrent(ctx, [], true);
    if (!refreshed.ok && refreshed.code !== "PARTIAL_SCAN") return failure(refreshed.code, refreshed.message, true);
    const queue = candidateQueue(current);
    if (!queue) return failure("SESSION_NOT_READY", "统一审阅候选状态无法确认", true);
    const candidates = queue.structuralCandidates;
    const valueCandidates = queue.testValueCandidates;
    const valueResult = valuePending(queue);

    if (input.action === "list") {
      const offset = Number(input.offset ?? 0);
      const limit = Number(input.limit ?? MAX_SECTION_FILES);
      const structureItems = structureListItems(offset, limit, candidates);
      const valueItems = valueCandidates.slice(offset, offset + limit).map((item) => ({
        path: item.file.path,
        fingerprint: item.file.fingerprint,
        invalidations: item.invalidations,
      }));
      const scanStatus = refreshed.ok ? "" : "扫描不完整；以下仅为已发现候选。";
      const valueStatus = valueResult.ok
        ? "测试价值发现局限：" + TEST_VALUE_DISCOVERY_LIMITATIONS
        : `测试价值候选无法确认（${valueResult.error.code}）：${valueResult.error.message}；不得推断为没有价值候选。`;
      const structureSummary = !queue.structuralConfirmed
        ? `结构候选状态无法确认；当前已发现 ${candidates.length} 个候选。`
        : structureItems.length > 0
          ? `结构待审 ${offset + 1}-${offset + structureItems.length}/${candidates.length}`
          : `没有该页已发现的结构候选；总数 ${candidates.length}`;
      const valueSummary = !queue.testValueConfirmed
        ? `测试价值候选状态未确认；当前已发现 ${valueCandidates.length} 个候选。`
        : valueItems.length > 0
          ? `测试价值待审 ${offset + 1}-${offset + valueItems.length}/${valueCandidates.length}`
          : `没有该页已发现的测试价值候选；总数 ${valueCandidates.length}`;
      const summary = kind === "test-value" ? valueSummary : structureSummary;
      return success(`${scanStatus}${summary}\n${valueStatus}`, {
        candidates: structureItems,
        total: candidates.length,
        valueCandidates: valueItems,
        valueTotal: valueCandidates.length,
        structuralComplete: queue.structuralConfirmed,
        valueScanComplete: queue.testValueConfirmed,
        valueError: valueResult.ok ? undefined : valueResult.error,
        offset,
        reviewKind: kind,
        scanComplete: refreshed.ok,
        errors: current.errors,
        candidateErrors: queue.errors,
      });
    }

    return kind === "test-value"
      ? completeValueReview(input, ctx, current)
      : completeStructureReview(input, ctx, current, refreshed);
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
        testValueConfirmed: queue?.testValueConfirmed ?? false,
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
    description: "List pending structural (over-threshold) and test-value review candidates; record a reasoned structural keep/split conclusion or an independent test-value keep/merge/rewrite/remove recommendation for the exact current versions after reading them. Test-value conclusions are advisory only and never modify tests.",
    promptSnippet: "Review large files and test value without treating line count as a hard limit",
    promptGuidelines: [
      `${FILE_REVIEW_THRESHOLD} lines triggers structural review; it is not a rule to split or reject edits.`,
      "Read the full current file using read before submitting a review; use offset/limit chunks when needed.",
      "Structure reviews use the default reviewKind (or reviewKind=\"structure\") with keep/recommend-split; test value uses reviewKind=\"test-value\" with keep/merge/rewrite/remove.",
      "Test-value review is independent of line count, requires explicit implementationPaths, and must not be inferred from test names or filenames.",
      "A test-value conclusion is advisory only: never delete, merge, or rewrite tests automatically. A structural keep does not satisfy test-value review.",
      "A review applies to the current content fingerprint only, and becomes stale when the test or any associated implementation version changes. Do not claim a recommendation has been implemented.",
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
  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx) => {
    if (!event.systemPromptOptions?.sections) return;
    const state = session;
    if (!state) {
      event.systemPromptOptions.sections[REVIEW_SECTION] = "审阅增量基线仍未完成；不得断言当前没有新变化。";
      return;
    }
    const queue = candidateQueue(state);
    const hasCandidates = !queue || incrementalReviewCandidates(state.incremental).length > 0
      || !queue.structuralConfirmed || !queue.testValueConfirmed || state.errors.length > 0;
    if (hasCandidates) {
      event.systemPromptOptions.sections[REVIEW_SECTION] = runtimeSection(ctx, queue);
    } else {
      delete event.systemPromptOptions.sections[REVIEW_SECTION];
    }
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
      notices.push(`结构候选无法确认${error ? `（${error.code}）：${"message" in error ? error.message : error.cause.message}` : ""}；不会推断为没有结构候选。`);
    }
    if (!queue.testValueConfirmed) {
      const error = queue.testValueError ?? queue.error;
      notices.push(`测试价值候选无法确认${error ? `（${error.code}）：${"message" in error ? error.message : error.cause.message}` : ""}；不会推断为没有价值候选。`);
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