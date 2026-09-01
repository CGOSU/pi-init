import assert from "node:assert/strict";
import test from "node:test";

import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createExtensionHarness,
  emitExtensionEvent,
  path,
  readFile,
  writeFile,
  withTempDirectory,
} from "./helpers.js";
import {
  EDIT_GUARD_CODES,
  classifyEditArguments,
  classifyEditError,
} from "../extensions/edit-guard.ts";

test("合法 edit 参数原样通过且不被修改", () => {
  const input = {
    path: "src/example.ts",
    edits: [{ oldText: "const before = 1;", newText: "const after = 2;" }],
  };

  const result = classifyEditArguments(input);

  assert.deepEqual(result, { kind: "allow", input });
  assert.equal(result.kind, "allow");
  assert.equal(result.input, input);
});

test("read 形状误传给 edit 时 fail-closed 并返回稳定诊断码", () => {
  const result = classifyEditArguments({ path: "src/example.ts", offset: 10, limit: 20 });

  assert.deepEqual(result, {
    kind: "reject",
    code: EDIT_GUARD_CODES.readArguments,
    message: "edit 只接受 path 和非空 edits；读取文件请调用 read。",
  });
});

test("缺少 edits 或传入空 edits 时拒绝且不猜测修复", () => {
  for (const input of [
    { path: "src/example.ts" },
    { path: "src/example.ts", edits: [] },
  ]) {
    const result = classifyEditArguments(input);
    assert.equal(result.kind, "reject");
    assert.equal(result.code, EDIT_GUARD_CODES.invalidArguments);
    assert.match(result.message, /edits/);
    assert.equal("input" in result, false);
  }
});

test("重复匹配错误映射为稳定诊断", () => {
  const error = new Error(
    "Found 2 occurrences of edits[0] in src/example.ts. Each oldText must be unique. Please provide more context to make it unique.",
  );

  assert.deepEqual(classifyEditError(error), {
    kind: "reject",
    code: EDIT_GUARD_CODES.duplicateMatch,
    message: "edit 的 oldText 匹配不唯一；请重新读取并补充唯一上下文。",
  });
});

test("重叠错误映射为稳定诊断", () => {
  const error = new Error(
    "edits[1] and edits[0] overlap in src/example.ts. Merge them into one edit or target disjoint regions.",
  );

  assert.deepEqual(classifyEditError(error), {
    kind: "reject",
    code: EDIT_GUARD_CODES.overlap,
    message: "edit 的替换区域重叠；请合并相邻或重叠改动。",
  });
});

test("未知文件、权限、编码和其他错误保持原错误", () => {
  const errors = [
    new Error("Could not edit file: missing.ts. Error code: ENOENT."),
    new Error("Error code: EACCES"),
    new Error("Invalid UTF-8 input"),
    new Error("No changes made to src/example.ts."),
    "unrecognized failure",
  ];

  for (const error of errors) {
    const result = classifyEditError(error);
    assert.equal(result.kind, "pass-through");
    assert.equal(result.error, error);
  }
});

test("扩展覆盖 edit 并保留内置 schema、提示元数据和 renderer", async () => {
  const harness = createExtensionHarness();
  const edit = harness.tools.find((tool) => tool.name === "edit");
  const native = createEditToolDefinition(process.cwd());

  assert.ok(edit);
  assert.equal(harness.tools.filter((tool) => tool.name === "edit").length, 1);
  assert.equal(edit.description, native.description);
  assert.deepEqual(edit.parameters, native.parameters);
  assert.equal(edit.promptSnippet, native.promptSnippet);
  assert.deepEqual(edit.promptGuidelines, native.promptGuidelines);
  assert.equal(typeof edit.renderCall, "function");
  assert.equal(typeof edit.renderResult, "function");
  await emitExtensionEvent(harness, "session_start");
  assert.equal(harness.tools.filter((tool) => tool.name === "edit").length, 1);
});

test("扩展 edit 合法调用委托内置实现并返回标准 diff", async () => {
  await withTempDirectory(async (directory) => {
    const harness = createExtensionHarness([], { cwd: directory });
    const edit = harness.tools.find((tool) => tool.name === "edit");
    const filePath = path.join(directory, "example.txt");
    await writeFile(filePath, "before\n", "utf8");

    const result = await edit.execute("edit", {
      path: "example.txt",
      edits: [{ oldText: "before", newText: "after" }],
    }, undefined, undefined, harness.context);

    assert.match(result.content[0].text, /Successfully replaced 1 block/);
    assert.equal(typeof result.details.diff, "string");
    assert.equal(await readFile(filePath, "utf8"), "after\n");
    assert.equal(harness.sentMessages.length, 0);
  });
});

test("扩展 edit 对 read 形状参数在校验前拒绝且不写文件", async () => {
  await withTempDirectory(async (directory) => {
    const harness = createExtensionHarness([], { cwd: directory });
    const edit = harness.tools.find((tool) => tool.name === "edit");
    const filePath = path.join(directory, "example.txt");
    await writeFile(filePath, "unchanged\n", "utf8");

    assert.throws(
      () => edit.prepareArguments({ path: "example.txt", offset: 1, limit: 1 }),
      /^Error: \[edit\.read-arguments\]/,
    );
    assert.equal(await readFile(filePath, "utf8"), "unchanged\n");
  });
});

test("扩展 edit 对重复匹配和重叠替换拒绝写入", async () => {
  await withTempDirectory(async (directory) => {
    const harness = createExtensionHarness([], { cwd: directory });
    const edit = harness.tools.find((tool) => tool.name === "edit");
    const filePath = path.join(directory, "example.txt");
    const original = "same\nsame\nabcdef\n";
    await writeFile(filePath, original, "utf8");

    await assert.rejects(
      edit.execute("duplicate", { path: "example.txt", edits: [{ oldText: "same", newText: "changed" }] }, undefined, undefined, harness.context),
      /\[edit\.duplicate-match\]/,
    );
    await assert.rejects(
      edit.execute("overlap", {
        path: "example.txt",
        edits: [{ oldText: "abcdef", newText: "x" }, { oldText: "cde", newText: "y" }],
      }, undefined, undefined, harness.context),
      /\[edit\.overlap\]/,
    );
    assert.equal(await readFile(filePath, "utf8"), original);
  });
});

test("扩展 edit 的未知执行错误保持真实失败", async () => {
  const harness = createExtensionHarness([], { cwd: process.cwd() });
  const edit = harness.tools.find((tool) => tool.name === "edit");

  await assert.rejects(
    edit.execute("missing", {
      path: "file-that-does-not-exist.txt",
      edits: [{ oldText: "x", newText: "y" }],
    }, undefined, undefined, harness.context),
    (error) => {
      assert.match(error.message, /Could not edit file/);
      assert.doesNotMatch(error.message, /\[edit\./);
      return true;
    },
  );
});
