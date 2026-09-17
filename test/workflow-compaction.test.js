import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";
import { createWorkflowCompaction } from "../extensions/workflow-compaction.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";

const {
  DEFAULT_ROLE_MODELS,
  createExtensionHarness,
  createWorkflowState,
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
    { id: "second", role: "architect", task: "完成第二项", files: ["src/second.js"], acceptanceCriteria: ["通过"] },
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
      roleModels: DEFAULT_ROLE_MODELS,
    }, null, 2)}\n`,
  );
}

function completeParams(taskId, summary) {
  return {
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
    const first = await workflow.execute("complete-first", completeParams("first", "第一项完成"), undefined, undefined, harness.context);
    assert.equal(first.details.status, "running");

    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(compactCalls, 0);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 2);

    await emitExtensionEvent(harness, "agent_start");
    const second = await workflow.execute("complete-second", completeParams("second", "第二项完成"), undefined, undefined, harness.context);
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
    await workflow.execute("complete-first", completeParams("first", "第一项完成"), undefined, undefined, harness.context);
    await emitExtensionEvent(harness, "agent_settled");

    assert.equal(compactCalls, 1);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 2);
    assert.equal(harness.statusCalls.filter(({ text }) => text?.includes("role-compaction-")).length >= 1, true);
  });
});

test("session_compact 信号可以独立收敛主动压缩", async () => {
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
    harness.context.compact = () => {};

    await emitExtensionEvent(harness, "session_start");
    await emitExtensionEvent(harness, "agent_start");
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    await workflow.execute("complete-first", completeParams("first", "第一项完成"), undefined, undefined, harness.context);
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1);
    assert.equal(harness.statusCalls.some(({ name, text }) => name === "pi-init-workflow" && text?.includes("正在压缩上下文")), true);

    await harness.completeCompaction();
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 2);
  });
});

test("主动压缩同步异常和 onError 都释放交接并继续任务", async () => {
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
      await workflow.execute("complete-first", completeParams("first", "第一项完成"), undefined, undefined, harness.context);
      await emitExtensionEvent(harness, "agent_settled");

      assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 2);
      assert.equal(harness.notifications.some(({ message }) => message.includes("压缩")), true);
      assert.notEqual(harness.statusCalls.at(-1)?.text?.includes("正在压缩"), true);
    });
  }
});

test("压缩 watchdog 只告警且 dispose 清理瞬态锁", async () => {
  const state = createExtensionRuntimeState();
  state.pendingRoleCompaction = {
    fromRole: "developer-test",
    toRole: "architect",
    continuation: { kind: "workflow-task", taskId: "second" },
  };
  const notifications = [];
  const statuses = [];
  let sent = 0;
  const ctx = {
    ui: {
      setStatus(name, text) { statuses.push({ name, text }); },
      notify(message, level) { notifications.push({ message, level }); },
    },
    sessionManager: { getBranch: () => [{ type: "user" }] },
    compact() {},
  };
  const controller = createWorkflowCompaction({ sendMessage() {} }, state, {
    setWorkflowDispatchInFlight() {},
    setInternalContinuationPending() {},
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
  assert.equal(statuses.at(-1)?.text?.includes("未自动启动下一任务"), true);

  controller.dispose();
  assert.equal(state.roleCompactionPhase, "idle");
  assert.equal(state.roleCompactionInFlight, false);
  assert.equal(state.roleCompactionOperationId, undefined);
});

test("Local UI 区分任务交接与真实 Agent 执行", async () => {
  await withTempDirectory(async (directory) => {
    await writeWorkflowConfig(directory, "local");
    const branch = [{
      type: "custom",
      customType: "pi-init-workflow",
      data: createWorkflowState({ summary: "交接状态", tasks: tasks(), executor: "local" }, 100),
    }];
    const harness = createExtensionHarness(branch, {
      cwd: directory,
      trusted: true,
      model: developerModel,
      availableModels: [developerModel],
    });

    await emitExtensionEvent(harness, "session_start");
    assert.equal(harness.statusCalls.some(({ name, text }) => name === "pi-init-workflow" && text?.includes("正在交接任务")), true);
    await emitExtensionEvent(harness, "agent_start");
    assert.equal(harness.statusCalls.some(({ name, text }) => name === "pi-init-workflow" && text?.includes("任务执行中")), true);
  });
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
    const recovered = await workflow.execute("resume-before-start", { action: "resume" }, undefined, undefined, harness.context);
    assert.equal(recovered.content[0].text, "已安全重新调度 Local 工作流。");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 2);

    await emitExtensionEvent(harness, "agent_start");
    const alreadyStarted = await workflow.execute("resume-after-start", { action: "resume" }, undefined, undefined, harness.context);
    assert.equal(alreadyStarted.content[0].text, "当前任务已真实启动，未重复派发。");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 2);
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
    await workflow.execute("complete-first", completeParams("first", "第一项完成"), undefined, undefined, harness.context);
    await emitExtensionEvent(harness, "agent_settled");
    const before = harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length;
    const resumed = await workflow.execute("resume-compacting", { action: "resume" }, undefined, undefined, harness.context);

    assert.equal(resumed.content[0].text, "工作流仍在等待上下文压缩，不会并发启动任务。");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, before);
    assert.equal(harness.notifications.some(({ message }) => message.includes("上下文压缩")), true);
  });
});

test("任务边界压缩要求自动模式和至少 50% 上下文", () => {
  assert.equal(shouldCompactAfterWorkflowTask({ mode: "auto", contextUsage: { percent: 50 } }), true);
  assert.equal(shouldCompactAfterWorkflowTask({ mode: "auto", contextUsage: { percent: 49.9 } }), false);
  assert.equal(shouldCompactAfterWorkflowTask({ mode: "auto", contextUsage: { percent: null } }), false);
  assert.equal(shouldCompactAfterWorkflowTask({ mode: "confirm", contextUsage: { percent: 90 } }), false);
});
