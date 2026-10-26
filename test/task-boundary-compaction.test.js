async function waitForDispatch(harness) {
  const deadline = Date.now() + 2000;
  while (messageCount(harness) !== 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(messageCount(harness), 2, JSON.stringify(harness.notifications));
}
import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionHarness, createWorkflowState, emitExtensionEvent, workflowMessageIdentity, withTempDirectory, mkdir, path, writeFile } from "./helpers.js";
const developer = { provider: "test", id: "developer", contextWindow: 100000, maxTokens: 1000 };
const docs = { ...developer, id: "docs" };
async function boundaryHarness(directory, secondRole = "docs-commit") {
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  await writeFile(path.join(directory, ".pi", "role-models.json"), JSON.stringify({ schemaVersion: 2, mode: "auto", workflowMode: "on", roleModels: { "developer-test": { provider: "test", model: "developer", thinkingLevel: "high" }, "docs-commit": { provider: "test", model: "docs", thinkingLevel: "high" }, architect: { provider: "test", model: "architect", thinkingLevel: "high" } } }));
  const workflow = createWorkflowState({ summary: "任务边界", tasks: [ { id: "first", role: "developer-test", task: "实现", files: ["src"], acceptanceCriteria: ["通过"] }, { id: "second", role: secondRole, task: "继续", files: ["src"], acceptanceCriteria: ["通过"] } ] });
  const harness = createExtensionHarness([{ type: "custom", customType: "pi-init-workflow", data: workflow }], { cwd: directory, trusted: true, model: developer, thinkingLevel: "high", availableModels: [developer, docs, { ...developer, id: "architect" }] });
  harness.context.getContextUsage = () => ({ tokens: 96000, contextWindow: 100000, percent: 96 });
  await emitExtensionEvent(harness, "session_start");
  return harness;
}
async function finishFirst(harness) {
  await emitExtensionEvent(harness, "agent_start");
  const tool = harness.tools.find((item) => item.name === "task_workflow");
  await tool.execute("complete", { ...workflowMessageIdentity(harness), action: "complete", taskId: "first", completionSummary: "完成", implementationRationale: "边界压缩", verification: ["通过"] }, undefined, undefined, harness.context);
  await emitExtensionEvent(harness, "agent_settled");
}
function latest(harness) { return harness.entries.filter((entry) => entry.type === "pi-init-workflow").at(-1).data; }
function messageCount(harness) { return harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length; }

test("边界压缩完成前不切模型、不启动下一任务，完成后只派发一次", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await boundaryHarness(directory);
    let complete;
    harness.context.compact = ({ onComplete }) => { complete = onComplete; };
    await finishFirst(harness);
    assert.equal(harness.context.model.id, developer.id);
    assert.equal(latest(harness).tasks[0].status, "completed");
    assert.equal(latest(harness).tasks[1].status, "pending");
    assert.equal(latest(harness).currentTaskId, undefined);
    assert.equal(messageCount(harness), 1);
    assert.equal(typeof complete, "function");
    complete();
    await waitForDispatch(harness);
    assert.equal(harness.context.model.id, docs.id);
    assert.equal(messageCount(harness), 2);
    complete();
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(messageCount(harness), 2);
    await emitExtensionEvent(harness, "session_shutdown");
  });
});

test("同角色也按任务边界判断压缩，普通 switch_role 不压缩", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await boundaryHarness(directory, "developer-test");
    let calls = 0;
    harness.context.compact = ({ onComplete }) => { calls++; onComplete(); };
    await finishFirst(harness);
    assert.equal(calls, 1);
    assert.equal(messageCount(harness), 2);
    const switchRole = harness.tools.find((item) => item.name === "switch_role");
    await switchRole.execute("switch", { role: "docs-commit" }, undefined, undefined, harness.context);
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(calls, 1);
    await emitExtensionEvent(harness, "session_shutdown");
  });
});

test("压缩失败保存完成结果并暂停，settled 不重试，显式 resume 后可重试边界", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await boundaryHarness(directory);
    let calls = 0;
    harness.context.compact = ({ onError }) => { calls++; onError(new Error("压缩失败")); };
    await finishFirst(harness);
    assert.equal(latest(harness).status, "paused");
    assert.equal(latest(harness).tasks[0].status, "completed");
    assert.equal(latest(harness).tasks[1].status, "pending");
    assert.equal(harness.context.model.id, developer.id);
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(calls, 1);
    harness.context.compact = ({ onComplete }) => { calls++; onComplete(); };
    await harness.commands.get("pi-init").handler("workflow resume", harness.context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal(messageCount(harness), 2);
    await emitExtensionEvent(harness, "session_shutdown");
  });
});

test("恢复未收敛边界时暂停，旧回调不能派发；显式恢复保留已完成任务", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await boundaryHarness(directory);
    let oldComplete;
    harness.context.compact = ({ onComplete }) => { oldComplete = onComplete; };
    await finishFirst(harness);
    await emitExtensionEvent(harness, "session_start", { reason: "resume" });
    assert.equal(latest(harness).status, "paused");
    assert.equal(latest(harness).pauseReason, "boundary-compaction-interrupted");
    oldComplete();
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(messageCount(harness), 1);
    harness.context.compact = ({ onComplete }) => onComplete();
    await harness.commands.get("pi-init").handler("workflow resume", harness.context);
    await waitForDispatch(harness);
    assert.equal(latest(harness).tasks[0].status, "completed");
    assert.equal(harness.context.model.id, docs.id);
    await emitExtensionEvent(harness, "session_shutdown");
  });
});

test("取消撤销边界续跑，压缩迟到完成不派发下一角色", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await boundaryHarness(directory);
    let complete;
    harness.context.compact = ({ onComplete }) => { complete = onComplete; };
    await finishFirst(harness);
    await harness.commands.get("pi-init").handler("workflow cancel", harness.context);
    complete();
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(latest(harness).status, "cancelled");
    assert.equal(messageCount(harness), 1);
    assert.equal(harness.context.model.id, developer.id);
    await emitExtensionEvent(harness, "session_shutdown");
  });
});

test("收益未知且容量充足时不按 50% 压缩，最终完成也不额外压缩", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await boundaryHarness(directory);
    let calls = 0;
    harness.context.getContextUsage = () => ({ tokens: 60000, contextWindow: 100000, percent: 60 });
    harness.context.compact = () => { calls++; };
    await finishFirst(harness);
    assert.equal(messageCount(harness), 2);
    harness.context.getContextUsage = () => ({ tokens: 96000, contextWindow: 100000, percent: 96 });
    await emitExtensionEvent(harness, "agent_start");
    const tool = harness.tools.find((item) => item.name === "task_workflow");
    await tool.execute("final", { ...workflowMessageIdentity(harness), action: "complete", taskId: "second", completionSummary: "最终完成", implementationRationale: "无后续交接", verification: ["通过"] }, undefined, undefined, harness.context);
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(calls, 0);
    assert.equal(latest(harness).status, "completed");
    await emitExtensionEvent(harness, "session_shutdown");
  });
});

test("Agent 仍忙时保留交接意图，idle 后才开始边界压缩", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await boundaryHarness(directory);
    let complete;
    let calls = 0;
    harness.context.isIdle = () => false;
    harness.context.compact = ({ onComplete }) => { calls++; complete = onComplete; };
    await finishFirst(harness);
    assert.equal(calls, 0);
    assert.equal(latest(harness).continuation.phase, "pending");
    assert.equal(messageCount(harness), 1);
    harness.context.isIdle = () => true;
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(calls, 1);
    complete();
    await waitForDispatch(harness);
    await emitExtensionEvent(harness, "session_shutdown");
  });
});

test("完成任务后的重规划也先压缩，再切换到 architect", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await boundaryHarness(directory);
    let complete;
    harness.context.compact = ({ onComplete }) => { complete = onComplete; };
    await emitExtensionEvent(harness, "input", { source: "interactive", text: "重规划：调整后续计划" });
    await finishFirst(harness);
    assert.equal(latest(harness).status, "replanning");
    assert.equal(latest(harness).continuation.phase, "compacting");
    assert.equal(harness.context.model.id, developer.id);
    assert.equal(harness.sentMessages.some(({ message }) => message.customType === "pi-init-workflow-replan"), false);
    complete();
    const deadline = Date.now() + 2000;
    while (!harness.sentMessages.some(({ message }) => message.customType === "pi-init-workflow-replan") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(harness.context.model.id, "architect");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-replan").length, 1);
    assert.equal(latest(harness).tasks[0].status, "completed");
    await emitExtensionEvent(harness, "session_shutdown");
  });
});

async function receiverBudgetBoundary() {
  await withTempDirectory(async (directory) => {
    const harness = await boundaryHarness(directory);
    const find = harness.context.modelRegistry.find;
    harness.context.modelRegistry.find = (provider, id) => {
      const model = find(provider, id);
      return model && { ...model, contextWindow: id === "docs" ? 32000 : 200000, maxTokens: 8000 };
    };
    harness.context.getContextUsage = () => ({ percent: 20, tokens: 40000, contextWindow: 200000 });
    let complete;
    harness.context.compact = ({ onComplete }) => { complete = onComplete; };
    await finishFirst(harness);
    assert.equal(typeof complete, "function");
    assert.equal(harness.context.model.id, "developer");
    assert.equal(messageCount(harness), 1);
    complete();
    await waitForDispatch(harness);
    const message = harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").at(-1).message;
    assert.match(message.content, /系统生成的轻量交接快照/);
    assert.match(message.content, /"taskId":"second"/);
    assert.equal(latest(harness).tasks[0].status, "completed");
    complete();
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(messageCount(harness), 2);
    await emitExtensionEvent(harness, "session_shutdown");
  });
}
test("小窗口接收模型在低于 50% 时先压缩，随后从当前状态重建快照且仅派发一次", receiverBudgetBoundary);
