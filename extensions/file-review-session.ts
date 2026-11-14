import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFileReviewJournalEntry, restoreFileReviewJournal } from "../src/file-review-journal.ts";
import { reviewPathSelected, type FileReviewScanScope, type FileReviewExclusion } from "../src/file-review-scope.ts";
import { FILE_REVIEW_ENTRY_TYPE, FILE_REVIEW_POLICY_VERSION, FILE_REVIEW_THRESHOLD, normalizeFileReviewError, inspectProjectFile, recordFileReview, scanProjectFiles, type FileScanError, type FileScanResult, type FileSnapshot, type PersistedFileReviewState, type StateReadResult } from "../src/file-review.ts";
import { buildReviewCandidateQueue, type ReviewCandidateQueueError } from "../src/review-candidates.ts";
import { createIncrementalReviewState, markIncrementalReviewNotified, observeIncrementalReviewFiles, refreshIncrementalReviewCandidates, unnotifiedIncrementalReviewCandidates, type IncrementalReviewCandidate, type IncrementalReviewState } from "../src/review-incremental.ts";
import { hasCompleteCoverage, mergeCoverage, type FileCoverage } from "./file-review-coverage.ts";
import type { LargeReviewSnapshot } from "./large-command.ts";

export function branchEntryIds(ctx: ExtensionContext) {
  return ctx.sessionManager.getBranch().map((entry) => entry.id);
}

function branchIdsContinue(currentIds: readonly string[], previousIds: readonly string[]) {
  return previousIds.length <= currentIds.length
    && previousIds.every((entryId, index) => currentIds[index] === entryId);
}

function branchContinuesFrom(ctx: ExtensionContext, previousIds: readonly string[]) {
  return branchIdsContinue(branchEntryIds(ctx), previousIds);
}

export type ReviewDiagnostic = { code: string; path: string; message: string };

export type ReviewSession = {
  generation: number;
  projectRoot: string;
  sessionId: string;
  branchIds: string[];
  inventory: Map<string, FileSnapshot>;
  errors: ReviewDiagnostic[];
  scanErrors: FileScanError[];
  fileReviewState: StateReadResult;
  readCoverage: Map<string, FileCoverage>;
  reviewRevision: number;
  scanScope: FileReviewScanScope;
  excluded: FileReviewExclusion[];
  incremental: IncrementalReviewState;
};

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

/** Owns generation, inventory, exact-version coverage, and append-before-memory journal commits. */
export function createFileReviewSession(appendJournal: (entry: ReturnType<typeof createFileReviewJournalEntry>) => void) {
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

  function markNotified(current: ReviewSession, candidates: readonly IncrementalReviewCandidate[]) {
    markIncrementalReviewNotified(current.incremental, candidates);
  }

  function persist(sessionToSave: ReviewSession, previous: PersistedFileReviewState) {
    try {
      appendJournal(createFileReviewJournalEntry(previous, persistedState(sessionToSave), sessionToSave.reviewRevision + 1));
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
    requestedScope?: FileReviewScanScope,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const current = session;
    if (!current || current.generation !== generation) {
      return { ok: false, code: "SESSION_NOT_READY", message: "当前 Pi session 尚未完成项目扫描" };
    }
    const previousFiles = [...current.inventory.values()];
    const branchIds = branchEntryIds(ctx);
    if (!branchIdsContinue(branchIds, current.branchIds)) {
      return { ok: false, code: "STALE_SESSION", message: "当前 session branch 已变化，扫描结果未应用" };
    }
    const scanScope = requestedScope ?? current.scanScope;
    const result = await scanProjectFiles(current.projectRoot, { previous: previousFiles, forcePaths, forceAll, ...scanScope });
    if (session !== current || current.generation !== generation || ctx.sessionManager.getSessionId() !== current.sessionId
      || !branchContinuesFrom(ctx, branchIds) || !branchContinuesFrom(ctx, current.branchIds)) {
      return { ok: false, code: "STALE_SESSION", message: "扫描期间 Pi session 已变化，结果未应用" };
    }
    if (!result.ok) {
      current.errors = [result.error];
      current.scanErrors = [result.error];
      return { ok: false, code: result.error.code, message: result.error.message };
    }

    if (requestedScope && JSON.stringify(requestedScope) !== JSON.stringify(current.scanScope)) current.readCoverage.clear();
    current.scanScope = scanScope;
    current.excluded = result.excluded ?? [];
    const next = new Map([...current.inventory].filter(([path]) => reviewPathSelected(path, scanScope)));
    if (result.errors.length === 0) next.clear();
    for (const file of result.files) {
      const previous = current.inventory.get(file.path);
      if (previous && previous.fingerprint !== file.fingerprint) current.readCoverage.delete(file.path);
      next.set(file.path, file);
    }
    current.inventory = next;
    current.errors = result.errors;
    current.scanErrors = result.errors;
    observeIncrementalReviewFiles(current.incremental, result.files, result.errors.length === 0);
    return result.errors.length === 0
      ? { ok: true }
      : {
        ok: false, code: "PARTIAL_SCAN",
        message: `${result.errors.length} 个路径无法扫描：\n${result.errors.slice(0, 3)
          .map((error) => `${error.path || "."} [${error.code}] ${error.message}`).join("\n")}${result.errors.length > 3 ? `\n另有 ${result.errors.length - 3} 个错误，可通过 /large 查看。` : ""}`,
      };
  }

  async function restore(ctx: ExtensionContext, preserveScope = false) {
    const thisGeneration = ++generation;
    const scanScope = preserveScope && session?.sessionId === ctx.sessionManager.getSessionId() ? session.scanScope : {};
    session = undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const branchIds = branchEntryIds(ctx);
    const scan = await scanProjectFiles(ctx.cwd, scanScope);
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
        reviewRevision: 0, scanScope, excluded: [],
        incremental: createIncrementalReviewState([], false),
      };
      return;
    }

    const branch = ctx.sessionManager.getBranch();
    const journal = restoreFileReviewJournal(branch.filter(item => item.type === "custom" && item.customType === FILE_REVIEW_ENTRY_TYPE)
      .map(item => item.type === "custom" ? item.data : undefined), scan.projectRoot, sessionId);
    const fileReviewState = journal.state;
    session = {
      generation: thisGeneration,
      projectRoot: scan.projectRoot,
      sessionId,
      branchIds,
      inventory: new Map(scan.files.map((file) => [file.path, file])),
      fileReviewState,
      errors: [
        ...scan.errors,
        ...(!fileReviewState.ok ? [{ code: fileReviewState.code, path: ".", message: fileReviewState.message }] : []),
      ],
      scanErrors: scan.errors,
      readCoverage: new Map(),
      reviewRevision: journal.revision, scanScope, excluded: scan.excluded ?? [],
      incremental: createIncrementalReviewState(scan.files, scan.errors.length === 0),
    };
  }

  async function refreshSpecificFile(ctx: ExtensionContext, pathInput: string) {
    const current = session;
    if (!current || current.generation !== generation) {
      return { ok: false as const, code: "SESSION_NOT_READY", message: "当前 Pi session 尚未完成项目扫描" };
    }
    const branchIds = branchEntryIds(ctx);
    if (!branchIdsContinue(branchIds, current.branchIds)) {
      return { ok: false as const, code: "STALE_SESSION", message: "当前 session branch 已变化，检查结果未应用" };
    }
    const inspected = await inspectProjectFile(current.projectRoot, pathInput);
    if (session !== current || current.generation !== generation || ctx.sessionManager.getSessionId() !== current.sessionId
      || !branchContinuesFrom(ctx, branchIds) || !branchContinuesFrom(ctx, current.branchIds)) {
      return { ok: false as const, code: "STALE_SESSION", message: "检查期间 Pi session 已变化，结果未应用" };
    }
    if (!inspected.ok) {
      current.errors = [...current.errors.filter((error) => error.path !== inspected.error.path), inspected.error];
      current.scanErrors = [...current.scanErrors.filter((error) => error.path !== inspected.error.path), inspected.error];
      return { ok: false as const, code: inspected.error.code, message: inspected.error.message };
    }
    if (reviewPathSelected(inspected.file.path, current.scanScope)) applyFileSnapshot(current, inspected.file);
    return { ok: true as const, file: inspected.file };
  }

  function completeReadEvidence(file: FileSnapshot) {
    return hasCompleteCoverage(session?.readCoverage.get(file.path), file);
  }

  function applyFileSnapshot(current: ReviewSession, file: FileSnapshot) {
    const previous = current.inventory.get(file.path);
    if (previous && previous.fingerprint !== file.fingerprint) current.readCoverage.delete(file.path);
    current.inventory.set(file.path, file);
    observeIncrementalReviewFiles(current.incremental, [file], false);
    current.errors = current.errors.filter((error) => error.path !== file.path);
    current.scanErrors = current.scanErrors.filter((error) => error.path !== file.path);
  }

  function isCurrent(current: ReviewSession | undefined, ctx: ExtensionContext, previousIds?: readonly string[]): current is ReviewSession {
    return current !== undefined && session === current && current.generation === generation
      && ctx.sessionManager.getSessionId() === current.sessionId
      && branchContinuesFrom(ctx, current.branchIds)
      && (previousIds === undefined || branchContinuesFrom(ctx, previousIds));
  }

  function recordRead(current: ReviewSession, file: FileSnapshot, start: number, end: number) {
    if (session !== current || current.inventory.get(file.path)?.fingerprint !== file.fingerprint) return;
    mergeCoverage(current.readCoverage, file, start, end);
  }

  function recordReview(current: ReviewSession, file: FileSnapshot, conclusion: "keep" | "recommend-split", rationale: string) {
    if (session !== current) return { ok: false as const, code: "STALE_SESSION", message: "当前 session 已变化，审阅未保存" };
    const next = recordFileReview(persistedState(current), file, conclusion, rationale);
    const saved = persist({ ...current, fileReviewState: { ok: true, value: next } }, persistedState(current));
    if (!saved.ok) return saved;
    current.fileReviewState = { ok: true, value: next };
    current.reviewRevision += 1;
    current.readCoverage.delete(file.path);
    return { ok: true as const };
  }

  function getSnapshot(): LargeReviewSnapshot | undefined {
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
      scanScope: current.scanScope,
      excluded: current.excluded,
      errors,
    };
  }

  function shutdown() { generation += 1; session = undefined; }
  return { getState: () => session, candidateQueue, pending, unnotifiedCandidates, markNotified, scanCurrent, restore, refreshSpecificFile, completeReadEvidence, applyFileSnapshot, isCurrent, recordRead, recordReview, getSnapshot, shutdown };
}

export type FileReviewSession = ReturnType<typeof createFileReviewSession>;
