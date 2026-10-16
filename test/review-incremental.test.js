import assert from "node:assert/strict";
import test from "node:test";
import {
  createIncrementalReviewState,
  incrementalReviewCandidates,
  markIncrementalReviewNotified,
  observeIncrementalReviewFiles,
  refreshIncrementalReviewCandidates,
  unnotifiedIncrementalReviewCandidates,
} from "../src/review-incremental.ts";

const file = (path, fingerprint, lineCount = 1) => ({
  path,
  fingerprint,
  lineCount,
  size: String(fingerprint.length),
  modifiedAt: "1",
});
const queue = (options = {}) => ({
  ok: true,
  candidates: [],
  structuralCandidates: [],
  testValueCandidates: [],
  structuralConfirmed: true,
  testValueConfirmed: true,
  errors: [],
  testDiscoveryLimitations: "",
  ...options,
});
const valueReview = (testFile, invalidations = []) => ({ file: testFile, invalidations });

function refresh(state, currentFiles, currentQueue, decisions = [], policies = {}) {
  refreshIncrementalReviewCandidates(
    state,
    currentQueue,
    new Map(currentFiles.map((item) => [item.path, item])),
    decisions,
    policies.structure ?? 1,
    policies.value ?? 1,
  );
}

test("已有库存不进入增量；完整观察到的新增、变化与删除更新范围", () => {
  const original = file("src/large.ts", "old", 501);
  const state = createIncrementalReviewState([original], true, 1, 1);
  refresh(state, [original], queue({ structuralCandidates: [original] }));
  assert.deepEqual(incrementalReviewCandidates(state), []);

  const changed = file(original.path, "changed", 501);
  const added = file("src/new.ts", "new", 501);
  observeIncrementalReviewFiles(state, [changed, added], true);
  assert.equal(state.changes.get(original.path), "changed");
  assert.equal(state.changes.get(added.path), "new");
  refresh(state, [changed, added], queue({ structuralCandidates: [changed, added] }));
  assert.deepEqual(incrementalReviewCandidates(state).map((candidate) => candidate.file.path), [
    "src/large.ts",
    "src/new.ts",
  ]);

  observeIncrementalReviewFiles(state, [added], true);
  assert.equal(state.changes.get(original.path), null);
  refresh(state, [added], queue({ structuralCandidates: [added] }));
  assert.deepEqual(incrementalReviewCandidates(state).map((candidate) => candidate.file.path), ["src/new.ts"]);
});

test("部分观察不推断删除；首次完整扫描补齐基线且只保留已知变化", () => {
  const known = file("src/known.ts", "before");
  const state = createIncrementalReviewState([known], false, 1, 1);
  observeIncrementalReviewFiles(state, [], false);
  assert.equal(state.changes.has(known.path), false);

  const changed = file(known.path, "after");
  const unknownBaselineFile = file("src/unseen-before-start.ts", "existing");
  observeIncrementalReviewFiles(state, [changed, unknownBaselineFile], true);
  assert.equal(state.changes.get(known.path), "after");
  assert.equal(state.changes.has(unknownBaselineFile.path), false);
  assert.equal(state.baselineComplete, true);
});

test("显式关联实现变化使未改动测试进入日常，按测试、实现和策略有效版本去重", () => {
  const testFile = file("test/service.test.js", "test-v1");
  const implementation = file("src/service.ts", "impl-v1");
  const state = createIncrementalReviewState([testFile, implementation], true, 1, 1);
  const decision = {
    testPath: testFile.path,
    testFingerprint: testFile.fingerprint,
    implementationFiles: [{ path: implementation.path, fingerprint: implementation.fingerprint }],
    policyVersion: 1,
    conclusion: "keep",
    rationale: "重要业务规则覆盖",
    reviewedAt: 1,
  };
  const changedImplementation = file(implementation.path, "impl-v2");
  observeIncrementalReviewFiles(state, [testFile, changedImplementation], true);
  const changedReview = valueReview(testFile, [{ code: "IMPLEMENTATION_CHANGED", path: implementation.path }]);
  refresh(state, [testFile, changedImplementation], queue({ testValueCandidates: [changedReview] }), [decision]);

  const first = unnotifiedIncrementalReviewCandidates(state, { structural: true, testValue: true });
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, "test-value");
  assert.match(first[0].version, /impl-v2/);
  assert.deepEqual(unnotifiedIncrementalReviewCandidates(state, { structural: true, testValue: false }), []);
  assert.equal(unnotifiedIncrementalReviewCandidates(state, { structural: true, testValue: true }).length, 1);
  markIncrementalReviewNotified(state, first);
  assert.deepEqual(unnotifiedIncrementalReviewCandidates(state, { structural: true, testValue: true }), []);

  const changedAgain = file(implementation.path, "impl-v3");
  observeIncrementalReviewFiles(state, [testFile, changedAgain], true);
  refresh(state, [testFile, changedAgain], queue({ testValueCandidates: [changedReview] }), [decision]);
  const nextVersion = unnotifiedIncrementalReviewCandidates(state, { structural: true, testValue: true });
  assert.equal(nextVersion.length, 1);
  assert.match(nextVersion[0].version, /impl-v3/);
});

test("价值通知版本包含策略变化，即使测试与实现内容未变", () => {
  const testFile = file("test/service.test.js", "test-v1");
  const implementation = file("src/service.ts", "impl-v1");
  const state = createIncrementalReviewState([testFile, implementation], true, 1, 1);
  const decision = {
    testPath: testFile.path,
    testFingerprint: testFile.fingerprint,
    implementationFiles: [{ path: implementation.path, fingerprint: implementation.fingerprint }],
    policyVersion: 1,
    conclusion: "keep",
    rationale: "显式关联的业务契约覆盖",
    reviewedAt: 1,
  };
  const changedPolicyReview = valueReview(testFile, [{ code: "POLICY_CHANGED" }]);
  refresh(
    state,
    [testFile, implementation],
    queue({ testValueCandidates: [changedPolicyReview] }),
    [decision],
    { value: 2 },
  );
  const candidate = unnotifiedIncrementalReviewCandidates(state, { structural: true, testValue: true })[0];
  assert.equal(candidate.kind, "test-value");
  assert.ok(candidate.version.includes(",2]"));
});

test("完成后退出日常范围，关联实现删除只在完整扫描后使显式测试失效", () => {
  const testFile = file("test/service.test.js", "test-v1");
  const implementation = file("src/service.ts", "impl-v1");
  const state = createIncrementalReviewState([testFile, implementation], true, 1, 1);
  const decision = {
    testPath: testFile.path,
    testFingerprint: testFile.fingerprint,
    implementationFiles: [{ path: implementation.path, fingerprint: implementation.fingerprint }],
    policyVersion: 1,
    conclusion: "keep",
    rationale: "保留业务契约回归",
    reviewedAt: 1,
  };
  const empty = queue();

  observeIncrementalReviewFiles(state, [testFile], false);
  assert.equal(state.changes.has(implementation.path), false);
  observeIncrementalReviewFiles(state, [testFile], true);
  assert.equal(state.changes.get(implementation.path), null);
  const missingReview = valueReview(testFile, [{ code: "IMPLEMENTATION_MISSING", path: implementation.path }]);
  const missingQueue = queue({ testValueCandidates: [missingReview] });
  refresh(state, [testFile], missingQueue, [decision]);
  assert.equal(incrementalReviewCandidates(state)[0].kind, "test-value");
  refresh(state, [testFile], empty, [decision]);
  assert.deepEqual(incrementalReviewCandidates(state), []);
});

test("未确认维度保留上次上下文且不消费通知水位", () => {
  const original = file("src/large.ts", "v1", 501);
  const state = createIncrementalReviewState([original], true, 1, 1);
  const changed = file(original.path, "v2", 501);
  observeIncrementalReviewFiles(state, [changed], true);
  refresh(state, [changed], queue({ structuralCandidates: [changed] }));
  const unconfirmed = queue({ structuralConfirmed: false, testValueConfirmed: false });
  refresh(state, [changed], unconfirmed);

  assert.equal(incrementalReviewCandidates(state).length, 1);
  assert.deepEqual(unnotifiedIncrementalReviewCandidates(state, { structural: false, testValue: false }), []);
  assert.equal(unnotifiedIncrementalReviewCandidates(state, { structural: true, testValue: true }).length, 1);
});
