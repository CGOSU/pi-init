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
  pendingFileReviews,
  readFileReviewState,
  recordFileReview,
  scanProjectFiles,
  type FileReviewDecision,
  type FileScanError,
  type FileSnapshot,
  type PersistedFileReviewState,
} from "../src/file-review.ts";
import { isTestValueCandidatePath, type TestValueReviewDecision } from "../src/test-value-review.ts";
import type { PendingTestValueReview } from "../src/test-value-review.ts";
import { registerLargeCommand, type LargeReviewSnapshot } from "./large-command.ts";
import { hasCompleteCoverage, mergeCoverage, pathKey, type FileCoverage } from "./file-review-coverage.ts";
import {
  TEST_VALUE_DISCOVERY_LIMITATIONS,
  TEST_VALUE_ENTRY_TYPE,
  pendingTestValueCandidates,
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

type ReviewSession = {
  generation: number;
  projectRoot: string;
  sessionId: string;
  inventory: Map<string, FileSnapshot>;
  decisions: FileReviewDecision[];
  valueDecisions: TestValueReviewDecision[];
  errors: ReviewDiagnostic[];
  scanErrors: FileScanError[];
  readCoverage: Map<string, FileCoverage>;
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
    decisions: session.decisions,
  };
}

export function createFileReviewRuntime(pi: ExtensionAPI, deps: ReviewDependencies) {
  let session: ReviewSession | undefined;
  let generation = 0;

  function pending() {
    if (!session) return [];
    return pendingFileReviews([...session.inventory.values()], session.decisions);
  }

  function valuePending() {
    if (!session) return { ok: true as const, pending: [] as PendingTestValueReview[] };
    return pendingTestValueCandidates(
      [...session.inventory.values()],
      session.scanErrors,
      session.valueDecisions,
    );
  }

  function runtimeSection(ctx: ExtensionContext) {
    if (!session) return "大文件审阅状态尚未完成扫描；不得将其视作无候选文件。";
    const candidates = pending();
    const valueResult = valuePending();
    const valueCandidates: PendingTestValueReview[] = valueResult.ok ? valueResult.pending : [];
    const lines = [
      "[pi-init 统一审阅候选]",
      `结构审阅阈值：超过 ${FILE_REVIEW_THRESHOLD} 个物理行进入审阅；这不是文件上限，不自动拆分或拒绝编辑。`,
      `测试价值审阅：独立于行数，按文件约定发现；${TEST_VALUE_DISCOVERY_LIMITATIONS}`,
    ];
    if (session.errors.length > 0) {
      lines.push("扫描不完整；下列结果可能不完整，不能据此断言没有其他待审文件：");
      for (const error of session.errors.slice(0, MAX_SECTION_FILES)) {
        lines.push(`- [${error.code}] ${error.path || "."}: ${error.message}`);
      }
    }
    lines.push(`结构待审文件：${candidates.length}`);
    for (const file of candidates.slice(0, MAX_SECTION_FILES)) {
      lines.push(`- ${file.path} · ${file.lineCount} 行 · version ${file.fingerprint}`);
    }
    if (candidates.length > MAX_SECTION_FILES) {
      lines.push(`另有 ${candidates.length - MAX_SECTION_FILES} 个结构候选；调用 file_review(action="list", offset=...) 分批读取。`);
    }
    lines.push(`测试价值待审：${valueResult.ok ? valueCandidates.length : "未确认"}`);
    if (!valueResult.ok) {
      lines.push(`测试价值候选无法确认（${valueResult.error.code}）：${valueResult.error.message}；不得推断为没有价值候选。`);
    }
    for (const item of valueCandidates.slice(0, MAX_SECTION_FILES)) {
      const reason = item.invalidations.length > 0
        ? ` · 需重新审阅：${item.invalidations.map((entry: { code: string; path?: string }) => `${entry.code}${entry.path ? `(${entry.path})` : ""}`).join(", ")}`
        : "";
      lines.push(`- ${item.file.path} · version ${item.file.fingerprint}${reason}`);
    }
    if (valueCandidates.length > MAX_SECTION_FILES) {
      lines.push(`另有 ${valueCandidates.length - MAX_SECTION_FILES} 个价值候选；调用 file_review(action="list") 分批读取。`);
    }
    const hasCandidates = candidates.length > 0 || valueCandidates.length > 0 || !valueResult.ok;
    if (hasCandidates) {
      if (!deps.canReview()) {
        lines.push("职责恢复或工具安全门尚未解除；暂不执行审阅操作，先完成当前职责恢复。");
      } else if (deps.getActiveRole(ctx)?.role === "architect") {
        lines.push("当前职责为 architect：不得读取或审阅代码；将审阅工作交给 developer-test 或 docs-commit。");
      } else {
        lines.push("结构审阅：读取文件内容，判断职责是否内聚；调用 file_review(action=\"complete\") 记录有理由的 keep 或 recommend-split。拆分只是建议，不自动修改代码；若内容版本变化，旧审阅失效。");
        lines.push("测试价值审阅：显式给出关联实现路径，完整读取当前测试及各实现版本后，用 reviewKind=\"test-value\" 记录 keep/merge/rewrite/remove 建议；这些建议不会删除、合并或重写任何测试。结构 keep 不代表价值审阅通过。");
      }
      if (session.readCoverage.size > 0) lines.push("只有 Pi read 工具读取覆盖当前完整文件版本后，审阅确认才会被接受；大文件可用 offset/limit 分段读取。");
    }
    return lines.join("\n");
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
        testValuePersistedState(sessionToSave.projectRoot, sessionToSave.sessionId, sessionToSave.valueDecisions),
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
    const before = new Set(pendingFileReviews(previousFiles, current.decisions).map((file) => pathKey(file.path, file.fingerprint)));
    const result = await scanProjectFiles(current.projectRoot, { previous: previousFiles, forcePaths, forceAll });
    if (session !== current || current.generation !== generation || ctx.sessionManager.getSessionId() !== current.sessionId) {
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
    const added = pendingFileReviews([...next.values()], current.decisions)
      .filter((file) => !before.has(pathKey(file.path, file.fingerprint)));
    return result.errors.length === 0
      ? { ok: true, added }
      : { ok: false, code: "PARTIAL_SCAN", message: `${result.errors.length} 个路径无法扫描`, added };
  }

  async function restore(ctx: ExtensionContext) {
    const thisGeneration = ++generation;
    session = undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const scan = await scanProjectFiles(ctx.cwd);
    if (thisGeneration !== generation) return;
    if (!scan.ok) {
      session = {
        generation: thisGeneration,
        projectRoot: ctx.cwd,
        sessionId,
        inventory: new Map(),
        decisions: [],
        valueDecisions: [],
        errors: [scan.error],
        scanErrors: [scan.error],
        readCoverage: new Map(),
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
    const valueRestored = restoreTestValueReviewSession(branch, scan.projectRoot, sessionId);
    session = {
      generation: thisGeneration,
      projectRoot: scan.projectRoot,
      sessionId,
      inventory: new Map(scan.files.map((file) => [file.path, file])),
      decisions: restored.ok ? restored.value.decisions : [],
      valueDecisions: valueRestored.decisions,
      errors: [
        ...scan.errors,
        ...(!restored.ok && sameSessionRecord ? [{ code: restored.code, path: ".", message: restored.message }] : []),
        ...valueRestored.errors,
      ],
      scanErrors: scan.errors,
      readCoverage: new Map(),
    };
  }

  async function refreshSpecificFile(ctx: ExtensionContext, pathInput: string) {
    const current = session;
    if (!current || current.generation !== generation) {
      return { ok: false as const, code: "SESSION_NOT_READY", message: "当前 Pi session 尚未完成项目扫描", added: [] as FileSnapshot[] };
    }
    const inspected = await inspectProjectFile(current.projectRoot, pathInput);
    if (session !== current || current.generation !== generation || ctx.sessionManager.getSessionId() !== current.sessionId) {
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
    const isStructuralCandidate = current.lineCount > FILE_REVIEW_THRESHOLD;
    const isValueCandidate = isTestValueCandidatePath(current.path);
    if (!isStructuralCandidate && !isValueCandidate) return undefined;

    const truncation = event.details?.truncation;
    const start = Number.isInteger(event.input.offset) && Number(event.input.offset) > 0 ? Number(event.input.offset) : 1;
    const requestedLimit = Number.isInteger(event.input.limit) && Number(event.input.limit) > 0
      ? Number(event.input.limit)
      : truncation?.maxLines ?? 2000;
    const outputLines = truncation?.outputLines ?? Math.min(requestedLimit, current.lineCount - start + 1);
    const partialLines = truncation?.lastLinePartial ? 1 : 0;
    mergeCoverage(session.readCoverage, current, start, Math.min(current.lineCount, start + outputLines - partialLines - 1));
    if (refreshed.added.length === 0) return undefined;
    return appendToolNotice(event, `[pi-init 大文件审阅待处理] ${refreshed.added.map((file) => `${file.path} (${file.lineCount} 行, ${file.fingerprint})`).join("\n")}`);
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
    if (result.added.length > 0) {
      notices.push(
        `[pi-init 大文件审阅待处理]\n${result.added.map((file) => `${file.path} (${file.lineCount} 行, ${file.fingerprint})`).join("\n")}\n请先审阅职责边界；行数不是拆分命令。`,
      );
    }
    return notices.length > 0 ? appendToolNotice(event, notices.join("\n\n")) : undefined;
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
    const file = session?.inventory.get(normalized.path);
    if (!file) return failure("FILE_NOT_FOUND", "文件不存在或不在当前项目的审阅范围内。");
    if (file.lineCount <= FILE_REVIEW_THRESHOLD) return failure("BELOW_THRESHOLD", "该文件当前不超过审阅阈值。");
    if (file.fingerprint !== fingerprintInput) return failure("STALE_VERSION", "文件内容已变化；请读取最新版本并重新审阅。");
    if (!pendingFileReviews([...current.inventory.values()], current.decisions).some((candidate) =>
      candidate.path === file.path && candidate.fingerprint === file.fingerprint,
    )) return failure("ALREADY_REVIEWED", "该内容版本已经审阅；只有内容变化后才需要重新提交结论。");
    if (!completeReadEvidence(file)) return failure("FILE_NOT_FULLY_READ", "尚未通过 Pi read 工具读取该版本的全部行；分段读取后再提交审阅结论。");

    const next = recordFileReview(persistedState(current), file, conclusion, rationale);
    const saved = persist({ ...current, decisions: next.decisions });
    if (!saved.ok) return failure(saved.code, `审阅结果未保存：${saved.message}`, true);
    current.decisions = next.decisions;
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

    const recorded = recordValueReview(
      currentSession.valueDecisions,
      scan,
      currentSession.sessionId,
      testFile.path,
      normalizedImplementations,
      conclusion as ValueConclusion,
      rationale,
    );
    if (!recorded.ok) return failure(recorded.error.code, recorded.error.message);
    const saved = persistValue({ ...currentSession, valueDecisions: recorded.value.decisions });
    if (!saved.ok) return failure(saved.code, `测试价值审阅结果未保存：${saved.message}`, true);
    currentSession.valueDecisions = recorded.value.decisions;
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
    const candidates = pending();
    const valueResult = valuePending();
    const valueCandidates: PendingTestValueReview[] = valueResult.ok ? valueResult.pending : [];

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
      const summary = kind === "test-value"
        ? `${scanStatus}${valueItems.length > 0 ? `测试价值待审 ${offset + 1}-${offset + valueItems.length}/${valueCandidates.length}` : `没有该页已发现的测试价值候选；总数 ${valueCandidates.length}`}`
        : `${scanStatus}${structureItems.length > 0 ? `结构待审 ${offset + 1}-${offset + structureItems.length}/${candidates.length}` : `没有该页已发现的结构候选；总数 ${candidates.length}`}`;
      return success(`${summary}\n${valueStatus}`, {
        candidates: structureItems,
        total: candidates.length,
        valueCandidates: valueItems,
        valueTotal: valueCandidates.length,
        valueScanComplete: valueResult.ok,
        valueError: valueResult.ok ? undefined : valueResult.error,
        offset,
        reviewKind: kind,
        scanComplete: refreshed.ok,
        errors: current.errors,
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
      return {
        generation: current.generation,
        sessionId: current.sessionId,
        files,
        candidates: pending(),
        errors: current.errors,
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
  pi.on("session_shutdown", () => {
    generation += 1;
    session = undefined;
  });
  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx) => {
    if (!event.systemPromptOptions?.sections) return;
    const state = session;
    if (!state) {
      event.systemPromptOptions.sections[REVIEW_SECTION] = "大文件审阅基线仍未完成；不得断言当前没有超限文件。";
      return;
    }
    const candidates = pending();
    const valueResult = valuePending();
    const hasValueCandidates = !valueResult.ok || valueResult.pending.length > 0;
    if (candidates.length > 0 || hasValueCandidates || state.errors.length > 0) {
      event.systemPromptOptions.sections[REVIEW_SECTION] = runtimeSection(ctx);
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
    const notices: string[] = [];
    if (result.added.length > 0) {
      notices.push(`发现 ${result.added.length} 个超过 ${FILE_REVIEW_THRESHOLD} 行的代码文件，待下轮结构审阅。`);
    }
    const valueResult = valuePending();
    if (!valueResult.ok) {
      notices.push(`测试价值候选无法确认（${valueResult.error.code}）：${valueResult.error.message}；不会推断为没有价值候选。`);
    } else if (valueResult.pending.length > 0) {
      notices.push(`有 ${valueResult.pending.length} 个测试文件待价值审阅（仅建议，不自动修改测试）。`);
    }
    if (notices.length > 0) ctx.ui.notify(notices.join("\n"), "warning");
  });

  return {
    getPending: pending,
    executeReviewTool,
    getState: () => session,
  };
}

export type FileReviewRuntime = ReturnType<typeof createFileReviewRuntime>;