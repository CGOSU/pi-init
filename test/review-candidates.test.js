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

const makeLines = (count, value) => Array.from({ length: count }, (_, index) => `${value} ${index + 1}`).join("\n");

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-review-candidates-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("候选队列只包含超限结构文件，不因短测试文件生成候选", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, "test"), { recursive: true });
    await mkdir(path.join(directory, "src"), { recursive: true });
    await writeFile(path.join(directory, "test", "short.test.js"), "assert(true);\n");
    await writeFile(path.join(directory, "src", "large.js"), makeLines(501, "implementation"));

    const scan = await scanProjectFiles(directory);
    assert.equal(scan.ok, true);
    if (!scan.ok) return;
    const state = createFileReviewState(scan.projectRoot, "session-a");
    const queue = buildReviewCandidateQueue(
      scan,
      readFileReviewState(state, scan.projectRoot, "session-a"),
    );

    assert.equal(queue.ok, true);
    assert.equal(queue.structuralConfirmed, true);
    assert.deepEqual(queue.candidates.map((candidate) => candidate.file.path), ["src/large.js"]);
    assert.deepEqual(Object.keys(queue.candidates[0]), ["file", "structuralReviewPending"]);
    assert.equal(queue.candidates[0].structuralReviewPending, true);
  });
});

test("结构结论只完成对应内容版本，内容变化后重新成为候选", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, "src"), { recursive: true });
    const filePath = path.join(directory, "src", "large.js");
    await writeFile(filePath, makeLines(501, "initial"));
    const scan = await scanProjectFiles(directory);
    assert.equal(scan.ok, true);
    if (!scan.ok) return;
    const initialState = createFileReviewState(scan.projectRoot, "session-a");
    const file = scan.files[0];
    const recorded = recordFileReview(initialState, file, "keep", "生产模块职责内聚，无需拆分", 1);
    const completed = buildReviewCandidateQueue(
      scan,
      readFileReviewState(recorded, scan.projectRoot, "session-a"),
    );
    assert.equal(completed.ok, true);
    assert.deepEqual(completed.candidates, []);

    await writeFile(filePath, makeLines(501, "changed"));
    const changedScan = await scanProjectFiles(directory);
    assert.equal(changedScan.ok, true);
    if (!changedScan.ok) return;
    const changed = buildReviewCandidateQueue(
      changedScan,
      readFileReviewState(recorded, changedScan.projectRoot, "session-a"),
    );
    assert.equal(changed.ok, true);
    assert.deepEqual(changed.candidates.map((candidate) => candidate.file.path), ["src/large.js"]);
  });
});

test("扫描不完整或结构状态无效时不返回貌似成功的空队列", () => {
  const projectRoot = "/project";
  const file = {
    path: "src/large.js",
    lineCount: 501,
    fingerprint: "a".repeat(64),
    size: "5000",
    modifiedAt: "1",
  };
  const validState = readFileReviewState(createFileReviewState(projectRoot, "session-a"), projectRoot, "session-a");
  const incomplete = buildReviewCandidateQueue({
    ok: true,
    projectRoot,
    files: [file],
    errors: [{ code: "DIRECTORY_UNREADABLE", path: "src", message: "permission denied" }],
  }, validState);
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.structuralConfirmed, false);
  assert.equal(incomplete.candidates.length, 1);
  assert.equal(incomplete.error.code, "SCAN_INCOMPLETE");

  const failed = buildReviewCandidateQueue({
    ok: false,
    error: { code: "PROJECT_ROOT_UNREADABLE", path: projectRoot, message: "missing" },
  }, validState);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "SCAN_FAILED");

  const invalidState = readFileReviewState({ schemaVersion: 1 }, projectRoot, "session-a");
  const invalid = buildReviewCandidateQueue({ ok: true, projectRoot, files: [file], errors: [] }, invalidState);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.structuralConfirmed, false);
  assert.equal(invalid.candidates.length, 1);
  assert.equal(invalid.error.code, "FILE_REVIEW_STATE_INVALID");
});

test("策略版本不匹配会重新呈现结构候选，而不是误认已审", () => {
  const projectRoot = "/project";
  const file = {
    path: "src/large.js",
    lineCount: 501,
    fingerprint: "b".repeat(64),
    size: "5000",
    modifiedAt: "1",
  };
  const oldPolicy = readFileReviewState({
    ...createFileReviewState(projectRoot, "session-a"),
    policyVersion: 999,
    decisions: [{ path: file.path, lineCount: file.lineCount, fingerprint: file.fingerprint, conclusion: "keep", rationale: "old", reviewedAt: 1 }],
  }, projectRoot, "session-a");
  const queue = buildReviewCandidateQueue({ ok: true, projectRoot, files: [file], errors: [] }, oldPolicy);

  assert.equal(queue.ok, true);
  assert.equal(queue.structuralConfirmed, true);
  assert.deepEqual(queue.candidates.map((candidate) => candidate.file.path), [file.path]);
});
