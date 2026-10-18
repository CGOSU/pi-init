import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandoffDiagnostics } from "../extensions/handoff-diagnostics.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createExtensionHarness, emitExtensionEvent } from "./helpers.js";

async function withMonitor(run, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-init-handoff-"));
  const handlers = new Map();
  const notifications = [];
  const state = createExtensionRuntimeState();
  const ctx = { cwd, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "session-1" }, ui: { notify: (...args) => notifications.push(args) } };
  const monitor = createHandoffDiagnostics({ on(name, handler) { handlers.set(name, handler); } }, state, { enabled: true, ...options });
  const read = async () => (await readFile(join(cwd, ".pi", "logs", "handoff.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  try { await run({ cwd, ctx, state, handlers, monitor, notifications, read }); }
  finally { await monitor.flush(); await rm(cwd, { recursive: true, force: true }); }
}

test("交接日志记录事件、身份和状态，观察器不改变任务或触发回合", async () => {
  await withMonitor(async ({ ctx, state, handlers, monitor, read }) => {
    state.activeRole = { role: "docs-commit", provider: "test", model: "model", thinkingLevel: "high" };
    const before = { ...state };
    assert.equal(handlers.get("input")({ source: "interactive", text: "secret-input" }, ctx), undefined);
    handlers.get("before_agent_start")({}, ctx);
    await handlers.get("tool_call")({ toolName: "task_workflow", toolCallId: "call-1", input: { action: "request-evidence", workflowId: "workflow-1", request: { requestId: "request-1", question: "secret-question", scope: ["secret-scope"] } } }, ctx);
    await handlers.get("tool_result")({ toolName: "task_workflow", toolCallId: "call-1", isError: true, content: [{ text: "secret-output" }], details: { code: "COORDINATION_NO_PROGRESS" } }, ctx);
    handlers.get("agent_settled")({}, ctx);
    await monitor.flush();
    const rows = await read();
    assert.deepEqual(rows.map((row) => row.event), ["input", "agent.before_start", "routing.tool_call", "routing.tool_result", "agent.settled"]);
    assert.deepEqual(rows.map((row) => row.sequence), [1, 2, 3, 4, 5]);
    assert.equal(rows[2].data.request.requestId, "request-1");
    assert.equal(rows[2].snapshot.role, "docs-commit");
    assert.equal(rows[3].data.code, "COORDINATION_NO_PROGRESS");
    assert.equal(rows[3].data.isError, true);
    assert.ok(rows[2].data.request.questionHash);
    assert.equal(JSON.stringify(rows).includes("secret-"), false);
    assert.deepEqual(state, before);
  });
});

test("压缩与持久状态跟踪保留操作身份且不写入失败原因正文", async () => {
  await withMonitor(async ({ ctx, state, monitor, read }) => {
    state.roleCompactionInFlight = true;
    state.roleCompactionPhase = "compacting";
    state.roleCompactionOperationId = "operation-1";
    state.coordinationRuntimeState = { coordination: { coordinationId: "coord-1", version: 1, phase: "investigating", requests: [{ requestId: "req-1", questionId: "q-1", round: 4, status: "pending", question: "private question", scope: ["private file"] }], reviews: [] }, recoveryGeneration: 2, handoff: { requestId: "req-1", role: "docs-commit", kind: "evidence", attemptId: "attempt-1", handoffId: "handoff-1", phase: "blocked", failure: { code: "UNKNOWN", message: "private credential" } } };
    state.traceHandoff(ctx, "compaction.long_wait", { operationId: "operation-1" });
    await monitor.flush();
    const [row] = await read();
    assert.equal(row.snapshot.compaction.operationId, "operation-1");
    assert.equal(row.snapshot.locks.compaction, true);
    assert.equal(row.snapshot.coordination.request.round, 4);
    assert.equal(row.snapshot.coordination.handoff.failureCode, "UNKNOWN");
    assert.equal(JSON.stringify(row).includes("private"), false);
  });
});

test("未信任项目或关闭日志时不创建文件", async () => {
  await withMonitor(async ({ cwd, ctx, monitor }) => {
    ctx.isProjectTrusted = () => false;
    monitor.trace(ctx, "test");
    await monitor.flush();
    assert.deepEqual(await readdir(cwd), []);
  });
  await withMonitor(async ({ cwd, ctx, monitor }) => {
    monitor.trace(ctx, "test");
    await monitor.flush();
    assert.deepEqual(await readdir(cwd), []);
  }, { enabled: false });
});

test("日志轮转仅保留当前文件和一个备份", async () => {
  await withMonitor(async ({ cwd, ctx, monitor, read }) => {
    for (let i = 0; i < 5; i++) { monitor.trace(ctx, "test", { index: i }); await monitor.flush(); }
    assert.deepEqual((await readdir(join(cwd, ".pi", "logs"))).sort(), ["handoff.jsonl", "handoff.jsonl.1"]);
    assert.equal((await read()).at(-1).data.index, 4);
    assert.equal(JSON.parse((await readFile(join(cwd, ".pi", "logs", "handoff.jsonl.1"), "utf8")).trim()).data.index, 3);
  }, { maxBytes: 1 });
});

test("写入失败只提醒一次，不向调用者抛异常", async () => {
  await withMonitor(async ({ cwd, ctx, monitor, notifications }) => {
    await writeFile(join(cwd, ".pi"), "not a directory");
    assert.doesNotThrow(() => monitor.trace(ctx, "first"));
    await monitor.flush();
    monitor.trace(ctx, "second");
    await monitor.flush();
    assert.equal(notifications.length, 1);
    assert.match(notifications[0][0], /不影响任务执行/);
  });
});

test("待写队列有上限，丢弃数量在后续记录中可见", async () => {
  await withMonitor(async ({ ctx, monitor, read }) => {
    for (let i = 0; i < 140; i++) monitor.trace(ctx, "burst");
    await monitor.flush();
    monitor.trace(ctx, "after-burst");
    await monitor.flush();
    const rows = await read();
    assert.equal(rows.length, 129);
    assert.equal(rows.at(-1).dropped, 12);
  });
});

test("开启监控后不抢占职责守卫，shutdown 刷新真实扩展的交接日志", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-init-handoff-integration-"));
  const previous = process.env.PI_INIT_HANDOFF_LOG;
  process.env.PI_INIT_HANDOFF_LOG = "1";
  const harness = createExtensionHarness([], { cwd, trusted: true });
  if (previous === undefined) delete process.env.PI_INIT_HANDOFF_LOG;
  else process.env.PI_INIT_HANDOFF_LOG = previous;
  try {
    await emitExtensionEvent(harness, "session_start", { reason: "new" });
    await emitExtensionEvent(harness, "session_compact", { reason: "manual" });
    const guard = harness.handlers.get("tool_call")[0];
    assert.equal(guard({ toolName: "edit", input: {} }, harness.context).block, true);
    await emitExtensionEvent(harness, "agent_settled");
    await emitExtensionEvent(harness, "session_shutdown");
    const rows = (await readFile(join(cwd, ".pi", "logs", "handoff.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(rows.some((row) => row.event === "workflow.schedule"));
    assert.ok(rows.some((row) => row.event === "coordination.schedule"));
    assert.equal(rows.at(-1).event, "session.shutdown");
    assert.equal(harness.sentMessages.length, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("模型提出的路由调用独立于执行守卫可观测，正文不进入日志", async () => {
  await withMonitor(async ({ ctx, handlers, monitor, read }) => {
    await handlers.get("message_end")({ message: { role: "assistant", content: [{ type: "text", text: "private-response" }, { type: "toolCall", id: "blocked-1", name: "task_workflow", arguments: { action: "plan", direction: "private-direction" } }, { type: "toolCall", id: "other-1", name: "bash", arguments: { command: "private-command" } }] } }, ctx);
    await monitor.flush();
    const rows = await read();
    assert.deepEqual(rows.map(row => row.event), ["routing.model_proposed", "tool.model_proposed"]);
    assert.equal(rows[0].event, "routing.model_proposed");
    assert.equal(rows[0].data.toolCallId, "blocked-1");
    assert.equal(rows[0].data.action, "plan");
    assert.equal(JSON.stringify(rows).includes("private-"), false);
  });
});
test("普通工具日志关联读取范围、文件版本和命令指纹，正文不落盘", async () => {
  await withMonitor(async ({ cwd, ctx, handlers, monitor, read }) => {
    await writeFile(join(cwd, "sample.ts"), "private-source");
    const call = { toolName: "read", toolCallId: "read-1", input: { path: join(cwd, "sample.ts"), offset: 2, limit: 20 } };
    await handlers.get("tool_call")(call, ctx);
    await handlers.get("tool_result")({ ...call, isError: false, content: [{ type: "text", text: "private-result" }] }, ctx);
    await handlers.get("tool_call")({ ...call, toolCallId: "read-2" }, ctx);
    await handlers.get("tool_call")({ toolName: "bash", toolCallId: "shell-1", input: { command: "echo private-token", timeout: 1200 } }, ctx);
    await handlers.get("tool_call")({ toolName: "edit", toolCallId: "edit-1", input: { path: "sample.ts", edits: [{ oldText: "private-source", newText: "private-new-source" }] } }, ctx);
    await writeFile(join(cwd, "sample.ts"), "private-new-source");
    await handlers.get("tool_result")({ toolName: "edit", toolCallId: "edit-1", input: { path: "sample.ts" }, isError: false, content: [{ type: "text", text: "private-diff" }] }, ctx);
    await monitor.flush();
    const rows = await read();
    assert.deepEqual(rows.map(row => row.event), ["tool.call", "tool.result", "tool.call", "tool.call", "tool.call", "tool.result"]);
    assert.equal(rows[0].data.files[0].path, "sample.ts");
    assert.equal(rows[0].data.files[0].offset, 2);
    assert.equal(rows[0].data.files[0].limit, 20);
    assert.ok(rows[0].data.files[0].version);
    assert.equal(rows[0].data.files[0].version, rows[2].data.files[0].version);
    assert.equal(rows[0].data.inputHash, rows[2].data.inputHash);
    assert.ok(rows[3].data.commandHash);
    assert.notEqual(rows[4].data.files[0].version, rows[5].data.files[0].version);
    assert.equal(JSON.stringify(rows).includes("private-"), false);
    assert.equal(JSON.stringify(rows).includes(cwd), false);
  });
});

test("工具执行结果记录耗时、嵌套身份和业务失败，暂停任务状态仍可关联", async () => {
  await withMonitor(async ({ ctx, state, handlers, monitor, read }) => {
    state.workflowState = { workflowId: "wf", status: "paused", pauseReason: "handoff-outcome-unknown", tasks: [{ id: "task", role: "developer-test", status: "blocked", outcomeUnknown: true }], revisions: [] };
    assert.equal(await handlers.get("tool_execution_start")({ toolName: "file_review", toolCallId: "parent/1", parentToolCallId: "parent", args: { action: "complete" } }, ctx), undefined);
    assert.equal(await handlers.get("tool_execution_end")({ toolName: "file_review", toolCallId: "parent/1", parentToolCallId: "parent", durationMs: 15, isError: false, result: { content: [{ type: "text", text: "private-error" }], details: { ok: false, code: "FILE_NOT_FULLY_READ", message: "private-message" } } }, ctx), undefined);
    await monitor.flush();
    const rows = await read();
    assert.equal(rows[0].event, "tool.execution_start");
    assert.equal(rows[1].event, "tool.execution_end");
    assert.equal(rows[1].data.parentToolCallId, "parent");
    assert.equal(rows[1].data.durationMs, 15);
    assert.equal(rows[1].data.isError, false);
    assert.equal(rows[1].data.businessOk, false);
    assert.equal(rows[1].data.code, "FILE_NOT_FULLY_READ");
    assert.equal(rows[1].snapshot.workflow.tasks[0].outcomeUnknown, true);
    assert.equal(JSON.stringify(rows).includes("private-"), false);
  });
});

test("普通工具模型提议即使未进入执行入口也有指纹记录", async () => {
  await withMonitor(async ({ ctx, handlers, monitor, read }) => {
    await handlers.get("message_end")({ message: { role: "assistant", content: [{ type: "toolCall", id: "blocked-edit", name: "edit", arguments: { path: "sample.ts", edits: [{ oldText: "private-old", newText: "private-new" }] } }] } }, ctx);
    await monitor.flush();
    const [row] = await read();
    assert.equal(row.event, "tool.model_proposed");
    assert.equal(row.data.toolCallId, "blocked-edit");
    assert.ok(row.data.inputHash);
    assert.equal(JSON.stringify(row).includes("private-"), false);
  });
});
test("工具摘要限制批量文件和范围，项目外路径及结构化失败不泄露正文", async () => {
  await withMonitor(async ({ cwd, ctx, handlers, monitor, read }) => {
    const files = Array.from({ length: 20 }, (_, i) => ({ path: "missing-" + i + ".ts", ranges: [{ start: 2, end: 5 }] }));
    await handlers.get("tool_call")({ toolName: "read", toolCallId: "batch", input: { files } }, ctx);
    await handlers.get("tool_call")({ toolName: "read", toolCallId: "external", input: { path: join(cwd, "..", "private-external.ts") } }, ctx);
    await handlers.get("tool_result")({ toolName: "custom", toolCallId: "structured", isError: false, input: {}, content: [{ type: "text", text: "private-output" }], structuredContent: { ok: false, code: "CONTRACT_REQUIRED", explanation: "private-explanation" } }, ctx);
    await monitor.flush();
    const rows = await read();
    assert.equal(rows[0].data.fileCount, 20);
    assert.equal(rows[0].data.files.length, 16);
    assert.equal(rows[0].data.filesTruncated, true);
    assert.deepEqual(rows[0].data.files[0].ranges, [{ start: 2, end: 5 }]);
    assert.equal(rows[0].data.files[0].statCode, "ENOENT");
    assert.equal(rows[1].data.files[0].outsideProject, true);
    assert.ok(rows[1].data.files[0].pathHash);
    assert.equal(rows[1].data.files[0].version, undefined);
    assert.equal(rows[2].data.businessOk, false);
    assert.equal(rows[2].data.code, "CONTRACT_REQUIRED");
    assert.equal(JSON.stringify(rows).includes("private-"), false);
  });
});


