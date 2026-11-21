import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseWorkflowControlInput } from "../src/workflow-input-intent.ts";
import { createWorkflowUserControl } from "../extensions/workflow/workflow-user-control.ts";
import { createRepeatedRejectionGuard } from "../extensions/workflow/workflow-status-polling.ts";
import { registerWorkflowTool } from "../extensions/workflow/workflow-tool.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowState } from "../src/workflow.ts";
import { SESSION_HANDOFF_ENTRY } from "../src/session-handoff.ts";
import { withTempDirectory } from "./support/temp-directory.js";
import { createReadTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { createExtensionHarness, emitExtensionEvent, emitToolResult } from "./support/extension-harness.js";
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
    for (const toolName of ["read", "grep", "find", "ls"]) {
      assert.equal(f.control.guardToolCall({ toolName, input: {} }), undefined);
    }
    for (const toolName of ["bash", "ffgrep", "fffind", "graph_locate", "obs_recall", "codemode", "file_review"]) {
      assert.equal(f.control.guardToolCall({ toolName, input: {} })?.block, true);
    }
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
test("工作流拒绝分类与有界停止使用结构化code而非提示语前缀", async () => {
  for (const [guardCode, code, prefix] of [
    ["ROLE_RECOVERY_REQUIRED", "WORKFLOW_EXECUTION_NOT_AUTHORIZED", "[pi-init-workflow-authorization]"],
    ["WORKFLOW_UNKNOWN_OUTCOME_CONFIRMATION_REQUIRED", "WORKFLOW_UNKNOWN_OUTCOME_CONFIRMATION_REQUIRED", "[pi-init-role-recovery]"],
    ["WORKFLOW_EXECUTION_NOT_AUTHORIZED", "WORKFLOW_EXECUTION_NOT_AUTHORIZED", ""],
  ]) {
    const f = fixture(".");
    const diagnostics = [];
    f.state.traceHandoff = (_ctx, event, data) => { if (event === "workflow.action_rejected") diagnostics.push(data); };
    f.state.roleRecoveryPending = guardCode === "ROLE_RECOVERY_REQUIRED";
    const guard = createRepeatedRejectionGuard({ on() { } }, f.state);
    let tool, message;
    registerWorkflowTool({ registerTool(value) { tool = value; } }, f.state, {
      workflowActions: { runTaskWorkflowAction() { assert.fail("拒绝不能执行工作流动作"); } },
      workflowBinding: { bind() { assert.fail("拒绝不能绑定或推进任务"); } },
      roleRecovery: { guardToolCall() { return { code: guardCode, message }; } },
      userControl: f.control,
      observeRejection: guard.observe,
    });
    for (let i = 0; i < 3; i++) {
      message = `${i === 0 ? "" : prefix}拒绝说明版本${i}`;
      const operation = tool.execute(`structured-${i}`, { action: "retry" }, undefined, undefined, f.ctx);
      if (i < 2) await assert.rejects(operation, error => error.code === code && error.message === message);
      else {
        const result = await operation;
        assert.equal(result.terminate, true);
        assert.equal(result.details.code, code);
        assert.equal(result.details.rejectionStopped, true);
      }
      assert.equal(diagnostics.at(-1).code, code);
    }
    assert.equal(f.state.userStopRequested, true);
    assert.equal(f.retired(), 1);
  }
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
async function runningHarness(cwd, { persisted = false, appendEntry, ...options } = {}) {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "role-models.json"), JSON.stringify({ schemaVersion: 2, mode: "auto", workflowMode: "on", roleModels: {} }));
  const manager = persisted ? SessionManager.create(cwd, cwd) : undefined;
  const sessionId = manager?.getSessionId() ?? "test-session";
  const initial = createWorkflowState({ sessionId, summary: "整体生命周期与预算", tasks: [{ id: "owned", role: "developer-test", task: "当前任务", files: ["src"], acceptanceCriteria: ["安全处理"] }] });
  manager?.appendMessage({ role: "user", content: "执行初始任务", timestamp: Date.now() });
  manager?.appendCustomEntry("pi-init-workflow", initial);
  const h = createExtensionHarness(manager?.getBranch() ?? [{ type: "custom", customType: "pi-init-workflow", data: initial }], {
    cwd, sessionId, trusted: true, deferSendMessagePersistence: true, ...options,
    appendEntry(type, data) {
      appendEntry?.(type, data);
      manager?.appendCustomEntry(type, data);
    },
  });
  h.context.sessionManager.getSessionFile = () => manager?.getSessionFile();
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
const lastWorkflow = h => h.branch.findLast(entry => entry.customType === "pi-init-workflow").data;
const lastStop = h => h.branch.findLast(entry => entry.customType === "pi-init-user-control").data;
const command = (h, args) => h.commands.get("pi-init").handler(args, h.context);
const messages = h => [h.sentMessages.length, h.sentUserMessages.length];

for (const source of ["command", "panel"]) {
  test(`停止后通过 ${source} 取消只结束旧队列，不解除会话停止或重放`, async () => {
    await withTempDirectory(async cwd => {
      const h = await runningHarness(cwd, {
        mode: "tui", select: (_title, items) => items[1],
        custom: call => {
          call.component.handleInput("a");
          call.component.handleInput("\u001b[B");
          call.component.handleInput("\u001b[B");
          call.component.handleInput("\r");
        },
      });
      try {
        const sent = messages(h);
        await writeFile(join(cwd, "existing.txt"), "已经发生的修改");
        await command(h, "workflow stop");
        await emitExtensionEvent(h, "agent_settled");
        const stopped = lastStop(h);
        const blocked = lastWorkflow(h).tasks[0];
        assert.equal(blocked.outcomeUnknown, true);
        await command(h, source === "command" ? "workflow cancel" : "workflow status");
        const cancelled = lastWorkflow(h);
        assert.equal(cancelled.status, "cancelled");
        assert.deepEqual(cancelled.tasks[0], blocked);
        assert.equal(lastStop(h), stopped);

        await command(h, "workflow resume");
        await command(h, "workflow retry owned --confirm-unknown-outcome");
        assert.deepEqual(await emitExtensionEvent(h, "input", { source: "interactive", text: "继续" }), { action: "handled" });
        await emitExtensionEvent(h, "agent_settled");
        assert.equal(lastStop(h), stopped);
        assert.equal(lastWorkflow(h), cancelled);
        assert.deepEqual(messages(h), sent);
        assert.equal(await readFile(join(cwd, "existing.txt"), "utf8"), "已经发生的修改");
      } finally { await emitExtensionEvent(h, "session_shutdown"); }
    });
  });
}

const selectNewTask = call => call.component.handleInput("\r");

async function stopAndCancel(h) {
  await command(h, "workflow stop");
  await emitExtensionEvent(h, "agent_settled");
  await command(h, "workflow cancel");
  assert.equal(lastWorkflow(h).status, "cancelled");
  assert.equal(lastStop(h).stopped, true);
}

test("终态面板确认仅持久化解除暂停；新输入走原有职责检查，旧队列不恢复", async () => {
  await withTempDirectory(async cwd => {
    let confirm = false;
    const h = await runningHarness(cwd, {
      persisted: true, mode: "tui", custom: selectNewTask, select: (_title, items) => items[confirm ? 1 : 0],
    });
    try {
      await stopAndCancel(h);
      const cancelled = structuredClone(lastWorkflow(h));
      const stopped = lastStop(h);
      const sent = messages(h);
      const aborts = h.aborts.length;
      await command(h, "workflow new-task"); // Only the confirmed panel request is an entry point.
      await command(h, "workflow status");
      assert.equal(lastStop(h), stopped);

      confirm = true;
      await command(h, "workflow status");
      await emitExtensionEvent(h, "agent_settled");
      assert.deepEqual(lastStop(h), { ...stopped, stopped: false, reason: "explicit-new-task" });
      assert.deepEqual(messages(h), sent);
      assert.deepEqual(lastWorkflow(h), cancelled);
      assert.equal(h.aborts.length, aborts);

      assert.deepEqual(await emitExtensionEvent(h, "input", { source: "interactive", text: "核对另一份独立报告" }), { action: "continue" });
      await emitExtensionEvent(h, "agent_start");
      const role = h.tools.find(tool => tool.name === "switch_role");
      const switched = await role.execute("check-role", { role: "developer-test" }, undefined, undefined, h.context);
      assert.equal(switched.details.role, "developer-test");
      assert.equal(await emitExtensionEvent(h, "tool_call", { toolName: "bash", toolCallId: "new-input", input: { command: "not executed" } }), undefined);
      await emitExtensionEvent(h, "agent_settled");
      assert.equal(h.aborts.length, aborts);
      assert.deepEqual(lastWorkflow(h), cancelled);
      assert.deepEqual(messages(h), sent);
    } finally { await emitExtensionEvent(h, "session_shutdown"); }
  });
});

for (const release of [false, true]) {
  test(`重载保留终态会话的${release ? "已解除" : "暂停"}记录，职责恢复仍独立生效`, async () => {
    await withTempDirectory(async cwd => {
      const h = await runningHarness(cwd, { persisted: true, mode: "tui", select: (_title, items) => items[1], custom: selectNewTask });
      await stopAndCancel(h);
      if (release) await command(h, "workflow status");
      assert.equal(lastStop(h).stopped, !release);
      await emitExtensionEvent(h, "session_shutdown");

      const manager = SessionManager.open(h.context.sessionManager.getSessionFile(), cwd);
      const reopened = createExtensionHarness(manager.getBranch(), {
        cwd, sessionId: manager.getSessionId(), trusted: true, mode: "tui",
        select: (_title, items) => items[1], custom: selectNewTask,
        appendEntry: (type, data) => manager.appendCustomEntry(type, data),
      });
      reopened.context.sessionManager.getSessionFile = () => manager.getSessionFile();
      try {
        await emitExtensionEvent(reopened, "session_start", { reason: "reload" });
        const stop = lastStop(reopened);
        assert.equal(stop.stopped, !release);
        await command(reopened, "workflow status");
        assert.equal(lastStop(reopened), stop);
        assert.deepEqual(await emitExtensionEvent(reopened, "input", { source: "interactive", text: "继续" }), { action: release ? "continue" : "handled" });
        const tool = await emitExtensionEvent(reopened, "tool_call", { toolName: "bash", toolCallId: "after-reload", input: { command: "not executed" } });
        assert.match(tool.reason, /职责尚未重新确认/);
        assert.deepEqual(lastWorkflow(reopened), JSON.parse(JSON.stringify(lastWorkflow(h))));
        assert.deepEqual(messages(reopened), [0, 0]);
      } finally { await emitExtensionEvent(reopened, "session_shutdown"); }
    });
  });
}

for (const failure of ["再次停止", "写入失败", "职责待确认", "交接待确认", "宿主有待处理消息", "会话不落盘"]) {
  test(`确认新任务时${failure}，保持暂停且不调度`, async () => {
    await withTempDirectory(async cwd => {
      const h = await runningHarness(cwd, {
        persisted: failure !== "会话不落盘", mode: "tui", custom: selectNewTask,
        appendEntry(type, data) {
          if (failure === "写入失败" && type === "pi-init-user-control" && !data.stopped) throw new Error("disk full");
        },
        async select(_title, items) {
          if (failure === "再次停止") await command(h, "workflow stop");
          if (failure === "职责待确认") await emitExtensionEvent(h, "session_compact", { reason: "manual" });
          if (failure === "交接待确认") h.branch.push({ type: "custom", customType: SESSION_HANDOFF_ENTRY, data: {
            version: 1, kind: "outgoing", phase: "prepared", sourceSessionId: h.context.sessionManager.getSessionId(), workflowId: lastWorkflow(h).workflowId,
          } });
          if (failure === "宿主有待处理消息") h.context.hasPendingMessages = () => true;
          return items[1];
        },
      });
      try {
        await stopAndCancel(h);
        const sent = messages(h);
        const cancelled = structuredClone(lastWorkflow(h));
        await command(h, "workflow status");
        assert.equal(h.selectCalls.length, 1);
        assert.equal(lastStop(h).stopped, true);
        assert.equal(h.branch.some(entry => entry.customType === "pi-init-user-control" && !entry.data.stopped), false);
        if (failure === "写入失败") assert.match(h.notifications.at(-1).message, /disk full/);
        await emitExtensionEvent(h, "agent_settled");
        assert.deepEqual(lastWorkflow(h), cancelled);
        assert.deepEqual(messages(h), sent);
      } finally { await emitExtensionEvent(h, "session_shutdown"); }
    });
  });
}

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

async function reviewHarness(cwd) {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "role-models.json"), JSON.stringify({
    schemaVersion: 2, workflowMode: "on",
    roleModels: {
      architect: { provider: "test-provider", model: "session-default", thinkingLevel: "max" },
      "developer-test": { provider: "test-provider", model: "session-default", thinkingLevel: "high" },
    },
  }));
  const review = createWorkflowState({ sessionId: "test-session", summary: "文章规划", reviewRequired: true,
    tasks: [{ id: "first", role: "developer-test", task: "验证文章链路", files: ["src"], acceptanceCriteria: ["可以读取已发布文章"] }] });
  return createExtensionHarness([{ id: "review-plan", type: "custom", customType: "pi-init-workflow", data: review }], { cwd, trusted: true, deferSendMessagePersistence: true });
}

test("架构审阅无当前任务时，交替撞同一门禁只结束本轮，仍可由用户批准原计划", async () => {
  await withTempDirectory(async cwd => {
    const h = await reviewHarness(cwd);
    const latest = () => h.branch.findLast(entry => entry.customType === "pi-init-workflow").data;
    const call = (toolName, toolCallId, input) => emitExtensionEvent(h, "tool_call", { toolName, toolCallId, input });
    try {
      await emitExtensionEvent(h, "session_start");
      await emitExtensionEvent(h, "agent_start");
      const before = structuredClone(latest());
      assert.equal(before.currentTaskId, undefined);
      const denied = [
        ["fffind", { pattern: "astro.config" }],
        ["graph_locate", { query: "article publication" }],
        ["fffind", { pattern: "package.json" }],
      ];
      for (const [i, [toolName, input]] of denied.entries()) {
        assert.equal((await call(toolName, `denied-${i}`, input)).block, true);
        assert.equal(h.aborts.length, i === 2 ? 1 : 0);
        if (i === 0) {
          assert.equal(await call("read", "read-before-stop", { path: "package.json" }), undefined);
          assert.equal((await call(toolName, `denied-${i}`, input)).block, true);
        }
      }
      await emitExtensionEvent(h, "agent_settled");
      assert.deepEqual(latest(), before);
      assert.equal(h.branch.some(entry => entry.customType === "pi-init-user-control"), false);
      assert.equal(h.sentMessages.length, 0);

      await emitExtensionEvent(h, "input", { source: "interactive", text: "继续" });
      await emitExtensionEvent(h, "agent_start");
      assert.equal((await call("fffind", "new-turn", { pattern: "astro.config" })).block, true);
      assert.equal(h.aborts.length, 1);
      await emitExtensionEvent(h, "agent_settled");
      assert.deepEqual(latest(), before);
      assert.equal(h.sentMessages.length, 0);

      await h.commands.get("pi-init").handler("workflow resume", h.context);
      assert.equal(latest().status, "running");
      assert.equal(latest().currentTaskId, "first");
      assert.equal(h.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1);
    } finally { await emitExtensionEvent(h, "session_shutdown"); }
  });
});

test("待审计划重复读取同一原生结果只结束本轮，仍待用户审批", async () => {
  await withTempDirectory(async cwd => {
    const h = await reviewHarness(cwd);
    const path = join(cwd, "package.json");
    const latest = () => h.branch.findLast(entry => entry.customType === "pi-init-workflow").data;
    const tool = createReadTool(cwd);
    async function read(i, input) {
      const toolCallId = `review-read-${i}`;
      h.branch.push({ id: `assistant-${i}`, type: "message", message: {
        role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: input }],
      } });
      assert.equal(await emitExtensionEvent(h, "tool_call", { toolName: "read", toolCallId, input }), undefined);
      const result = await tool.execute(toolCallId, input, undefined);
      return emitToolResult(h, { ...result, toolName: "read", toolCallId, input, isError: false });
    }
    try {
      await writeFile(path, '{\n  "name": "review-fixture"\n}\n');
      await emitExtensionEvent(h, "session_start");
      await emitExtensionEvent(h, "agent_start");
      const before = structuredClone(latest());
      assert.equal(before.currentTaskId, undefined);
      for (let i = 0; i <= 6; i++) {
        const result = await read(i, { path: i % 2 ? path : "package.json", ...(i % 2 ? { offset: 1 } : {}), limit: 100 + i });
        assert.equal(result?.content.some(block => block.type === "text" && block.text.includes("WORKFLOW_REPEATED_READ")) ?? false, i === 3);
        assert.equal(h.aborts.length, i === 6 ? 1 : 0);
      }
      await emitExtensionEvent(h, "agent_settled");
      assert.deepEqual(latest(), before);
      assert.equal(h.entries.some(entry => entry.type === "pi-init-user-control"), false);
      assert.equal(h.sentMessages.length, 0);

      await emitExtensionEvent(h, "input", { source: "interactive", text: "继续" });
      await emitExtensionEvent(h, "agent_start");
      await read("new-turn", { path: "package.json" });
      assert.equal(h.aborts.length, 1);
      await emitExtensionEvent(h, "agent_settled");
      assert.deepEqual(latest(), before);

      await h.commands.get("pi-init").handler("workflow resume", h.context);
      assert.equal(latest().status, "running");
      assert.equal(latest().currentTaskId, "first");
      assert.equal(h.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1);
    } finally { await emitExtensionEvent(h, "session_shutdown"); }
  });
});

test("完整工具组不触发主动压缩，原生压缩后保留任务并重新确认职责", async () => {
  await withTempDirectory(async cwd => {
    const h = await runningHarness(cwd);
    try {
      h.context.model = { ...h.context.model, contextWindow: 100000, maxTokens: 1000 };
      h.context.getContextUsage = () => ({ tokens: 96000, contextWindow: 100000, percent: 96 });
      h.context.hasPendingMessages = () => false;
      let callbacks;
      h.context.compact = options => { callbacks = options; };
      const latest = () => h.branch.findLast(entry => entry.customType === "pi-init-workflow").data;
      const before = structuredClone(latest());
      const sent = h.sentMessages.length;
      await emitExtensionEvent(h, "turn_end", { outcome: "completed", message: { role: "assistant", content: [{ type: "toolCall", id: "complete-read", name: "read", arguments: { path: "src" } }] }, toolResults: [{ role: "toolResult", toolCallId: "complete-read", toolName: "read", content: [] }], toolResultEntryIds: ["result-entry"] });
      assert.equal(callbacks, undefined);
      assert.equal(h.sentMessages.length, sent);
      assert.deepEqual(latest(), before);
      await h.completeCompaction({ reason: "threshold" });
      assert.equal(h.sentMessages.length, sent);
      assert.deepEqual(latest(), before);
      const denied = await emitExtensionEvent(h, "tool_call", { toolName: "bash", toolCallId: "after-native-compaction", input: { command: "true" } });
      assert.equal(denied.block, true);
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
