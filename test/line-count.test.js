import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REVIEW_THRESHOLD,
  checkLineCount,
  countPhysicalLines,
  findCodeFiles,
  recordFileReviewDecision,
} from "../scripts/check-line-count.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = join(projectRoot, "scripts", "check-line-count.js");

function makeLines(count, ending = "\n") {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join(ending);
}

function runChecker(directory, args = []) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [checkerPath, ...args], {
      cwd: directory,
      encoding: "utf8",
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code, output }));
  });
}

test("countPhysicalLines 处理空文本及 LF/CRLF/CR 换行边界", () => {
  assert.equal(countPhysicalLines(""), 0);
  assert.equal(countPhysicalLines("one"), 1);
  assert.equal(countPhysicalLines("one\n"), 1);
  assert.equal(countPhysicalLines("one\r\ntwo\r\n"), 2);
  assert.equal(countPhysicalLines("one\rtwo\r"), 2);
});

test("递归扫描支持的代码扩展名并排除依赖、VCS、缓存与临时目录", async () => {
  const directory = await mkdtemp(join(projectRoot, "line-count-test-"));
  try {
    await mkdir(join(directory, "nested"), { recursive: true });
    await mkdir(join(directory, ".git"), { recursive: true });
    await mkdir(join(directory, "node_modules", "package"), { recursive: true });
    await mkdir(join(directory, "dist"), { recursive: true });
    await mkdir(join(directory, ".pi-graph"), { recursive: true });
    await mkdir(join(directory, ".pi", "diagnostics"), { recursive: true });
    await mkdir(join(directory, ".pi", "extensions"), { recursive: true });
    await mkdir(join(directory, ".tmp-work"), { recursive: true });
    await writeFile(join(directory, "root.ts"), "export {};");
    await writeFile(join(directory, "nested", "module.mts"), "export {};");
    await writeFile(join(directory, "nested", "module.jsx"), "export {};");
    await writeFile(join(directory, ".pi", "extensions", "keep.ts"), "export {};");
    await writeFile(join(directory, ".git", "ignored.js"), "ignored");
    await writeFile(join(directory, "node_modules", "package", "ignored.ts"), "ignored");
    await writeFile(join(directory, "dist", "ignored.js"), "ignored");
    await writeFile(join(directory, ".pi-graph", "ignored.ts"), "ignored");
    await writeFile(join(directory, ".pi", "diagnostics", "ignored.ts"), "ignored");
    await writeFile(join(directory, ".tmp-work", "temp.ts"), "export {};");

    const files = await findCodeFiles(directory);
    assert.deepEqual(
      files.map((file) => relative(directory, file).replaceAll("\\", "/")),
      [".pi/extensions/keep.ts", "nested/module.jsx", "nested/module.mts", "root.ts"],
    );

    const withTemp = await findCodeFiles(directory, { includeTemporary: true });
    assert.ok(withTemp.some((file) => relative(directory, file).replaceAll("\\", "/") === ".tmp-work/temp.ts"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("500 行不进入审阅队列，501 行报告候选，支持 scope/exclude 与增量指纹账本", async () => {
  const directory = await mkdtemp(join(projectRoot, "line-count-test-"));
  try {
    await mkdir(join(directory, "src", "generated"), { recursive: true });
    const file = join(directory, "src", "too-many.js");
    const generated = join(directory, "src", "generated", "big.js");
    await writeFile(file, makeLines(REVIEW_THRESHOLD));
    await writeFile(generated, makeLines(REVIEW_THRESHOLD + 5));

    const belowThreshold = await checkLineCount(directory, REVIEW_THRESHOLD, { exclude: ["src/generated"] });
    assert.equal(belowThreshold.ok, true);
    assert.deepEqual(belowThreshold.candidates, []);

    await writeFile(file, makeLines(REVIEW_THRESHOLD + 1));
    const result = await checkLineCount(directory, REVIEW_THRESHOLD, { scope: "src", exclude: ["src/generated"] });
    assert.equal(result.ok, true);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].path, "src/too-many.js");
    assert.equal(result.candidates[0].lineCount, REVIEW_THRESHOLD + 1);
    const fingerprint = result.candidates[0].fingerprint;

    const processResult = await runChecker(directory, ["--scope", "src", "--exclude", "src/generated"]);
    assert.equal(processResult.code, 0);
    assert.match(processResult.output, /src\/too-many\.js: 501 lines; structural review recommended/);

    const badRecord = await runChecker(directory, ["record", "src/too-many.js", "keep", "too short"]);
    assert.equal(badRecord.code, 1);
    assert.match(badRecord.output, /INVALID_RATIONALE/);

    const staleRecord = await recordFileReviewDecision(directory, {
      path: "src/too-many.js",
      conclusion: "keep",
      rationale: "职责单一且边界稳定，暂不拆分。",
      fingerprint: "0".repeat(64),
    });
    assert.equal(staleRecord.ok, false);
    assert.equal(staleRecord.code, "STALE_VERSION");

    const recordCli = await runChecker(directory, [
      "record", "src/too-many.js", "keep", "职责单一且边界稳定，暂不拆分。", "--fingerprint", fingerprint,
    ]);
    assert.equal(recordCli.code, 0, recordCli.output);
    assert.match(recordCli.output, /src\/too-many\.js: recorded keep/);

    const afterRecord = await checkLineCount(directory, REVIEW_THRESHOLD, { scope: "src", exclude: ["src/generated"] });
    assert.equal(afterRecord.ok, true);
    assert.deepEqual(afterRecord.candidates, []);
    assert.equal(afterRecord.reviewed.length, 1);

    const allCli = await runChecker(directory, ["scan", "--scope", "src", "--exclude", "src/generated", "--all"]);
    assert.equal(allCli.code, 0);
    assert.match(allCli.output, /src\/too-many\.js: 501 lines; reviewed=keep/);

    await writeFile(file, makeLines(REVIEW_THRESHOLD + 2));
    const afterModify = await checkLineCount(directory, REVIEW_THRESHOLD, { scope: "src", exclude: ["src/generated"] });
    assert.equal(afterModify.candidates.length, 1);
    assert.equal(afterModify.candidates[0].lineCount, REVIEW_THRESHOLD + 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("拒绝项目外路径、低于阈值文件、损坏或符号链接账本", async (t) => {
  const directory = await mkdtemp(join(projectRoot, "line-count-test-"));
  try {
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "src", "small.ts"), makeLines(10));
    await writeFile(join(directory, "src", "large.ts"), makeLines(REVIEW_THRESHOLD + 1));

    const outside = await recordFileReviewDecision(directory, {
      path: "../outside.ts",
      conclusion: "keep",
      rationale: "不能允许越界路径写入账本。",
    });
    assert.equal(outside.ok, false);
    assert.equal(outside.code, "PATH_OUTSIDE_PROJECT");

    const small = await recordFileReviewDecision(directory, {
      path: "src/small.ts",
      conclusion: "keep",
      rationale: "未超过阈值的文件无需登记。",
    });
    assert.equal(small.ok, false);
    assert.equal(small.code, "BELOW_THRESHOLD");

    await mkdir(join(directory, ".pi"), { recursive: true });
    await writeFile(join(directory, ".pi", "file-review.json"), "{corrupt");
    const corrupt = await runChecker(directory);
    assert.equal(corrupt.code, 1);
    assert.match(corrupt.output, /INVALID_LEDGER/);

    await rm(join(directory, ".pi", "file-review.json"));
    const targetFile = join(directory, "external.json");
    await writeFile(targetFile, JSON.stringify({ schemaVersion: 1, decisions: [] }));
    try {
      await symlink(targetFile, join(directory, ".pi", "file-review.json"), "file");
    } catch (error) {
      if (process.platform === "win32" && error.code === "EPERM") {
        t.skip("File symlinks require Windows developer mode or elevated permissions.");
        return;
      }
      throw error;
    }
    const unsafe = await runChecker(directory);
    assert.equal(unsafe.code, 1);
    assert.match(unsafe.output, /UNSAFE_LEDGER_PATH/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
