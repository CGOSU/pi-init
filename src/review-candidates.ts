import {
  pendingFileReviews,
  type FileReviewDecision,
  type FileScanError,
  type FileScanResult,
  type FileSnapshot,
  type StateReadResult,
} from "./file-review.ts";

export type ReviewCandidate = {
  file: FileSnapshot;
  structuralReviewPending: boolean;
};

export type ReviewCandidateQueueError =
  | { code: "SCAN_FAILED"; message: string; cause: FileScanError }
  | { code: "SCAN_INCOMPLETE"; message: string; diagnostics: FileScanError[] }
  | {
      code: "FILE_REVIEW_STATE_INVALID";
      stateCode: Exclude<Extract<StateReadResult, { ok: false }>["code"], "POLICY_MISMATCH">;
      message: string;
    }
  | { code: "STATE_PROJECT_MISMATCH"; state: "file-review"; message: string };

export type ReviewCandidateQueueResult = {
  ok: boolean;
  projectRoot?: string;
  candidates: ReviewCandidate[];
  structuralCandidates: FileSnapshot[];
  structuralConfirmed: boolean;
  structuralError?: ReviewCandidateQueueError;
  errors: ReviewCandidateQueueError[];
  error?: ReviewCandidateQueueError;
};

function currentFileDecisions(result: StateReadResult):
  | { ok: true; decisions: readonly FileReviewDecision[] }
  | { ok: false; error: ReviewCandidateQueueError } {
  if (result.ok) return { ok: true, decisions: result.value.decisions };
  if (result.code === "POLICY_MISMATCH") return { ok: true, decisions: [] };
  return {
    ok: false,
    error: { code: "FILE_REVIEW_STATE_INVALID", stateCode: result.code, message: result.message },
  };
}

export function buildReviewCandidateQueue(
  scan: FileScanResult,
  fileReviewState: StateReadResult,
): ReviewCandidateQueueResult {
  if (!scan.ok) {
    const error: ReviewCandidateQueueError = {
      code: "SCAN_FAILED",
      message: `${scan.error.path}: ${scan.error.message}`,
      cause: scan.error,
    };
    return {
      ok: false,
      candidates: [],
      structuralCandidates: [],
      structuralConfirmed: false,
      structuralError: error,
      errors: [error],
      error,
    };
  }

  const errors: ReviewCandidateQueueError[] = [];
  const scanError: ReviewCandidateQueueError | undefined = scan.errors.length > 0
    ? {
        code: "SCAN_INCOMPLETE",
        message: "项目扫描不完整，不能确认候选队列无遗漏",
        diagnostics: scan.errors,
      }
    : undefined;
  if (scanError) errors.push(scanError);

  const fileState = currentFileDecisions(fileReviewState);
  const fileStateError = fileState.ok ? undefined : fileState.error;
  if (fileStateError) errors.push(fileStateError);
  const fileProjectMismatch = fileReviewState.ok && fileReviewState.value.projectRoot !== scan.projectRoot
    ? {
        code: "STATE_PROJECT_MISMATCH" as const,
        state: "file-review" as const,
        message: "大文件审阅状态不属于当前项目",
      }
    : undefined;
  if (fileProjectMismatch) errors.push(fileProjectMismatch);

  const structuralCandidates = pendingFileReviews(
    scan.files,
    fileState.ok && !fileProjectMismatch ? fileState.decisions : [],
  );
  const structuralConfirmed = !scanError && !fileStateError && !fileProjectMismatch;
  const structuralError = scanError ?? fileStateError ?? fileProjectMismatch;

  return {
    ok: errors.length === 0,
    projectRoot: scan.projectRoot,
    candidates: structuralCandidates.map((file) => ({ file, structuralReviewPending: true })),
    structuralCandidates,
    structuralConfirmed,
    structuralError,
    errors,
    error: errors[0],
  };
}
