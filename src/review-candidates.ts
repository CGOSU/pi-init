import {
  pendingFileReviews,
  type FileReviewDecision,
  type FileScanError,
  type FileScanResult,
  type FileSnapshot,
  type StateReadResult,
} from "./file-review.ts";
import {
  TEST_VALUE_DISCOVERY_LIMITATIONS,
  isTestValueCandidatePath,
  pendingTestValueReviews,
  type PendingTestValueReview,
  type TestValueFreshnessError,
  type TestValueInvalidation,
  type TestValueStateReadResult,
} from "./test-value-review.ts";

export type ReviewCandidate = {
  file: FileSnapshot;
  structuralReviewPending: boolean;
  testValueReviewApplicable: boolean;
  testValueReviewPending: boolean;
  testValueInvalidations: TestValueInvalidation[];
};

export type ReviewCandidateQueueError =
  | { code: "SCAN_FAILED"; message: string; cause: FileScanError }
  | { code: "SCAN_INCOMPLETE"; message: string; diagnostics: FileScanError[] }
  | {
      code: "FILE_REVIEW_STATE_INVALID";
      stateCode: Exclude<Extract<StateReadResult, { ok: false }>["code"], "POLICY_MISMATCH">;
      message: string;
    }
  | {
      code: "TEST_VALUE_STATE_INVALID";
      stateCode: Exclude<Extract<TestValueStateReadResult, { ok: false }>["code"], "POLICY_MISMATCH">;
      message: string;
    }
  | { code: "STATE_PROJECT_MISMATCH"; state: "file-review" | "test-value-review"; message: string }
  | { code: "TEST_VALUE_CANDIDATES_UNAVAILABLE"; cause: TestValueFreshnessError };

export type ReviewCandidateQueueResult = {
  ok: boolean;
  projectRoot?: string;
  candidates: ReviewCandidate[];
  structuralCandidates: FileSnapshot[];
  testValueCandidates: PendingTestValueReview[];
  structuralConfirmed: boolean;
  testValueConfirmed: boolean;
  structuralError?: ReviewCandidateQueueError;
  testValueError?: ReviewCandidateQueueError;
  errors: ReviewCandidateQueueError[];
  error?: ReviewCandidateQueueError;
  testDiscoveryLimitations: string;
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

function currentTestValueDecisions(result: TestValueStateReadResult) {
  if (result.ok) return { ok: true as const, decisions: result.value.decisions };
  if (result.code === "POLICY_MISMATCH") return { ok: true as const, decisions: [] };
  return {
    ok: false as const,
    error: { code: "TEST_VALUE_STATE_INVALID" as const, stateCode: result.code, message: result.message },
  };
}

export function buildReviewCandidateQueue(
  scan: FileScanResult,
  fileReviewState: StateReadResult,
  testValueReviewState: TestValueStateReadResult,
): ReviewCandidateQueueResult {
  if (!scan.ok) {
    const scanError: ReviewCandidateQueueError = {
      code: "SCAN_FAILED",
      message: `${scan.error.path}: ${scan.error.message}`,
      cause: scan.error,
    };
    const valueError: ReviewCandidateQueueError = {
      code: "TEST_VALUE_CANDIDATES_UNAVAILABLE",
      cause: {
        code: "SCAN_FAILED",
        message: `项目扫描失败：${scan.error.path}: ${scan.error.message}`,
        diagnostics: [scan.error],
      },
    };
    return {
      ok: false,
      candidates: [],
      structuralCandidates: [],
      testValueCandidates: [],
      structuralConfirmed: false,
      testValueConfirmed: false,
      structuralError: scanError,
      testValueError: valueError,
      errors: [scanError, valueError],
      error: scanError,
      testDiscoveryLimitations: TEST_VALUE_DISCOVERY_LIMITATIONS,
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

  const testValueState = currentTestValueDecisions(testValueReviewState);
  const testValueStateError = testValueState.ok ? undefined : testValueState.error;
  if (testValueStateError) errors.push(testValueStateError);
  const testValueProjectMismatch = testValueReviewState.ok && testValueReviewState.value.projectRoot !== scan.projectRoot
    ? {
        code: "STATE_PROJECT_MISMATCH" as const,
        state: "test-value-review" as const,
        message: "测试价值审阅状态不属于当前项目",
      }
    : undefined;
  if (testValueProjectMismatch) errors.push(testValueProjectMismatch);

  const structuralCandidates = pendingFileReviews(
    scan.files,
    fileState.ok && !fileProjectMismatch ? fileState.decisions : [],
  );
  const testValuePendingResult = pendingTestValueReviews(
    scan,
    testValueState.ok && !testValueProjectMismatch ? testValueState.decisions : [],
  );
  let testValueCandidates: PendingTestValueReview[] = [];
  let testValueCandidateError: ReviewCandidateQueueError | undefined;
  if (testValuePendingResult.ok) {
    testValueCandidates = testValuePendingResult.pending;
  } else {
    testValueCandidateError = {
      code: "TEST_VALUE_CANDIDATES_UNAVAILABLE",
      cause: testValuePendingResult.error,
    };
    errors.push(testValueCandidateError);
  }

  const structuralConfirmed = !scanError && !fileStateError && !fileProjectMismatch;
  const testValueConfirmed = !scanError && !testValueStateError && !testValueProjectMismatch && !testValueCandidateError;
  const structuralError = scanError ?? fileStateError ?? fileProjectMismatch;
  const testValueError = scanError ? testValueCandidateError ?? scanError : testValueStateError ?? testValueProjectMismatch ?? testValueCandidateError;
  const structuralPaths = new Set(structuralCandidates.map((file) => file.path));
  const valueByPath = new Map(testValueCandidates.map((item) => [item.file.path, item]));
  const candidates: ReviewCandidate[] = [];
  for (const file of scan.files) {
    const structuralReviewPending = structuralPaths.has(file.path);
    const valueCandidate = valueByPath.get(file.path);
    const testValueReviewPending = valueCandidate !== undefined;
    const testValueReviewApplicable = isTestValueCandidatePath(file.path);
    if (!structuralReviewPending && !testValueReviewPending) continue;
    candidates.push({
      file,
      structuralReviewPending,
      testValueReviewApplicable,
      testValueReviewPending,
      testValueInvalidations: valueCandidate?.invalidations ?? [],
    });
  }

  return {
    ok: errors.length === 0,
    projectRoot: scan.projectRoot,
    candidates,
    structuralCandidates,
    testValueCandidates,
    structuralConfirmed,
    testValueConfirmed,
    structuralError,
    testValueError,
    errors,
    error: errors[0],
    testDiscoveryLimitations: TEST_VALUE_DISCOVERY_LIMITATIONS,
  };
}
