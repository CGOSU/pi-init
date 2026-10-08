import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";
import { createWorkflowCompaction } from "../extensions/workflow-compaction.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { workflowHandoffIdentity } from "../src/workflow-handoff.js";

const {
  createExtensionHarness,
  createWorkflowState,
  workflowMessageIdentity,
  startWorkflowTask,
  emitExtensionEvent,
  mkdir,
  path,
  shouldCompactAfterWorkflowTask,
  withTempDirectory,
  writeFile,
} = helpers;

const developerModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
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

test("长工作流在同角色任务边界不主动压缩", async () => {
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
    harness.context.getContextUsage = () => ({ percent: 60 });
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
    assert.equal(compactCalls, 0);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 2);

    await emitExtensionEvent(harness, "agent_start");
    const second = await workflow.execute("complete-second", completeParams(harness, "second", "第二项完成"), undefined, undefined, harness.context);
    assert.equal(second.details.status, "completed");
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(compactCalls, 0);
  });
});

test("实际角色切换的压缩信号只派发一次下一任务", async () => {
  await withTempDirectory(async (directory) => {
    await writeWorkflowConfig(directory, "local");
    const branch = [{
      type: "custom",
      customType: "pi-init-workflow",
      data: createWorkflowState({ summary: "角色切换压缩", tasks: roleSwitchTasks(), executor: "local" }, 100),
    }];
    const harness = createExtensionHarness(branch, {
      cwd: directory,
      trusted: true,
      model: developerModel,
      availableModels: [developerModel, architectModel],
    });
    let compactCalls = 0;
    const compact = harness.context.compact;
    harness.context.getContextUsage = () => ({ percent: 60 });
    harness.context.compact = (options) => {
      compactCalls++;
      compact(options);
    };

    await emitExtensionEvent(harness, "session_start");
    await emitExtensionEvent(harness, "agent_start");
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    await workflow.execute("complete-first", completeParams(harness, "first", "第一项完成"), undefined, undefined, harness.context);
    await emitExtensionEvent(harness, "agent_settled");

    assert.equal(compactCalls, 1);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 2);
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
    harness.context.getContextUsage = () => ({ percent: 60 });
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
      harness.context.getContextUsage = () => ({ percent: 60 });
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

test("branch/context 变化并 dispose 后，迟到的压缩回调失效", () => {
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
  state.roleContextGeneration++;
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

test("压缩 watchdog 只告警且 dispose 清理瞬态锁", async () => {
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
  assert.equal(state.roleCompactionPhase, "stalled");
  assert.equal(state.roleCompactionInFlight, true);
  assert.equal(sent, 0);
  assert.equal(notifications.length, 1);
  controller.dispose();
  assert.equal(state.roleCompactionPhase, "idle");
  assert.equal(state.roleCompactionInFlight, false);
  assert.equal(state.roleCompactionOperationId, undefined);
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
    harness.context.getContextUsage = () => ({ percent: 60 });
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

test("任务边界压缩要求自动模式和至少 50% 上下文", () => {
  assert.equal(shouldCompactAfterWorkflowTask({ mode: "auto", contextUsage: { percent: 50 } }), true);
  assert.equal(shouldCompactAfterWorkflowTask({ mode: "auto", contextUsage: { percent: 49.9 } }), false);
  assert.equal(shouldCompactAfterWorkflowTask({ mode: "auto", contextUsage: { percent: null } }), false);
  assert.equal(shouldCompactAfterWorkflowTask({ mode: "confirm", contextUsage: { percent: 90 } }), false);
});
