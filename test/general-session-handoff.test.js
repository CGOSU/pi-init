import assert from "node:assert/strict";
import test from "node:test";
import { realpathSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { registerGeneralSessionHandoff } from "../extensions/general-session-handoff.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowToolBinding } from "../extensions/workflow-tool-binding.ts";
import { GENERAL_HANDOFF_ENTRY, parseGeneralHandoff, readGeneralHandoff } from "../src/general-session-handoff.ts";
import { SESSION_HANDOFF_MAX_BYTES } from "../src/session-handoff.ts";
import { withTempDirectory } from "./support/temp-directory.js";

const body = () => ({ goal: "继续实现交接", constraints: ["不得部署"], completed: ["已调查"], remaining: ["实现fresh"], verification: [], unknowns: ["未验证真实Provider费用"], nextStep: "预览快照", sources: [] });
function fixture(cwd) {
  const manager = SessionManager.create(cwd, cwd);
  manager.appendMessage({ role: "user", content: "准备短交接", timestamp: Date.now() });
  // A real assistant entry is needed for the SDK to persist the transcript to disk.
  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "prepare", name: "session_handoff", arguments: body() }], api: "test", provider: "test", model: "test", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() });
  const handlers = new Map(), tools = [];
  const pi = {
    on(name, handler) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerTool(tool) { tools.push(tool); },
    appendEntry(type, data) { manager.appendCustomEntry(type, data); },
    getThinkingLevel() { return "medium"; },
  };
  const state = createExtensionRuntimeState();
  state.activeRole = { role: "developer-test", provider: "test", model: "test", thinkingLevel: "medium" };
  const ctx = { cwd, sessionManager: manager, model: { provider: "test", id: "test" }, isProjectTrusted: () => true };
  const binding = createWorkflowToolBinding(pi, state);
  const api = registerGeneralSessionHandoff(pi, state, binding.generalToolsSettled);
  const save = input => tools[0].execute("prepare", input ?? body(), undefined, undefined, ctx).then(result => result.details);
  const emit = async (name, event = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  return { manager, state, ctx, api, save, emit, pi };
}

test("complete bounded input distinguishes missing, invalid and oversized data without truncation", () => {
  for (const [input, code] of [[undefined, "MISSING"], [[], "TYPE"], [{ goal: "a" }, "MISSING"], [{ ...body(), goal: " " }, "EMPTY"], [{ ...body(), constraints: [42] }, "TYPE"], [{ ...body(), sessionId: "forged" }, "FIELD"], [{ ...body(), goal: "x".repeat(SESSION_HANDOFF_MAX_BYTES) }, "TOO_LARGE"], [{ ...body(), verification: [{ summary: "passed", sources: [] }] }, "SOURCE_MISSING"], [{ ...body(), sources: [{ kind: "obs_recall", location: "obs_fake", description: "跨会话不可假定" }] }, "SOURCE_KIND"]]) {
    const result = parseGeneralHandoff(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
  }
  assert.deepEqual(parseGeneralHandoff(body()), { ok: true, value: body() });
});

test("decision context is optional, distinguishes status and permits unknown rationale", () => {
  for (const decisions of [[], [
    { status: "confirmed", conclusion: "  保留身份校验  ", rationale: "  防止错误续接；排除绕过校验，限普通交接  " },
    { status: "proposed", conclusion: "后续按需优化" },
    { status: "unverified", conclusion: "历史假设", rationale: "" },
  ]]) {
    const result = parseGeneralHandoff({ ...body(), decisions });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.decisions, decisions.map(d => ({ ...d, conclusion: d.conclusion.trim(), ...(d.rationale !== undefined ? { rationale: d.rationale.trim() } : {}) })));
  }
  for (const [decisions, code] of [
    [null, "TYPE"], [[null], "TYPE"], [[{ status: "approved", conclusion: "a" }], "DECISION_STATUS"],
    [[{ status: "confirmed", conclusion: " " }], "EMPTY"], [[{ status: "proposed", conclusion: 1 }], "TYPE"],
    [[{ status: "unverified", conclusion: "a", rationale: 1 }], "TYPE"],
    [[{ status: "confirmed", conclusion: "a", authorized: true }], "FIELD"],
    [[{ status: "confirmed", conclusion: "a", rationale: "中".repeat(SESSION_HANDOFF_MAX_BYTES) }], "TOO_LARGE"],
  ]) {
    const result = parseGeneralHandoff({ ...body(), decisions });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
  }
});

test("decision context survives persistence without upgrading suggestions or assumptions", async () => {
  await withTempDirectory(async cwd => {
    const h = fixture(cwd);
    const decisions = [
      { status: "confirmed", conclusion: "保留32 KiB限制", rationale: "限制交接体积，完整拒绝而非截断" },
      { status: "proposed", conclusion: "后续优化提示" },
      { status: "unverified", conclusion: "尚未证实的判断", rationale: "待确认" },
    ];
    const saved = await h.save({ ...body(), decisions });
    assert.equal(saved.ok, true);
    const reopened = SessionManager.open(h.manager.getSessionFile(), cwd);
    const read = readGeneralHandoff(reopened.getBranch(), saved.value.source);
    assert.equal(read.ok, true);
    assert.deepEqual(read.value.context.decisions, decisions);
  });
});

test("preparation persists source-bound historical background without migration or workflow", async () => {
  await withTempDirectory(async cwd => {
    const h = fixture(cwd);
    const input = body();
    const source = { kind: "session-entry", location: h.manager.getBranch()[0].id, description: "用户约束" };
    input.sources.push(source);
    input.verification.push({ summary: "仅历史声明，未升级为本次验证", sources: [source] });
    await h.emit("tool_execution_start", { toolCallId: "prepare", toolName: "session_handoff" });
    const saved = await h.save(input);
    assert.equal(saved.ok, true);
    assert.equal(saved.value.historical, true);
    assert.equal(saved.value.source.sessionId, h.manager.getSessionId());
    assert.equal(h.state.workflowState, undefined);
    await h.emit("tool_execution_end", { toolCallId: "prepare" });
    h.manager.appendMessage({ role: "toolResult", toolCallId: "prepare", toolName: "session_handoff", content: [{ type: "text", text: "saved" }], isError: false, timestamp: Date.now() });
    h.manager.appendCustomEntry("pi-token-speed", { version: 1, outputTokens: 42, elapsedMs: 1000 });
    h.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "已准备" }], api: "test", provider: "test", model: "test", usage: {}, stopReason: "stop", timestamp: Date.now() });
    h.manager.appendCustomEntry("pi-init-session-work-time", { totalMilliseconds: 1000 });
    h.manager.appendCustomEntry("pi-init-run-timing", { source: "interactive", completedAt: Date.now() });
    await h.emit("agent_end");
    assert.equal(h.api.read(h.ctx).ok, true);
    const reopened = SessionManager.open(h.manager.getSessionFile(), cwd);
    assert.equal(readGeneralHandoff(reopened.getBranch(), saved.value.source).ok, true);
    const differentSession = { ...saved.value.source, sessionId: "other-session" };
    assert.equal(readGeneralHandoff(reopened.getBranch(), differentSession).code, "IDENTITY");
  });
});

test("omitting an empty failed assistant after preparation preserves the persisted snapshot", async () => {
  await withTempDirectory(async cwd => {
    const h = fixture(cwd);
    const saved = await h.save();
    const failed = h.manager.appendMessage({ role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: {}, stopReason: "error", errorMessage: "connection termination", timestamp: Date.now() });
    h.manager.appendContextEdit(failed, null);
    assert.equal(h.api.read(h.ctx).ok, true);
    const reopened = SessionManager.open(h.manager.getSessionFile(), cwd);
    assert.equal(readGeneralHandoff(reopened.getBranch(), saved.value.source).ok, true);
  });
});

test("context edits outside undispatched post-snapshot failure omissions still invalidate", async () => {
  for (const scenario of [
    { before: true, content: [], stopReason: "error", replacement: null },
    { content: [{ type: "text", text: "partial answer" }], stopReason: "error", replacement: null },
    { content: [{ type: "toolCall", id: "business", name: "bash", arguments: {} }], stopReason: "toolUse", replacement: null },
    { content: [{ type: "text", text: "partial" }, { type: "toolCall", id: "business", name: "bash", arguments: {} }], stopReason: "error", replacement: null },
    { content: [], stopReason: "stop", replacement: null },
    { content: [{ type: "text", text: "partial" }], stopReason: "aborted", replacement: null },
    { content: [], stopReason: "error", replacement: { content: "replacement answer" } },
    { role: "user", content: "changed requirement", replacement: null },
    { role: "toolResult", toolCallId: "business", toolName: "bash", content: [], replacement: null },
  ]) await withTempDirectory(async cwd => {
    const h = fixture(cwd);
    const { before, replacement, ...message } = scenario;
    const append = () => h.manager.appendMessage({ role: "assistant", api: "test", provider: "test", model: "test", usage: {}, timestamp: Date.now(), ...message });
    const earlier = before ? append() : undefined;
    assert.equal((await h.save()).ok, true);
    const target = earlier ?? append();
    h.manager.appendContextEdit(target, replacement);
    assert.equal(h.api.read(h.ctx).code, "STALE", JSON.stringify(scenario));
  });
});

test("business activity, input and branch changes invalidate; save's own result does not", async () => {
  for (const mutate of [
    h => h.emit("tool_execution_start", { toolCallId: "next", toolName: "bash" }),
    h => h.emit("input", { text: "新增需求" }),
    h => h.emit("session_tree", {}),
    h => h.manager.appendCustomEntry("pi-init-role-recovery", { status: "pending", reason: "reload" }),
    h => h.manager.appendCustomEntry("unknown-extension-state", { changed: true }),
    h => h.manager.appendMessage({ role: "user", content: "new goal", timestamp: Date.now() }),
    h => h.manager.appendMessage({ role: "toolResult", toolCallId: "business", toolName: "bash", content: [], isError: true, timestamp: Date.now() }),
  ]) await withTempDirectory(async cwd => {
    const h = fixture(cwd);
    assert.equal((await h.save()).ok, true);
    await mutate(h);
    assert.equal(h.api.read(h.ctx).code, "STALE");
  });
});

test("role, trust, stop, recovery, unknown workflow and concurrent tools fail closed", async () => {
  const cases = [
    [h => { h.state.activeRole.role = "architect"; }, "ROLE"],
    [h => { h.state.activeRole.model = "other"; }, "ROLE"],
    [h => { h.state.activeRole = undefined; }, "ROLE"],
    [h => { h.ctx.isProjectTrusted = () => false; }, "SAFETY_GATE"],
    [h => { h.state.userStopRequested = true; }, "SAFETY_GATE"],
    [h => { h.state.roleRecoveryPending = true; }, "SAFETY_GATE"],
    [h => { h.state.workflowState = { status: "paused" }; }, "WORKFLOW_ACTIVE"],
    [h => h.emit("tool_execution_start", { toolCallId: "nested", toolName: "codemode" }), "TOOLS_ACTIVE"],
    [h => { h.ctx.sessionManager.getSessionFile = () => undefined; }, "PERSISTENCE"],
  ];
  for (const [change, code] of cases) await withTempDirectory(async cwd => {
    const h = fixture(cwd);
    await change(h);
    assert.equal((await h.save()).code, code);
    assert.equal(h.manager.getBranch().some(e => e.customType === GENERAL_HANDOFF_ENTRY), false);
  });
});

test("missing snapshots and foreign sources are explicit; fresh preparation replaces stale data", async () => {
  await withTempDirectory(async cwd => {
    const h = fixture(cwd);
    assert.equal(h.api.read(h.ctx).code, "MISSING");
    const foreign = { ...body(), sources: [{ kind: "session-entry", location: "other-branch", description: "not accessible" }] };
    assert.equal((await h.save(foreign)).code, "SOURCE_IDENTITY");
    assert.equal((await h.save()).ok, true);
    await h.emit("input", { text: "changed" });
    assert.equal(h.api.read(h.ctx).code, "STALE");
    const reopened = SessionManager.open(h.manager.getSessionFile(), cwd);
    assert.equal(readGeneralHandoff(reopened.getBranch(), { sessionId: h.manager.getSessionId(), sessionFile: realpathSync(h.manager.getSessionFile()), projectRoot: realpathSync(cwd) }).code, "STALE");
    assert.equal((await h.save()).ok, true);
    assert.equal(h.api.read(h.ctx).ok, true);
    h.pi.appendEntry = () => { throw new Error("disk error"); };
    assert.equal((await h.save()).code, "PERSISTENCE");
  });
});
