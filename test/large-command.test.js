import assert from "node:assert/strict";
import test from "node:test";
import { registerLargeCommand } from "../extensions/large-command.ts";

function candidate(path = "src/large.ts", fingerprint = "a".repeat(64)) {
  return { path, lineCount: 501, fingerprint };
}

function snapshot(overrides = {}) {
  const file = candidate();
  return {
    generation: 1,
    sessionId: "test-session",
    files: [file],
    candidates: [file],
    errors: [],
    ...overrides,
  };
}

function createHarness(options = {}) {
  const state = { snapshot: options.snapshot ?? snapshot() };
  const commands = new Map();
  const listeners = new Map();
  const notifications = [];
  const sentUserMessages = [];
  let scanCount = 0;
  const context = {
    isIdle: () => options.isIdle ?? true,
    sessionManager: { getSessionId: () => state.snapshot?.sessionId ?? "test-session" },
    ui: { notify: (message, level) => notifications.push({ message, level }) },
  };
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) {
      const handlers = listeners.get(name) ?? [];
      handlers.push(handler);
      listeners.set(name, handlers);
    },
    async sendUserMessage(message) {
      sentUserMessages.push(message);
      if (options.sendError) throw new Error("message dispatch failed");
    },
  };
  registerLargeCommand(pi, {
    scan: async () => {
      scanCount += 1;
      return options.scan ? options.scan(state) : { ok: true, added: [] };
    },
    getSnapshot: () => state.snapshot,
    getActiveRole: () => options.activeRole,
    roleRecoveryPending: () => options.roleRecoveryPending ?? false,
    canReview: () => options.canReview ?? true,
    getDispatchBlockReason: () => typeof options.blockReason === "function"
      ? options.blockReason()
      : options.blockReason,
  });
  return {
    commands,
    listeners,
    notifications,
    sentUserMessages,
    context,
    state,
    get scanCount() { return scanCount; },
    async emit(name) {
      for (const handler of listeners.get(name) ?? []) await handler({}, context);
    },
  };
}

test("完整扫描有待审版本时启动一次命令专属审阅并保留请求身份", async () => {
  const harness = createHarness({ activeRole: { role: "developer-test" }, canReview: true });
  const command = harness.commands.get("large");

  await command.handler("", harness.context);
  await command.handler("", harness.context);

  assert.equal(harness.scanCount, 2);
  assert.equal(harness.sentUserMessages.length, 1);
  assert.match(harness.sentUserMessages[0], /用户通过 \/large 明确启动/);
  assert.match(harness.sentUserMessages[0], /developer-test/);
  assert.match(harness.sentUserMessages[0], /docs-commit.*architect/s);
  assert.match(harness.sentUserMessages[0], /完整读取/);
  assert.match(harness.sentUserMessages[0], /不修改、拆分或重构源码/);
  assert.match(harness.notifications.at(-1).message, /已有 \/large 审阅请求正在处理/);

  await harness.emit("agent_settled");
  await command.handler("", harness.context);
  assert.equal(harness.sentUserMessages.length, 2);
});

test("没有待审候选或扫描不完整时不启动审阅", async () => {
  const noPending = createHarness({
    snapshot: snapshot({ candidates: [] }),
  });
  await noPending.commands.get("large").handler("", noPending.context);
  assert.equal(noPending.sentUserMessages.length, 0);
  assert.match(noPending.notifications.at(-1).message, /没有当前版本待审/);

  const incomplete = createHarness({
    snapshot: snapshot({ errors: [{ code: "READ_FAILED", path: "src/b.ts", message: "denied" }] }),
    scan: async () => ({ ok: false, code: "PARTIAL_SCAN", message: "1 个路径无法扫描", added: [] }),
  });
  await incomplete.commands.get("large").handler("", incomplete.context);
  assert.equal(incomplete.sentUserMessages.length, 0);
  assert.match(incomplete.notifications.at(-1).message, /扫描不完整/);
  assert.match(incomplete.notifications.at(-1).message, /READ_FAILED/);
});

test("职责恢复 pending 或 architect 当前角色不阻止用户扫描并启动受角色门控的请求", async () => {
  const harness = createHarness({
    activeRole: { role: "architect" },
    roleRecoveryPending: true,
    canReview: false,
  });

  await harness.commands.get("large").handler("", harness.context);

  assert.equal(harness.scanCount, 1);
  assert.equal(harness.sentUserMessages.length, 1);
  assert.match(harness.sentUserMessages[0], /当前匹配职责：architect/);
  assert.match(harness.sentUserMessages[0], /职责恢复待确认：是/);
  assert.match(harness.sentUserMessages[0], /必须先完成角色确认/);
  assert.equal(harness.notifications.at(-1).level, "info");
});

test("忙碌 Agent、活动工作流或恢复持久化失败时只报告扫描，不派发或排队", async () => {
  for (const options of [
    { isIdle: false },
    { blockReason: "当前有未结束的工作流；未启动 AI 审阅。" },
    { blockReason: "职责恢复记录持久化失败；未启动 AI 审阅。" },
  ]) {
    const harness = createHarness(options);
    await harness.commands.get("large").handler("", harness.context);
    assert.equal(harness.scanCount, 1);
    assert.equal(harness.sentUserMessages.length, 0);
    assert.equal(harness.notifications.at(-1).level, "warning");
    assert.match(harness.notifications.at(-1).message, /未启动/);
  }
});

test("扫描期间 session 变化或命令重入不会派发过期/重复请求", async () => {
  let finishScan;
  const reentrant = createHarness({
    scan: () => new Promise((resolve) => { finishScan = resolve; }),
  });
  const first = reentrant.commands.get("large").handler("", reentrant.context);
  const second = reentrant.commands.get("large").handler("", reentrant.context);
  await second;
  assert.equal(reentrant.scanCount, 1);
  finishScan({ ok: true, added: [] });
  await first;
  assert.equal(reentrant.sentUserMessages.length, 1);

  const stale = createHarness({
    scan: async (state) => {
      state.snapshot = snapshot({ sessionId: "next-session", generation: 2 });
      return { ok: true, added: [] };
    },
  });
  await stale.commands.get("large").handler("", stale.context);
  assert.equal(stale.sentUserMessages.length, 0);
  assert.match(stale.notifications.at(-1).message, /session 已变化/);
});

test("无候选、不支持参数和派发错误均不留下审阅锁", async () => {
  const invalid = createHarness();
  await invalid.commands.get("large").handler("unexpected", invalid.context);
  assert.equal(invalid.scanCount, 0);
  assert.equal(invalid.sentUserMessages.length, 0);

  const failing = createHarness({ sendError: true });
  await failing.commands.get("large").handler("", failing.context);
  assert.equal(failing.sentUserMessages.length, 1);
  assert.match(failing.notifications.at(-1).message, /启动审阅失败/);

  failing.context.isIdle = () => true;
  await failing.commands.get("large").handler("", failing.context);
  assert.equal(failing.sentUserMessages.length, 2);
});