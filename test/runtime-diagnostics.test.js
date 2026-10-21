import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile, stat, utimes, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandoffDiagnostics } from "../extensions/handoff-diagnostics.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createExtensionHarness, emitExtensionEvent } from "./helpers.js";

async function withBox(fn, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-blackbox-"));
  const handlers = new Map();
  const notices = [];
  const ctx = { cwd, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "s1" }, ui: { notify: (...args) => notices.push(args) } };
  const state = createExtensionRuntimeState();
  const monitor = createHandoffDiagnostics({ on: (name, handler) => handlers.set(name, handler) }, state, { mode: "automatic", ...options });
  const emit = async (name, event = {}) => handlers.get(name)?.(event, ctx);
  const rows = async () => { await monitor.flush(); return (await readFile(join(cwd, ".pi", "diagnostics", "runtime.jsonl"), "utf8")).trim().split("\n").map(JSON.parse); };
  try { await fn({ cwd, ctx, state, monitor, emit, rows, notices }); }
  finally { await monitor.flush(); await rm(cwd, { recursive: true, force: true }); }
}
test("黑匣子正常回合仅保存摘要，记录用量且不创建详细日志", async () => {
  await withBox(async ({ cwd, emit, rows }) => {
    await emit("before_agent_start");
    await emit("tool_call", { toolName: "read", toolCallId: "c1", input: { path: "missing-secret.ts" } });
    await emit("tool_result", { toolName: "read", toolCallId: "c1", input: {}, content: [{ text: "private-output" }] });
    await emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [], usage: { input: 10, output: 2, totalTokens: 12 } } });
    await emit("agent_settled", { aborted: false });
    const data = await rows();
    assert.deepEqual(data.map(row => row.kind), ["summary"]);
    assert.equal(data[0].tokens.totalTokens, 12);
    assert.equal(data[0].toolCalls, 1);
    assert.deepEqual(await readdir(join(cwd, ".pi")), ["diagnostics"]);
    assert.equal(JSON.stringify(data).includes("private"), false);
  });
});
test("黑匣子错误自动保留前后现场，同类问题合并且不重复通知", async () => {
  await withBox(async ({ ctx, emit, monitor, rows, notices }) => {
    await emit("before_agent_start");
    await emit("input", { source: "interactive", text: "private-prompt" });
    for (const id of ["a", "b"]) await emit("tool_result", { toolName: "bash", toolCallId: id, isError: true, content: [{ text: "private-result" }], details: { code: "ETIMEDOUT" } });
    await emit("agent_settled", { aborted: false });
    const data = await rows();
    const issues = data.filter(row => row.kind === "issue");
    assert.equal(new Set(issues.map(row => row.id)).size, 1);
    assert.equal(issues.at(-1).count, 2);
    assert.ok(issues.at(-1).events.some(row => row.event === "agent.before_start"));
    assert.ok(issues.at(-1).events.some(row => row.event === "agent.settled"));
    assert.equal(notices.length, 1);
    assert.match(await monitor.report(ctx), /tool-failure \/ ETIMEDOUT \/ bash：2 次观察/);
    assert.equal(JSON.stringify(data).includes("private-"), false);
  });
});
test("黑匣子业务拒绝与用户取消不混为运行故障", async () => {
  await withBox(async ({ emit, rows }) => {
    await emit("before_agent_start");
    await emit("tool_result", { toolName: "task_workflow", toolCallId: "r1", isError: false, details: { ok: false, code: "CONTRACT_REQUIRED" } });
    await emit("message_end", { message: { role: "assistant", stopReason: "aborted", content: [] } });
    await emit("agent_settled", { aborted: true });
    const data = await rows();
    assert.equal(data.find(row => row.kind === "issue").category, "business-rejection");
    assert.equal(data.find(row => row.kind === "summary").aborted, true);
    assert.equal(new Set(data.filter(row => row.kind === "issue").map(row => row.id)).size, 1);
  });
});
test("黑匣子未信任项目及完全关闭模式不记录", async () => {
  for (const mode of ["automatic", "off"]) await withBox(async ({ cwd, ctx, emit, monitor }) => {
    if (mode === "automatic") ctx.isProjectTrusted = () => false;
    await emit("before_agent_start");
    await emit("tool_result", { toolName: "bash", toolCallId: "e", isError: true });
    await emit("agent_settled");
    await monitor.flush();
    assert.deepEqual(await readdir(cwd), []);
  }, { mode });
});

test("默认自动记录，显式 0 关闭，1 保留详细诊断兼容模式", async () => {
  const previous = process.env.PI_INIT_HANDOFF_LOG;
  try {
    delete process.env.PI_INIT_HANDOFF_LOG;
    await withBox(async ({ emit, rows }) => { await emit("before_agent_start"); await emit("agent_settled"); assert.equal((await rows())[0].kind, "summary"); }, { mode: undefined });
    process.env.PI_INIT_HANDOFF_LOG = "0";
    await withBox(async ({ cwd, emit, monitor }) => { await emit("before_agent_start"); await emit("agent_settled"); await monitor.flush(); assert.deepEqual(await readdir(cwd), []); }, { mode: undefined });
    process.env.PI_INIT_HANDOFF_LOG = "1";
    await withBox(async ({ cwd, emit, monitor }) => { await emit("before_agent_start"); await emit("agent_settled"); await monitor.flush(); assert.ok((await readFile(join(cwd, ".pi/logs/handoff.jsonl"), "utf8")).includes("agent.settled")); }, { mode: undefined });
  } finally { if (previous === undefined) delete process.env.PI_INIT_HANDOFF_LOG; else process.env.PI_INIT_HANDOFF_LOG = previous; }
});
test("Provider 错误分开分类，缺少响应及取消不推断为网络故障", async () => {
  await withBox(async ({ emit, rows }) => {
    await emit("before_agent_start");
    await emit("before_provider_request");
    await emit("after_provider_response", { status: 503 });
    await emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "private-error ECONNRESET", content: [] } });
    await emit("before_provider_request");
    await emit("agent_settled", { aborted: true });
    const data = await rows();
    assert.deepEqual([...new Set(data.filter(row => row.kind === "issue").map(row => row.category))].sort(), ["assistant-failure", "provider-http"]);
    assert.equal(data.find(row => row.kind === "summary").providerRequests, 2);
    assert.equal(JSON.stringify(data).includes("private-error"), false);
  });
});
test("会话与 branch 切换隔离现场和计数，问题汇总保留各窗口观察", async () => {
  await withBox(async ({ ctx, emit, monitor, rows }) => {
    const error = { toolName: "bash", toolCallId: "same", isError: true };
    for (const session of ["s1", "s2"]) {
      ctx.sessionManager.getSessionId = () => session;
      await emit("before_agent_start"); await emit("tool_result", error); await emit("agent_settled");
    }
    await emit("session_tree");
    await emit("before_agent_start"); await emit("tool_result", error); await emit("agent_settled");
    const data = await rows();
    assert.equal(new Set(data.filter(row => row.kind === "issue").map(row => row.captureId)).size, 3);
    assert.match(await monitor.report(ctx), /bash：3 次观察/);
  });
});
test("错误首次立即留证，长现场受限，shutdown 保存未收敛回合摘要", async () => {
  await withBox(async ({ emit, monitor, rows }) => {
    await emit("before_agent_start");
    for (let i = 0; i < 90; i++) await emit("input", { source: "interactive", text: "private-text" });
    await emit("tool_result", { toolName: "bash", toolCallId: "e", isError: true });
    assert.equal((await rows()).filter(row => row.kind === "issue").length, 1);
    for (let i = 0; i < 90; i++) await emit("input", { source: "interactive", text: "private-text" });
    await emit("session_shutdown");
    const data = await rows();
    const issue = data.filter(row => row.kind === "issue").at(-1);
    assert.ok(issue.events.length <= 32);
    assert.equal(issue.incomplete, true);
    assert.equal(data.find(row => row.kind === "summary").incomplete, true);
    assert.equal(JSON.stringify(data).includes("private-text"), false);
    await monitor.flush();
  });
});
test("写入故障只通知一次，不影响工具和回合", async () => {
  await withBox(async ({ cwd, emit, monitor, notices }) => {
    await writeFile(join(cwd, ".pi"), "not-a-directory");
    await emit("before_agent_start");
    await emit("tool_result", { toolName: "bash", toolCallId: "e", isError: true });
    await monitor.flush();
    await emit("agent_settled"); await monitor.flush();
    assert.equal(notices.filter(([text]) => text.includes("写入失败")).length, 1);
  });
});
test("磁盘轮转、保留期限和截断行在报告中有明确边界", async () => {
  await withBox(async ({ cwd, ctx, emit, monitor, rows }) => {
    for (let i = 0; i < 800; i++) { await emit("before_agent_start"); await emit("agent_settled"); if (i % 20 === 0) await monitor.flush(); }
    await monitor.flush();
    const path = join(cwd, ".pi/diagnostics/runtime.jsonl");
    assert.ok((await stat(path)).size <= 128 * 1024);
    assert.ok((await stat(path + ".1")).size <= 128 * 1024);
    await appendFile(path, "{broken\n");
    assert.match(await monitor.report(ctx), /记录不完整/);
    const old = new Date(Date.now() - 8 * 86400000);
    await utimes(path, old, old); await utimes(path + ".1", old, old);
    await emit("before_agent_start"); await emit("agent_settled"); await monitor.flush();
    assert.equal((await rows()).length, 1);
    assert.deepEqual(await readdir(join(cwd, ".pi/diagnostics")), ["runtime.jsonl"]);
  }, { maxBytes: 128 * 1024 });
});
test("真实扩展提供只读 blackbox 命令，不触发模型或修改工作流", async () => {
  await withBox(async ({ cwd }) => {
    const h = createExtensionHarness([], { cwd, trusted: true });
    await h.commands.get("blackbox").handler("", h.context);
    assert.equal(h.sentMessages.length, 0);
    assert.equal(h.sentUserMessages.length, 0);
    assert.ok(h.notifications.some(({ message }) => message.includes("运行黑匣子")));
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("恢复及持久化错误首次观察时留证，正常路径不构造工作流快照", async () => {
  await withBox(async ({ state, emit, rows }) => {
    Object.defineProperty(state, "workflowState", { get() { throw new Error("snapshot unavailable"); } });
    await emit("before_agent_start");
    await emit("agent_settled");
    assert.deepEqual((await rows()).map(row => row.kind), ["summary"]);
    state.roleRecoveryPersistenceFailed = true;
    await emit("before_agent_start");
    await emit("tool_result", { toolName: "read", toolCallId: "normal", content: [] });
    await emit("agent_settled");
    const issues = (await rows()).filter(row => row.kind === "issue");
    assert.equal(issues.at(-1).code, "ROLE_RECOVERY_PERSISTENCE_FAILED");
    assert.equal(issues.at(-1).count, 1);
    assert.deepEqual(issues[0].snapshot, { omitted: true, reason: "snapshot-unavailable" });
  });
});
test("错误风暴限制类别与写入队列，披露溢出且工具调用不抛错", async () => {
  await withBox(async ({ ctx, monitor, emit, rows }) => {
    await emit("before_agent_start");
    assert.doesNotThrow(() => { for (let i = 0; i < 80; i++) monitor.trace(ctx, "runtime.failure", { code: "FAIL_" + i }); });
    await emit("agent_settled");
    await monitor.flush();
    await emit("before_agent_start"); await emit("agent_settled");
    const data = await rows();
    assert.ok(new Set(data.filter(row => row.kind === "issue").map(row => row.id)).size <= 24);
    assert.ok(data.some(row => row.dropped > 0));
    assert.match(await monitor.report(ctx), /记录不完整/);
  });
});


