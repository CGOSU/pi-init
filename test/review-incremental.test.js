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
  structuralConfirmed: true,
  errors: [],
  ...options,
});

function refresh(state, currentQueue, policyVersion = 1) {
  refreshIncrementalReviewCandidates(state, currentQueue, policyVersion);
}

test("已有库存不进入增量；新增、变化与完整扫描发现的删除更新结构范围", () => {
  const original = file("src/large.ts", "old", 501);
  const state = createIncrementalReviewState([original], true);
  refresh(state, queue({ structuralCandidates: [original] }));
  assert.deepEqual(incrementalReviewCandidates(state), []);

  const changed = file(original.path, "changed", 501);
  const added = file("src/new.ts", "new", 501);
  observeIncrementalReviewFiles(state, [changed, added], true);
  assert.equal(state.changes.get(original.path), "changed");
  assert.equal(state.changes.get(added.path), "new");
  refresh(state, queue({ structuralCandidates: [changed, added] }));
  assert.deepEqual(incrementalReviewCandidates(state).map((candidate) => candidate.file.path), [
    "src/large.ts",
    "src/new.ts",
  ]);

  observeIncrementalReviewFiles(state, [added], true);
  assert.equal(state.changes.get(original.path), null);
  refresh(state, queue({ structuralCandidates: [added] }));
  assert.deepEqual(incrementalReviewCandidates(state).map((candidate) => candidate.file.path), ["src/new.ts"]);
});

test("短测试变化不会由增量状态自行形成结构候选", () => {
  const existing = file("src/large.ts", "baseline", 501);
  const state = createIncrementalReviewState([existing], true);
  const shortTest = file("test/service.test.js", "new-test");
  observeIncrementalReviewFiles(state, [existing, shortTest], true);

  assert.equal(state.changes.get(shortTest.path), shortTest.fingerprint);
  refresh(state, queue());
  assert.deepEqual(incrementalReviewCandidates(state), []);
});

test("部分观察不推断删除；首次完整扫描补齐基线", () => {
  const known = file("src/known.ts", "before");
  const state = createIncrementalReviewState([known], false);
  observeIncrementalReviewFiles(state, [], false);
  assert.equal(state.changes.has(known.path), false);

  const changed = file(known.path, "after");
  const unknownBaselineFile = file("src/unseen-before-start.ts", "existing");
  observeIncrementalReviewFiles(state, [changed, unknownBaselineFile], true);
  assert.equal(state.changes.get(known.path), "after");
  assert.equal(state.changes.has(unknownBaselineFile.path), false);
  assert.equal(state.baselineComplete, true);
});

test("未确认时保留结构候选且不消费通知水位；新版本可再次通知", () => {
  const original = file("src/large.ts", "v1", 501);
  const state = createIncrementalReviewState([original], true);
  const changed = file(original.path, "v2", 501);
  observeIncrementalReviewFiles(state, [changed], true);
  refresh(state, queue({ structuralCandidates: [changed] }), 1);

  const first = unnotifiedIncrementalReviewCandidates(state, true);
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, "structure");
  assert.match(first[0].version, /v2/);
  assert.deepEqual(unnotifiedIncrementalReviewCandidates(state, false), []);
  assert.equal(unnotifiedIncrementalReviewCandidates(state, true).length, 1);
  markIncrementalReviewNotified(state, first);
  assert.deepEqual(unnotifiedIncrementalReviewCandidates(state, true), []);

  const changedAgain = file(original.path, "v3", 501);
  observeIncrementalReviewFiles(state, [changedAgain], true);
  refresh(state, queue({ structuralCandidates: [changedAgain] }), 1);
  const nextVersion = unnotifiedIncrementalReviewCandidates(state, true);
  assert.equal(nextVersion.length, 1);
  assert.match(nextVersion[0].version, /v3/);
});
