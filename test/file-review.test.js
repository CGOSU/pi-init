import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FILE_REVIEW_THRESHOLD,
  countPhysicalLines,
  createFileReviewState,
  inspectProjectFile,
  pendingFileReviews,
  readFileReviewState,
  recordFileReview,
  scanProjectFiles,
} from "../src/file-review.ts";

function makeLines(count, value = "line") {
  return Array.from({ length: count }, (_, index) => `${value} ${index + 1}`).join("\n");
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-file-review-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("物理行数兼容 LF、CRLF、CR 和末尾换行", () => {
  assert.equal(countPhysicalLines(""), 0);
  assert.equal(countPhysicalLines("one"), 1);
  assert.equal(countPhysicalLines("one\n"), 1);
  assert.equal(countPhysicalLines("one\r\ntwo\r\n"), 2);
  assert.equal(countPhysicalLines("one\rtwo\r"), 2);
});

test("会话扫描发现原本已超限文件，不跟随链接并排除依赖和生成目录", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, "src"));
    await mkdir(path.join(directory, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(directory, "dist"));
    await writeFile(path.join(directory, "src", "large.ts"), makeLines(FILE_REVIEW_THRESHOLD + 1));
    await writeFile(path.join(directory, "node_modules", "pkg", "ignored.js"), makeLines(900));
    await writeFile(path.join(directory, "dist", "generated.js"), makeLines(900));

    const result = await scanProjectFiles(directory);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.files.map(({ path: filePath }) => filePath), ["src/large.ts"]);
    assert.deepEqual(pendingFileReviews(result.files, []).map(({ path: filePath, lineCount }) => [filePath, lineCount]), [
      ["src/large.ts", FILE_REVIEW_THRESHOLD + 1],
    ]);
  });
});

test("同一超限文件内容变化即使行数不变也产生新指纹并重新待审", async () => {
  await withTempDirectory(async (directory) => {
    const filePath = path.join(directory, "large.js");
    await writeFile(filePath, makeLines(FILE_REVIEW_THRESHOLD + 1, "before"));
    const initial = await scanProjectFiles(directory);
    assert.equal(initial.ok, true);
    if (!initial.ok) return;
    const file = initial.files[0];
    const state = createFileReviewState(initial.projectRoot, "session-a");
    const reviewed = recordFileReview(state, file, "keep", "职责内聚，拆分会增加共享状态。", 123);
    assert.deepEqual(pendingFileReviews(initial.files, reviewed.decisions), []);

    await writeFile(filePath, makeLines(FILE_REVIEW_THRESHOLD + 1, "after"));
    const currentStat = await lstat(filePath, { bigint: true });
    const metadataMatchedCache = [{
      ...file,
      size: currentStat.size.toString(),
      modifiedAt: currentStat.mtimeNs.toString(),
    }];
    const changed = await scanProjectFiles(directory, { previous: metadataMatchedCache, forceAll: true });
    assert.equal(changed.ok, true);
    if (!changed.ok) return;
    assert.equal(changed.files[0].lineCount, file.lineCount);
    assert.notEqual(changed.files[0].fingerprint, file.fingerprint);
    assert.deepEqual(pendingFileReviews(changed.files, reviewed.decisions).map(({ path: candidate }) => candidate), ["large.js"]);
  });
});

test("审阅记录校验项目、会话、策略版本和结论字段", async () => {
  await withTempDirectory(async (directory) => {
    const scan = await scanProjectFiles(directory);
    assert.equal(scan.ok, true);
    if (!scan.ok) return;
    const state = createFileReviewState(scan.projectRoot, "session-a");
    assert.deepEqual(readFileReviewState(state, scan.projectRoot, "session-a"), { ok: true, value: state });
    assert.equal(readFileReviewState(state, scan.projectRoot, "session-b").ok, false);
    assert.equal(readFileReviewState(state, path.join(scan.projectRoot, "other"), "session-a").ok, false);
    assert.equal(readFileReviewState({ ...state, policyVersion: 999 }, scan.projectRoot, "session-a").ok, false);
    assert.equal(readFileReviewState({ ...state, decisions: [{ path: "../outside.js" }] }, scan.projectRoot, "session-a").ok, false);
  });
});

test("单文件检查拒绝项目外路径及未覆盖的扩展名", async () => {
  await withTempDirectory(async (directory) => {
    await writeFile(path.join(directory, "outside.js"), makeLines(501));
    await mkdir(path.join(directory, "project"));
    const outside = await inspectProjectFile(path.join(directory, "project"), "../outside.js");
    assert.equal(outside.ok, false);
    if (!outside.ok) assert.equal(outside.error.code, "PATH_OUTSIDE_PROJECT");
    const unsupported = await inspectProjectFile(path.join(directory, "project"), "module.py");
    assert.equal(unsupported.ok, false);
    if (!unsupported.ok) assert.equal(unsupported.error.code, "UNSUPPORTED_FILE");
  });
});

test("扫描失败保留可区分错误，不返回成功的空项目", async () => {
  const result = await scanProjectFiles(path.join(os.tmpdir(), `missing-${Date.now()}`));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PROJECT_ROOT_UNREADABLE");
});