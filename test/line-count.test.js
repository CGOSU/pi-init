import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REVIEW_THRESHOLD,
  checkLineCount,
  countPhysicalLines,
  findCodeFiles,
} from "../scripts/check-line-count.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = join(projectRoot, "scripts", "check-line-count.js");

function makeLines(count, ending = "\n") {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join(ending);
}

function runChecker(directory) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [checkerPath], {
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

test("物理行数正确处理 LF、CRLF、CR 和无末尾换行", () => {
  assert.equal(countPhysicalLines(""), 0);
  assert.equal(countPhysicalLines("one"), 1);
  assert.equal(countPhysicalLines("one\n"), 1);
  assert.equal(countPhysicalLines("one\ntwo"), 2);
  assert.equal(countPhysicalLines("one\r\ntwo\r\n"), 2);
  assert.equal(countPhysicalLines("one\rtwo"), 2);
  assert.equal(countPhysicalLines("one\r\ntwo\nthree\r"), 3);
});

test("递归扫描支持的代码扩展名并排除依赖、VCS 与生成目录", async () => {
  const directory = await mkdtemp(join(projectRoot, "line-count-test-"));
  try {
    await mkdir(join(directory, "nested"), { recursive: true });
    await mkdir(join(directory, ".git"), { recursive: true });
    await mkdir(join(directory, "node_modules", "package"), { recursive: true });
    await mkdir(join(directory, "dist"), { recursive: true });
    await writeFile(join(directory, "root.ts"), "export {};");
    await writeFile(join(directory, "nested", "module.mts"), "export {};");
    await writeFile(join(directory, "nested", "module.jsx"), "export {};");
    await writeFile(join(directory, ".git", "ignored.js"), "ignored");
    await writeFile(join(directory, "node_modules", "package", "ignored.ts"), "ignored");
    await writeFile(join(directory, "dist", "ignored.js"), "ignored");

    const files = await findCodeFiles(directory);
    assert.deepEqual(
      files.map((file) => relative(directory, file).replaceAll("\\", "/")),
      ["nested/module.jsx", "nested/module.mts", "root.ts"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("大文件扫描不再通过 npm 脚本暴露", async () => {
  const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  assert.equal(manifest.scripts.test, "node --test");
  assert.equal(manifest.scripts["check:large-files"], undefined);
});

test("500 行不进入审阅队列，501 行报告候选但不会让扫描失败", async () => {
  const directory = await mkdtemp(join(projectRoot, "line-count-test-"));
  const file = join(directory, "too-many.js");
  try {
    await writeFile(file, makeLines(REVIEW_THRESHOLD));
    const belowThreshold = await checkLineCount(directory);
    assert.equal(belowThreshold.ok, true);
    assert.deepEqual(belowThreshold.candidates, []);

    await writeFile(file, makeLines(REVIEW_THRESHOLD + 1));
    const result = await checkLineCount(directory);
    assert.equal(result.ok, true);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].lineCount, REVIEW_THRESHOLD + 1);

    const processResult = await runChecker(directory);
    assert.equal(processResult.code, 0);
    assert.match(processResult.output, /too-many\.js/);
    assert.match(processResult.output, /501 lines; structural review recommended/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
