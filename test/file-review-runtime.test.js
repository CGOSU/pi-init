import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("list path is ignored for project inventory pagination and Markdown is never reviewed", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, "docs"));
    await writeFile(path.join(directory, "docs", "session-log.md"), makeFile("markdown"));
    await writeFile(path.join(directory, "src", "other.ts"), makeFile("other"));
    const harness = createExtensionHarness([], { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    await harness.tools.find((item) => item.name === "switch_role")
      .execute("developer-test", { role: "developer-test" }, undefined, undefined, harness.context);
    const tool = harness.tools.find((item) => item.name === "file_review");
    const list = (params) => tool.execute("scope-list", { action: "list", ...params }, undefined, undefined, harness.context);
    const inventory = await list({});
    assert.equal(inventory.details.scope, "project");
    assert.equal("ignoredPath" in inventory.details, false);
    assert.deepEqual(inventory.details.candidates.map((item) => item.path), ["src/large.ts", "src/other.ts"]);
    const page = await list({ offset: 1, limit: 1 });
    for (const ignoredPath of ["docs/session-log.md", "src/large.ts", "missing.ts"]) {
      const result = await list({ path: ignoredPath, offset: 1, limit: 1 });
      assert.equal(result.details.scope, "project");
      assert.equal(result.details.ignoredPath, ignoredPath);
      const { ignoredPath: ignored, ...details } = result.details;
      assert.deepEqual(details, page.details);
      assert.equal(details.total, 2);
      assert.equal(details.offset, 1);
    }
    assert.equal(await emitToolResult(harness, readEvent("docs/session-log.md")), undefined);
    const completed = await completeReview(harness, {
      path: "docs/session-log.md", fingerprint: inventory.details.candidates[0].fingerprint,
    });
    assert.equal(completed.details.code, "UNSUPPORTED_FILE");
    assert.deepEqual((await list({})).details, inventory.details);
  });
});

test("启动库存不进入日常提示，但完整 file_review 列表仍可读取", async () => {
  await withTempDirectory(async (directory) => {
    const harness = createExtensionHarness([], { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    const event = { systemPromptOptions: { sections: {} } };
    await emitExtensionEvent(harness, "before_agent_start", event);
    assert.equal(event.systemPromptOptions.sections.pi_init_large_file_review, undefined);

    const tool = harness.tools.find((item) => item.name === "file_review");
    const listed = await tool.execute("inventory-list", { action: "list" }, undefined, undefined, harness.context);
    assert.equal(listed.details.total, 1);
    assert.equal(listed.details.candidates[0].path, "src/large.ts");
    assert.equal(await emitToolResult(harness, readEvent("src/large.ts")), undefined);
  });
});

test("session_tree 与 reload 重建同一 session 的增量基线", async () => {
  await withTempDirectory(async (directory) => {
    const harness = createExtensionHarness([], { cwd: directory, sessionId: "same-session" });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    await writeFile(path.join(directory, "src", "large.ts"), makeFile("branch-baseline"));
    harness.branch.push({ type: "custom", id: "branch-entry", parentId: null });
    await emitExtensionEvent(harness, "session_tree", { oldLeafId: "old-leaf", newLeafId: "new-leaf" });

    let prompt = { systemPromptOptions: { sections: {} } };
    await emitExtensionEvent(harness, "before_agent_start", prompt);
    assert.equal(prompt.systemPromptOptions.sections.pi_init_large_file_review, undefined);

    await writeFile(path.join(directory, "src", "large.ts"), makeFile("after-branch-baseline"));
    const mutation = await emitToolResult(harness, {
      type: "tool_result",
      toolCallId: "branch-edit",
      toolName: "edit",
      input: { path: "src/large.ts", edits: [] },
      content: [],
      details: undefined,
      isError: false,
    });
    assert.match(mutation.content.at(-1).text, /src\/large\.ts/);

    await emitExtensionEvent(harness, "session_start", { reason: "reload" });
    prompt = { systemPromptOptions: { sections: {} } };
    await emitExtensionEvent(harness, "before_agent_start", prompt);
    assert.equal(prompt.systemPromptOptions.sections.pi_init_large_file_review, undefined);
  });
});

test("扫描期间活动 branch 改变时拒绝应用旧候选结果", async () => {
  await withTempDirectory(async (directory) => {
    const branch = [{ type: "custom", id: "branch-root", customType: "unrelated", data: {} }];
    const harness = createExtensionHarness(branch, { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    await harness.tools.find((item) => item.name === "switch_role")
      .execute("developer-test", { role: "developer-test" }, undefined, undefined, harness.context);
    const tool = harness.tools.find((item) => item.name === "file_review");
    const pending = tool.execute("branch-list", { action: "list" }, undefined, undefined, harness.context);
    branch[0] = { ...branch[0], id: "sibling-root" };
    const result = await pending;
    assert.equal(result.details.code, "STALE_SESSION");
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
    assert.match(editResult.content.at(-1).text, /src\/large\.ts/);
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

test("settled 通知只提示新候选版本且待审上下文持续保留", async () => {
  await withTempDirectory(async (directory) => {
    const harness = createExtensionHarness([], { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    await writeFile(path.join(directory, "src", "new.ts"), makeFile("first-version"));

    await emitExtensionEvent(harness, "agent_settled", {});
    assert.equal(harness.notifications.length, 1);
    assert.match(harness.notifications[0].message, /src\/new\.ts/);

    const prompt = { systemPromptOptions: { sections: {} } };
    await emitExtensionEvent(harness, "before_agent_start", prompt);
    assert.match(prompt.systemPromptOptions.sections.pi_init_large_file_review, /src\/new\.ts/);
    assert.doesNotMatch(prompt.systemPromptOptions.sections.pi_init_large_file_review, /测试价值|test-value|implementationPaths/);
    await emitExtensionEvent(harness, "agent_settled", {});
    assert.equal(harness.notifications.length, 1);

    await writeFile(path.join(directory, "src", "new.ts"), makeFile("second-version"));
    await emitExtensionEvent(harness, "agent_settled", {});
    assert.equal(harness.notifications.length, 2);
    assert.match(harness.notifications[1].message, /src\/new\.ts/);
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
  });
});
test("短测试不会形成候选、通知或 /large 主动派发", async () => {
  await withTempDirectory(async (directory) => {
    await rm(path.join(directory, "src", "large.ts"));
    await mkdir(path.join(directory, "test"));
    await writeFile(path.join(directory, "test", "small.test.js"), "assert(true);\n");
    const harness = createExtensionHarness([], { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    const tool = harness.tools.find((item) => item.name === "file_review");

    const listed = await tool.execute("list-short-test", { action: "list" }, undefined, undefined, harness.context);
    assert.equal(listed.details.total, 0);
    assert.deepEqual(listed.details.candidates, []);
    assert.equal("valueCandidates" in listed.details, false);
    assert.equal(await emitToolResult(harness, readEvent("test/small.test.js")), undefined);

    const prompt = { systemPromptOptions: { sections: {} } };
    await emitExtensionEvent(harness, "before_agent_start", prompt);
    assert.equal(prompt.systemPromptOptions.sections.pi_init_large_file_review, undefined);
    await emitExtensionEvent(harness, "agent_settled", {});
    assert.equal(harness.notifications.length, 0);
    await harness.commands.get("large").handler("", harness.context);
    assert.equal(harness.sentUserMessages.length, 0);
    assert.doesNotMatch(harness.notifications.at(-1).message, /测试价值|test-value|implementationPaths/);
  });
});

test("旧价值 session 条目原样忽略；旧调用明确失败且结构审阅仍可完成", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, "test"));
    await writeFile(path.join(directory, "test", "small.test.js"), "assert(true);\n");
    const legacyEntry = {
      type: "custom",
      id: "legacy-value-review",
      customType: "pi-init-test-value-review",
      data: { schemaVersion: 1, policyVersion: 1, decisions: [{}] },
    };
    const branch = [legacyEntry];
    const originalLegacyEntry = structuredClone(legacyEntry);
    const harness = createExtensionHarness(branch, { cwd: directory });
    await emitExtensionEvent(harness, "session_start", { reason: "startup" });
    await harness.tools.find((item) => item.name === "switch_role")
      .execute("developer-test", { role: "developer-test" }, undefined, undefined, harness.context);
    const tool = harness.tools.find((item) => item.name === "file_review");
    const metadata = JSON.stringify({
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: tool.promptGuidelines,
      parameters: tool.parameters,
    });
    assert.doesNotMatch(metadata, /test-value|implementationPaths|merge|rewrite|remove/);

    const listed = await tool.execute("list-current", { action: "list" }, undefined, undefined, harness.context);
    assert.equal(listed.details.total, 1, JSON.stringify(listed));
    assert.equal(listed.details.candidates[0].path, "src/large.ts");
    assert.equal("valueCandidates" in listed.details, false);

    const unsupportedList = await tool.execute("legacy-value-list", {
      action: "list",
      reviewKind: "test-value",
    }, undefined, undefined, harness.context);
    assert.equal(unsupportedList.details.code, "TEST_VALUE_REVIEW_REMOVED");
    const unsupportedComplete = await tool.execute("legacy-value-complete", {
      action: "complete",
      reviewKind: "test-value",
      path: "src/large.ts",
      fingerprint: listed.details.candidates[0].fingerprint,
      conclusion: "keep",
      rationale: "结构结论不得被旧价值调用代替。",
    }, undefined, undefined, harness.context);
    assert.equal(unsupportedComplete.details.code, "TEST_VALUE_REVIEW_REMOVED");
    assert.deepEqual(branch[0], originalLegacyEntry);
    assert.equal(branch.filter((entry) => entry.customType === "pi-init-file-review").length, 0);

    const structuralList = await tool.execute("structure-list", {
      action: "list",
      reviewKind: "structure",
    }, undefined, undefined, harness.context);
    const candidate = structuralList.details.candidates[0];
    await emitExtensionEvent(harness, "tool_result", readEvent(candidate.path));
    const completed = await completeReview(harness, candidate);
    assert.equal(completed.details.ok, true);
    assert.deepEqual(branch[0], originalLegacyEntry);
    assert.equal(branch.filter((entry) => entry.customType === "pi-init-test-value-review").length, 1);
    assert.equal(branch.filter((entry) => entry.customType === "pi-init-file-review").length, 1);
  });
});
