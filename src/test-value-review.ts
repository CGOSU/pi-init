import { extname, isAbsolute } from "node:path";
import {
  FILE_REVIEW_CODE_EXTENSIONS,
  type FileScanError,
  type FileScanResult,
  type FileSnapshot,
} from "./file-review.ts";

export const TEST_VALUE_REVIEW_POLICY_VERSION = 1;
export const TEST_VALUE_REVIEW_ENTRY_TYPE = "pi-init-test-value-review";
export const TEST_VALUE_DISCOVERY_LIMITATIONS =
  "仅按 test/、tests/、__tests__/ 目录或 *.test.*、*.spec.*、*_test.* 文件名发现；不解析语法，内嵌测试和不符合约定的文件可能遗漏。";

export type TestValueReviewConclusion = "keep" | "merge" | "rewrite" | "remove";

export type TestValueImplementationFile = {
  path: string;
  fingerprint: string;
};

export type TestValueReviewDecision = {
  testPath: string;
  testFingerprint: string;
  implementationFiles: TestValueImplementationFile[];
  policyVersion: number;
  conclusion: TestValueReviewConclusion;
  rationale: string;
  reviewedAt: number;
};

export type PersistedTestValueReviewState = {
  schemaVersion: 1;
  policyVersion: number;
  projectRoot: string;
  sessionId: string;
  decisions: TestValueReviewDecision[];
};

export type TestValueStateReadResult =
  | { ok: true; value: PersistedTestValueReviewState }
  | {
      ok: false;
      code: "INVALID_STATE" | "PROJECT_MISMATCH" | "SESSION_MISMATCH" | "POLICY_MISMATCH";
      message: string;
    };

export type TestValueReviewInputErrorCode =
  | "INVALID_STATE"
  | "PROJECT_MISMATCH"
  | "SCAN_FAILED"
  | "SCAN_INCOMPLETE"
  | "INVALID_TEST_FILE"
  | "TEST_FILE_NOT_CANDIDATE"
  | "TEST_FILE_NOT_FOUND"
  | "INVALID_IMPLEMENTATION_FILE"
  | "IMPLEMENTATION_ASSOCIATION_REQUIRED"
  | "IMPLEMENTATION_FILE_NOT_FOUND"
  | "DUPLICATE_IMPLEMENTATION_PATH"
  | "INVALID_CONCLUSION"
  | "INVALID_RATIONALE"
  | "INVALID_REVIEW_TIME";

export type TestValueReviewInputError = {
  code: TestValueReviewInputErrorCode;
  message: string;
  diagnostics?: FileScanError[];
};

export type RecordTestValueReviewResult =
  | { ok: true; value: PersistedTestValueReviewState }
  | { ok: false; error: TestValueReviewInputError };

export type TestValueInvalidation = {
  code: "POLICY_CHANGED" | "TEST_MISSING" | "TEST_CHANGED" | "IMPLEMENTATION_MISSING" | "IMPLEMENTATION_CHANGED";
  path?: string;
};

export type TestValueFreshnessError = {
  code: "INVALID_REVIEW" | "IMPLEMENTATION_ASSOCIATION_REQUIRED" | "SCAN_FAILED" | "SCAN_INCOMPLETE";
  message: string;
  diagnostics?: FileScanError[];
};

export type TestValueFreshnessResult =
  | { ok: true; current: true; invalidations: [] }
  | { ok: true; current: false; invalidations: TestValueInvalidation[] }
  | { ok: false; error: TestValueFreshnessError };

export type PendingTestValueReview = {
  file: FileSnapshot;
  invalidations: TestValueInvalidation[];
};

export type PendingTestValueReviewsResult =
  | { ok: true; pending: PendingTestValueReview[] }
  | { ok: false; error: TestValueFreshnessError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validCodePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || isAbsolute(value)) return false;
  const parts = value.split("/");
  return !parts.includes("") && !parts.includes(".") && !parts.includes("..") &&
    FILE_REVIEW_CODE_EXTENSIONS.has(extname(value).toLowerCase());
}

export function isTestValueCandidatePath(filePath: string): boolean {
  if (!validCodePath(filePath)) return false;
  const parts = filePath.split("/");
  const filename = parts.at(-1)!.toLowerCase();
  const inTestDirectory = parts.slice(0, -1).some((part) =>
    part.toLowerCase() === "test" || part.toLowerCase() === "tests" || part.toLowerCase() === "__tests__",
  );
  return inTestDirectory || /(?:\.test\.|\.spec\.|_test\.)/.test(filename);
}

export function createTestValueReviewState(projectRoot: string, sessionId: string): PersistedTestValueReviewState {
  return {
    schemaVersion: 1,
    policyVersion: TEST_VALUE_REVIEW_POLICY_VERSION,
    projectRoot,
    sessionId,
    decisions: [],
  };
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validConclusion(value: unknown): value is TestValueReviewConclusion {
  return value === "keep" || value === "merge" || value === "rewrite" || value === "remove";
}

export function readTestValueReviewState(
  value: unknown,
  projectRoot: string,
  sessionId: string,
): TestValueStateReadResult {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.decisions)) {
    return { ok: false, code: "INVALID_STATE", message: "保存的测试价值审阅状态格式无效" };
  }
  if (value.projectRoot !== projectRoot) {
    return { ok: false, code: "PROJECT_MISMATCH", message: "保存的测试价值审阅状态属于其他项目" };
  }
  if (value.sessionId !== sessionId) {
    return { ok: false, code: "SESSION_MISMATCH", message: "保存的测试价值审阅状态属于其他 Pi 会话" };
  }
  if (!Number.isInteger(value.policyVersion) || Number(value.policyVersion) < 1) {
    return { ok: false, code: "INVALID_STATE", message: "保存的测试价值审阅策略版本无效" };
  }
  if (value.policyVersion !== TEST_VALUE_REVIEW_POLICY_VERSION) {
    return { ok: false, code: "POLICY_MISMATCH", message: "保存的测试价值审阅状态使用了旧策略版本" };
  }

  const decisions: TestValueReviewDecision[] = [];
  const seenTestPaths = new Set<string>();
  for (const item of value.decisions) {
    if (
      !isRecord(item) ||
      !validCodePath(item.testPath) ||
      !isTestValueCandidatePath(item.testPath) ||
      !isFingerprint(item.testFingerprint) ||
      !Number.isInteger(item.policyVersion) ||
      Number(item.policyVersion) < 1 ||
      !Array.isArray(item.implementationFiles) ||
      item.implementationFiles.length === 0 ||
      !validConclusion(item.conclusion) ||
      typeof item.rationale !== "string" ||
      !item.rationale.trim() ||
      item.rationale.trim().length > 2000 ||
      !Number.isFinite(item.reviewedAt)
    ) {
      return { ok: false, code: "INVALID_STATE", message: "保存的测试价值审阅结果包含无效字段" };
    }
    if (seenTestPaths.has(item.testPath)) {
      return { ok: false, code: "INVALID_STATE", message: "保存的测试价值审阅状态包含重复测试路径" };
    }

    const implementationFiles: TestValueImplementationFile[] = [];
    const seenImplementationPaths = new Set<string>();
    for (const implementation of item.implementationFiles) {
      if (!isRecord(implementation) || !validCodePath(implementation.path) || !isFingerprint(implementation.fingerprint)) {
        return { ok: false, code: "INVALID_STATE", message: "保存的实现关联包含无效路径或指纹" };
      }
      if (seenImplementationPaths.has(implementation.path)) {
        return { ok: false, code: "INVALID_STATE", message: "保存的实现关联包含重复路径" };
      }
      seenImplementationPaths.add(implementation.path);
      implementationFiles.push({ path: implementation.path, fingerprint: implementation.fingerprint });
    }

    seenTestPaths.add(item.testPath);
    decisions.push({
      testPath: item.testPath,
      testFingerprint: item.testFingerprint,
      implementationFiles,
      policyVersion: Number(item.policyVersion),
      conclusion: item.conclusion,
      rationale: item.rationale.trim(),
      reviewedAt: Number(item.reviewedAt),
    });
  }

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      policyVersion: TEST_VALUE_REVIEW_POLICY_VERSION,
      projectRoot,
      sessionId,
      decisions,
    },
  };
}

export function recordTestValueReview(
  state: PersistedTestValueReviewState,
  scan: FileScanResult,
  testPath: string,
  implementationPaths: readonly string[],
  conclusion: TestValueReviewConclusion,
  rationale: string,
  reviewedAt = Date.now(),
): RecordTestValueReviewResult {
  if (
    !isRecord(state) || state.schemaVersion !== 1 ||
    state.policyVersion !== TEST_VALUE_REVIEW_POLICY_VERSION ||
    !Array.isArray(state.decisions)
  ) {
    return { ok: false, error: { code: "INVALID_STATE", message: "当前测试价值审阅状态无效或策略已过期" } };
  }
  if (!scan.ok) {
    return {
      ok: false,
      error: { code: "SCAN_FAILED", message: `${scan.error.path}: ${scan.error.message}`, diagnostics: [scan.error] },
    };
  }
  if (scan.errors.length > 0) {
    return {
      ok: false,
      error: { code: "SCAN_INCOMPLETE", message: "项目扫描不完整，无法核实测试及实现文件", diagnostics: scan.errors },
    };
  }
  if (state.projectRoot !== scan.projectRoot) {
    return { ok: false, error: { code: "PROJECT_MISMATCH", message: "测试价值状态不属于当前项目" } };
  }
  if (!validCodePath(testPath)) {
    return { ok: false, error: { code: "INVALID_TEST_FILE", message: "测试文件路径无效" } };
  }
  if (!isTestValueCandidatePath(testPath)) {
    return { ok: false, error: { code: "TEST_FILE_NOT_CANDIDATE", message: "测试文件不符合当前文件级发现约定" } };
  }
  const filesByPath = new Map(scan.files.map((file) => [file.path, file]));
  const testFile = filesByPath.get(testPath);
  if (!testFile) {
    return { ok: false, error: { code: "TEST_FILE_NOT_FOUND", message: `当前扫描中没有测试文件：${testPath}` } };
  }
  if (!Array.isArray(implementationPaths) || implementationPaths.length === 0) {
    return { ok: false, error: { code: "IMPLEMENTATION_ASSOCIATION_REQUIRED", message: "必须显式关联至少一个实现文件" } };
  }
  const implementations: TestValueImplementationFile[] = [];
  const seenImplementationPaths = new Set<string>();
  for (const implementationPath of implementationPaths) {
    if (!validCodePath(implementationPath)) {
      return { ok: false, error: { code: "INVALID_IMPLEMENTATION_FILE", message: "实现文件路径无效" } };
    }
    if (seenImplementationPaths.has(implementationPath)) {
      return { ok: false, error: { code: "DUPLICATE_IMPLEMENTATION_PATH", message: "实现关联中不能重复包含同一路径" } };
    }
    seenImplementationPaths.add(implementationPath);
    const implementation = filesByPath.get(implementationPath);
    if (!implementation) {
      return {
        ok: false,
        error: { code: "IMPLEMENTATION_FILE_NOT_FOUND", message: `当前扫描中没有关联实现文件：${implementationPath}` },
      };
    }
    implementations.push({ path: implementation.path, fingerprint: implementation.fingerprint });
  }
  if (!validConclusion(conclusion)) {
    return { ok: false, error: { code: "INVALID_CONCLUSION", message: "测试价值结论必须是 keep、merge、rewrite 或 remove" } };
  }
  if (typeof rationale !== "string" || !rationale.trim() || rationale.trim().length > 2000) {
    return { ok: false, error: { code: "INVALID_RATIONALE", message: "审阅理由不能为空且不得超过 2000 个字符" } };
  }
  if (!Number.isFinite(reviewedAt)) {
    return { ok: false, error: { code: "INVALID_REVIEW_TIME", message: "审阅时间必须是有限数值" } };
  }

  const decision: TestValueReviewDecision = {
    testPath: testFile.path,
    testFingerprint: testFile.fingerprint,
    implementationFiles: implementations,
    policyVersion: TEST_VALUE_REVIEW_POLICY_VERSION,
    conclusion,
    rationale: rationale.trim(),
    reviewedAt,
  };
  return {
    ok: true,
    value: {
      ...state,
      decisions: [...state.decisions.filter((item) => item.testPath !== testFile.path), decision],
    },
  };
}

function validDecisionForFreshness(value: unknown): value is TestValueReviewDecision {
  return isRecord(value) &&
    validCodePath(value.testPath) && isTestValueCandidatePath(value.testPath) &&
    isFingerprint(value.testFingerprint) && Number.isInteger(value.policyVersion) && Number(value.policyVersion) >= 1 &&
    Array.isArray(value.implementationFiles) &&
    value.implementationFiles.every((item) => isRecord(item) && validCodePath(item.path) && isFingerprint(item.fingerprint)) &&
    validConclusion(value.conclusion) && typeof value.rationale === "string" &&
    Boolean(value.rationale.trim()) && value.rationale.trim().length <= 2000 && Number.isFinite(value.reviewedAt);
}

export function checkTestValueReviewFreshness(
  decision: TestValueReviewDecision,
  scan: FileScanResult,
): TestValueFreshnessResult {
  if (!scan.ok) {
    return {
      ok: false,
      error: { code: "SCAN_FAILED", message: `项目扫描失败：${scan.error.path}: ${scan.error.message}`, diagnostics: [scan.error] },
    };
  }
  if (scan.errors.length > 0) {
    return {
      ok: false,
      error: { code: "SCAN_INCOMPLETE", message: "项目扫描不完整，无法核实测试及其实现版本", diagnostics: scan.errors },
    };
  }
  if (!validDecisionForFreshness(decision)) {
    return { ok: false, error: { code: "INVALID_REVIEW", message: "测试价值审阅记录格式无效" } };
  }
  if (decision.implementationFiles.length === 0) {
    return {
      ok: false,
      error: { code: "IMPLEMENTATION_ASSOCIATION_REQUIRED", message: "测试价值审阅记录没有显式关联实现文件" },
    };
  }

  const files = new Map(scan.files.map((file) => [file.path, file.fingerprint]));
  const invalidations: TestValueInvalidation[] = [];
  if (decision.policyVersion !== TEST_VALUE_REVIEW_POLICY_VERSION) {
    invalidations.push({ code: "POLICY_CHANGED" });
  }
  const currentTestFingerprint = files.get(decision.testPath);
  if (currentTestFingerprint === undefined) invalidations.push({ code: "TEST_MISSING", path: decision.testPath });
  else if (currentTestFingerprint !== decision.testFingerprint) invalidations.push({ code: "TEST_CHANGED", path: decision.testPath });

  const seenImplementationPaths = new Set<string>();
  for (const implementation of decision.implementationFiles) {
    if (seenImplementationPaths.has(implementation.path)) {
      return { ok: false, error: { code: "INVALID_REVIEW", message: "测试价值审阅记录包含重复实现路径" } };
    }
    seenImplementationPaths.add(implementation.path);
    const currentFingerprint = files.get(implementation.path);
    if (currentFingerprint === undefined) {
      invalidations.push({ code: "IMPLEMENTATION_MISSING", path: implementation.path });
    } else if (currentFingerprint !== implementation.fingerprint) {
      invalidations.push({ code: "IMPLEMENTATION_CHANGED", path: implementation.path });
    }
  }
  if (invalidations.length > 0) return { ok: true, current: false, invalidations };
  return { ok: true, current: true, invalidations: [] };
}

export function pendingTestValueReviews(
  scan: FileScanResult,
  decisions: readonly TestValueReviewDecision[],
): PendingTestValueReviewsResult {
  if (!scan.ok) {
    return {
      ok: false,
      error: { code: "SCAN_FAILED", message: `项目扫描失败：${scan.error.path}: ${scan.error.message}`, diagnostics: [scan.error] },
    };
  }
  if (scan.errors.length > 0) {
    return {
      ok: false,
      error: { code: "SCAN_INCOMPLETE", message: "项目扫描不完整，无法建立完整的测试价值候选队列", diagnostics: scan.errors },
    };
  }

  const decisionsByTestPath = new Map(decisions.map((decision) => [decision.testPath, decision]));
  const pending: PendingTestValueReview[] = [];
  for (const file of scan.files) {
    if (!isTestValueCandidatePath(file.path)) continue;
    const decision = decisionsByTestPath.get(file.path);
    if (!decision) {
      pending.push({ file, invalidations: [] });
      continue;
    }
    const freshness = checkTestValueReviewFreshness(decision, scan);
    if (!freshness.ok) return { ok: false, error: freshness.error };
    if (!freshness.current) pending.push({ file, invalidations: freshness.invalidations });
  }
  return { ok: true, pending };
}
