import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";
import { createWorkflowCompaction } from "../extensions/workflow-compaction.ts";
import { createCompactionPolicy } from "../extensions/compaction-policy.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { workflowHandoffIdentity } from "../src/workflow.ts";

const {
  createExtensionHarness,
  createWorkflowState,
  workflowMessageIdentity,
  startWorkflowTask,
  emitExtensionEvent,
  mkdir,
  path,
  withTempDirectory,
  writeFile,
} = helpers;

const developerModel = { provider: "openai-codex", id: "gpt-5.6-luna", contextWindow: 100000, maxTokens: 1000 };
const architectModel = { provider: "openai-codex", id: "gpt-5.6-sol" };

function tasks() {
  return [
    { id: "first", role: "developer-test", task: "完成第一项", files: ["src/first.js"], acceptanceCriteria: ["通过"] },
    { id: "second", role: "developer-test", task: "完成第二项", files: ["src/second.js"], acceptanceCriteria: ["通过"] },
  ];
}

function roleSwitchTasks() {
  return [
    { id: "first", role: "developer-test", task: "完成第一项", files: ["src/first.js"], acceptanceCriteria: ["通过"] },
    { id: "second", role: "docs-commit", task: "完成第二项", files: ["src/second.js"], acceptanceCriteria: ["通过"] }
  ];
}

async function writeWorkflowConfig(directory, executor) {
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  await writeFile(
    path.join(directory, ".pi", "role-models.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      mode: "auto",
      workflowMode: "on",
      workflowExecutor: executor,
      roleModels: {},
    }, null, 2)}\n`,
  );
}

function completeParams(harness, taskId, summary) {
  return {
    ...workflowMessageIdentity(harness),
    action: "complete",
    taskId,
    completionSummary: summary,
    implementationRationale: "在任务边界先压缩上下文，再继续后续任务",
    verification: ["通过"],
  };
}

test("同角色任务在接近容量上限时于任务边界压缩", async () => {
  await withTempDirectory(async (directory) => {
    await writeWorkflowConfig(directory, "local");
    const branch = [{
      type: "custom",
      customType: "pi-init-workflow",
      data: createWorkflowState({ summary: "任务边界压缩", tasks: tasks(), executor: "local" }, 100),
    }];
    const harness = createExtensionHarness(branch, {
      cwd: directory,
      trusted: true,
      model: developerModel,
      availableModels: [developerModel],
    });
    let compactCalls = 0;
    harness.context.getContextUsage = () => ({ tokens: 96000, contextWindow: 100000, percent: 96 });
    harness.context.compact = ({ onComplete }) => {
      compactCalls++;
      onComplete?.({});
    };

    await emitExtensionEvent(harness, "session_start");
    await emitExtensionEvent(harness, "agent_start");
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const first = await workflow.execute("complete-first", completeParams(harness, "first", "第一项完成"), undefined, undefined, harness.context);
    assert.equal(first.details.status, "running");

    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(compactCalls, 1);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 2);

    await emitExtensionEvent(harness, "agent_start");
    const second = await workflow.execute("complete-second", completeParams(harness, "second", "第二项完成"), undefined, undefined, harness.context);
    assert.equal(second.details.status, "completed");
    const finalActivity = harness.statusCalls.filter(({ name }) => name === "pi-init-activity").at(-1)?.text;
    assert.doesNotMatch(finalActivity ?? "", /\b\d+\/2\b/);
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(compactCalls, 1);
  });
});

test("无归属的 session_compact 信号不能确认压缩交接，只有本次回调能收敛", async () => {
  await withTempDirectory(async (directory) => {
    await writeWorkflowConfig(directory, "local");
    const branch = [{
      type: "custom",
      customType: "pi-init-workflow",
      data: createWorkflowState({ summary: "压缩事件兜底", tasks: roleSwitchTasks(), executor: "local" }, 100),
    }];
    const harness = createExtensionHarness(branch, {
      cwd: directory,
      trusted: true,
      model: developerModel,
      availableModels: [developerModel, architectModel],
    });
    harness.context.getContextUsage = () => ({ tokens: 96000, contextWindow: 100000, percent: 96 });
    let completeCompaction;
    harness.context.compact = ({ onComplete }) => { completeCompaction = onComplete; };

    await emitExtensionEvent(harness, "session_start");
    await emitExtensionEvent(harness, "agent_start");
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    await workflow.execute("complete-first", completeParams(harness, "first", "第一项完成"), undefined, undefined, harness.context);
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1);

    await harness.completeCompaction();
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1);
    completeCompaction?.({});
    const deadline = Date.now() + 2000;
    while (harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length !== 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 2);
  });
});

test("主动压缩同步异常和 onError 都给出模型可见失败且不盲目派发", async () => {
  for (const failure of ["throw", "callback"]) {
    await withTempDirectory(async (directory) => {
      await writeWorkflowConfig(directory, "local");
      const branch = [{
        type: "custom",
        customType: "pi-init-workflow",
        data: createWorkflowState({ summary: `压缩${failure}失败`, tasks: roleSwitchTasks(), executor: "local" }, 100),
      }];
      const harness = createExtensionHarness(branch, {
        cwd: directory,
        trusted: true,
        model: developerModel,
        availableModels: [developerModel, architectModel],
      });
      harness.context.getContextUsage = () => ({ tokens: 96000, contextWindow: 100000, percent: 96 });
      harness.context.compact = failure === "throw"
        ? () => { throw new Error("同步压缩失败"); }
        : ({ onError }) => onError?.(new Error("回调压缩失败"));

      await emitExtensionEvent(harness, "session_start");
      await emitExtensionEvent(harness, "agent_start");
      const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
      await workflow.execute("complete-first", completeParams(harness, "first", "第一项完成"), undefined, undefined, harness.context);
      await emitExtensionEvent(harness, "agent_settled");

      assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1);
      const failureMessage = harness.sentMessages.find(({ message }) => message.customType === "pi-init-role-transition");
      assert.match(failureMessage.message.content, /ROLE_COMPACTION_FAILED/);
      assert.equal(failureMessage.options.triggerTurn, false);
      assert.equal(harness.notifications.length > 0, true);
    });
  }
});

test("普通角色压缩完成后不自动触发额外任务回合", () => {
  const state = createExtensionRuntimeState();
  state.roleTransitionGeneration = 1;
  state.activeRole = { role: "docs-commit", provider: developerModel.provider, model: developerModel.id, thinkingLevel: "max" };
  state.pendingRoleCompaction = {
    fromRole: "developer-test",
    toRole: "docs-commit",
    sessionId: "test-session",
    contextGeneration: 0,
    roleTransitionGeneration: 1,
    targetRole: state.activeRole,
  };
  const sentMessages = [];
  let completeCompaction;
  const ctx = {
    sessionManager: { getSessionId: () => "test-session", getBranch: () => [{ type: "user" }] },
    ui: { setStatus() {}, notify() {} },
    compact({ onComplete }) { completeCompaction = onComplete; },
  };
  const controller = createWorkflowCompaction({ sendMessage(message, options) { sentMessages.push({ message, options }); } }, state, {
    setWorkflowDispatchInFlight() {},
    getActiveRole: () => state.activeRole,
    requireRoleRecovery() {},
    sendWorkflowTaskMessage() {},
    async scheduleWorkflow() {},
    sendWorkflowReplanMessage() {},
    acknowledgeRoleRecovery() {},
  });

  assert.equal(controller.start(ctx), true);
  completeCompaction?.({});
  assert.deepEqual(sentMessages, []);
});

test("branch/context 变化阻止迟到 watchdog 提示且 dispose 后回调失效", async () => {
  const state = createExtensionRuntimeState();
  state.roleTransitionGeneration = 1;
  state.activeRole = { role: "docs-commit", provider: developerModel.provider, model: developerModel.id, thinkingLevel: "max" };
  state.pendingRoleCompaction = {
    fromRole: "developer-test",
    toRole: "docs-commit",
    sessionId: "test-session",
    contextGeneration: 0,
    roleTransitionGeneration: 1,
    targetRole: state.activeRole,
  };
  let completeCompaction;
  let dispatches = 0;
  let acknowledgements = 0;
  const notifications = [];
  const ctx = {
    sessionManager: { getSessionId: () => "test-session", getBranch: () => [{ type: "user" }] },
    ui: { setStatus() {}, notify(message, level) { notifications.push({ message, level }); } },
    compact({ onComplete }) { completeCompaction = onComplete; },
  };
  const controller = createWorkflowCompaction({ sendMessage() {} }, state, {
    setWorkflowDispatchInFlight() {},
    getActiveRole: () => state.activeRole,
    requireRoleRecovery() {},
    sendWorkflowTaskMessage() { dispatches++; },
    async scheduleWorkflow() {},
    sendWorkflowReplanMessage() {},
    acknowledgeRoleRecovery() { acknowledgements++; },
  }, { watchdogMs: 5 });

  assert.equal(controller.start(ctx), true);
  state.roleContextGeneration++;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(notifications.length, 0);
  assert.equal(state.roleCompactionInFlight, true);
  controller.dispose();
  completeCompaction?.({});
  assert.equal(dispatches, 0);
  assert.equal(acknowledgements, 0);
  assert.equal(state.roleCompactionPhase, "idle");
});

test("迟到的压缩回调不能继续已更换的 workflow handoff", () => {
  const state = createExtensionRuntimeState();
  const workflow = startWorkflowTask(createWorkflowState({
    summary: "旧交接",
    sessionId: "test-session",
    tasks: [{ id: "task", role: "docs-commit", task: "旧任务", files: ["docs"], acceptanceCriteria: ["完成"] }],
  }, 100), "task", 110);
  const identity = workflowHandoffIdentity(workflow);
  state.workflowState = workflow;
  state.roleTransitionGeneration = 1;
  state.activeRole = { role: "docs-commit", provider: developerModel.provider, model: developerModel.id, thinkingLevel: "max" };
  state.pendingRoleCompaction = {
    fromRole: "developer-test",
    toRole: "docs-commit",
    sessionId: "test-session",
    contextGeneration: 0,
    roleTransitionGeneration: 1,
    targetRole: state.activeRole,
    continuation: { kind: "workflow-task", taskId: "task", identity },
  };
  let completeCompaction;
  let dispatches = 0;
  let acknowledgements = 0;
  const ctx = {
    sessionManager: { getSessionId: () => "test-session", getBranch: () => [{ type: "user" }] },
    ui: { setStatus() {}, notify() {} },
    compact({ onComplete }) { completeCompaction = onComplete; },
  };
  const controller = createWorkflowCompaction({ sendMessage() {} }, state, {
    setWorkflowDispatchInFlight() {},
    getActiveRole: () => state.activeRole,
    requireRoleRecovery() {},
    sendWorkflowTaskMessage() { dispatches++; },
    async scheduleWorkflow() {},
    sendWorkflowReplanMessage() {},
    acknowledgeRoleRecovery() { acknowledgements++; },
  });

  assert.equal(controller.start(ctx), true);
  state.workflowState = startWorkflowTask(createWorkflowState({
    summary: "新交接",
    sessionId: "test-session",
    tasks: [{ id: "task", role: "docs-commit", task: "新任务", files: ["docs"], acceptanceCriteria: ["完成"] }],
  }, 120), "task", 130);
  completeCompaction?.({});

  assert.equal(dispatches, 0);
  assert.equal(acknowledgements, 0);
  assert.equal(state.roleCompactionInFlight, false);
});

test("压缩长等待 watchdog 只提醒仍在压缩且 dispose 清理瞬态锁", async () => {
  const state = createExtensionRuntimeState();
  state.roleTransitionGeneration = 1;
  state.activeRole = {
    role: "architect",
    provider: architectModel.provider,
    model: architectModel.id,
    thinkingLevel: "max",
  };
  state.pendingRoleCompaction = {
    fromRole: "developer-test",
    toRole: "architect",
    sessionId: "test-session",
    contextGeneration: 0,
    roleTransitionGeneration: 1,
    targetRole: state.activeRole,
  };
  const notifications = [];
  const compactionStates = [];
  let sent = 0;
  const ctx = {
    ui: {
      setStatus() {},
      notify(message, level) { notifications.push({ message, level }); },
    },
    sessionManager: { getSessionId: () => "test-session", getBranch: () => [{ type: "user" }] },
    compact() {},
  };
  const controller = createWorkflowCompaction({ sendMessage() {} }, state, {
    activityStatus: { setCompaction(_ctx, phase, startedAt) { compactionStates.push({ phase, startedAt }); } },
    setWorkflowDispatchInFlight() {},
    getActiveRole() { return state.activeRole; },
    requireRoleRecovery() {},
    sendWorkflowTaskMessage() { sent++; },
    async scheduleWorkflow() {},
    sendWorkflowReplanMessage() {},
    acknowledgeRoleRecovery() {},
  }, { watchdogMs: 5 });

  assert.equal(controller.start(ctx), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.roleCompactionPhase, "compacting");
  assert.equal(state.roleCompactionInFlight, true);
  assert.ok(Number.isFinite(state.roleCompactionStartedAt));
  assert.equal(sent, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /仍在进行/);
  assert.match(notifications[0].message, /达到 5ms 软提醒阈值/);
  assert.match(notifications[0].message, /不代表失败/);
  assert.deepEqual(compactionStates.map(({ phase }) => phase), ["compacting", "long-wait"]);
  assert.ok(Number.isFinite(compactionStates[0].startedAt));
  assert.equal(compactionStates[1].startedAt, compactionStates[0].startedAt);
  controller.dispose();
  assert.equal(state.roleCompactionPhase, "idle");
  assert.equal(state.roleCompactionInFlight, false);
  assert.equal(state.roleCompactionOperationId, undefined);
  assert.deepEqual(compactionStates.map(({ phase }) => phase), ["compacting", "long-wait", undefined]);
});

test("长等待软提醒之后的真实压缩失败仍进入失败诊断", async () => {
  const state = createExtensionRuntimeState();
  state.roleTransitionGeneration = 1;
  state.activeRole = { role: "architect", provider: architectModel.provider, model: architectModel.id, thinkingLevel: "max" };
  state.pendingRoleCompaction = {
    fromRole: "developer-test", toRole: "architect", sessionId: "test-session",
    contextGeneration: 0, roleTransitionGeneration: 1, targetRole: state.activeRole,
  };
  const notifications = [];
  const compactionStates = [];
  const diagnostics = [];
  let dispatches = 0;
  let onError;
  const ctx = {
    ui: { setStatus() {}, notify(message, level) { notifications.push({ message, level }); } },
    sessionManager: { getSessionId: () => "test-session", getBranch: () => [{ type: "user" }] },
    compact(options) { onError = options.onError; },
  };
  const controller = createWorkflowCompaction({ sendMessage(message) { diagnostics.push(message); } }, state, {
    activityStatus: { setCompaction(_ctx, phase) { compactionStates.push(phase); } },
    setWorkflowDispatchInFlight(value) { state.workflowDispatchInFlight = value; },
    getActiveRole: () => state.activeRole,
    requireRoleRecovery() {},
    sendWorkflowTaskMessage() { dispatches++; }, async scheduleWorkflow() {}, sendWorkflowReplanMessage() {}, acknowledgeRoleRecovery() {},
  }, { watchdogMs: 5 });

  assert.equal(controller.start(ctx), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.roleCompactionInFlight, true);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /不代表失败/);
  onError?.(new Error("provider failed"));
  assert.equal(state.roleCompactionPhase, "idle");
  assert.equal(state.roleCompactionInFlight, false);
  assert.equal(state.workflowDispatchInFlight, false);
  assert.deepEqual(compactionStates, ["compacting", "long-wait", undefined]);
  assert.equal(diagnostics.length, 1);
  assert.equal(dispatches, 0);
  assert.match(notifications[1].message, /压缩失败或被中止/);
});

test("Local running 工作流可安全恢复未启动任务且不重复真实执行", async () => {
  await withTempDirectory(async (directory) => {
    await writeWorkflowConfig(directory, "local");
    const branch = [{
      type: "custom",
      customType: "pi-init-workflow",
      data: createWorkflowState({ summary: "Local 恢复", tasks: tasks(), executor: "local" }, 100),
    }];
    const harness = createExtensionHarness(branch, {
      cwd: directory,
      trusted: true,
      model: developerModel,
      availableModels: [developerModel],
    });
    await emitExtensionEvent(harness, "session_start");
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    await emitExtensionEvent(harness, "before_agent_start");
    const recovered = await workflow.execute("resume-before-start", { action: "resume", ...workflowMessageIdentity(harness) }, undefined, undefined, harness.context);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1);

    await emitExtensionEvent(harness, "agent_start");
    const alreadyStarted = await workflow.execute("resume-after-start", { action: "resume", ...workflowMessageIdentity(harness) }, undefined, undefined, harness.context);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1);
  });
});

test("Local resume 在主动压缩期间不清锁也不重复派发", async () => {
  await withTempDirectory(async (directory) => {
    await writeWorkflowConfig(directory, "local");
    const branch = [{
      type: "custom",
      customType: "pi-init-workflow",
      data: createWorkflowState({ summary: "压缩恢复保护", tasks: roleSwitchTasks(), executor: "local" }, 100),
    }];
    const harness = createExtensionHarness(branch, {
      cwd: directory,
      trusted: true,
      model: developerModel,
      availableModels: [developerModel, architectModel],
    });
    harness.context.getContextUsage = () => ({ tokens: 96000, contextWindow: 100000, percent: 96 });
    harness.context.compact = () => {};

    await emitExtensionEvent(harness, "session_start");
    await emitExtensionEvent(harness, "agent_start");
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    await workflow.execute("complete-first", completeParams(harness, "first", "第一项完成"), undefined, undefined, harness.context);
    await emitExtensionEvent(harness, "agent_settled");
    const before = harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length;
    const currentState = harness.entries.findLast((entry) => entry.type === "pi-init-workflow")?.data;
    const resumed = await workflow.execute("resume-compacting", { action: "resume", ...currentState }, undefined, undefined, harness.context);

    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, before);
    assert.equal(harness.notifications.length > 0, true);
  });
});
test("目标模型容量保护识别大窗口到小窗口交接，无需收益预测", () => {
  const state = createExtensionRuntimeState();
  const policy = createCompactionPolicy({ on() {} }, state);
  const ctx = { model: developerModel, getContextUsage: () => ({ percent: 20, tokens: 40000 }) };
  assert.equal(policy.evaluate(ctx, { ...developerModel, contextWindow: 32000, maxTokens: 8000 }).compact, true);
  const big = { ...developerModel, contextWindow: 200000, maxTokens: 8000 };
  ctx.sessionManager = { getBranch: () => [], getSessionId: () => 'test' };
  assert.equal(policy.evaluate(ctx, big).compact, false);
  state.roleModeStatus = 'manual';
  assert.equal(policy.evaluate(ctx, big).ok, false);
});

test("预算不可用时明确拒绝估算，不再以 50% 作为兜底", () => {
  const state = createExtensionRuntimeState();
  const policy = createCompactionPolicy({ on() {} }, state);
  for (const percent of [49.9, 50, 90]) {
    const result = policy.evaluate({ model: developerModel, getContextUsage: () => ({ percent }) });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'COMPACTION_USAGE_UNAVAILABLE');
  }
});

test('budget operation without explicit role verifies actual result and never dispatches or acknowledges recovery', async () => {
  const { createContextBudgetChecker } = await import('../extensions/context-budget-monitor.ts');
  for (const outcome of ['success', 'unknown', 'error', 'stop', 'branch', 'generation', 'role', 'session', 'dispose']) {
    const state = createExtensionRuntimeState();
    let callbacks, acknowledgements = 0, sessionId = 'budget-session';
    const messages = [], notifications = [], traces = [];
    const branch = [{ id: 'a', type: 'message' }];
    const ctx = {
      model: { provider: 'test', id: 'model', contextWindow: 100000, maxTokens: 1000 },
      sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
      getContextUsage: () => ({ tokens: 96000, contextWindow: 100000, percent: 96 }),
      hasPendingMessages: () => false,
      ui: { notify: text => notifications.push(text) },
      compact: options => { callbacks = options; },
    };
    state.traceHandoff = (_ctx, event, data) => traces.push({ event, ...data });
    const pi = { getThinkingLevel: () => 'off', sendMessage: (...args) => messages.push(args) };
    const controller = createWorkflowCompaction(pi, state, {
      getActiveRole: () => state.activeRole,
      setWorkflowDispatchInFlight: value => { state.workflowDispatchInFlight = value; },
      requireRoleRecovery() {},
      acknowledgeRoleRecovery: () => { acknowledgements++; },
      sendWorkflowTaskMessage: () => assert.fail('task replay'),
      scheduleWorkflow: () => assert.fail('workflow restart'),
      sendWorkflowReplanMessage: () => assert.fail('replan replay'),
      sendCoordinationMessage: () => assert.fail('handoff replay'),
    });
    const check = createContextBudgetChecker(pi, state,
      { mode: async () => 'auto', activeRole: () => state.activeRole, start: controller.start,
        decide: createCompactionPolicy({ on() {} }, state).evaluate });
    assert.equal(await check(ctx), true, outcome);
    assert.equal(state.roleCompactionInFlight, true);
    assert.match(callbacks.customInstructions, /System-derived current task snapshot/);
    const result = { summary: 'verified summary', firstKeptEntryId: 'a', tokensBefore: 90000 };
    branch.push({ id: 'c', type: 'compaction', summary: result.summary });
    if (outcome === 'stop') state.userStopRequested = true;
    if (outcome === 'branch') branch[0] = { id: 'other-branch', type: 'message' };
    if (outcome === 'generation') state.roleContextGeneration++;
    if (outcome === 'role') state.activeRole = { role: 'other', provider: 'test', model: 'model', thinkingLevel: 'off' };
    if (outcome === 'session') sessionId = 'other-session';
    if (outcome === 'dispose') controller.dispose();
    if (outcome === 'error') callbacks.onError(new Error('cancelled'));
    else callbacks.onComplete(outcome === 'unknown' ? {} : result);
    assert.equal(state.roleCompactionInFlight, false, outcome);
    assert.equal(acknowledgements, 0, outcome);
    assert.equal(messages.length, ['unknown', 'error'].includes(outcome) ? 1 : 0, outcome);
    const count = messages.length;
    callbacks.onComplete(result);
    assert.equal(messages.length, count, 'duplicate callbacks ignored');
    controller.dispose();
  }
});

test("budget compaction resumes a verified unfinished workflow once through existing dispatcher, never replays task dispatch", async () => {
  const { createContextBudgetChecker } = await import("../extensions/context-budget-monitor.ts");
  const state = createExtensionRuntimeState();
  state.activeRole = { role: "developer-test", provider: "test", model: "model", thinkingLevel: "off" };
  state.workflowState = startWorkflowTask(createWorkflowState({ sessionId: "budget-live", summary: "long task", tasks: [{ id: "t", role: "developer-test", task: "long task", files: ["src"], acceptanceCriteria: ["done"] }] }), "t");
  state.workflowState.handoff.phase = "executing";
  state.agentRunActive = true;
  const branch = [{ id: "a", type: "message" }];
  let callbacks, scheduled = 0;
  const ctx = { model: { provider: "test", id: "model", contextWindow: 100000, maxTokens: 1000 }, sessionManager: { getSessionId: () => "budget-live", getBranch: () => branch }, getContextUsage: () => ({ tokens: 96000, contextWindow: 100000, percent: 96 }), hasPendingMessages: () => false, isIdle: () => !state.agentRunActive, ui: { notify() {} }, compact: options => { callbacks = options; } };
  const pi = { getThinkingLevel: () => "off" };
  const controller = createWorkflowCompaction(pi, state, { getActiveRole: () => state.activeRole, setWorkflowDispatchInFlight: value => { state.workflowDispatchInFlight = value; }, requireRoleRecovery() {}, acknowledgeRoleRecovery() {}, sendWorkflowTaskMessage: () => assert.fail("task replay"), scheduleWorkflow: async (_ctx, identity) => { assert.equal(identity.workflowId, state.workflowState.workflowId); scheduled++; }, sendWorkflowReplanMessage: () => assert.fail("replan replay"), sendCoordinationMessage: () => assert.fail("evidence replay") });
  const check = createContextBudgetChecker(pi, state, { mode: async () => "auto", activeRole: () => state.activeRole, start: controller.start,
    decide: createCompactionPolicy({ on() {} }, state).evaluate });
  assert.equal(await check(ctx), true);
  state.agentRunActive = false;
  const result = { summary: "compressed", firstKeptEntryId: "a", tokensBefore: 90000 };
  branch.push({ id: "c", type: "compaction", summary: result.summary });
  callbacks.onComplete(result); callbacks.onComplete(result);
  assert.equal(scheduled, 1);
  assert.equal(state.workflowState.tasks[0].status, "in_progress");
  assert.equal(state.workflowState.tasks[0].outcomeUnknown, undefined);
  controller.dispose();
});
