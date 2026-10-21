import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseWorkflowControlInput } from "../src/workflow-input-intent.ts";
import { createWorkflowUserControl } from "../extensions/workflow-user-control.ts";
import { createRepeatedRejectionGuard } from "../extensions/workflow-status-polling.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowState } from "../src/workflow.ts";
import { withTempDirectory, createExtensionHarness, emitExtensionEvent } from "./helpers.js";
function fixture(cwd) {
  const state = createExtensionRuntimeState();
  state.workflowState = createWorkflowState({ sessionId: "s", workflowId: "w", summary: "整体运行时收敛", tasks: [{ id: "one", task: "收敛生命周期", role: "developer-test", files: ["src"], acceptanceCriteria: ["安全停止"] }, { id: "two", task: "补齐预算", role: "developer-test", files: ["src"], acceptanceCriteria: ["预算可达"] }] }, 1);
  state.workflowState.status = "running";
  state.workflowState.currentTaskId = "one";
  state.workflowState.tasks[0].status = "in_progress";
  state.workflowState.handoff = { workflowId: "w", planVersion: 0, sessionId: "s", recoveryGeneration: 0, taskId: "one", attemptId: "a", handoffId: "h", phase: "executing", createdAt: 1 };
  const branch = [];
  const notices = [];
  let retired = 0;
  const pi = { appendEntry(customType, data) { branch.push({ type: "custom", customType, data }); } };
  const ctx = { cwd, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "s", getBranch: () => branch }, ui: { notify: (...args) => notices.push(args) }, abort() {} };
  const control = createWorkflowUserControl(pi, state, { retire: () => retired++ });
  return { state, branch, pi, ctx, control, notices, retired: () => retired };
}
test("明确停止及仅保存待办由运行时识别，讨论、否定和条件句不抢占任务", () => {
  for (const text of ["停止工作", "先停一下", "先停", "写进todo之后，停止工作", "把要做的和已经做了的输出到todo，这个过程不走任务流"]) assert.ok(parseWorkflowControlInput(text), text);
  for (const text of ["不要停止工作，继续修复", "实现停止工作这个功能", "解释为什么停止工作", "修复完成后停止工作", "测试字符串：停止工作", "如何停止工作？", "修复完成后输出到todo", "实现输出到todo功能", "继续"]) assert.equal(parseWorkflowControlInput(text), undefined, text);
});
test("停止和保存快照不需要切角、不修改工作流、不重放任务，保留已有TODO", async () => {
  await withTempDirectory(async cwd => {
    const f = fixture(cwd);
    await writeFile(join(cwd, "TODO.md"), "# 用户已有待办\n保留这段\n");
    const before = structuredClone(f.state.workflowState);
    assert.deepEqual(await f.control.input({ source: "interactive", text: "写进todo之后，停止工作" }, f.ctx), { action: "handled" });
    assert.equal(f.state.userStopRequested, true);
    assert.deepEqual(f.state.workflowState, before);
    assert.equal(f.retired(), 1);
    const text = await readFile(join(cwd, "TODO.md"), "utf8");
    assert.ok(text.startsWith("# 用户已有待办\n保留这段"));
    assert.ok(text.includes("整体运行时收敛"));
    assert.ok(text.includes("补齐预算"));
    const restored = createWorkflowUserControl(f.pi, f.state, { retire() {} });
    f.state.userStopRequested = false;
    restored.restore(f.ctx);
    assert.equal(f.state.userStopRequested, true);
    assert.equal(f.control.guardToolCall({ toolName: "bash", input: {} })?.block, true);
    assert.equal(f.control.guardToolCall({ toolName: "task_workflow", input: { action: "status" } }), undefined);
  });
});
test("停止记录失败仍停止本轮，恢复记录失败不解除停止；未知结果不获重试授权", async () => {
  await withTempDirectory(async cwd => {
    const f = fixture(cwd);
    f.pi.appendEntry = () => { throw new Error("disk full"); };
    f.control.suspend(f.ctx, "user-stop");
    assert.equal(f.state.userStopRequested, true);
    assert.equal(f.control.resume(f.ctx), false);
    assert.equal(f.state.userStopRequested, true);
    assert.equal(f.state.workflowState.tasks[0].status, "in_progress");
  });
});
test("非真实用户来源不改变停止状态，TODO符号链接不能写出项目", async () => {
  await withTempDirectory(async cwd => {
    const f = fixture(cwd);
    assert.equal(await f.control.input({ source: "extension", text: "停止工作" }, f.ctx), undefined);
    assert.equal(f.state.userStopRequested, false);
    await writeFile(join(cwd, "outside.md"), "unchanged");
    await symlink(join(cwd, "outside.md"), join(cwd, "TODO.md"));
    await f.control.input({ source: "interactive", text: "写进todo之后，停止工作" }, f.ctx);
    assert.equal(await readFile(join(cwd, "outside.md"), "utf8"), "unchanged");
    assert.equal(f.state.userStopRequested, true);
  });
});
test("重复拒绝按真实身份与调用去重，穿插读取不清空，正常身份变化重新评估", async () => {
  await withTempDirectory(async cwd => {
    const f = fixture(cwd);
    const guard = createRepeatedRejectionGuard({ on() {} }, f.state);
    const reject = id => guard.observe({ toolName: "switch_role", toolCallId: id, role: "docs-commit", code: "WORKFLOW_TASK_BOUNDARY_REQUIRED" }, f.ctx);
    assert.equal(reject("a").stop, false);
    assert.equal(reject("a").stop, false);
    assert.equal(reject("b").stop, false);
    assert.equal(reject("c").stop, true);
    f.state.workflowState.handoff.attemptId = "new";
    assert.equal(reject("d").stop, false);
  });
});
test("真实扩展的停止输入不会产生模型消息或settled续跑", async () => {
  await withTempDirectory(async cwd => {
    const h = createExtensionHarness([], { cwd, trusted: true });
    assert.deepEqual(await emitExtensionEvent(h, "input", { source: "interactive", text: "停止工作" }), { action: "handled" });
    await emitExtensionEvent(h, "agent_settled");
    assert.equal(h.sentMessages.length, 0);
    assert.equal(h.sentUserMessages.length, 0);
    await emitExtensionEvent(h, "session_shutdown");
  });
});
async function runningHarness(cwd) {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "role-models.json"), JSON.stringify({ schemaVersion: 2, mode: "auto", workflowMode: "on", roleModels: {} }));
  const initial = createWorkflowState({ sessionId: "test-session", summary: "整体生命周期与预算", tasks: [{ id: "owned", role: "developer-test", task: "当前任务", files: ["src"], acceptanceCriteria: ["安全处理"] }] });
  const h = createExtensionHarness([{ type: "custom", customType: "pi-init-workflow", data: initial }], { cwd, trusted: true, deferSendMessagePersistence: true });
  await emitExtensionEvent(h, "session_start");
  const task = h.sentMessages.findLast(({ message }) => message.customType === "pi-init-workflow-task").message;
  await emitExtensionEvent(h, "agent_start");
  await emitExtensionEvent(h, "message_start", { message: { ...task, role: "custom", timestamp: Date.now() } });
  h.persistSentMessage(task);
  return h;
}

test("活动任务停止后进入未知结果保护，继续输入不授权重放，settled不产生新派发", async () => {
  await withTempDirectory(async cwd => {
    const h = await runningHarness(cwd);
    try {
      const sent = h.sentMessages.length;
      await emitExtensionEvent(h, "input", { source: "interactive", text: "写进todo之后，停止工作" });
      const latest = () => h.branch.findLast(entry => entry.customType === "pi-init-workflow").data;
      assert.equal(latest().status, "paused");
      assert.equal(latest().tasks[0].outcomeUnknown, true);
      assert.equal(latest().tasks[0].status, "blocked");
      await emitExtensionEvent(h, "agent_settled");
      await emitExtensionEvent(h, "input", { source: "interactive", text: "继续" });
      await emitExtensionEvent(h, "agent_settled");
      assert.equal(h.sentMessages.length, sent);
      assert.equal(latest().tasks[0].outcomeUnknown, true);
      const todo = await readFile(join(cwd, "TODO.md"), "utf8");
      assert.ok(todo.includes("整体生命周期与预算"));
      assert.ok(todo.includes("结果未知"));
    } finally { await emitExtensionEvent(h, "session_shutdown"); }
  });
});
test("连续角色拒绝只结束重复回合，普通读取不绕过保护，未派发新角色或重试任务", async () => {
  await withTempDirectory(async cwd => {
    const h = await runningHarness(cwd);
    try {
      const sent = h.sentMessages.length;
      const tool = h.tools.find(tool => tool.name === "switch_role");
      for (let i = 0; i < 3; i++) {
        const result = await tool.execute("denied-" + i, { role: "docs-commit" }, undefined, undefined, h.context);
        assert.equal(result.details.code, "WORKFLOW_TASK_BOUNDARY_REQUIRED");
        assert.equal(result.terminate === true, i === 2);
        await emitExtensionEvent(h, "tool_result", { toolName: "read", toolCallId: "read-" + i, input: { path: "src/example.ts" }, content: [] });
      }
      await emitExtensionEvent(h, "agent_settled");
      assert.equal(h.sentMessages.length, sent);
      assert.ok(h.aborts.length > 0);
      assert.equal(h.branch.findLast(entry => entry.customType === "pi-init-workflow").data.pauseReason, "handoff-outcome-unknown");
    } finally { await emitExtensionEvent(h, "session_shutdown"); }
  });
});
test("恢复门在tool_call前置拒绝时也有界停止，不能依赖execute钩子才能发现循环", async () => {
  await withTempDirectory(async cwd => {
    const h = await runningHarness(cwd);
    try {
      await emitExtensionEvent(h, "session_compact", { reason: "manual" });
      for (let i = 0; i < 3; i++) assert.equal((await emitExtensionEvent(h, "tool_call", { toolName: "bash", toolCallId: "guard-" + i, input: { command: "not executed" } })).block, true);
      assert.ok(h.aborts.length > 0);
      assert.ok(h.branch.some(entry => entry.customType === "pi-init-user-control" && entry.data.stopped));
    } finally { await emitExtensionEvent(h, "session_shutdown"); }
  });
});

test("完整工具组预算压缩后沿同一任务身份续做一次，不累加无结果纠偏或重派新attempt", async () => {
  await withTempDirectory(async cwd => {
    const h = await runningHarness(cwd);
    try {
      h.context.model = { ...h.context.model, contextWindow: 100000, maxTokens: 1000 };
      h.context.getContextUsage = () => ({ tokens: 80000, contextWindow: 100000, percent: 80 });
      h.context.hasPendingMessages = () => false;
      let callbacks;
      h.context.compact = options => { callbacks = options; };
      const latest = () => h.branch.findLast(entry => entry.customType === "pi-init-workflow").data;
      const before = structuredClone(latest());
      const sent = h.sentMessages.length;
      await emitExtensionEvent(h, "turn_end", { outcome: "completed", message: { role: "assistant", content: [{ type: "toolCall", id: "complete-read", name: "read", arguments: { path: "src" } }] }, toolResults: [{ role: "toolResult", toolCallId: "complete-read", toolName: "read", content: [] }], toolResultEntryIds: ["result-entry"] });
      assert.ok(callbacks);
      await emitExtensionEvent(h, "agent_end");
      await emitExtensionEvent(h, "agent_settled");
      assert.equal(h.sentMessages.length, sent);
      await h.completeCompaction(callbacks);
      assert.equal(h.sentMessages.length, sent + 1);
      assert.equal(latest().handoff.attemptId, before.handoff.attemptId);
      assert.equal(latest().handoff.handoffId, before.handoff.handoffId);
      assert.equal(latest().nudgeCount, before.nudgeCount);
      assert.equal(latest().tasks[0].status, "in_progress");
      assert.equal(latest().tasks[0].outcomeUnknown, undefined);
    } finally { await emitExtensionEvent(h, "session_shutdown"); }
  });
});

test("否定保存不会停止或写入，单独明确停止仍生效但不保存TODO", async () => {
  for (const text of ["不要保存到TODO.md", "不用输出到todo", "别把任务写进TODO", "不需要把进度保存到TODO"]) assert.equal(parseWorkflowControlInput(text), undefined, text);
  assert.deepEqual(parseWorkflowControlInput("不要保存到TODO.md，停止工作"), { stop: true, saveTodo: false });
  await withTempDirectory(async cwd => {
    const f = fixture(cwd);
    await writeFile(join(cwd, "TODO.md"), "unchanged");
    assert.equal(await f.control.input({ source: "interactive", text: "不要保存到TODO.md" }, f.ctx), undefined);
    assert.equal(f.state.userStopRequested, false);
    assert.equal(f.retired(), 0);
    assert.equal(await readFile(join(cwd, "TODO.md"), "utf8"), "unchanged");
  });
});
