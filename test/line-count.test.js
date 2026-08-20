import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_LINE_COUNT,
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

test("递归扫描支持的代码扩展名并排除 .git 与 node_modules", async () => {
  const directory = await mkdtemp(join(projectRoot, "line-count-test-"));
  try {
    await mkdir(join(directory, "nested"), { recursive: true });
    await mkdir(join(directory, ".git"), { recursive: true });
    await mkdir(join(directory, "node_modules", "package"), { recursive: true });
    await writeFile(join(directory, "root.ts"), "export {};");
    await writeFile(join(directory, "nested", "module.mts"), "export {};");
    await writeFile(join(directory, "nested", "ignored.jsx"), "ignored");
    await writeFile(join(directory, ".git", "ignored.js"), "ignored");
    await writeFile(join(directory, "node_modules", "package", "ignored.ts"), "ignored");

    const files = await findCodeFiles(directory);
    assert.deepEqual(
      files.map((file) => relative(directory, file).replaceAll("\\", "/")),
      ["nested/module.mts", "root.ts"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("500 行通过，501 行返回违规并报告实际路径和行数", async () => {
  const directory = await mkdtemp(join(projectRoot, "line-count-test-"));
  const file = join(directory, "too-many.js");
  try {
    await writeFile(file, makeLines(MAX_LINE_COUNT));
    assert.deepEqual((await checkLineCount(directory)).violations, []);

    await writeFile(file, makeLines(MAX_LINE_COUNT + 1));
    const result = await checkLineCount(directory);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].lineCount, MAX_LINE_COUNT + 1);

    const processResult = await runChecker(directory);
    assert.equal(processResult.code, 1);
    assert.match(processResult.output, /too-many\.js/);
    assert.match(processResult.output, /501 lines/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
