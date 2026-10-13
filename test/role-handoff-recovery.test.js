import assert from "node:assert/strict";
import test from "node:test";
import { createRoleHandoff } from "../extensions/role-handoff.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";

function fixture(overrides = {}) {
  const state = createExtensionRuntimeState();
  state.agentRunActive = true;
  state.activeRole = { role: "architect", provider: "test", model: "model", thinkingLevel: "high" };
  const records = [];
  const sent = [];
  const ctx = { isIdle: () => true, sessionManager: { getSessionId: () => "session" }, ui: { notify() {} } };
  const pi = { appendEntry(type, data) { records.push({ type, data }); }, async sendMessage(message) { sent.push(message); }, ...overrides };
  const controller = createRoleHandoff(pi, state, { getActiveRole: () => state.activeRole, requireRecovery: () => { state.roleRecoveryPending = true; } });
  const source = controller.capture(ctx);
  state.activeRole = { ...state.activeRole, role: "docs-commit" };
  state.roleTransitionGeneration++;
  return { state, ctx, records, sent, controller, source };
}

test("交接保存失败终止旧回合但不自动派发", async () => {
  const f = fixture({ appendEntry() { throw new Error("disk failure"); } });
  const result = f.controller.finishSwitch(f.ctx, f.source, f.state.activeRole);
  assert.equal(result.terminate, true);
  assert.equal(result.handoffFailure, "persist-failed");
  f.state.agentRunActive = false;
  assert.equal(await f.controller.schedule(f.ctx), false);
  assert.equal(f.sent.length, 0);
  assert.equal(f.state.roleRecoveryPending, true);
});

test("派发结果未知不重放，职责恢复门保留", async () => {
  let attempts = 0;
  const f = fixture({ async sendMessage() { attempts++; throw new Error("send failure"); } });
  f.controller.finishSwitch(f.ctx, f.source, f.state.activeRole);
  f.state.agentRunActive = false;
  assert.equal(await f.controller.schedule(f.ctx), true);
  assert.equal(await f.controller.schedule(f.ctx), false);
  assert.equal(attempts, 1);
  assert.equal(f.records.at(-1).data.phase, "uncertain");
  assert.equal(f.state.roleRecoveryPending, true);
  assert.equal(f.state.internalContinuationPending, false);
});

test("context 代际变化丢弃旧交接，不向新分支发送", async () => {
  const f = fixture();
  f.controller.finishSwitch(f.ctx, f.source, f.state.activeRole);
  f.state.roleContextGeneration++;
  f.state.agentRunActive = false;
  assert.equal(await f.controller.schedule(f.ctx), false);
  assert.equal(f.sent.length, 0);
});

test("切角被中止不创建待派发交接", async () => {
  const f = fixture();
  assert.equal(f.controller.finishSwitch(f.ctx, f.source, f.state.activeRole, true).terminate, true);
  f.state.agentRunActive = false;
  assert.equal(await f.controller.schedule(f.ctx), false);
  assert.equal(f.sent.length, 0);
});

test("职责恢复未确认时阻止待交接续跑", async () => {
  const f = fixture();
  f.controller.finishSwitch(f.ctx, f.source, f.state.activeRole);
  f.state.roleRecoveryPending = true;
  f.state.agentRunActive = false;
  assert.equal(await f.controller.schedule(f.ctx), true);
  assert.equal(f.sent.length, 0);
  assert.equal(await f.controller.schedule(f.ctx), false);
});

test("角色代际变化后不派发旧目标", async () => {
  const f = fixture();
  f.controller.finishSwitch(f.ctx, f.source, f.state.activeRole);
  f.state.roleTransitionGeneration++;
  f.state.agentRunActive = false;
  assert.equal(await f.controller.schedule(f.ctx), false);
  assert.equal(f.sent.length, 0);
});
