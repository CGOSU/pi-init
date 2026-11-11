import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowStatusView } from "../extensions/workflow-status-view.ts";
import { validateWorkflowTaskStartMessage } from "../extensions/workflow-start-evidence.ts";
import { createExtensionHarness, emitExtensionEvent } from "./support/extension-harness.js";
import { createWorkflowState, latestWorkflow } from "./support/workflow-fixtures.js";
import { withTempDirectory } from "./support/temp-directory.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { branchContainsExactlyOneAnchor } from "../extensions/role-context-protocol.ts";
import { workflowHandoffIdentity } from "../src/workflow.ts";

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
    verification: [{ check: "fixture check", status: "passed", details: "针对性生命周期测试通过" }],
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

test("无进展时先发一次纠偏续跑，仍无结果则暂停且不再自动派发", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await createTaskHarness(directory, { deferSendMessagePersistence: true });
    const runUnfinishedTurn = async () => {
      const message = harness.sentMessages.at(-1).message;
      await emitExtensionEvent(harness, "agent_start");
      await emitExtensionEvent(harness, "message_start", taskMessageEvent(message));
      await emitExtensionEvent(harness, "message_end", { type: "message_end", message: taskMessageEvent(message).message });
      harness.persistSentMessage(message);
      await emitExtensionEvent(harness, "agent_end");
      await emitExtensionEvent(harness, "agent_settled");
    };

    await runUnfinishedTurn();
    assert.equal(latestWorkflow(harness).nudgeCount, 1);
    await runUnfinishedTurn();
    assert.equal(latestWorkflow(harness).status, "running");
    assert.equal(latestWorkflow(harness).nudgeCount, 2);
    const correction = harness.sentMessages.at(-1).message;
    assert.match(correction.content, /停止重复查询|反复读取/);
    assert.match(correction.content, /未知.*操作|副作用/);

    const messageCountAfterCorrection = harness.sentMessages.length;
    await runUnfinishedTurn();
    const paused = latestWorkflow(harness);
    assert.equal(paused.status, "paused");
    assert.equal(paused.pauseReason, "task-blocked");
    assert.equal(paused.nudgeCount, 3);
    assert.equal(paused.tasks[0].outcomeUnknown, undefined);
    assert.equal(harness.sentMessages.length, messageCountAfterCorrection, "纠偏后仍无结果时不再自动续跑");
    await emitExtensionEvent(harness, "session_shutdown");
  });
});

async function invokeTaskTool(h, name, args, execute) {
  const serial = h.branch.length + 1;
  const id = "stage-call-" + serial;
  const message = { role: "assistant", timestamp: serial, provider: developerModel.provider, model: developerModel.id,
    stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: args }] };
  await emitExtensionEvent(h, "before_provider_request");
  await emitExtensionEvent(h, "message_end", { message });
  h.branch.push({ type: "message", id: "stage-proposal-" + serial, message });
  await emitExtensionEvent(h, "tool_execution_start", { toolCallId: id, toolName: name, args });
  const result = execute ? await execute(id) : { content: [{ type: "text", text: "source " + args.path }] };
  const isError = result.isError === true;
  await emitExtensionEvent(h, "tool_result", { toolCallId: id, toolName: name, input: args, ...result, isError });
  await emitExtensionEvent(h, "tool_execution_end", { toolCallId: id, toolName: name, result, isError });
  const source = "stage-result-" + serial;
  h.branch.push({ type: "message", id: source, message: { role: "toolResult", toolCallId: id, toolName: name,
    ...result, isError, timestamp: serial } });
  return source;
}

test("真实阶段检查点让长任务跨越三轮继续，重复旧成果仍有限暂停", async () => {
  await withTempDirectory(async directory => {
    const h = await createTaskHarness(directory, { deferSendMessagePersistence: true });
    const workflow = h.tools.find(tool => tool.name === "task_workflow");
    const identity = latestTaskMessage(h).details;
    const invoke = (...args) => invokeTaskTool(h, ...args);
    let oldSource;
    for (let turn = 0; turn < 6; turn++) {
      await emitExtensionEvent(h, "before_agent_start", { systemPrompt: "" });
      await emitExtensionEvent(h, "agent_start");
      await emitExtensionEvent(h, "message_start", taskMessageEvent(latestTaskMessage(h)));
      h.persistSentMessage(h.sentMessages.at(-1).message);
      if (turn === 1) {
        await invoke("bash", { command: "test regression" }, async () => ({
          content: [{ type: "text", text: "Known regression assertion failed" }], isError: true,
        }));
        await invoke("edit", { path: "src/fix.ts", oldText: "broken", newText: "fixed" });
      }
      const source = turn === 1 ? await invoke("bash", { command: "test regression" }, async () => ({
        content: [{ type: "text", text: "Regression passed after repair" }],
      })) : turn < 4 ? await invoke("read", { path: `src/part-${turn}.ts` }) : oldSource;
      oldSource = source;
      const revision = h.branch.findLast(entry => entry.customType === "pi-init-task-memory")?.data.revision ?? 0;
      const args = { action: "checkpoint", expectedMemoryRevision: revision, checkpoint: {
        step: "阶段 " + turn, accomplished: [{ summary: "已核对本阶段来源", evidenceIds: [source] }],
        remaining: ["整项交付尚未完成"], blockers: [], nextStep: "继续下一阶段",
      } };
      await invoke("task_workflow", args, id => workflow.execute(id, args, undefined, undefined, h.context));
      await emitExtensionEvent(h, "agent_end");
      await emitExtensionEvent(h, "agent_settled");
      const state = latestWorkflow(h);
      if (turn < 4) {
        assert.equal(state.status, "running", `第 ${turn + 1} 轮有新成果，不应因缺终态而暂停`);
        assert.equal(state.nudgeCount, 1);
        assert.equal(state.handoff.attemptId, identity.attemptId);
      }
    }
    assert.equal(latestWorkflow(h).pauseReason, "task-blocked");
    assert.equal(latestWorkflow(h).tasks[0].outcomeUnknown, undefined);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("阶段成果已保存但提醒计数写入失败时停止推进，不重放检查点", async () => {
  await withTempDirectory(async directory => {
    let failProgressWrite = false;
    const h = await createTaskHarness(directory, { deferSendMessagePersistence: true,
      appendEntry(type, data) {
        if (failProgressWrite && type === "pi-init-workflow" && data.status === "running" && data.nudgeCount === 0) {
          throw new Error("progress counter write failed");
        }
      },
    });
    await emitExtensionEvent(h, "agent_start");
    await emitExtensionEvent(h, "message_start", taskMessageEvent(latestTaskMessage(h)));
    h.persistSentMessage();
    await emitExtensionEvent(h, "agent_end");
    await emitExtensionEvent(h, "agent_settled");
    assert.equal(latestWorkflow(h).nudgeCount, 1);
    await emitExtensionEvent(h, "agent_start");
    const source = await invokeTaskTool(h, "edit", { path: "src/fix.ts", oldText: "old", newText: "new" });
    failProgressWrite = true;
    const args = { action: "checkpoint", expectedMemoryRevision: 0, checkpoint: {
      step: "保存新成果", accomplished: [{ summary: "改动已保存", evidenceIds: [source] }],
      remaining: ["最终验证"], blockers: [], nextStep: "验证",
    } };
    const tool = h.tools.find(item => item.name === "task_workflow");
    const receipt = await invokeTaskTool(h, "task_workflow", args, async id => {
      await assert.rejects(tool.execute(id, args, undefined, undefined, h.context), /progress counter write failed/);
      return { content: [{ type: "text", text: "progress counter write failed" }], isError: true };
    });
    assert.equal(h.branch.findLast(entry => entry.customType === "pi-init-task-memory").data.revision, 1);
    assert.notEqual(h.branch.find(entry => entry.id === receipt).message.details?.checkpointSaved, true);
    assert.equal(h.branch.findLast(entry => entry.customType === "pi-init-user-control").data.stopped, true);
    const sent = h.sentMessages.length;
    await emitExtensionEvent(h, "agent_end");
    await emitExtensionEvent(h, "agent_settled");
    assert.equal(h.sentMessages.length, sent);
    assert.equal(latestWorkflow(h).tasks[0].outcomeUnknown, true);
    await emitExtensionEvent(h, "session_shutdown");
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

test("final provider failure pauses once instead of redispatching the same task", async () => {
  await withTempDirectory(async directory => {
    const h = await createTaskHarness(directory, { deferSendMessagePersistence: true });
    await emitExtensionEvent(h, "before_agent_start", { systemPrompt: "" });
    await emitExtensionEvent(h, "agent_start");
    const first = latestTaskMessage(h);
    await emitExtensionEvent(h, "message_start", taskMessageEvent(first));
    h.persistSentMessage(first);
    const sent = h.sentMessages.length;
    await emitExtensionEvent(h, "message_end", { message: { role: "assistant", content: [], stopReason: "error", errorMessage: "The usage limit has been reached" } });
    await emitExtensionEvent(h, "agent_end");
    await emitExtensionEvent(h, "agent_settled", { aborted: false });
    assert.equal(latestWorkflow(h).status, "paused");
    assert.equal(latestWorkflow(h).tasks[0].outcomeUnknown, true);
    assert.equal(h.sentMessages.length, sent);
    await emitExtensionEvent(h, "agent_settled", { aborted: false });
    assert.equal(h.sentMessages.length, sent);
    await emitExtensionEvent(h, "session_shutdown");
  });
});
test("ordinary continuation preserves exactly one task authorization anchor", async () => {
  await withTempDirectory(async directory => {
    const h = await createTaskHarness(directory, { deferSendMessagePersistence: true });
    await emitExtensionEvent(h, "agent_start");
    const first = latestTaskMessage(h);
    await emitExtensionEvent(h, "message_start", taskMessageEvent(first));
    h.persistSentMessage(first);
    const identity = workflowHandoffIdentity(latestWorkflow(h));
    await emitExtensionEvent(h, "message_end", { message: { role: "assistant", content: [], stopReason: "stop" } });
    await emitExtensionEvent(h, "agent_end");
    await emitExtensionEvent(h, "agent_settled");
    const reminder = h.sentMessages.at(-1).message;
    assert.equal(reminder.customType, "pi-init-workflow-continuation");
    h.persistSentMessage(reminder);
    assert.equal(branchContainsExactlyOneAnchor(h.branch, "pi-init-workflow-task", identity), true);
    assert.deepEqual(workflowHandoffIdentity(latestWorkflow(h)), identity);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("a recovered assistant response is not treated as a final provider failure", async () => {
  await withTempDirectory(async directory => {
    const h = await createTaskHarness(directory, { deferSendMessagePersistence: true });
    await emitExtensionEvent(h, "agent_start");
    const first = latestTaskMessage(h);
    await emitExtensionEvent(h, "message_start", taskMessageEvent(first)); h.persistSentMessage(first);
    await emitExtensionEvent(h, "message_end", { message: { role: "assistant", content: [], stopReason: "error" } });
    await emitExtensionEvent(h, "message_end", { message: { role: "assistant", content: [], stopReason: "stop" } });
    await emitExtensionEvent(h, "agent_end"); await emitExtensionEvent(h, "agent_settled");
    assert.equal(latestWorkflow(h).status, "running");
    assert.equal(h.sentMessages.at(-1).message.customType, "pi-init-workflow-continuation");
    await emitExtensionEvent(h, "session_shutdown");
  });
});
test("registered repeated-read guard pauses without replaying or dispatching another task", async () => {
  await withTempDirectory(async directory => {
    const h = await createTaskHarness(directory, { deferSendMessagePersistence: true });
    await emitExtensionEvent(h, "agent_start");
    const first = latestTaskMessage(h);
    await emitExtensionEvent(h, "message_start", taskMessageEvent(first)); h.persistSentMessage(first);
    const before = h.sentMessages.length;
    for (let i = 0; i < 7; i++) {
      await emitExtensionEvent(h, "tool_call", { toolName: "read", toolCallId: "same-" + i, input: { path: "src/first.ts" } });
      await emitExtensionEvent(h, "tool_result", { toolName: "read", toolCallId: "same-" + i, input: { path: "src/first.ts" }, content: [{ type: "text", text: "unchanged" }], isError: false });
    }
    assert.equal(latestWorkflow(h).status, "paused");
    assert.equal(latestWorkflow(h).tasks[0].outcomeUnknown, true);
    await emitExtensionEvent(h, "agent_end"); await emitExtensionEvent(h, "agent_settled");
    assert.equal(h.sentMessages.length, before);
    assert.ok(h.branch.some(entry => entry.customType === "pi-init-user-control" && entry.data.reason === "repeated-read"));
    await emitExtensionEvent(h, "session_shutdown");
  });
});
