import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  TEST_VALUE_REVIEW_POLICY_VERSION,
  checkTestValueReviewFreshness,
  createTestValueReviewState,
  isTestValueCandidatePath,
  readTestValueReviewState,
  recordTestValueReview,
} from "../src/test-value-review.ts";

const fingerprint = (value) => createHash("sha256").update(value).digest("hex");
const file = (path, value) => ({ path, fingerprint: fingerprint(value), lineCount: 1, size: "1", modifiedAt: "1" });
const scan = (...files) => ({ ok: true, projectRoot: "/project", files, errors: [] });

function recordedDecision(testFile = file("test/unit.test.ts", "test"), implementation = file("src/service.ts", "impl")) {
  const state = createTestValueReviewState("/project", "session-a");
  const result = recordTestValueReview(state, scan(testFile, implementation), testFile.path, [implementation.path], "keep", "覆盖关键边界", 123);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.decisions[0];
}

test("仅按约定的目录和文件名识别测试，明确保留发现局限", () => {
  assert.equal(isTestValueCandidatePath("test/helper.ts"), true);
  assert.equal(isTestValueCandidatePath("src/__tests__/service.js"), true);
  assert.equal(isTestValueCandidatePath("src/widget.test.ts"), true);
  assert.equal(isTestValueCandidatePath("src/widget.spec.tsx"), true);
  assert.equal(isTestValueCandidatePath("src/widget_test.rs"), true);
  assert.equal(isTestValueCandidatePath("src/test-helper.ts"), false);
  assert.equal(isTestValueCandidatePath("src/widget.ts"), false);
});

test("价值记录要求显式实现关联并绑定两侧 SHA-256 与当前策略版本", () => {
  const testFile = file("test/unit.test.ts", "test");
  const implementation = file("src/service.ts", "impl");
  const state = createTestValueReviewState("/project", "session-a");

  const currentScan = scan(testFile, implementation);
  const missingAssociation = recordTestValueReview(state, currentScan, testFile.path, [], "keep", "理由", 123);
  assert.equal(missingAssociation.ok, false);
  if (!missingAssociation.ok) assert.equal(missingAssociation.error.code, "IMPLEMENTATION_ASSOCIATION_REQUIRED");

  const result = recordTestValueReview(state, currentScan, testFile.path, [implementation.path], "merge", "覆盖重复边界", 123);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const decision = result.value.decisions[0];
  assert.equal(decision.testFingerprint, testFile.fingerprint);
  assert.deepEqual(decision.implementationFiles, [{ path: implementation.path, fingerprint: implementation.fingerprint }]);
  assert.equal(decision.policyVersion, TEST_VALUE_REVIEW_POLICY_VERSION);
  assert.equal(readTestValueReviewState(result.value, "/project", "session-a").ok, true);
});

test("记录时校验扫描、测试文件与每个显式实现关联，核验失败返回结构化错误", () => {
  const testFile = file("test/unit.test.ts", "test");
  const implementation = file("src/service.ts", "impl");
  const state = createTestValueReviewState("/project", "session-a");
  const currentScan = scan(testFile, implementation);
  const missingTest = recordTestValueReview(state, currentScan, "test/missing.test.ts", [implementation.path], "keep", "理由", 1);
  assert.equal(missingTest.ok, false);
  if (!missingTest.ok) assert.equal(missingTest.error.code, "TEST_FILE_NOT_FOUND");

  const missingImplementation = recordTestValueReview(state, currentScan, testFile.path, ["src/missing.ts"], "keep", "理由", 1);
  assert.equal(missingImplementation.ok, false);
  if (!missingImplementation.ok) assert.equal(missingImplementation.error.code, "IMPLEMENTATION_FILE_NOT_FOUND");

  const incomplete = recordTestValueReview(state, {
    ...currentScan,
    errors: [{ code: "FILE_UNREADABLE", path: "src/service.ts", message: "permission denied" }],
  }, testFile.path, [implementation.path], "keep", "理由", 1);
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) assert.equal(incomplete.error.code, "SCAN_INCOMPLETE");

  const failed = recordTestValueReview(state, {
    ok: false,
    error: { code: "PROJECT_ROOT_UNREADABLE", path: "/project", message: "missing" },
  }, testFile.path, [implementation.path], "keep", "理由", 1);
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.code, "SCAN_FAILED");
});

test("测试或任一实现版本缺失、变化以及策略变化都会使价值结论失效", () => {
  const testFile = file("test/unit.test.ts", "test");
  const implementation = file("src/service.ts", "impl");
  const decision = recordedDecision(testFile, implementation);

  assert.deepEqual(checkTestValueReviewFreshness(decision, scan(testFile, implementation)), {
    ok: true,
    current: true,
    invalidations: [],
  });
  const changedTest = checkTestValueReviewFreshness(decision, scan(file(testFile.path, "changed-test"), implementation));
  assert.equal(changedTest.ok, true);
  if (changedTest.ok) assert.deepEqual(changedTest.invalidations, [{ code: "TEST_CHANGED", path: testFile.path }]);

  const changedImplementation = checkTestValueReviewFreshness(decision, scan(testFile, file(implementation.path, "changed-impl")));
  assert.equal(changedImplementation.ok, true);
  if (changedImplementation.ok) {
    assert.deepEqual(changedImplementation.invalidations, [{ code: "IMPLEMENTATION_CHANGED", path: implementation.path }]);
  }

  const missingImplementation = checkTestValueReviewFreshness(decision, scan(testFile));
  assert.equal(missingImplementation.ok, true);
  if (missingImplementation.ok) {
    assert.deepEqual(missingImplementation.invalidations, [{ code: "IMPLEMENTATION_MISSING", path: implementation.path }]);
  }

  const missingTest = checkTestValueReviewFreshness(decision, scan(implementation));
  assert.equal(missingTest.ok, true);
  if (missingTest.ok) assert.deepEqual(missingTest.invalidations, [{ code: "TEST_MISSING", path: testFile.path }]);

  const oldPolicy = checkTestValueReviewFreshness({ ...decision, policyVersion: TEST_VALUE_REVIEW_POLICY_VERSION + 1 }, scan(testFile, implementation));
  assert.equal(oldPolicy.ok, true);
  if (oldPolicy.ok) assert.deepEqual(oldPolicy.invalidations, [{ code: "POLICY_CHANGED" }]);
});

test("记录解析区分项目、会话、策略和字段错误，并拒绝旧结构记录冒充价值记录", () => {
  const state = createTestValueReviewState("/project", "session-a");
  const testFile = file("test/unit.test.ts", "test");
  const implementation = file("src/service.ts", "impl");
  const result = recordTestValueReview(
    state,
    scan(testFile, implementation),
    testFile.path,
    [implementation.path],
    "keep",
    "理由",
    123,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(readTestValueReviewState(result.value, "/other", "session-a").ok, false);
  const otherProject = readTestValueReviewState(result.value, "/other", "session-a");
  if (!otherProject.ok) assert.equal(otherProject.code, "PROJECT_MISMATCH");
  const otherSession = readTestValueReviewState(result.value, "/project", "session-b");
  if (!otherSession.ok) assert.equal(otherSession.code, "SESSION_MISMATCH");
  const oldPolicy = readTestValueReviewState({ ...result.value, policyVersion: 999 }, "/project", "session-a");
  if (!oldPolicy.ok) assert.equal(oldPolicy.code, "POLICY_MISMATCH");
  const oldStructuralState = readTestValueReviewState({
    schemaVersion: 1,
    policyVersion: 1,
    projectRoot: "/project",
    sessionId: "session-a",
    decisions: [{ path: "src/large.ts", lineCount: 501, fingerprint: fingerprint("large"), conclusion: "keep", rationale: "内聚", reviewedAt: 1 }],
  }, "/project", "session-a");
  if (!oldStructuralState.ok) assert.equal(oldStructuralState.code, "INVALID_STATE");
  assert.equal(readTestValueReviewState({ ...result.value, decisions: [{ ...result.value.decisions[0], implementationFiles: [] }] }, "/project", "session-a").ok, false);
});

test("真实扫描失败和不完整扫描以结构化错误返回，不视为可复用结论", () => {
  const decision = recordedDecision();
  const failed = checkTestValueReviewFreshness(decision, {
    ok: false,
    error: { code: "PROJECT_ROOT_UNREADABLE", path: "/missing", message: "missing" },
  });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.code, "SCAN_FAILED");

  const incomplete = checkTestValueReviewFreshness(decision, {
    ok: true,
    projectRoot: "/project",
    files: [],
    errors: [{ code: "FILE_UNREADABLE", path: "src/service.ts", message: "permission denied" }],
  });
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) assert.equal(incomplete.error.code, "SCAN_INCOMPLETE");

  const malformed = checkTestValueReviewFreshness({ ...decision, implementationFiles: [] }, scan(file("test/unit.test.ts", "test")));
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.code, "IMPLEMENTATION_ASSOCIATION_REQUIRED");
});
