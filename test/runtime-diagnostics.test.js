import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile, stat, utimes, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandoffDiagnostics } from "../extensions/handoff-diagnostics.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createExtensionHarness, emitExtensionEvent } from "./helpers.js";
import { createRuntimeDiagnostics } from "../extensions/runtime-diagnostics.ts";
import { createWorkflowProgressTracker } from "../src/workflow-progress.ts";
import { createWorkflowState } from "../src/workflow.ts";

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
    const beforeReport = await stat(path);
      assert.match(await monitor.report(ctx), /记录不完整/);
      assert.equal((await stat(path)).mtimeMs, beforeReport.mtimeMs);
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

test("第二版复用语义循环判断，只保存结构化线索且不重复计算循环", async () => {
  await withBox(async ({ ctx, state, monitor, emit, rows }) => {
    const workflow = createWorkflowState({ sessionId: "s1", workflowId: "w1", summary: "private-plan", tasks: [{ id: "t1", task: "private-task", files: ["src"], acceptanceCriteria: ["done"] }] }, 1);
    workflow.status = "running";
    const tracker = createWorkflowProgressTracker();
    state.workflowState = workflow;
    for (let i = 0; i < 4; i++) state.workflowProgressObservation = tracker.observe(workflow, "status-query");
    assert.equal(state.workflowProgressObservation.status, "suspected-loop");
    await emit("before_agent_start");
    monitor.trace(ctx, "workflow.schedule");
    await emit("agent_settled");
    const data = await rows();
    const issues = data.filter(row => row.kind === "issue" && row.category === "suspected-loop");
    assert.equal(issues.at(-1).code, "WORKFLOW_REPEATED_STATE");
    assert.equal(issues.at(-1).count, 1);
    assert.equal(data.find(row => row.kind === "summary").issueOccurrences, 1);
    assert.equal(JSON.stringify(data).includes("private-"), false);
    assert.equal(workflow.status, "running");
  });
});
test("第二版耗时基线先积累健康同配置样本，再对异常慢回合留证", async () => {
  await withBox(async ({ ctx, rows }) => {
    let now = 0;
    ctx.model = { provider: "test", id: "model-a" };
    const box = createRuntimeDiagnostics(() => ({}), { now: () => now });
    const round = async (ms, aborted = false) => {
      box.observe(ctx, "agent.before_start", { profile: { provider: "test", model: "model-a", role: "session", thinkingLevel: "high" } });
      now += ms;
      box.observe(ctx, "assistant.result", { stopReason: "stop" });
      box.observe(ctx, "agent.settled", { aborted });
      await box.flush();
    };
    await round(10000, true);
    for (let i = 0; i < 8; i++) await round(100);
    await round(3000);
    const data = await rows();
    const issue = data.find(row => row.kind === "issue" && row.category === "suspected-slow");
    assert.ok(issue);
    assert.ok(issue.events.some(row => row.data.baselineSamples === 8));
    assert.match(await box.report(ctx), /p50|P50/);
  });
});

test("持续的疑似循环不重复告警，但每个回合仍标记为非健康样本", async () => {
  await withBox(async ({ ctx, state, emit, rows }) => {
    ctx.model = { provider: "test", id: "model" };
    state.activeRole = { role: "developer-test", provider: "test", model: "model", thinkingLevel: "high" };
    state.workflowState = { workflowId: "w", status: "running", tasks: [], revisions: [] };
    state.workflowProgressObservation = { status: "suspected-loop", windowSize: 4, historyLimit: 12, suspicion: { kind: "state-cycle", summary: "private-summary", evidence: ["private-evidence"] } };
    for (let i = 0; i < 2; i++) {
      await emit("before_agent_start");
      await emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
      await emit("agent_settled");
    }
    const summaries = (await rows()).filter(row => row.kind === "summary");
    assert.equal(summaries.length, 2);
    assert.ok(summaries.every(row => row.degraded === true));
    assert.equal(summaries[1].issueOccurrences, 0);
  });
});

test("耗时基线不跨模型配置，回合内换模型或推理强度不进入基线", async () => {
  await withBox(async ({ ctx, rows }) => {
    let now = 0;
    const box = createRuntimeDiagnostics(() => ({}), { now: () => now });
    const profile = { provider: "test", model: "a", role: "session", thinkingLevel: "high" };
    async function round(config, ms, change) {
      ctx.model = { provider: config.provider, id: config.model };
      box.observe(ctx, "agent.before_start", { profile: config });
      now += ms;
      box.observe(ctx, "assistant.result", { stopReason: "stop", profile: change ?? config });
      box.observe(ctx, "agent.settled");
      await box.flush();
    }
    for (let i = 0; i < 8; i++) await round(profile, 100);
    await round({ ...profile, model: "b" }, 5000);
    await round(profile, 5000, { ...profile, thinkingLevel: "low" });
    const data = await rows();
    assert.equal(data.some(row => row.category === "suspected-slow"), false);
    assert.equal(data.filter(row => row.kind === "summary").at(-1).profileChanged, true);
  });
});
test("疑似循环首次在 settled 出现时也计入当前摘要；正常暂停不被判定为循环", async () => {
  await withBox(async ({ ctx, state, monitor, emit, rows }) => {
    await emit("before_agent_start");
    state.workflowState = { workflowId: "w", status: "running", tasks: [], revisions: [] };
    state.workflowProgressObservation = { status: "suspected-loop", windowSize: 3, historyLimit: 12, suspicion: { kind: "repeated-revision", summary: "private-direction", evidence: [] } };
    await emit("agent_settled");
    assert.equal((await rows()).find(row => row.kind === "summary").issueOccurrences, 1);
    state.workflowState.status = "paused";
    monitor.trace(ctx, "workflow.persisted");
    await emit("before_agent_start"); await emit("agent_settled");
    const data = await rows();
    assert.equal(data.filter(row => row.kind === "issue").at(-1).count, 1);
    assert.equal(JSON.stringify(data).includes("private-direction"), false);
  });
});

test("routing rejection stages count eight calls once and retain both observations", async () => {
  await withBox(async ({ ctx, monitor, emit, rows }) => {
    await emit("before_agent_start");
    for (let i = 0; i < 8; i++) {
      const toolCallId = "route-" + i;
      monitor.trace(ctx, "workflow.action_rejected", { toolCallId, action: "switch_role", code: "WORKFLOW_TASK_BOUNDARY_REQUIRED" });
      await emit("tool_result", { toolName: "switch_role", toolCallId, details: { ok: false, code: "WORKFLOW_TASK_BOUNDARY_REQUIRED" } });
    }
    await emit("agent_settled");
    const data = await rows();
    const issues = data.filter(row => row.kind === "issue");
    assert.equal(new Set(issues.map(row => row.id)).size, 1);
    assert.equal(issues.at(-1).count, 8);
    assert.equal(issues.at(-1).toolName, "switch_role");
    assert.equal(data.find(row => row.kind === "summary").issueOccurrences, 8);
    for (const stage of ["workflow.action_rejected", "routing.tool_result"]) assert.ok(issues.at(-1).events.some(row => row.event === stage));
  });
});
test("bounded evidence preserves first and refreshes latest trigger snapshot", async () => {
  await withBox(async ({ ctx, rows }) => {
    let generation = 1;
    const box = createRuntimeDiagnostics(() => ({ generation }));
    box.observe(ctx, "tool.result", { toolName: "bash", toolCallId: "first", isError: true });
    for (let i = 0; i < 90; i++) box.observe(ctx, "input");
    generation = 2;
    box.observe(ctx, "tool.result", { toolName: "bash", toolCallId: "last", isError: true });
    box.observe(ctx, "session.shutdown");
    await box.flush();
    const issue = (await rows()).filter(row => row.kind === "issue").at(-1);
    assert.deepEqual(issue.snapshot, { generation: 1 });
    assert.deepEqual(issue.latestSnapshot, { generation: 2 });
    assert.ok(issue.events.some(row => row.data.toolCallId === "first"));
    assert.ok(issue.events.some(row => row.data.toolCallId === "last"));
    assert.ok(issue.events.length <= 32);
    assert.equal(issue.evidenceTruncated, true);
    assert.equal(issue.incomplete, true);
  });
});
test("budget decisions retain safe numeric context without collection hooks", async () => {
  await withBox(async ({ ctx, monitor, emit, rows }) => {
    monitor.trace(ctx, "context.budget_checked", { tokens: 900, contextWindow: 1000, percent: 90, reason: "threshold", decision: "failed", body: "private-budget" });
    await emit("agent_settled");
    const issue = (await rows()).filter(row => row.kind === "issue").at(-1);
    assert.equal(issue.category, "context-budget");
    assert.deepEqual(issue.events.at(-2).data, { tokens: 900, contextWindow: 1000, percent: 90, reason: "threshold", decision: "failed" });
    assert.equal(JSON.stringify(issue).includes("private-budget"), false);
  });
});
test("provider request summaries disclose missing observations and safe structured errors", async () => {
  await withBox(async ({ emit, rows, monitor, ctx }) => {
    await emit("before_agent_start");
    await emit("before_provider_request");
    await emit("after_provider_response", { status: 503 });
    await emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: { code: "ECONNRESET", status: 503, message: "private-provider" }, content: [] } });
    await emit("before_provider_request");
    await emit("agent_settled", { aborted: true });
    const data = await rows();
    const requests = data.filter(row => row.kind === "provider-request");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].status, 503);
    assert.equal(requests[0].errorCodeHint, "ECONNRESET");
    assert.deepEqual(requests[1].missingObservations, ["headers", "response", "assistant"]);
    assert.equal(requests[1].outcome, "aborted");
    assert.equal(JSON.stringify(data).includes("private-provider"), false);
    assert.match(await monitor.report(ctx), /Provider 请求摘要：2；观察缺失：2/);
  });
});

test("正常预算判断不当作问题，健康Provider请求不逐条落盘", async () => {
  await withBox(async ({ ctx, monitor, emit, rows, notices }) => {
    await emit("before_agent_start");
    monitor.trace(ctx, "context.budget_checked", { tokens: 100, contextWindow: 1000, percent: 10, decision: "threshold", reason: "below-threshold" });
    await emit("before_provider_request");
    await emit("before_provider_headers");
    await emit("after_provider_response", { status: 200 });
    await emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
    await emit("agent_settled");
    const data = await rows();
    assert.deepEqual(data.map(row => row.kind), ["summary"]);
    assert.equal(data[0].issueOccurrences, 0);
    assert.equal(data[0].budget.last.decision, "threshold");
    assert.equal(data[0].providerObservations.requests, 1);
    assert.match(await monitor.report(ctx), /Provider 请求摘要：1；观察缺失：0/);
    assert.equal(notices.length, 0);
  });
});

test("相同错误码来自不同工具仍保留独立问题归属", async () => {
  await withBox(async ({ emit, rows }) => {
    await emit("before_agent_start");
    for (const toolName of ["custom-a", "custom-b"]) await emit("tool_result", { toolName, toolCallId: toolName, details: { ok: false, code: "NOT_ALLOWED" } });
    await emit("agent_settled");
    const issues = (await rows()).filter(row => row.kind === "issue");
    assert.equal(new Set(issues.map(row => row.id)).size, 2);
  });
});

test("headers before request remain associated without leaking across rounds or branches", async () => {
  await withBox(async ({ ctx, emit, rows }) => {
    await emit("before_agent_start");
    await emit("before_provider_headers", { headers: { authorization: "private-header" } });
    await emit("before_provider_request");
    await emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
    await emit("agent_settled", { aborted: false });
    let data = await rows();
    assert.deepEqual(data.at(-1).providerObservations.missingByHook, { headers: 0, response: 1, assistant: 0 });
    await emit("before_provider_headers");
    await emit("session_tree");
    await emit("before_agent_start");
    await emit("before_provider_request");
    await emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
    await emit("agent_settled", { aborted: false });
    data = await rows();
    assert.equal(data.at(-1).providerObservations.missingByHook.headers, 1);
    assert.equal(JSON.stringify(data).includes("private-header"), false);
  });
});
test("projection budget dimensions survive metadata filtering and healthy round aggregation", async () => {
  await withBox(async ({ ctx, emit, monitor, rows }) => {
    await emit("before_agent_start");
    const projection = { reason: "protected-content-over-budget", inputBytes: 250000, outputBytes: 200000, budgetBytes: 192000, checkpointed: true, overBudget: true, omittedMessages: 10, messages: ["private-source"] };
    monitor.trace(ctx, "context.projected", projection);
    await emit("tool_result", { toolName: "edit", toolCallId: "edit-1", isError: true });
    await emit("agent_settled", { aborted: false });
    const data = await rows();
    const event = data.find(row => row.kind === "issue").events.find(row => row.event === "context.projected");
    assert.equal(event.data.inputBytes, 250000);
    assert.equal(event.data.overBudget, true);
    const summary = data.find(row => row.kind === "summary");
    assert.equal(summary.contextProjection.overBudget, 1);
    assert.equal(summary.contextProjection.last.budgetBytes, 192000);
    assert.equal(JSON.stringify(data).includes("private-source"), false);
    assert.match(await monitor.report(ctx), /投影预算超额：1/);
  });
});
test("nested failures are displayed as observed chains without erasing per-tool counts", async () => {
  await withBox(async ({ ctx, emit, monitor }) => {
    await emit("before_agent_start");
    await emit("tool_result", { toolName: "ctx_execute_file", toolCallId: "parent/1", parentToolCallId: "parent", isError: true });
    await emit("tool_result", { toolName: "codemode", toolCallId: "parent", isError: true });
    await emit("agent_settled", { aborted: false });
    const report = await monitor.report(ctx);
    assert.match(report, /已关联嵌套工具失败链：1/);
    assert.match(report, /ctx_execute_file：1 次观察/);
    assert.match(report, /codemode：1 次观察/);
  });
});

test("pre-request headers are consumed once and reset at every identity boundary", async () => {
  for (const boundary of ["round", "session", "cwd", "branch", "settled", "untrusted"]) {
    await withBox(async ({ ctx, emit, rows }) => {
      await emit("before_agent_start");
      await emit("before_provider_headers");
      if (boundary === "round") await emit("before_agent_start");
      if (boundary === "session") ctx.sessionManager.getSessionId = () => "s2";
      if (boundary === "cwd") { const previous = ctx.cwd; ctx.cwd += "/other"; await emit("before_provider_request"); ctx.cwd = previous; }
      if (boundary === "branch") await emit("session_tree");
      if (boundary === "settled") await emit("agent_settled", { aborted: false });
      if (boundary === "untrusted") { ctx.isProjectTrusted = () => false; await emit("before_provider_request"); ctx.isProjectTrusted = () => true; }
      if (["session", "cwd", "branch", "settled"].includes(boundary)) await emit("before_agent_start");
      await emit("before_provider_request");
      await emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
      await emit("agent_settled", { aborted: false });
      assert.equal((await rows()).at(-1).providerObservations.missingByHook.headers, 1, boundary);
    });
  }
  await withBox(async ({ emit, rows }) => {
    await emit("before_agent_start");
    await emit("before_provider_headers");
    for (let i = 0; i < 2; i++) {
      await emit("before_provider_request");
      await emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
    }
    await emit("agent_settled", { aborted: false });
    assert.deepEqual((await rows()).at(-1).providerObservations.missingByHook, { headers: 1, response: 2, assistant: 0 });
  });
});
test("healthy rounds retain only bounded projection summaries without creating issues", async () => {
  await withBox(async ({ ctx, emit, monitor, rows }) => {
    await emit("before_agent_start");
    monitor.trace(ctx, "context.projected", { inputBytes: 250000, outputBytes: 200000, budgetBytes: 192000, checkpointed: true, overBudget: true });
    await emit("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
    await emit("agent_settled", { aborted: false });
    const data = await rows();
    assert.deepEqual(data.map(row => row.kind), ["summary"]);
    assert.equal(data[0].contextProjection.overBudget, 1);
    await emit("before_agent_start");
    await emit("agent_settled", { aborted: false });
    assert.equal((await rows()).at(-1).contextProjection.checks, 0);
  });
});

async function withDirectDiagnostics(fn) {
  await withBox(async ({ cwd, ctx }) => {
    const box = createRuntimeDiagnostics(() => ({}));
    const rows = async () => {
      await box.flush();
      return (await readFile(join(cwd, ".pi/diagnostics/runtime.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    };
    try { await fn({ ctx, box, rows }); } finally { await box.flush(); }
  });
}

test("workflow rejection correlates only observed call IDs; real failures and private result boundaries remain", async () => {
  await withDirectDiagnostics(async ({ ctx, box, rows }) => {
    box.observe(ctx, "agent.before_start");
    box.observe(ctx, "workflow.action_rejected", { toolCallId: "rejected", code: "TASK_MEMORY_REVISION_STALE" });
    const result = { toolCallId: "rejected", toolName: "task_workflow", isError: true, text: "private-result", input: { secret: "private-input" } };
    box.observe(ctx, "routing.tool_result", result);
    box.observe(ctx, "tool.result", result);
    box.observe(ctx, "routing.tool_result", { ...result, toolCallId: "real-failure" });
    box.observe(ctx, "routing.tool_result", { ...result, code: "EIO" });
    box.observe(ctx, "agent.settled");
    const data = await rows();
    const latest = [...new Map(data.filter(row => row.kind === "issue").map(row => [row.id, row])).values()];
    assert.deepEqual(latest.map(row => [row.category, row.code, row.count]), [
      ["business-rejection", "TASK_MEMORY_REVISION_STALE", 1], ["tool-failure", "UNKNOWN", 1], ["tool-failure", "EIO", 1],
    ]);
    assert.equal(data.find(row => row.kind === "summary").issueOccurrences, 3);
    assert.ok(latest[0].events.some(row => row.event === "routing.tool_result" && row.data.toolCallId === "rejected" && row.data.isError));
    assert.equal(JSON.stringify(data).includes("private-"), false);
    assert.equal(result.isError, true);
  });
});

test("rejection correlation clears on run, capture, session, settlement, shutdown and trust boundaries", async () => {
  for (const boundary of ["agent.before_start", "session.tree", "session.start", "session-change", "agent.settled", "session.shutdown", "untrusted"]) {
    await withDirectDiagnostics(async ({ ctx, box, rows }) => {
      box.observe(ctx, "agent.before_start");
      box.observe(ctx, "workflow.action_rejected", { toolCallId: "same", code: "TASK_MEMORY_REVISION_STALE" });
      if (boundary === "session-change") ctx.sessionManager.getSessionId = () => "other";
      else if (boundary === "untrusted") {
        ctx.isProjectTrusted = () => false;
        box.observe(ctx, "input");
        ctx.isProjectTrusted = () => true;
      } else box.observe(ctx, boundary);
      box.observe(ctx, "routing.tool_result", { toolCallId: "same", isError: true });
      box.observe(ctx, "agent.settled");
      assert.ok((await rows()).some(row => row.category === "tool-failure" && row.code === "UNKNOWN"), boundary);
    });
  }
});

test("correlation is bounded and never inferred from text or tool name", async () => {
  await withDirectDiagnostics(async ({ ctx, box, rows }) => {
    box.observe(ctx, "agent.before_start");
    for (let i = 0; i < 129; i++) box.observe(ctx, "workflow.action_rejected", { toolCallId: `id-${i}`, code: "TASK_MEMORY_REVISION_STALE" });
    box.observe(ctx, "routing.tool_result", { toolCallId: "id-0", toolName: "task_workflow", isError: true, text: "TASK_MEMORY_REVISION_STALE" });
    box.observe(ctx, "routing.tool_result", { toolCallId: "id-128", isError: true });
    box.observe(ctx, "agent.settled");
    const failures = (await rows()).filter(row => row.category === "tool-failure");
    assert.equal(failures.at(-1).count, 1);
    assert.equal(failures.at(-1).latestTrigger.data.toolCallId, "id-0");
  });
});
