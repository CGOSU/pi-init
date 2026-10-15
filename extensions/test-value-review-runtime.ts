import type { FileScanError, FileScanResult, FileSnapshot } from "../src/file-review.ts";
import {
  TEST_VALUE_DISCOVERY_LIMITATIONS,
  TEST_VALUE_REVIEW_ENTRY_TYPE,
  TEST_VALUE_REVIEW_POLICY_VERSION,
  pendingTestValueReviews,
  readTestValueReviewState,
  recordTestValueReview,
  type PendingTestValueReview,
  type PersistedTestValueReviewState,
  type RecordTestValueReviewResult,
  type TestValueFreshnessError,
  type TestValueReviewConclusion,
  type TestValueReviewDecision,
  type TestValueStateReadResult,
} from "../src/test-value-review.ts";

export { TEST_VALUE_DISCOVERY_LIMITATIONS };
export const TEST_VALUE_ENTRY_TYPE = TEST_VALUE_REVIEW_ENTRY_TYPE;

export type ReviewDiagnostic = {
  code: string;
  path: string;
  message: string;
};

export type TestValueReviewSessionState = {
  decisions: TestValueReviewDecision[];
  errors: ReviewDiagnostic[];
  state?: TestValueStateReadResult;
};

export function createTestValueReviewSessionState(): TestValueReviewSessionState {
  return { decisions: [], errors: [] };
}

export function testValuePersistedState(
  projectRoot: string,
  sessionId: string,
  decisions: readonly TestValueReviewDecision[],
): PersistedTestValueReviewState {
  return {
    schemaVersion: 1,
    policyVersion: TEST_VALUE_REVIEW_POLICY_VERSION,
    projectRoot,
    sessionId,
    decisions: [...decisions],
  };
}

export function restoreTestValueReviewSession(
  branchEntries: readonly { type?: string; customType?: string; data?: unknown }[],
  projectRoot: string,
  sessionId: string,
): TestValueReviewSessionState {
  const entry = [...branchEntries]
    .reverse()
    .find((item) => item.type === "custom" && item.customType === TEST_VALUE_ENTRY_TYPE);
  const entryData = entry?.data;
  const restored = readTestValueReviewState(entryData, projectRoot, sessionId);
  const sameSessionRecord = Boolean(entryData) && typeof entryData === "object"
    && (entryData as { projectRoot?: unknown }).projectRoot === projectRoot
    && (entryData as { sessionId?: unknown }).sessionId === sessionId;
  const state = restored.ok || sameSessionRecord
    ? restored
    : { ok: true as const, value: testValuePersistedState(projectRoot, sessionId, []) };
  return {
    decisions: state.ok ? state.value.decisions : [],
    errors: !restored.ok && sameSessionRecord
      ? [{ code: restored.code, path: ".", message: restored.message }]
      : [],
    state,
  };
}

export function pendingTestValueCandidates(
  files: readonly FileSnapshot[],
  errors: readonly FileScanError[],
  decisions: readonly TestValueReviewDecision[],
):
  | { ok: true; pending: PendingTestValueReview[] }
  | { ok: false; error: TestValueFreshnessError } {
  const scan: FileScanResult = { ok: true, projectRoot: "", files: [...files], errors: [...errors] };
  return pendingTestValueReviews(scan, decisions);
}

export function recordValueReview(
  decisions: readonly TestValueReviewDecision[],
  scan: FileScanResult,
  sessionId: string,
  testPath: string,
  implementationPaths: readonly string[],
  conclusion: TestValueReviewConclusion,
  rationale: string,
  reviewedAt = Date.now(),
): RecordTestValueReviewResult {
  const state = testValuePersistedState(scan.ok ? scan.projectRoot : "", sessionId, decisions);
  return recordTestValueReview(state, scan, testPath, implementationPaths, conclusion, rationale, reviewedAt);
}
