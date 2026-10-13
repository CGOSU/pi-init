import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionHarness, emitExtensionEvent } from "./helpers.js";
import { createWorkflowState, requestWorkflowReplan } from "../src/workflow.ts";

function switchRole(harness, role, signal) {
  return harness.tools.find((tool) => tool.name === "switch_role").execute("switch-" + role, { role }, signal, undefined, harness.context);
}
async function startRun(harness) {
  const event = { systemPromptOptions: { sections: {} } };
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
  const nextRun = await startRun(harness);
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
