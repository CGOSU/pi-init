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

export type ReviewCandidateQueueResult =
  | {
      ok: true;
      projectRoot: string;
      candidates: ReviewCandidate[];
      testDiscoveryLimitations: string;
    }
  | { ok: false; error: ReviewCandidateQueueError };

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
    return {
      ok: false,
      error: { code: "SCAN_FAILED", message: `${scan.error.path}: ${scan.error.message}`, cause: scan.error },
    };
  }
  if (scan.errors.length > 0) {
    return {
      ok: false,
      error: {
        code: "SCAN_INCOMPLETE",
        message: "项目扫描不完整，不能确认候选队列无遗漏",
        diagnostics: scan.errors,
      },
    };
  }

  const fileState = currentFileDecisions(fileReviewState);
  if (!fileState.ok) return fileState;
  const testValueState = currentTestValueDecisions(testValueReviewState);
  if (!testValueState.ok) return testValueState;
  if (fileReviewState.ok && fileReviewState.value.projectRoot !== scan.projectRoot) {
    return {
      ok: false,
      error: { code: "STATE_PROJECT_MISMATCH", state: "file-review", message: "大文件审阅状态不属于当前项目" },
    };
  }
  if (testValueReviewState.ok && testValueReviewState.value.projectRoot !== scan.projectRoot) {
    return {
      ok: false,
      error: { code: "STATE_PROJECT_MISMATCH", state: "test-value-review", message: "测试价值审阅状态不属于当前项目" },
    };
  }

  const structuralPending = new Set(
    pendingFileReviews(scan.files, fileState.decisions).map((file) => file.path),
  );
  const testValuePendingResult = pendingTestValueReviews(scan, testValueState.decisions);
  if (!testValuePendingResult.ok) {
    return { ok: false, error: { code: "TEST_VALUE_CANDIDATES_UNAVAILABLE", cause: testValuePendingResult.error } };
  }
  const testValuePending = new Map(
    testValuePendingResult.pending.map((item) => [item.file.path, item.invalidations]),
  );

  const candidates: ReviewCandidate[] = [];
  for (const file of scan.files) {
    const structuralReviewPending = structuralPending.has(file.path);
    const invalidations = testValuePending.get(file.path);
    const testValueReviewPending = invalidations !== undefined;
    const testValueReviewApplicable = isTestValueCandidatePath(file.path);
    if (!structuralReviewPending && !testValueReviewPending) continue;
    candidates.push({
      file,
      structuralReviewPending,
      testValueReviewApplicable,
      testValueReviewPending,
      testValueInvalidations: invalidations ?? [],
    });
  }

  return {
    ok: true,
    projectRoot: scan.projectRoot,
    candidates,
    testDiscoveryLimitations: TEST_VALUE_DISCOVERY_LIMITATIONS,
  };
}
