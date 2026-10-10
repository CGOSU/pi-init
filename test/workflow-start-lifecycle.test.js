import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowStatusView } from "../extensions/workflow-status-view.ts";
import { validateWorkflowTaskStartMessage } from "../extensions/workflow-start-evidence.ts";
import {
  createExtensionHarness,
  createWorkflowState,
  emitExtensionEvent,
  withTempDirectory,
  mkdir,
  path,
  writeFile,
} from "./helpers.js";

const developerModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
const idleRuntime = { roleCompactionPhase: "idle", workflowDispatchInFlight: false };

async function createTaskHarness(directory, options = {}) {
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  await writeFile(path.join(directory, ".pi", "role-models.json"), `${JSON.stringify({
    schemaVersion: 2,
    mode: "auto",
    workflowMode: "on",
    roleModels: { "developer-test": { provider: developerModel.provider, model: developerModel.id, thinkingLevel: "max" } },
  }, null, 2)}\n`);

  const initial = createWorkflowState({
    summary: "任务启动生命周期",
    sessionId: "test-session",
    executor: "local",
    tasks: [{ id: "first", role: "developer-test", task: "执行第一项", files: ["src/first.ts"], acceptanceCriteria: ["完成"] }],
  }, 100);
  const harness = createExtensionHarness([
    { type: "custom", customType: "pi-init-workflow", data: initial },
  ], {
    cwd: directory,
    trusted: true,
    sessionId: "test-session",
    model: developerModel,
    availableModels: [developerModel],
    deferSendMessagePersistence: options.deferSendMessagePersistence,
    beforeSendMessagePersist: options.beforeSendMessagePersist,
    appendEntry: options.appendEntry,
  });
  await emitExtensionEvent(harness, "session_start");
  return harness;
}

function latestWorkflow(harness) {
  return harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow")?.data;
}

function latestTaskMessage(harness) {
  return harness.sentMessages.findLast(({ message }) => message.customType === "pi-init-workflow-task")?.message;
}

function taskMessageEvent(message, overrides = {}) {
  return {
    type: "message_start",
    message: {
      role: "custom",
      content: message.content,
      customType: message.customType,
      display: message.display,
      details: message.details,
      timestamp: Date.now(),
      ...overrides,
    },
  };
}

function taskResult(identity) {
  return {
    ...identity,
    action: "complete",
    taskId: "first",
    completionSummary: "第一项完成",
    implementationRationale: "验证当前 handoff 的真实启动证据",
    verification: ["针对性生命周期测试通过"],
  };
}

test("只有实际消费完整身份匹配的任务消息才记录启动，且发生在 branch 持久化前", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await createTaskHarness(directory, { deferSendMessagePersistence: true });
    const sentMessage = latestTaskMessage(harness);
    const identity = sentMessage.details;
    const storedTaskMessage = () => harness.branch.some((entry) => entry.type === "custom_message" && entry.customType === "pi-init-workflow-task");

    assert.equal(storedTaskMessage(), false);
    await emitExtensionEvent(harness, "message_start", taskMessageEvent(sentMessage));
    assert.equal(latestWorkflow(harness).handoff.phase, "queued", "没有当前 agent_start 运行窗口时忽略消息事件");
    await emitExtensionEvent(harness, "agent_start");
    assert.equal(latestWorkflow(harness).handoff.phase, "queued");
    assert.equal(latestWorkflow(harness).tasks[0].executionStartedAt, undefined);

    const staleValues = {
      workflowId: "old-workflow",
      planVersion: identity.planVersion + 1,
      sessionId: "old-session",
      recoveryGeneration: identity.recoveryGeneration + 1,
      taskId: "old-task",
      attemptId: "old-attempt",
      handoffId: "old-handoff",
    };
    const staleResult = validateWorkflowTaskStartMessage(taskMessageEvent(sentMessage, {
      details: { ...identity, workflowId: staleValues.workflowId },
    }).message, identity);
    assert.equal(staleResult.ok, false);
    if (!staleResult.ok) assert.equal(staleResult.code, "WORKFLOW_TASK_MESSAGE_IDENTITY_STALE");

    const invalidVersion = validateWorkflowTaskStartMessage(taskMessageEvent(sentMessage, {
      details: { ...identity, planVersion: 1.5 },
    }).message, identity);
    assert.equal(invalidVersion.ok, false);
    if (!invalidVersion.ok) {
      assert.equal(invalidVersion.code, "WORKFLOW_HANDOFF_IDENTITY_FIELD_INVALID");
      assert.equal(invalidVersion.field, "planVersion");
    }

    for (const [field, value] of Object.entries(staleValues)) {
      await emitExtensionEvent(harness, "message_start", taskMessageEvent(sentMessage, {
        details: { ...identity, [field]: value },
      }));
      assert.equal(latestWorkflow(harness).handoff.phase, "queued", `过期 ${field} 不得记录启动`);
      assert.equal(latestWorkflow(harness).tasks[0].executionStartedAt, undefined);
    }

    const malformedDetails = { ...identity };
    delete malformedDetails.attemptId;
    const malformed = validateWorkflowTaskStartMessage({
      ...taskMessageEvent(sentMessage).message,
      details: malformedDetails,
    }, identity);
    assert.deepEqual(malformed, {
      ok: false,
      code: "WORKFLOW_HANDOFF_IDENTITY_FIELD_MISSING",
      message: "工作流任务消息缺少身份字段 attemptId",
      field: "attemptId",
    });
    await emitExtensionEvent(harness, "message_start", taskMessageEvent(sentMessage, { details: malformedDetails }));
    await emitExtensionEvent(harness, "message_start", taskMessageEvent(sentMessage, { role: "user" }));
    await emitExtensionEvent(harness, "message_start", taskMessageEvent(sentMessage, { customType: "pi-init-workflow-replan" }));
    assert.equal(latestWorkflow(harness).handoff.phase, "queued");

    const consumedEvent = taskMessageEvent(sentMessage);
    await emitExtensionEvent(harness, "message_start", consumedEvent);
    const started = latestWorkflow(harness);
    const task = started.tasks[0];
    assert.equal(started.handoff.phase, "executing");
    assert.equal(task.startedAt, started.handoff.startedAt);
    assert.equal(task.executionStartedAt, started.handoff.startedAt);
    assert.equal(storedTaskMessage(), false, "message_start 扩展回调先于 task custom_message branch entry");

    const view = createWorkflowStatusView(started, idleRuntime, started.handoff.startedAt + 1000);
    assert.equal(view.kind, "workflow");
    assert.equal(view.kind === "workflow" ? view.activity : "unexpected", "executing");

    const workflowEntryCount = harness.branch.filter((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow").length;
    await emitExtensionEvent(harness, "message_start", consumedEvent);
    assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow").length, workflowEntryCount);
    assert.equal(latestWorkflow(harness).handoff.startedAt, started.handoff.startedAt, "重复事件不得重置启动时间");

    await emitExtensionEvent(harness, "message_end", { type: "message_end", message: consumedEvent.message });
    assert.equal(storedTaskMessage(), false, "message_end 扩展通知之后，Pi 才持久化任务消息");
    harness.persistSentMessage(sentMessage);
    assert.equal(storedTaskMessage(), true);

    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const completed = await workflow.execute("complete-after-start", taskResult(identity), undefined, undefined, harness.context);
    assert.equal(completed.details.status, "completed");
    const completedEntryCount = harness.branch.filter((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow").length;
    await emitExtensionEvent(harness, "message_start", consumedEvent);
    assert.equal(latestWorkflow(harness).status, "completed", "旧启动事件不得复活已完成工作流");
    assert.equal(harness.branch.filter((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow").length, completedEntryCount);
  });
});

test("只有 branch 中的存储消息不足以证明任务在当前运行中被消费", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await createTaskHarness(directory);
    const sentMessage = latestTaskMessage(harness);
    assert.equal(harness.branch.some((entry) => entry.type === "custom_message" && entry.customType === "pi-init-workflow-task"), true);

    await emitExtensionEvent(harness, "agent_start");
    await emitExtensionEvent(harness, "message_start", taskMessageEvent(sentMessage));
    assert.equal(latestWorkflow(harness).handoff.phase, "queued");
    assert.equal(latestWorkflow(harness).tasks[0].executionStartedAt, undefined);
  });
});

test("启动记录持久化失败时保持 queued，branch 落盘后结果调用仍可安全补记", async () => {
  await withTempDirectory(async (directory) => {
    let failExecutingAppend = false;
    const harness = await createTaskHarness(directory, {
      deferSendMessagePersistence: true,
      appendEntry(type, data) {
        if (failExecutingAppend && type === "pi-init-workflow" && data.handoff?.phase === "executing") {
          throw new Error("启动记录写入失败");
        }
      },
    });
    const sentMessage = latestTaskMessage(harness);
    const identity = sentMessage.details;
    failExecutingAppend = true;

    await emitExtensionEvent(harness, "agent_start");
    await emitExtensionEvent(harness, "message_start", taskMessageEvent(sentMessage));
    const afterFailure = latestWorkflow(harness);
    assert.equal(afterFailure.handoff.phase, "queued");
    assert.equal(afterFailure.tasks[0].startedAt, undefined);
    assert.equal(afterFailure.tasks[0].executionStartedAt, undefined);
    assert.ok(harness.notifications.some(({ message, level }) => level === "error" && message.includes("启动记录写入失败")));
    const failedView = createWorkflowStatusView(afterFailure, idleRuntime, 200);
    assert.equal(failedView.kind === "workflow" ? failedView.activity : "unexpected", "waiting-task");
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const status = await workflow.execute("status-after-start-write-failure", { action: "status" }, undefined, undefined, harness.context);
    assert.equal(status.details.handoff.phase, "queued");
    assert.equal(status.details.workflowPresentation.view.activity, "waiting-task");

    await emitExtensionEvent(harness, "message_end", { type: "message_end", message: taskMessageEvent(sentMessage).message });
    harness.persistSentMessage(sentMessage);
    failExecutingAppend = false;
    const completed = await workflow.execute("complete-after-retryable-start-write", taskResult(identity), undefined, undefined, harness.context);
    assert.equal(completed.details.status, "completed");
    assert.equal(completed.details.tasks[0].startedAt, completed.details.tasks[0].executionStartedAt);
    assert.equal(typeof completed.details.tasks[0].executionStartedAt, "number");
  });
});

test("派发中的同步任务消息消费不会被后续 queued 写入覆盖", async () => {
  await withTempDirectory(async (directory) => {
    let consumed = false;
    const harness = await createTaskHarness(directory, {
      beforeSendMessagePersist(message, { handlers, context }) {
        if (consumed || message.customType !== "pi-init-workflow-task") return;
        consumed = true;
        for (const handler of handlers.get("agent_start") ?? []) handler({ type: "agent_start" }, context);
        const event = taskMessageEvent(message);
        for (const handler of handlers.get("message_start") ?? []) handler(event, context);
      },
    });

    assert.equal(consumed, true);
    assert.equal(latestWorkflow(harness).handoff.phase, "executing");
    assert.equal(latestWorkflow(harness).tasks[0].executionStartedAt, latestWorkflow(harness).handoff.startedAt);
    assert.equal(harness.branch.some((entry) => entry.type === "custom_message" && entry.customType === "pi-init-workflow-task"), true);
  });
});

test("已退休 runtime 忽略延迟到达的旧任务消息事件", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await createTaskHarness(directory, { deferSendMessagePersistence: true });
    const sentMessage = latestTaskMessage(harness);
    await emitExtensionEvent(harness, "session_shutdown");

    await emitExtensionEvent(harness, "message_start", taskMessageEvent(sentMessage));
    assert.equal(latestWorkflow(harness).handoff.phase, "queued");
    assert.equal(latestWorkflow(harness).tasks[0].executionStartedAt, undefined);
  });
});
