import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorkflowToolBinding } from "../extensions/workflow-tool-binding.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createSessionHandoff } from "../extensions/session-handoff.ts";
import { GENERAL_TRANSFER_ENTRY } from "../extensions/general-session-transfer.ts";
import { GENERAL_HANDOFF_ENTRY } from "../src/general-session-handoff.ts";
import { sdkReceipt } from "./support/nested-receipt.js";
import { sdkAssistantTurn } from "./support/sdk-assistant-turn.js";
import { SESSION_HANDOFF_ENTRY } from "../src/session-handoff.ts";
import { withTempDirectory } from "./support/temp-directory.js";

const body = () => ({ goal: "继续普通会话", constraints: ["不部署"], completed: ["已调查"], remaining: ["实现后续"], verification: [], unknowns: ["未验证费用"], nextStep: "等待用户继续", sources: [] });
function fixture(cwd, manager = SessionManager.create(cwd, cwd)) {
  const handlers = new Map(), tools = [], notices = [], confirmations = [];
  let settled = true, disposed = false, preparation = 0;
  const state = createExtensionRuntimeState();
  state.activeRole = { role: "developer-test", provider: "test", model: "test", thinkingLevel: "medium" };
  const pi = {
    on(name, fn) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    registerTool(tool) { tools.push(tool); },
    appendEntry(type, data) { assert.equal(disposed, false, "old pi used after replacement"); manager.appendCustomEntry(type, data); },
    getThinkingLevel() { assert.equal(disposed, false, "old pi used after replacement"); return "medium"; },
  };
  const ctx = { cwd, sessionManager: manager, model: { provider: "test", id: "test" }, hasUI: true,
    isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
    abort() {}, ui: {
      notify(message, level) { assert.equal(disposed, false, "old ctx used after replacement"); notices.push({ message, level }); },
      async confirm(title, content) { confirmations.push({ title, content }); return true; },
    },
  };
  const binding = createWorkflowToolBinding(pi, state);
  const api = createSessionHandoff(pi, state, { generalToolsSettled: (current, preparingId) => settled ? binding.generalToolsSettled(current, preparingId) : { ok: false, code: "TOOLS_NOT_SETTLED", message: "test runtime uncertainty" }, toolsSettled: current => settled && binding.toolsSettled(current), persist() { throw new Error("ordinary handoff must not create workflow"); }, restore() {}, schedule() { throw new Error("must not schedule"); } });
  const save = async (overrides = {}) => {
    manager.appendMessage({ role: "user", content: "准备交接", timestamp: Date.now() });
    const input = { ...body(), ...overrides };
    const preparingId = `prepare-${++preparation}-${manager.getLeafId()}`;
    input.sources = [{ kind: "session-entry", location: manager.getLeafId(), description: "原始需求" }];
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: preparingId, name: "session_handoff", arguments: input }], api: "test", provider: "test", model: "test", usage: {}, stopReason: "toolUse", timestamp: Date.now() });
    const result = await tools.find(t => t.name === "session_handoff").execute(preparingId, input, undefined, undefined, ctx);
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    manager.appendMessage({ role: "toolResult", toolCallId: preparingId, toolName: "session_handoff", content: result.content, isError: false, timestamp: Date.now() });
    return result.details.value;
  };
  const h = { api, state, manager, ctx, notices, confirmations, tools, save, setSettled(v) { settled = v; }, dispose() { disposed = true; state.runtimeDisposed = true; } };
  h.emit = async (name, event = {}) => { const results = []; for (const fn of handlers.get(name) ?? []) results.push(await fn(event, ctx)); return results; };
  ctx.sendMessage = async (message, options) => {
    assert.equal(options.triggerTurn, false);
    assert.equal(disposed, false, "old ctx used after replacement");
    manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    await h.emit("message_end", { message: { role: "custom", ...message } });
  };
  h.replace = async (options, { skipActivation = false, failAfterSetup = false, failBodyWrite = false, corrupt = false } = {}) => {
    h.calls = (h.calls ?? 0) + 1;
    h.target = fixture(cwd);
    h.dispose();
    if (failBodyWrite) {
      const append = h.target.manager.appendMessage.bind(h.target.manager);
      h.target.manager.appendMessage = message => { append(message); throw new Error("body write result unknown after persistence"); };
    }
    await options.setup(h.target.manager);
    if (corrupt) h.target.manager.getBranch().find(e => e.customType === GENERAL_TRANSFER_ENTRY).data.snapshot.context.goal = "tampered";
    if (failAfterSetup) throw new Error("replacement outcome unknown after target setup");
    if (!skipActivation) await options.withSession(h.target.ctx);
    return { cancelled: false };
  };
  ctx.newSession = options => h.replace(options);
  return h;
}

test("ordinary handoff uses setup then fresh context, persists only background, and does not schedule", async () => {
  await withTempDirectory(async cwd => {
    const h = fixture(cwd);
    const snapshot = await h.save();
    h.manager.appendCustomEntry("pi-token-speed", { version: 1, outputTokens: 42, elapsedMs: 1000 });
    h.manager.appendCustomEntry("pi-init-session-work-time", { totalMilliseconds: 1000 });
    h.manager.appendCustomEntry("pi-init-run-timing", { source: "interactive", completedAt: Date.now() });
    const failed = h.manager.appendMessage({ role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: {}, stopReason: "error", errorMessage: "connection termination", timestamp: Date.now() });
    h.manager.appendContextEdit(failed, null);
    h.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "已准备好交接" }], api: "test", provider: "test", model: "test", usage: {}, stopReason: "stop", timestamp: Date.now() });
    const oldFile = h.manager.getSessionFile();
    await h.api.fresh(h.ctx);
    assert.equal(h.calls, 1);
    const target = h.target;
    assert.equal(target.state.workflowState, undefined);
    assert.equal(target.notices.at(-1).level, "info");
    assert.ok(target.notices.at(-1).message.includes(target.manager.getSessionId()));
    const messages = target.manager.getBranch().filter(e => e.type === "message");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message.role, "user");
    assert.ok(messages[0].message.content.includes(JSON.stringify(snapshot)));
    assert.equal(target.manager.getHeader().id === h.manager.getHeader().id, false);
    const reopened = SessionManager.open(target.manager.getSessionFile(), cwd);
    assert.equal(reopened.getEntries().filter(e => e.type === "message").length, 1);
    assert.ok((await readFile(oldFile, "utf8")).includes(snapshot.context.goal));
    assert.equal(h.confirmations.length, 1);
    const recovered = fixture(cwd, reopened);
    recovered.ctx.newSession = () => { throw new Error("must not create a second target"); };
    await recovered.api.fresh(recovered.ctx);
    assert.ok(recovered.notices.some(n => n.level === "info"));
    assert.ok(recovered.notices.at(-1).message.includes("本次未新建会话"));
    assert.equal(reopened.getEntries().filter(e => e.type === "message").length, 1);
  });
});

test("decision context reaches preview and the persisted target background without status changes", async () => {
  await withTempDirectory(async cwd => {
    const h = fixture(cwd);
    const decisions = [
      { status: "confirmed", conclusion: "不扩大交接授权", rationale: "历史背景不能恢复执行身份；排除自动续跑" },
      { status: "proposed", conclusion: "按需改进摘要" },
      { status: "unverified", conclusion: "依据尚待确认", rationale: "" },
    ];
    const snapshot = await h.save({ decisions });
    await h.api.fresh(h.ctx);
    assert.equal(h.calls, 1);
    assert.ok(h.confirmations[0].content.includes(JSON.stringify(snapshot)));
    const reopened = SessionManager.open(h.target.manager.getSessionFile(), cwd);
    const background = reopened.getBranch().find(e => e.type === "message" && e.message.role === "user").message.content;
    assert.ok(background.includes(JSON.stringify(snapshot)));
    const incoming = reopened.getEntries().find(e => e.type === "custom" && e.customType === GENERAL_TRANSFER_ENTRY).data;
    assert.deepEqual(incoming.snapshot.context.decisions, decisions);
    assert.equal(h.target.state.workflowState, undefined);
  });
});

test("received sessions can prepare another handoff and create a distinct successor, including after reload", async () => {
  for (const reload of [false, true]) await withTempDirectory(async cwd => {
    const a = fixture(cwd);
    await a.save({ goal: "background selected for B" });
    await a.api.fresh(a.ctx);
    const b = reload ? fixture(cwd, SessionManager.open(a.target.manager.getSessionFile(), cwd)) : a.target;
    await b.save({ goal: "new background selected for C" });
    await b.api.fresh(b.ctx);
    assert.equal(b.calls, 1, JSON.stringify(b.notices));
    const c = b.target;
    assert.equal(new Set([a, b, c].map(h => h.manager.getSessionId())).size, 3);
    const records = h => h.manager.getEntries().filter(e => e.type === "custom" && e.customType === GENERAL_TRANSFER_ENTRY).map(e => e.data);
    const outgoing = records(b).find(e => e.kind === "outgoing");
    const incoming = records(c).find(e => e.kind === "incoming");
    assert.equal(incoming.id, outgoing.id);
    assert.equal(incoming.hash, outgoing.hash);
    assert.equal(incoming.snapshot.source.sessionId, b.manager.getSessionId());
    assert.equal(incoming.targetSessionId, c.manager.getSessionId());
    const messages = c.manager.getBranch().filter(e => e.type === "message");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message.role, "user");
    assert.ok(messages[0].message.content.includes("new background selected for C"));
    assert.ok(!messages[0].message.content.includes("background selected for B"));
  });
});

test("new stale, corrupt or off-branch preparations cannot fall back to old import success", async () => {
  for (const change of [
    b => b.emit("input", { text: "new goal" }),
    b => b.manager.appendCustomEntry(GENERAL_HANDOFF_ENTRY, {}),
    (b, oldLeaf) => b.manager.branch(oldLeaf),
  ]) await withTempDirectory(async cwd => {
    const a = fixture(cwd); await a.save(); await a.api.fresh(a.ctx);
    const b = a.target;
    const oldLeaf = b.manager.getLeafId();
    await b.save({ goal: "new selection" });
    await change(b, oldLeaf);
    const before = b.notices.length;
    await b.api.fresh(b.ctx);
    assert.equal(b.calls ?? 0, 0);
    assert.ok(b.notices.length > before);
    assert.equal(b.notices.at(-1).level, "warning");
    assert.equal(b.manager.getEntries().some(e => e.type === "custom" && e.customType === GENERAL_TRANSFER_ENTRY && e.data.kind === "outgoing"), false);
  });
});

test("a failed preparation attempt reports the missing current snapshot, not old import success", async () => {
  for (const previousPreparation of [false, true]) await withTempDirectory(async cwd => {
    const a = fixture(cwd); await a.save(); await a.api.fresh(a.ctx);
    const b = a.target;
    if (previousPreparation) await b.save();
    const input = { ...body(), goal: "" };
    b.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "failed-preparation", name: "session_handoff", arguments: input }], api: "test", provider: "test", model: "test", usage: {}, stopReason: "toolUse", timestamp: Date.now() });
    const result = await b.tools.find(t => t.name === "session_handoff").execute("failed-preparation", input, undefined, undefined, b.ctx);
    assert.equal(result.details.ok, false);
    b.manager.appendMessage({ role: "toolResult", toolCallId: "failed-preparation", toolName: "session_handoff", content: result.content, isError: false, timestamp: Date.now() });
    const before = b.notices.length;
    await b.api.fresh(b.ctx);
    assert.equal(b.calls ?? 0, 0);
    assert.ok(b.notices.length > before);
    assert.equal(b.notices.at(-1).level, "warning");
  });
});

test("new preparation never bypasses a damaged historical import", async () => {
  await withTempDirectory(async cwd => {
    const a = fixture(cwd); await a.save(); await a.api.fresh(a.ctx);
    const b = a.target;
    b.manager.getBranch().find(e => e.type === "custom" && e.customType === GENERAL_TRANSFER_ENTRY).data.snapshot.context.goal = "tampered";
    await b.save();
    await b.api.fresh(b.ctx);
    assert.equal(b.calls ?? 0, 0);
    assert.equal(b.notices.at(-1).level, "warning");
  });
});

test("a previous incoming never unlocks a source with an uncertain outgoing, even after reload and branch change", async () => {
  await withTempDirectory(async cwd => {
    const a = fixture(cwd); await a.save(); await a.api.fresh(a.ctx);
    const b = a.target; await b.save();
    const beforeOutgoing = b.manager.getLeafId();
    let attempts = 0;
    b.ctx.newSession = async () => { attempts++; return { cancelled: false }; };
    await b.api.fresh(b.ctx);
    await b.api.fresh(b.ctx);
    assert.equal(attempts, 1);
    assert.equal(b.notices.at(-1).level, "warning");
    const reopened = SessionManager.open(b.manager.getSessionFile(), cwd);
    reopened.branch(beforeOutgoing);
    const recovered = fixture(cwd, reopened);
    recovered.ctx.newSession = async () => { attempts++; throw new Error("must not create again"); };
    await recovered.api.fresh(recovered.ctx);
    assert.equal(attempts, 1);
    assert.equal(recovered.notices.at(-1).level, "warning");
    assert.ok((await recovered.emit("tool_call")).some(result => result?.block));
    assert.ok((await recovered.emit("input")).some(result => result?.action === "handled"));
  });
});

test("successive handoff cancellation needs a fresh preparation; partial targets recover without a duplicate", async () => {
  for (const partial of [false, true]) await withTempDirectory(async cwd => {
    const a = fixture(cwd); await a.save(); await a.api.fresh(a.ctx);
    const b = a.target; await b.save();
    if (partial) b.ctx.newSession = options => b.replace(options, { failAfterSetup: true });
    else b.ctx.newSession = async () => ({ cancelled: true });
    await b.api.fresh(b.ctx);
    if (partial) {
      const c = b.target;
      c.ctx.newSession = async () => { throw new Error("must not duplicate partial target"); };
      await c.api.fresh(c.ctx);
      assert.equal(c.notices.at(-1).level, "info");
      assert.equal(b.calls, 1);
      const recoveredB = fixture(cwd, SessionManager.open(b.manager.getSessionFile(), cwd));
      await recoveredB.api.fresh(recoveredB.ctx);
      assert.equal(recoveredB.calls ?? 0, 0);
      assert.equal(recoveredB.notices.at(-1).level, "warning");
    } else {
      b.ctx.newSession = options => b.replace(options);
      await b.api.fresh(b.ctx);
      assert.equal(b.calls ?? 0, 0);
      assert.equal(b.notices.at(-1).level, "warning");
      await b.save({ goal: "selected after cancellation" });
      await b.api.fresh(b.ctx);
      assert.equal(b.calls, 1);
      assert.equal(b.target.notices.at(-1).level, "info");
    }
  });
});

test("SDK recovery, parameter omissions and completed imports survive reload and preview in one handoff", async () => {
  for (const status of ["completed", "cancelled"]) for (const stop of ["error", "aborted"]) await withTempDirectory(async cwd => {
    const h = fixture(cwd);
    const completed = { status, workflowId: "old-workflow", tasks: [] };
    h.state.workflowState = completed;
    h.manager.appendCustomEntry(SESSION_HANDOFF_ENTRY, { kind: "incoming", workflowId: "old-workflow" });
    const addRecovery = async (manager, id) => {
      const { messages } = await sdkAssistantTurn(stop, `${cwd}/never-executed`, id);
      const failed = manager.appendMessage(messages.find(m => m.role === "assistant"));
      manager.appendContextEdit(failed, null);
    };
    await addRecovery(h.manager, "before-snapshot");
    h.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "root", name: "codemode", arguments: {} }], api: "test", provider: "test", model: "test", usage: {}, stopReason: "toolUse", timestamp: Date.now() });
    h.manager.appendMessage({ role: "toolResult", toolCallId: "root", toolName: "codemode", content: [], isError: false, nestedCalls: sdkReceipt(), timestamp: Date.now() });
    const snapshot = await h.save();
    await addRecovery(h.manager, "after-snapshot");
    h.manager.appendCustomEntry("pi-init-run-timing", { completedAt: Date.now() });
    const loaded = fixture(cwd, SessionManager.open(h.manager.getSessionFile(), cwd));
    loaded.state.workflowState = completed;
    await loaded.emit("session_start");
    loaded.ctx.ui.confirm = async () => {
      await addRecovery(loaded.manager, "during-preview");
      loaded.manager.appendCustomEntry("pi-token-speed", { elapsedMs: 1 });
      return true;
    };
    await loaded.api.fresh(loaded.ctx);
    assert.equal(loaded.calls, 1, JSON.stringify(loaded.notices));
    assert.equal(loaded.target.notices.at(-1).level, "info");
    const messages = loaded.target.manager.getBranch().filter(e => e.type === "message");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message.role, "user");
    assert.ok(messages[0].message.content.includes(JSON.stringify(snapshot)));
    await loaded.target.api.fresh(loaded.target.ctx);
    assert.equal(loaded.target.calls ?? 0, 0);
    const source = await readFile(h.manager.getSessionFile(), "utf8");
    assert.ok(source.includes("before-snapshot"));
    assert.ok(source.includes("during-preview"));
  });
});

test("ordinary handoff accepts system updates and a resolved historical edit rejection", async () => {
  await withTempDirectory(async cwd => {
    const h = fixture(cwd);
    h.manager.appendMessage({ role: "system", content: "Pi runtime system update", timestamp: Date.now() });
    h.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "old-edit", name: "edit", arguments: {} }], api: "test", provider: "test", model: "test", timestamp: Date.now(), stopReason: "toolUse", usage: {} });
    h.manager.appendMessage({ role: "toolResult", toolCallId: "old-edit", toolName: "edit", isError: true, content: [{ type: "text", text: "exact replacement rejected" }], timestamp: Date.now() });
    await h.save();
    await h.api.fresh(h.ctx);
    assert.equal(h.calls, 1);
    assert.equal(h.target.notices.at(-1).level, "info");
  });
});

test("real SDK omitted-argument receipts pass preparation and fresh, but incomplete execution blocks preparation", async () => {
  await withTempDirectory(async cwd => {
    const h = fixture(cwd);
    h.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "root", name: "codemode", arguments: {} }], api: "test", provider: "test", model: "test", usage: {}, stopReason: "toolUse", timestamp: Date.now() });
    h.manager.appendMessage({ role: "toolResult", toolCallId: "root", toolName: "codemode", content: [], isError: false, nestedCalls: sdkReceipt({ failed: true }), timestamp: Date.now() });
    await h.save();
    await h.api.fresh(h.ctx);
    assert.equal(h.calls, 1);
  });
  await withTempDirectory(async cwd => {
    const h = fixture(cwd);
    h.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "root", name: "codemode", arguments: {} }, { type: "toolCall", id: "prepare", name: "session_handoff", arguments: body() }], api: "test", provider: "test", model: "test", usage: {}, stopReason: "toolUse", timestamp: Date.now() });
    h.manager.appendMessage({ role: "toolResult", toolCallId: "root", toolName: "codemode", content: [], isError: false, nestedCalls: sdkReceipt({ unfinished: true }), timestamp: Date.now() });
    const result = await h.tools.find(t => t.name === "session_handoff").execute("prepare", body(), undefined, undefined, h.ctx);
    assert.equal(result.details.code, "NESTED_UNFINISHED");
    assert.equal(h.calls ?? 0, 0);
  });
});

test("ordinary readiness identifies the blocking safety gate without changing it", async () => {
  for (const [change, code] of [
    [h => { h.state.roleRecoveryPending = true; }, "ROLE_RECOVERY"],
    [h => { h.state.sessionRoleConfigOverrides = { modelStrategy: "roles" }; }, "UNSAVED_CONFIG"],
    [h => h.setSettled(false), "TOOLS_NOT_SETTLED"],
    [h => { h.state.userStopRequested = true; }, "USER_STOPPED"],
  ]) await withTempDirectory(async cwd => {
    const h = fixture(cwd);
    await h.save(); change(h); await h.api.fresh(h.ctx);
    assert.equal(h.calls, undefined);
    assert.ok(h.notices.at(-1).message.includes(`[${code}]`));
  });
});

test("missing, stale, unsafe, mismatched role, active nested tools and unfinished workflows do not migrate", async () => {
  const changes = [
    h => { h.state.userStopRequested = true; }, h => { h.state.roleRecoveryPending = true; },
    h => { h.state.pendingWorkflowRecovery = {}; }, h => { h.state.workflowRestoreError = { code: "UNKNOWN", message: "unknown" }; },
    h => { h.state.activeRole.model = "other"; }, h => { h.state.sessionRoleConfigOverrides = { modelStrategy: "auto" }; },
    h => { h.state.sessionRoleConfigOverrides = { "developer-test": {} }; }, h => h.setSettled(false),
    h => { h.ctx.hasPendingMessages = () => true; }, h => { h.ctx.isIdle = () => false; },
    h => { h.ctx.isProjectTrusted = () => false; }, h => { h.state.workflowState = { status: "paused" }; },
    h => h.manager.appendMessage({ role: "user", content: "new requirement", timestamp: Date.now() }),
    h => { h.ctx.hasUI = false; },
  ];
  for (const change of changes) await withTempDirectory(async cwd => {
    const h = fixture(cwd); await h.save(); change(h); await h.api.fresh(h.ctx);
    assert.equal(h.calls, undefined);
  });
  await withTempDirectory(async cwd => {
    const h = fixture(cwd); await h.api.fresh(h.ctx);
    assert.equal(h.calls, undefined);
    assert.ok(h.notices.some(n => n.message.includes("session_handoff")));
  });
});

test("preview cancellation and async state changes never freeze or create a target", async () => {
  for (const change of [
    () => false,
    h => { h.state.userStopRequested = true; return true; },
    h => { h.state.roleContextGeneration++; return true; },
    h => { h.manager.appendMessage({ role: "user", content: "new input", timestamp: Date.now() }); return true; },
    h => { h.setSettled(false); return true; },
  ]) await withTempDirectory(async cwd => {
    const h = fixture(cwd); await h.save();
    h.ctx.ui.confirm = async () => change(h);
    await h.api.fresh(h.ctx);
    assert.equal(h.calls, undefined);
    assert.equal(h.manager.getEntries().some(e => e.customType === GENERAL_TRANSFER_ENTRY), false);
  });
});

test("confirmed native cancel unlocks only before setup; unknown outcome freezes every old branch", async () => {
  await withTempDirectory(async cwd => {
    const h = fixture(cwd); await h.save();
    h.ctx.newSession = async () => ({ cancelled: true });
    await h.api.fresh(h.ctx);
    assert.equal(h.manager.getLeafEntry().data.phase, "cancelled");
    assert.equal((await h.emit("tool_call"))[0], undefined);
  });
  await withTempDirectory(async cwd => {
    const h = fixture(cwd); await h.save(); const leaf = h.manager.getLeafId(); let calls = 0;
    h.ctx.newSession = async () => { calls++; throw new Error("unknown outcome"); };
    await h.api.fresh(h.ctx); await h.api.fresh(h.ctx);
    h.manager.branch(leaf);
    await h.emit("session_start");
    await h.api.fresh(h.ctx);
    assert.equal(calls, 1);
    assert.ok((await h.emit("tool_call")).some(result => result?.block === true));
    assert.ok((await h.emit("input")).some(result => result?.action === "handled"));
  });
});

test("target setup followed by failure recovers in target without newSession or old APIs", async () => {
  for (const failure of [{ failAfterSetup: true }, { failBodyWrite: true }]) await withTempDirectory(async cwd => {
    const h = fixture(cwd); await h.save();
    h.ctx.newSession = options => h.replace(options, failure);
    await h.api.fresh(h.ctx);
    assert.equal(h.calls, 1);
    const target = h.target;
    target.ctx.newSession = () => { throw new Error("must not duplicate target"); };
    target.state.userStopRequested = true;
    await target.api.fresh(target.ctx);
    assert.equal(target.notices.at(-1).level, "warning");
    target.state.userStopRequested = false;
    await target.api.fresh(target.ctx);
    await target.api.fresh(target.ctx);
    assert.equal(target.notices.at(-1).level, "info");
    assert.equal(target.manager.getEntries().filter(e => e.type === "message").length, 1);
  });
});

test("corrupted packets, missing target body, foreign source, and source persistence failures never activate", async () => {
  for (const change of [
    h => { h.target.manager.getBranch().find(e => e.customType === GENERAL_TRANSFER_ENTRY).data.snapshot.context.goal = "tampered"; },
    h => { h.target.manager.branch(h.target.manager.getBranch().find(e => e.customType === GENERAL_TRANSFER_ENTRY).id); },
    async h => { const source = JSON.parse((await readFile(h.manager.getSessionFile(), "utf8")).split("\n")[0]); source.id = "foreign"; const text = await readFile(h.manager.getSessionFile(), "utf8"); await writeFile(h.manager.getSessionFile(), JSON.stringify(source) + "\n" + text.split("\n").slice(1).join("\n")); },
  ]) await withTempDirectory(async cwd => {
    const h = fixture(cwd); await h.save(); h.ctx.newSession = options => h.replace(options, { skipActivation: true });
    await h.api.fresh(h.ctx); await change(h);
    h.target.ctx.newSession = () => { throw new Error("must not duplicate damaged target"); };
    await h.target.api.fresh(h.target.ctx);
    assert.equal(h.target.notices.at(-1).level, "warning");
  });
  await withTempDirectory(async cwd => {
    const h = fixture(cwd); await h.save(); await writeFile(h.manager.getSessionFile(), "");
    await h.api.fresh(h.ctx); assert.equal(h.calls, undefined);
  });
});
