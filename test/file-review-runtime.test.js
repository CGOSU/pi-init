import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createExtensionHarness,
  createWorkflowState,
  emitExtensionEvent,
  emitToolResult,
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

async function completeValueReview(harness, candidate, implementationPaths, conclusion = "keep", rationale = "覆盖关键业务规则，属于高价值回归防护。") {
  const tool = harness.tools.find((item) => item.name === "file_review");
  return tool.execute("value-review-call", {
    action: "complete",
    reviewKind: "test-value",
    path: candidate.path,
    fingerprint: candidate.fingerprint,
    implementationPaths,
    conclusion,
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
    assert.equal(harness.sentUserMessages.length, 1);
    assert.match(harness.sentUserMessages[0].message, /用户通过 \/large 明确启动/);
  });
});

test("/large 在职责恢复 pending 时仍扫描并将恢复门交给审阅请求处理", async () => {
  await withTempDirectory(async (directory) => {
    const branch = [{ type: "custom", customType: "pi-init-role-recovery", data: { status: "pending" } }];
    const harness = createExtensionHarness(branch, { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });

    await harness.commands.get("large").handler("", harness.context);

    assert.equal(harness.sentUserMessages.length, 1);
    assert.match(harness.sentUserMessages[0].message, /职责恢复待确认：是/);
    assert.match(harness.sentUserMessages[0].message, /恢复门未确认时必须先完成角色确认/);
    assert.equal(branch.findLast((entry) => entry.customType === "pi-init-role-recovery").data.status, "pending");
    assert.equal(branch.filter((entry) => entry.customType === "pi-init-file-review").length, 0);
  });
});

test("/large 在职责恢复持久化失败时仍扫描但不启动 AI", async () => {
  await withTempDirectory(async (directory) => {
    const harness = createExtensionHarness([], {
      cwd: directory,
      appendEntry(type) {
        if (type === "pi-init-role-recovery") throw new Error("recovery entry failed");
      },
    });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    await mkdir(path.join(directory, "rust"));
    await writeFile(path.join(directory, "rust", "main.rs"), makeFile("rust"));
    await emitExtensionEvent(harness, "session_compact", { reason: "manual" });

    await harness.commands.get("large").handler("", harness.context);

    assert.equal(harness.sentUserMessages.length, 0);
    assert.match(harness.notifications.at(-1).message, /rust\/main\.rs · 501 行/);
    assert.match(harness.notifications.at(-1).message, /职责恢复记录持久化失败/);
  });
});

test("/large 不会在暂停中的工作流期间派发审阅", async () => {
  await withTempDirectory(async (directory) => {
    const workflow = createWorkflowState({
      summary: "阻止主动大文件审阅",
      reviewRequired: true,
      tasks: [{ id: "task", task: "待确认", files: ["src"], acceptanceCriteria: ["已确认"] }],
    });
    const branch = [{ type: "custom", customType: "pi-init-workflow", data: workflow }];
    const harness = createExtensionHarness(branch, { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });

    await harness.commands.get("large").handler("", harness.context);

    assert.equal(harness.sentUserMessages.length, 0);
    assert.equal(harness.notifications.at(-1).level, "warning");
    assert.match(harness.notifications.at(-1).message, /未结束的工作流/);
    assert.equal(branch.findLast((entry) => entry.customType === "pi-init-workflow").data.status, "paused");
  });
});

test("非代码文件的 read 结果不触发大文件扫描错误提示", async () => {
  await withTempDirectory(async (directory) => {
    const harness = createExtensionHarness([], { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    const result = await emitToolResult(harness, readEvent("README.md"));
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
    const editResult = await emitToolResult(harness, editEvent);
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
    const result = await emitToolResult(harness, event);
    assert.match(result.content.at(-1).text, /src\/new\.ts/);
    assert.match(result.content.at(-1).text, /大文件审阅待处理/);
  });
});
test("list 同时呈现结构与测试价值待审，且价值同意独立于行数", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, "test"));
    await writeFile(path.join(directory, "test", "small.test.js"), "assert(true);\n");
    const harness = createExtensionHarness([], { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    const tool = harness.tools.find((item) => item.name === "file_review");

    const listed = await tool.execute("list-call", { action: "list" }, undefined, undefined, harness.context);
    assert.equal(listed.details.total, 1);
    assert.equal(listed.details.valueTotal, 1);
    assert.equal(listed.details.valueCandidates[0].path, "test/small.test.js");
    assert.deepEqual(listed.details.valueCandidates[0].invalidations, []);
    assert.equal(listed.details.candidates[0].lineCount, 501);

    const valueOnly = await tool.execute("list-call", { action: "list", reviewKind: "test-value" }, undefined, undefined, harness.context);
    assert.match(valueOnly.content[0].text, /测试价值待审 1-1\/1/);
    assert.match(valueOnly.content[0].text, /发现局限/);
  });
});

test("测试价值完成需要显式实现关联并完整读取测试与实现当前版本", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, "test"));
    await writeFile(path.join(directory, "test", "unit.test.js"), "assert(true);\n");
    const harness = createExtensionHarness([], { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    const tool = harness.tools.find((item) => item.name === "file_review");
    const listed = await tool.execute("list-call", { action: "list" }, undefined, undefined, harness.context);
    const candidate = listed.details.valueCandidates[0];

    const noAssociation = await completeValueReview(harness, candidate, []);
    assert.equal(noAssociation.details.ok, false);
    assert.equal(noAssociation.details.code, "INVALID_REVIEW");

    const unread = await completeValueReview(harness, candidate, ["src/large.ts"]);
    assert.equal(unread.details.ok, false);
    assert.equal(unread.details.code, "IMPLEMENTATION_NOT_FULLY_READ");

    await emitExtensionEvent(harness, "tool_result", readEvent("src/large.ts"));
    const testUnread = await completeValueReview(harness, candidate, ["src/large.ts"]);
    assert.equal(testUnread.details.ok, false);
    assert.equal(testUnread.details.code, "TEST_NOT_FULLY_READ");

    await emitExtensionEvent(harness, "tool_result", readEvent("test/unit.test.js"));
    const completed = await completeValueReview(harness, candidate, ["src/large.ts"]);
    assert.equal(completed.details.ok, true);
  });
});

test("价值记录独立持久化并可随同会话恢复，结构记录不受影响", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, "test"));
    await writeFile(path.join(directory, "test", "unit.test.js"), "assert(true);\n");
    const harness = createExtensionHarness([], { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    const tool = harness.tools.find((item) => item.name === "file_review");
    const listed = await tool.execute("list-call", { action: "list" }, undefined, undefined, harness.context);
    const candidate = listed.details.valueCandidates[0];

    await emitExtensionEvent(harness, "tool_result", readEvent("test/unit.test.js"));
    await emitExtensionEvent(harness, "tool_result", readEvent("src/large.ts"));
    const recorded = await completeValueReview(harness, candidate, ["src/large.ts"], "merge", "与其它用例重复，建议合并而非自动修改。");
    assert.equal(recorded.details.ok, true);
    assert.equal(recorded.details.reviewKind, "test-value");
    assert.equal(recorded.details.conclusion, "merge");
    assert.equal(harness.branch.filter((entry) => entry.customType === "pi-init-test-value-review").length, 1);
    assert.equal(harness.branch.filter((entry) => entry.customType === "pi-init-file-review").length, 0);

    const afterRecord = await tool.execute("list-call-2", { action: "list" }, undefined, undefined, harness.context);
    assert.equal(afterRecord.details.valueTotal, 0);
    assert.equal(afterRecord.details.total, 1);

    await emitExtensionEvent(harness, "session_start", { reason: "resume" });
    await harness.tools.find((item) => item.name === "switch_role")
      .execute("developer-test", { role: "developer-test" }, undefined, undefined, harness.context);
    const afterResume = await tool.execute("list-call-3", { action: "list" }, undefined, undefined, harness.context);
    assert.equal(afterResume.details.valueTotal, 0);
    assert.equal(afterResume.details.total, 1);
  });
});

test("价值关联实现版本变化或持久化失败时使记录失效且不产生虚假通过", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, "test"));
    await writeFile(path.join(directory, "test", "unit.test.js"), "assert(true);\n");
    const harness = createExtensionHarness([], { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    const tool = harness.tools.find((item) => item.name === "file_review");
    const listed = await tool.execute("list-call", { action: "list" }, undefined, undefined, harness.context);
    const candidate = listed.details.valueCandidates[0];
    await emitExtensionEvent(harness, "tool_result", readEvent("test/unit.test.js"));
    await emitExtensionEvent(harness, "tool_result", readEvent("src/large.ts"));
    const recorded = await completeValueReview(harness, candidate, ["src/large.ts"], "keep", "覆盖核心业务规则，值得保留并持续维护。");
    assert.equal(recorded.details.ok, true);

    await writeFile(path.join(directory, "src", "large.ts"), makeFile("changed-implementation"));
    const rescan = await tool.execute("list-call-2", { action: "list" }, undefined, undefined, harness.context);
    assert.equal(rescan.details.valueTotal, 1);
    assert.deepEqual(rescan.details.valueCandidates[0].invalidations, [
      { code: "IMPLEMENTATION_CHANGED", path: "src/large.ts" },
    ]);

    const failingHarness = createExtensionHarness([], {
      cwd: directory,
      appendEntry(type) {
        if (type === "pi-init-test-value-review") throw new Error("session append failed");
      },
    });
    await emitExtensionEvent(failingHarness, "session_start", { reason: "startup" });
    const failingTool = failingHarness.tools.find((item) => item.name === "file_review");
    const failingListed = await failingTool.execute("list-call", { action: "list" }, undefined, undefined, failingHarness.context);
    const failingCandidate = failingListed.details.valueCandidates[0];
    await emitExtensionEvent(failingHarness, "tool_result", readEvent("test/unit.test.js"));
    await emitExtensionEvent(failingHarness, "tool_result", readEvent("src/large.ts"));
    const failed = await completeValueReview(failingHarness, failingCandidate, ["src/large.ts"], "remove", "建议移除重复覆盖，但不自动删除测试文件。");
    assert.equal(failed.details.ok, false);
    assert.equal(failed.details.code, "PERSIST_FAILED");
    const pending = await failingTool.execute("list-call-2", { action: "list" }, undefined, undefined, failingHarness.context);
    assert.equal(pending.details.valueTotal, 1);
  });
});

test("短生产实现的成功 read 覆盖可分段累积并支持价值完成", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, "test"));
    await writeFile(path.join(directory, "src", "service.ts"), "export function add(a, b) {\n  return a + b;\n}\n");
    await writeFile(path.join(directory, "test", "unit.test.js"), "assert.equal(add(1, 2), 3);\n");
    const harness = createExtensionHarness([], { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    const tool = harness.tools.find((item) => item.name === "file_review");
    const listed = await tool.execute("list-short", { action: "list" }, undefined, undefined, harness.context);
    const candidate = listed.details.valueCandidates[0];

    await emitExtensionEvent(harness, "tool_result", { ...readEvent("src/service.ts"), isError: true });
    const failedRead = await completeValueReview(harness, candidate, ["src/service.ts"]);
    assert.equal(failedRead.details.code, "IMPLEMENTATION_NOT_FULLY_READ");

    await emitExtensionEvent(harness, "tool_result", readEvent("src/service.ts", { offset: 1, limit: 1 }));
    const partialRead = await completeValueReview(harness, candidate, ["src/service.ts"]);
    assert.equal(partialRead.details.code, "IMPLEMENTATION_NOT_FULLY_READ");

    await emitExtensionEvent(harness, "tool_result", readEvent("src/service.ts", { offset: 2, limit: 2 }));
    const testUnread = await completeValueReview(harness, candidate, ["src/service.ts"]);
    assert.equal(testUnread.details.code, "TEST_NOT_FULLY_READ");

    await emitExtensionEvent(harness, "tool_result", readEvent("test/unit.test.js"));
    const completed = await completeValueReview(harness, candidate, ["src/service.ts"]);
    assert.equal(completed.details.ok, true);
    assert.equal(completed.details.reviewKind, "test-value");
    assert.equal(harness.branch.filter((entry) => entry.customType === "pi-init-test-value-review").length, 1);
  });
});

test("读取后实现指纹变化会清除旧覆盖并拒绝价值完成", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, "test"));
    await writeFile(path.join(directory, "src", "service.ts"), "export const version = 1;\n");
    await writeFile(path.join(directory, "test", "unit.test.js"), "assert.equal(version, 1);\n");
    const harness = createExtensionHarness([], { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    const tool = harness.tools.find((item) => item.name === "file_review");
    const listed = await tool.execute("list-stale", { action: "list" }, undefined, undefined, harness.context);
    const candidate = listed.details.valueCandidates[0];
    await emitExtensionEvent(harness, "tool_result", readEvent("src/service.ts"));
    await emitExtensionEvent(harness, "tool_result", readEvent("test/unit.test.js"));

    await writeFile(path.join(directory, "src", "service.ts"), "export const version = 2;\n");
    const stale = await completeValueReview(harness, candidate, ["src/service.ts"]);
    assert.equal(stale.details.ok, false);
    assert.equal(stale.details.code, "IMPLEMENTATION_NOT_FULLY_READ");
    assert.equal(harness.branch.filter((entry) => entry.customType === "pi-init-test-value-review").length, 0);
  });
});

test("短测试价值候选贯穿运行时提示、通知和 /large 主动入口", async () => {
  await withTempDirectory(async (directory) => {
    await rm(path.join(directory, "src", "large.ts"));
    await mkdir(path.join(directory, "test"));
    await writeFile(path.join(directory, "src", "service.ts"), "export function run() { return true; }\n");
    await writeFile(path.join(directory, "test", "service.test.js"), "assert.equal(run(), true);\n");
    const harness = createExtensionHarness([], { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });

    const tool = harness.tools.find((item) => item.name === "file_review");
    const listed = await tool.execute("runtime-list", { action: "list" }, undefined, undefined, harness.context);
    assert.equal(listed.details.total, 0);
    assert.equal(listed.details.valueTotal, 1);

    const prompt = { systemPromptOptions: { sections: {} } };
    await emitExtensionEvent(harness, "before_agent_start", prompt);
    assert.match(prompt.systemPromptOptions.sections.pi_init_large_file_review, /结构待审文件：0/);
    assert.match(prompt.systemPromptOptions.sections.pi_init_large_file_review, /service\.test\.js/);

    await emitExtensionEvent(harness, "agent_settled", {});
    assert.match(harness.notifications.at(-1).message, /1 个测试文件待价值审阅/);

    await harness.commands.get("large").handler("", harness.context);
    assert.equal(harness.sentUserMessages.length, 1);
    assert.match(harness.sentUserMessages[0].message, /service\.test\.js/);
    assert.match(harness.sentUserMessages[0].message, /implementationPaths/);
  });
});

test("/large 重扫成功后仍报告损坏价值状态并保留另一维候选", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, "test"));
    await writeFile(path.join(directory, "test", "unit.test.js"), "assert(true);\n");
    const branch = [{
      type: "custom",
      customType: "pi-init-test-value-review",
      data: {
        schemaVersion: 1,
        policyVersion: 1,
        projectRoot: await realpath(directory),
        sessionId: "test-session",
        decisions: [{}],
      },
    }];
    const harness = createExtensionHarness(branch, { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    await harness.tools.find((item) => item.name === "switch_role")
      .execute("developer-test", { role: "developer-test" }, undefined, undefined, harness.context);
    const reviewTool = harness.tools.find((item) => item.name === "file_review");
    const listed = await reviewTool.execute("list-invalid-state", { action: "list" }, undefined, undefined, harness.context);
    assert.equal(listed.details.valueScanComplete, false, JSON.stringify(listed));
    assert.ok(listed.details.candidateErrors.some((error) => error.code === "TEST_VALUE_STATE_INVALID"));

    await harness.commands.get("large").handler("", harness.context);

    assert.equal(harness.sentUserMessages.length, 0);
    const report = harness.notifications.at(-1).message;
    assert.match(report, /结构待审 1 个版本/);
    assert.match(report, /测试价值审阅状态无法确认/);
    assert.match(report, /TEST_VALUE_STATE_INVALID/);
    assert.match(report, /测试价值审阅结果包含无效字段/);
    assert.match(report, /test\/unit\.test\.js/);
    assert.match(report, /未启动审阅/);
    assert.doesNotMatch(report, /没有当前版本待审候选/);
  });
});
