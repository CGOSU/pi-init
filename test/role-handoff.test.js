import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionHarness, emitExtensionEvent } from "./helpers.js";
import { createWorkflowState, requestWorkflowReplan } from "../src/workflow.ts";
import { buildHandoffSnapshot } from "../extensions/handoff-snapshot.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createRoleHandoff } from "../extensions/role-handoff.ts";

function switchRole(harness, role, signal) {
  return harness.tools.find((tool) => tool.name === "switch_role").execute("switch-" + role, { role }, signal, undefined, harness.context);
}
async function startRun(harness, message) {
  const event = { ...(message ? { messageType: "custom", message } : { messageType: "user", prompt: "继续" }), systemPromptOptions: { sections: {} } };
  await emitExtensionEvent(harness, "before_agent_start", event);
  await emitExtensionEvent(harness, "agent_start");
  return event;
}
function handoffs(harness) { return harness.sentMessages.filter(({ message }) => message.customType === "pi-init-role-handoff"); }

test("轮内切角终止旧回合，settled 后启动新职责回合并刷新系统提示", async () => {
  const harness = createExtensionHarness();
  await switchRole(harness, "architect");
  const oldRun = await startRun(harness);
  const oldPrompt = oldRun.systemPromptOptions.sections.pi_init_runtime;
  const result = await switchRole(harness, "docs-commit");
  assert.equal(result.terminate, true);
  assert.equal(handoffs(harness).length, 0);
  assert.equal(oldRun.systemPromptOptions.sections.pi_init_runtime, oldPrompt);
  await emitExtensionEvent(harness, "agent_end");
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(handoffs(harness).length, 1);
  assert.equal(handoffs(harness)[0].options.triggerTurn, true);
  const message = handoffs(harness)[0].message;
  assert.match(message.content, /补充说明可省略/);
  assert.match(message.content, /引用失效或证据不足/);
  const nextRun = await startRun(harness, message);
  assert.match(nextRun.systemPromptOptions.sections.pi_init_runtime, /当前职责：文档收尾/);
  await emitExtensionEvent(harness, "agent_end");
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(handoffs(harness).length, 1);
  await emitExtensionEvent(harness, "session_shutdown");
});

test("同职责确认及闲置切角不额外终止或派发回合", async () => {
  const harness = createExtensionHarness();
  const idle = await switchRole(harness, "architect");
  assert.notEqual(idle.terminate, true);
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(handoffs(harness).length, 0);
  await startRun(harness);
  const same = await switchRole(harness, "architect");
  assert.notEqual(same.terminate, true);
  await emitExtensionEvent(harness, "agent_end");
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(handoffs(harness).length, 0);
  await emitExtensionEvent(harness, "session_shutdown");
});

test("关闭会话撤销待交接，迟到 settled 不重放", async () => {
  const harness = createExtensionHarness();
  await switchRole(harness, "architect");
  await startRun(harness);
  await switchRole(harness, "docs-commit");
  await emitExtensionEvent(harness, "session_shutdown");
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(handoffs(harness).length, 0);
});

test("replanning 中切角使用新回合，不重复派发旧架构消息或改写计划", async () => {
  const planned = createWorkflowState({ sessionId: "test-session", summary: "重规划", tasks: [{ id: "task", role: "developer-test", task: "实现", files: ["src"], acceptanceCriteria: ["完成"] }] });
  const workflow = requestWorkflowReplan(planned, { direction: "重新安排" });
  const harness = createExtensionHarness([{ type: "custom", customType: "pi-init-workflow", data: workflow }]);
  await emitExtensionEvent(harness, "session_start");
  const original = harness.entries.filter((entry) => entry.type === "pi-init-workflow").at(-1).data;
  const oldHandoffId = original.continuation.handoffId;
  await startRun(harness);
  assert.equal((await switchRole(harness, "docs-commit")).terminate, true);
  await emitExtensionEvent(harness, "agent_end");
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(handoffs(harness).length, 1);
  assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-replan").length, 1);
  const nextRun = await startRun(harness);
  assert.match(nextRun.systemPromptOptions.sections.pi_init_runtime, /当前职责：文档收尾/);
  const next = harness.entries.filter((entry) => entry.type === "pi-init-workflow").at(-1).data;
  assert.equal(next.planVersion, original.planVersion);
  assert.equal(next.continuation.handoffId, oldHandoffId);
  await emitExtensionEvent(harness, "session_shutdown");
});

test("职责交接内部续跑沿用一次外部请求计时，不提前生成完成报告", async () => {
  const harness = createExtensionHarness();
  await switchRole(harness, "architect");
  await emitExtensionEvent(harness, "input", { source: "interactive", text: "继续未完成工作" });
  await startRun(harness);
  await switchRole(harness, "docs-commit");
  await emitExtensionEvent(harness, "agent_end");
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(harness.entries.filter((entry) => entry.type === "pi-init-run-timing").length, 0);
  await startRun(harness);
  await emitExtensionEvent(harness, "agent_end");
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(harness.entries.filter((entry) => entry.type === "pi-init-run-timing").length, 1);
  await emitExtensionEvent(harness, "session_shutdown");
});
test("轻量交接自动引用任务，缺少说明不阻塞且不复制契约全文", () => {
  const state = createExtensionRuntimeState();
  state.workflowState = createWorkflowState({ sessionId: "test-session", summary: "交接目标", tasks: [{ id: "next", role: "developer-test", task: "继续实现", files: ["src"], acceptanceCriteria: ["通过"] }] });
  const snapshot = buildHandoffSnapshot(state, "developer-test");
  assert.equal(snapshot.role, "developer-test");
  assert.equal(snapshot.workflow.taskId, "next");
  assert.equal(snapshot.workflow.status, "running");
  assert.match(snapshot.nextAction, /task_workflow/);
  assert.equal(snapshot.contract, undefined);
  assert.equal(snapshot.verification, undefined);
});

test("无活动任务交接不创造任务，完成工作流不提供旧任务引用", () => {
  const state = createExtensionRuntimeState();
  assert.match(buildHandoffSnapshot(state, "architect").nextAction, /未完成/);
  state.workflowState = createWorkflowState({ sessionId: "test-session", summary: "已结束", tasks: [{ id: "old", role: "developer-test", task: "旧任务", files: ["src"], acceptanceCriteria: ["通过"] }] });
  state.workflowState.status = "completed";
  assert.equal(buildHandoffSnapshot(state, "architect").workflow, undefined);
});
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
