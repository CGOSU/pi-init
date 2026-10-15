import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createFileReviewState,
  readFileReviewState,
  recordFileReview,
  scanProjectFiles,
} from "../src/file-review.ts";
import { buildReviewCandidateQueue } from "../src/review-candidates.ts";
import {
  createTestValueReviewState,
  readTestValueReviewState,
  recordTestValueReview,
} from "../src/test-value-review.ts";

const makeLines = (count, value) => Array.from({ length: count }, (_, index) => `${value} ${index + 1}`).join("\n");

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-review-candidates-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("统一队列把短测试、超限测试和生产文件分到独立待审维度", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, "test"), { recursive: true });
    await mkdir(path.join(directory, "tests"), { recursive: true });
    await mkdir(path.join(directory, "src"), { recursive: true });
    await writeFile(path.join(directory, "test", "short.test.js"), "assert(true);\n");
    await writeFile(path.join(directory, "tests", "large.spec.js"), makeLines(501, "test"));
    await writeFile(path.join(directory, "src", "large.js"), makeLines(501, "implementation"));
    await writeFile(path.join(directory, "src", "helper.ts"), "export const value = 1;\n");

    const scan = await scanProjectFiles(directory);
    assert.equal(scan.ok, true);
    if (!scan.ok) return;
    const fileState = createFileReviewState(scan.projectRoot, "session-a");
    const testValueState = createTestValueReviewState(scan.projectRoot, "session-a");
    const initial = buildReviewCandidateQueue(
      scan,
      readFileReviewState(fileState, scan.projectRoot, "session-a"),
      readTestValueReviewState(testValueState, scan.projectRoot, "session-a"),
    );
    assert.equal(initial.ok, true);
    if (!initial.ok) return;
    assert.deepEqual(initial.candidates.map((candidate) => [
      candidate.file.path,
      candidate.structuralReviewPending,
      candidate.testValueReviewApplicable,
      candidate.testValueReviewPending,
    ]), [
      ["src/large.js", true, false, false],
      ["test/short.test.js", false, true, true],
      ["tests/large.spec.js", true, true, true],
    ]);
    const largeTest = scan.files.find((file) => file.path === "tests/large.spec.js");
    const largeSource = scan.files.find((file) => file.path === "src/large.js");
    const shortTest = scan.files.find((file) => file.path === "test/short.test.js");
    assert.ok(largeTest && largeSource && shortTest);
    const structurallyReviewed = recordFileReview(
      recordFileReview(fileState, largeTest, "keep", "大测试文件职责内聚", 1),
      largeSource,
      "keep",
      "生产模块职责内聚",
      2,
    );
    const valueReviewed = recordTestValueReview(
      testValueState,
      scan,
      shortTest.path,
      [largeSource.path],
      "keep",
      "覆盖关键业务边界",
      3,
    );
    assert.equal(valueReviewed.ok, true);
    if (!valueReviewed.ok) return;
    const afterIndependentReviews = buildReviewCandidateQueue(
      scan,
      readFileReviewState(structurallyReviewed, scan.projectRoot, "session-a"),
      readTestValueReviewState(valueReviewed.value, scan.projectRoot, "session-a"),
    );
    assert.equal(afterIndependentReviews.ok, true);
    if (!afterIndependentReviews.ok) return;
    assert.deepEqual(afterIndependentReviews.candidates.map((candidate) => [
      candidate.file.path,
      candidate.structuralReviewPending,
      candidate.testValueReviewPending,
    ]), [["tests/large.spec.js", false, true]]);

    const largeTestValueReviewed = recordTestValueReview(
      valueReviewed.value,
      scan,
      largeTest.path,
      [largeSource.path],
      "rewrite",
      "保持边界覆盖并简化重复准备",
      4,
    );
    assert.equal(largeTestValueReviewed.ok, true);
    if (!largeTestValueReviewed.ok) return;
    const complete = buildReviewCandidateQueue(
      scan,
      readFileReviewState(structurallyReviewed, scan.projectRoot, "session-a"),
      readTestValueReviewState(largeTestValueReviewed.value, scan.projectRoot, "session-a"),
    );
    assert.equal(complete.ok, true);
    if (complete.ok) assert.deepEqual(complete.candidates, []);
  });
});

test("旧结构状态与价值状态不互相迁移；策略失效会重新呈现价值候选", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, "test"), { recursive: true });
    await mkdir(path.join(directory, "src"), { recursive: true });
    await writeFile(path.join(directory, "test", "unit.test.js"), "assert(true);\n");
    await writeFile(path.join(directory, "src", "service.js"), "export function run() {}\n");
    const scan = await scanProjectFiles(directory);
    assert.equal(scan.ok, true);
    if (!scan.ok) return;

    const fileState = createFileReviewState(scan.projectRoot, "session-a");
    const valueState = createTestValueReviewState(scan.projectRoot, "session-a");
    const testFile = scan.files.find((file) => file.path === "test/unit.test.js");
    const implementation = scan.files.find((file) => file.path === "src/service.js");
    assert.ok(testFile && implementation);
    const legacyStructuralState = {
      ...fileState,
      decisions: [{
        path: "src/large.js",
        lineCount: 501,
        fingerprint: implementation.fingerprint,
        conclusion: "keep",
        rationale: "内聚",
        reviewedAt: 1,
      }],
    };
    const structuralAsValue = readTestValueReviewState(legacyStructuralState, scan.projectRoot, "session-a");
    assert.equal(structuralAsValue.ok, false);
    if (!structuralAsValue.ok) assert.equal(structuralAsValue.code, "INVALID_STATE");

    const recorded = recordTestValueReview(valueState, scan, testFile.path, [implementation.path], "keep", "必要边界覆盖", 1);
    assert.equal(recorded.ok, true);
    if (!recorded.ok) return;
    const valueAsStructural = readFileReviewState(recorded.value, scan.projectRoot, "session-a");
    assert.equal(valueAsStructural.ok, false);
    if (!valueAsStructural.ok) assert.equal(valueAsStructural.code, "INVALID_STATE");
    const stalePolicy = readTestValueReviewState({ ...recorded.value, policyVersion: 999 }, scan.projectRoot, "session-a");
    assert.equal(stalePolicy.ok, false);
    if (stalePolicy.ok) return;
    assert.equal(stalePolicy.code, "POLICY_MISMATCH");

    const queue = buildReviewCandidateQueue(
      scan,
      readFileReviewState(fileState, scan.projectRoot, "session-a"),
      stalePolicy,
    );
    assert.equal(queue.ok, true);
    if (queue.ok) {
      assert.equal(queue.candidates.length, 1);
      assert.equal(queue.candidates[0].file.path, "test/unit.test.js");
      assert.equal(queue.candidates[0].testValueReviewPending, true);
    }
  });
});

test("扫描不完整或状态校验失败时不返回貌似成功的空队列", async () => {
  const projectRoot = "/project";
  const fileState = readFileReviewState(createFileReviewState(projectRoot, "session-a"), projectRoot, "session-a");
  const valueState = readTestValueReviewState(createTestValueReviewState(projectRoot, "session-a"), projectRoot, "session-a");
  const incomplete = buildReviewCandidateQueue({
    ok: true,
    projectRoot,
    files: [],
    errors: [{ code: "DIRECTORY_UNREADABLE", path: "test", message: "permission denied" }],
  }, fileState, valueState);
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) assert.equal(incomplete.error.code, "SCAN_INCOMPLETE");

  const failed = buildReviewCandidateQueue({
    ok: false,
    error: { code: "PROJECT_ROOT_UNREADABLE", path: projectRoot, message: "missing" },
  }, fileState, valueState);
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.code, "SCAN_FAILED");

  const invalidValueState = readTestValueReviewState({ schemaVersion: 1 }, projectRoot, "session-a");
  const invalidStateQueue = buildReviewCandidateQueue({ ok: true, projectRoot, files: [], errors: [] }, fileState, invalidValueState);
  assert.equal(invalidStateQueue.ok, false);
  if (!invalidStateQueue.ok) assert.equal(invalidStateQueue.error.code, "TEST_VALUE_STATE_INVALID");
});

test("统一队列在一个维度失败时保留另一个维度候选和各自确认状态", () => {
  const projectRoot = "/project";
  const testFile = {
    path: "test/unit.test.js",
    lineCount: 2,
    fingerprint: "a".repeat(64),
    size: "20",
    modifiedAt: "1",
  };
  const largeFile = {
    path: "src/large.js",
    lineCount: 501,
    fingerprint: "b".repeat(64),
    size: "5000",
    modifiedAt: "1",
  };
  const scan = { ok: true, projectRoot, files: [testFile, largeFile], errors: [] };
  const validFileState = readFileReviewState(createFileReviewState(projectRoot, "session-a"), projectRoot, "session-a");
  const invalidValueState = readTestValueReviewState({ schemaVersion: 1 }, projectRoot, "session-a");
  const valueInvalid = buildReviewCandidateQueue(scan, validFileState, invalidValueState);

  assert.equal(valueInvalid.ok, false);
  assert.equal(valueInvalid.structuralConfirmed, true);
  assert.equal(valueInvalid.testValueConfirmed, false);
  assert.equal(valueInvalid.structuralCandidates.length, 1);
  assert.equal(valueInvalid.structuralCandidates[0].path, "src/large.js");
  assert.ok(valueInvalid.candidates.some((candidate) => candidate.testValueReviewApplicable));
  assert.ok(valueInvalid.errors.some((error) => error.code === "TEST_VALUE_STATE_INVALID"));

  const invalidFileState = readFileReviewState({
    schemaVersion: 1,
    policyVersion: 1,
    projectRoot,
    sessionId: "session-a",
    decisions: [{}],
  }, projectRoot, "session-a");
  const validValueState = readTestValueReviewState(createTestValueReviewState(projectRoot, "session-a"), projectRoot, "session-a");
  const structureInvalid = buildReviewCandidateQueue({ ...scan, files: [testFile] }, invalidFileState, validValueState);

  assert.equal(structureInvalid.structuralConfirmed, false);
  assert.equal(structureInvalid.testValueConfirmed, true);
  assert.equal(structureInvalid.testValueCandidates.length, 1);
  assert.equal(structureInvalid.candidates[0].testValueReviewPending, true);
  assert.ok(structureInvalid.errors.some((error) => error.code === "FILE_REVIEW_STATE_INVALID"));
});
