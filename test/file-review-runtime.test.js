import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createExtensionHarness,
  emitExtensionEvent,
} from "./helpers.js";

const lineCount = 501;

function makeFile(value) {
  return Array.from({ length: lineCount }, (_, index) => `${value}-${index + 1}`).join("\n");
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-file-review-runtime-"));
  try {
    await mkdir(path.join(directory, "src"));
    await writeFile(path.join(directory, "src", "large.ts"), makeFile("initial"));
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function readEvent(filePath, input = {}) {
  return {
    type: "tool_result",
    toolCallId: "read-call",
    toolName: "read",
    input: { path: filePath, ...input },
    content: [],
    details: undefined,
    isError: false,
  };
}

async function completeReview(harness, candidate, rationale = "职责内聚，拆分会增加模块跳转和共享状态。") {
  const tool = harness.tools.find((item) => item.name === "file_review");
  return tool.execute("review-call", {
    action: "complete",
    path: candidate.path,
    fingerprint: candidate.fingerprint,
    conclusion: "keep",
    rationale,
  }, undefined, undefined, harness.context);
}

test("session 启动发现已有超限文件并向 Pi 注入待审阅版本", async () => {
  await withTempDirectory(async (directory) => {
    const harness = createExtensionHarness([], { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    const event = { systemPromptOptions: { sections: {} } };
    await emitExtensionEvent(harness, "before_agent_start", event);
    const section = event.systemPromptOptions.sections.pi_init_large_file_review;
    assert.match(section, /待审文件：1/);
    assert.match(section, /src\/large\.ts/);
    assert.match(section, /不是文件上限/);
    assert.match(section, /file_review/);
  });
});

test("/large 手动重扫并报告当前项目的多语言超限文件", async () => {
  await withTempDirectory(async (directory) => {
    const harness = createExtensionHarness([], { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    await mkdir(path.join(directory, "rust"));
    await writeFile(path.join(directory, "rust", "main.rs"), makeFile("rust"));

    await harness.commands.get("large").handler("", harness.context);

    const report = harness.notifications.at(-1);
    assert.equal(report.level, "info");
    assert.match(report.message, /扫描完成：发现 2 个超过 500 行的代码文件/);
    assert.match(report.message, /src\/large\.ts · 501 行/);
    assert.match(report.message, /rust\/main\.rs · 501 行/);
  });
});

test("非代码文件的 read 结果不触发大文件扫描错误提示", async () => {
  await withTempDirectory(async (directory) => {
    const harness = createExtensionHarness([], { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    const resultHandler = harness.handlers.get("tool_result").at(-1);
    const result = await resultHandler(readEvent("README.md"), harness.context);
    assert.equal(result, undefined);
  });
});

test("完整读取当前版本并提交带理由的审阅后，结果随同一 session 恢复", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, ".pi"));
    await writeFile(path.join(directory, ".pi", "role-models.json"), JSON.stringify({
      schemaVersion: 2,
      roleModels: {
        "developer-test": { provider: "test-provider", model: "session-default", thinkingLevel: "max" },
      },
    }));
    const harness = createExtensionHarness([], { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    const tool = harness.tools.find((item) => item.name === "file_review");
    const listed = await tool.execute("list-call", { action: "list" }, undefined, undefined, harness.context);
    const candidate = listed.details.candidates[0];

    await emitExtensionEvent(harness, "tool_result", readEvent("src/large.ts"));
    const completed = await completeReview(harness, candidate);
    assert.equal(completed.details.ok, true);
    assert.equal(harness.branch.filter((entry) => entry.customType === "pi-init-file-review").length, 1);
    await emitExtensionEvent(harness, "tool_result", readEvent("src/large.ts"));
    const duplicate = await completeReview(harness, candidate);
    assert.equal(duplicate.details.code, "ALREADY_REVIEWED");

    await emitExtensionEvent(harness, "session_start", { reason: "resume" });
    const switchRole = harness.tools.find((item) => item.name === "switch_role");
    await switchRole.execute("developer-test", { role: "developer-test" }, undefined, undefined, harness.context);
    const afterResume = await tool.execute("list-call-2", { action: "list" }, undefined, undefined, harness.context);
    assert.equal(afterResume.details.total, 0);
  });
});

test("分段读取覆盖完整文件后才能确认；内容变化使旧确认失效", async () => {
  await withTempDirectory(async (directory) => {
    const harness = createExtensionHarness([], { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    const tool = harness.tools.find((item) => item.name === "file_review");
    const listed = await tool.execute("list-call", { action: "list" }, undefined, undefined, harness.context);
    const candidate = listed.details.candidates[0];

    await emitExtensionEvent(harness, "tool_result", readEvent("src/large.ts", { offset: 1, limit: 250 }));
    const incomplete = await completeReview(harness, candidate);
    assert.equal(incomplete.details.code, "FILE_NOT_FULLY_READ");

    await emitExtensionEvent(harness, "tool_result", readEvent("src/large.ts", { offset: 251, limit: 251 }));
    const completed = await completeReview(harness, candidate);
    assert.equal(completed.details.ok, true);

    await writeFile(path.join(directory, "src", "large.ts"), makeFile("modified"));
    const editEvent = {
      type: "tool_result",
      toolCallId: "edit-call",
      toolName: "edit",
      input: { path: "src/large.ts", edits: [] },
      content: [],
      structuredContent: { ok: false, reason: "original failure" },
      details: undefined,
      isError: true,
    };
    const resultHandler = harness.handlers.get("tool_result").at(-1);
    const editResult = await resultHandler(editEvent, harness.context);
    assert.match(editResult.content.at(-1).text, /大文件审阅待处理/);
    assert.deepEqual(editResult.structuredContent, editEvent.structuredContent);
    assert.equal(editEvent.isError, true);
    const refreshed = await tool.execute("list-call-2", { action: "list" }, undefined, undefined, harness.context);
    assert.equal(refreshed.details.total, 1);
    assert.notEqual(refreshed.details.candidates[0].fingerprint, candidate.fingerprint);
  });
});

test("审阅记录持久化失败时不标记已审", async () => {
  await withTempDirectory(async (directory) => {
    const harness = createExtensionHarness([], {
      cwd: directory,
      appendEntry(type) {
        if (type === "pi-init-file-review") throw new Error("session append failed");
      },
    });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    const tool = harness.tools.find((item) => item.name === "file_review");
    const listed = await tool.execute("list-call", { action: "list" }, undefined, undefined, harness.context);
    const candidate = listed.details.candidates[0];
    await emitExtensionEvent(harness, "tool_result", readEvent("src/large.ts"));

    const result = await completeReview(harness, candidate);
    assert.equal(result.details.ok, false);
    assert.equal(result.details.code, "PERSIST_FAILED");
    const pending = await tool.execute("list-call-2", { action: "list" }, undefined, undefined, harness.context);
    assert.equal(pending.details.total, 1);
  });
});

test("恢复门未解除时大文件审阅工具不执行", async () => {
  await withTempDirectory(async (directory) => {
    const branch = [{ type: "custom", customType: "pi-init-role-recovery", data: { status: "pending" } }];
    const harness = createExtensionHarness(branch, { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    const tool = harness.tools.find((item) => item.name === "file_review");
    const result = await tool.execute("list-call", { action: "list" }, undefined, undefined, harness.context);
    assert.equal(result.details.ok, false);
    assert.equal(result.details.code, "ROLE_RECOVERY_PENDING");
    assert.equal(branch.filter((entry) => entry.customType === "pi-init-file-review").length, 0);
  });
});

test("shell 写入产生的新超限文件在当前工具结果中被发现", async () => {
  await withTempDirectory(async (directory) => {
    const harness = createExtensionHarness([], { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    await writeFile(path.join(directory, "src", "new.ts"), makeFile("shell"));
    const event = {
      type: "tool_result",
      toolCallId: "bash-call",
      toolName: "bash",
      input: { command: "write source file" },
      content: [],
      details: undefined,
      isError: false,
    };
    const resultHandler = harness.handlers.get("tool_result").at(-1);
    const result = await resultHandler(event, harness.context);
    assert.match(result.content.at(-1).text, /src\/new\.ts/);
    assert.match(result.content.at(-1).text, /大文件审阅待处理/);
  });
});