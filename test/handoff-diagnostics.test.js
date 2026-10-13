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
    handlers.get("tool_call")({ toolName: "task_workflow", toolCallId: "call-1", input: { action: "request-evidence", workflowId: "workflow-1", request: { requestId: "request-1", question: "secret-question", scope: ["secret-scope"] } } }, ctx);
    handlers.get("tool_result")({ toolName: "task_workflow", toolCallId: "call-1", isError: true, content: [{ text: "secret-output" }], details: { code: "COORDINATION_NO_PROGRESS" } }, ctx);
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
    handlers.get("message_end")({ message: { role: "assistant", content: [{ type: "text", text: "private-response" }, { type: "toolCall", id: "blocked-1", name: "task_workflow", arguments: { action: "plan", direction: "private-direction" } }, { type: "toolCall", id: "other-1", name: "bash", arguments: { command: "private-command" } }] } }, ctx);
    await monitor.flush();
    const rows = await read();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, "routing.model_proposed");
    assert.equal(rows[0].data.toolCallId, "blocked-1");
    assert.equal(rows[0].data.action, "plan");
    assert.equal(JSON.stringify(rows).includes("private-"), false);
  });
});


