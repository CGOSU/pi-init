import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";
import { createWorkflowReport } from "../extensions/workflow-report.ts";
import { WORKFLOW_RECOVERY_DISPOSITION_TYPE } from "../src/workflow-recovery-disposition.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";

const { createExtensionHarness, createWorkflowState, emitExtensionEvent, workflowMessageIdentity, startWorkflowTask, withTempDirectory, mkdir, path, writeFile } = helpers;

const developerModel = { provider: "openai-codex", id: "gpt-5.6-luna" };

function tasks() {
  return [
    { id: "first", role: "developer-test", task: "完成第一项", files: ["src/first.js"], acceptanceCriteria: ["通过"] },
    { id: "second", role: "developer-test", task: "完成第二项", files: ["src/second.js"], acceptanceCriteria: ["通过"] },
  ];
}

async function writeWorkflowConfig(directory) {
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  await writeFile(
    path.join(directory, ".pi", "role-models.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      mode: "auto",
      workflowMode: "on",
      workflowExecutor: "local",
      roleModels: {
        "developer-test": { provider: developerModel.provider, model: developerModel.id, thinkingLevel: "max" },
      },
    }, null, 2)}\n`,
  );
}

function completeParams(harness) {
  return {
    ...workflowMessageIdentity(harness),
    action: "complete",
    taskId: "first",
    completionSummary: "第一项完成",
    implementationRationale: "测试持久化失败不推进完成状态",
    verification: ["针对性测试通过"],
  };
}

test("appendEntry 失败时 persistWorkflowState 保留内存状态和恢复错误", () => {
  const current = createWorkflowState({ summary: "持久化失败", tasks: tasks() }, 100);
  const next = { ...current, status: "cancelled", updatedAt: 200 };
  const restoreError = { code: "WORKFLOW_STATE_INVALID", message: "之前读取的状态无效" };
  const state = createExtensionRuntimeState();
  state.workflowState = current;
  state.workflowRestoreError = restoreError;
  const persistenceError = new Error("session entry 写入失败");
  const report = createWorkflowReport(state, {
    pi: { appendEntry() { throw persistenceError; } },
    roleRuntime: {},
  });

  assert.throws(() => report.persistWorkflowState(next, {}), persistenceError);
  assert.equal(state.workflowState, current);
  assert.equal(state.workflowRestoreError, restoreError);
});

test("初始任务状态写入失败不派发任务且后续可安全重新调度", async () => {
  await withTempDirectory(async (directory) => {
    await writeWorkflowConfig(directory);
    let failAppend = true;
    const initial = createWorkflowState({ summary: "启动写入失败恢复", tasks: tasks(), executor: "local" }, 100);
    const branch = [{ type: "custom", customType: "pi-init-workflow", data: initial }];
    const harness = createExtensionHarness(branch, {
      cwd: directory,
      trusted: true,
      model: developerModel,
      availableModels: [developerModel],
      appendEntry() {
        if (failAppend) throw new Error("session entry 写入失败");
      },
    });

    await emitExtensionEvent(harness, "session_start");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 0);
    assert.equal(harness.branch.length, 1);
    assert.equal(harness.notifications.some(({ message }) => message.includes("session entry 写入失败")), true);

    failAppend = false;
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1);
    const persisted = harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow").data;
    assert.equal(persisted.currentTaskId, "first");
    assert.equal(persisted.tasks[0].status, "in_progress");
  });
});

test("取消状态持久化失败时不报告成功并保留原工作流与状态展示", async () => {
  await withTempDirectory(async (directory) => {
    const initial = createWorkflowState({
      summary: "取消写入失败",
      sessionId: "test-session",
      reviewRequired: true,
      tasks: [{ id: "task", task: "保持可恢复", files: ["src/task.js"], acceptanceCriteria: ["完成"] }],
    }, 100);
    const branch = [{ type: "custom", customType: "pi-init-workflow", data: initial }];
    const harness = createExtensionHarness(branch, {
      cwd: directory,
      trusted: true,
      mode: "rpc",
      appendEntry(type, data) {
        if (type === "pi-init-workflow" && data.status === "cancelled") {
          throw new Error("取消状态 session entry 写入失败");
        }
      },
    });
    await emitExtensionEvent(harness, "session_start");
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");

    const current = harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow").data;
    await assert.rejects(
      workflow.execute("cancel-with-write-failure", {
        action: "cancel",
        workflowId: current.workflowId,
        planVersion: current.planVersion,
        sessionId: current.sessionId,
        recoveryGeneration: current.recoveryGeneration,
      }, undefined, undefined, harness.context),
      /取消状态 session entry 写入失败/,
    );

    const status = await workflow.execute("status-after-cancel-write-failure", { action: "status" }, undefined, undefined, harness.context);
    assert.equal(status.details.status, "paused");
    assert.equal(harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow")?.data.status, "paused");
    assert.ok(harness.statusCalls.some(({ name, text }) => name === "pi-init-activity" && text?.includes("已暂停")));
  });
});

test("显式 discard-recovery 核对来源并仅追加同 session 的版本化处置记录", async () => {
  await withTempDirectory(async (directory) => {
    const source = {
      type: "custom",
      customType: "pi-init-workflow",
      id: "source-entry-a",
      data: "损坏的原始记录",
    };
    const original = { ...source };
    const harness = createExtensionHarness([source], {
      cwd: directory,
      trusted: true,
      sessionId: "session-a",
    });
    await emitExtensionEvent(harness, "session_start");
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const before = await workflow.execute("recovery-before", { action: "status" }, undefined, undefined, harness.context);
    assert.equal(before.details.error.code, "WORKFLOW_STATE_INVALID_TYPE");
    assert.equal(before.details.error.sourceEntryId, "source-entry-a");
    assert.match(before.content[0].text, /discard-recovery source-entry-a/);

    const command = harness.commands.get("pi-init");
    await command.handler("workflow discard-recovery source-entry-a", harness.context);
    assert.equal(harness.branch.length, 1);
    assert.match(harness.notifications.at(-1).message, /--confirm-unknown-outcome/);

    await command.handler("workflow discard-recovery other-entry --confirm-unknown-outcome", harness.context);
    assert.equal(harness.branch.length, 1);
    assert.match(harness.notifications.at(-1).message, /不匹配/);

    await command.handler("workflow discard-recovery source-entry-a --confirm-unknown-outcome", harness.context);
    assert.equal(harness.branch.length, 2);
    assert.deepEqual(harness.branch[0], original);
    assert.equal(harness.branch[1].customType, WORKFLOW_RECOVERY_DISPOSITION_TYPE);
    assert.deepEqual(harness.branch[1].data, {
      version: 1,
      action: "discard",
      sessionId: "session-a",
      sourceEntryId: "source-entry-a",
      sourceErrorCode: "WORKFLOW_STATE_INVALID_TYPE",
      confirmedUnknownOutcome: true,
    });

    await emitExtensionEvent(harness, "session_start");
    const after = await workflow.execute("recovery-after", { action: "status" }, undefined, undefined, harness.context);
    assert.equal(after.details.workflowPresentation.view.kind, "no-workflow");
    assert.doesNotMatch(after.content[0].text, /WORKFLOW_STATE_INVALID_TYPE/);
  });
});

test("隔离处置写入失败会保留恢复阻塞和原记录", async () => {
  await withTempDirectory(async (directory) => {
    const source = {
      type: "custom",
      customType: "pi-init-workflow",
      id: "source-entry-b",
      data: "损坏的原始记录",
    };
    const harness = createExtensionHarness([source], {
      cwd: directory,
      trusted: true,
      appendEntry(type) {
        if (type === WORKFLOW_RECOVERY_DISPOSITION_TYPE) throw new Error("隔离 entry 写入失败");
      },
    });
    await emitExtensionEvent(harness, "session_start");

    await harness.commands.get("pi-init").handler(
      "workflow discard-recovery source-entry-b --confirm-unknown-outcome",
      harness.context,
    );
    assert.equal(harness.branch.length, 1);
    assert.match(harness.notifications.at(-1).message, /WORKFLOW_RECOVERY_DISPOSITION_PERSIST_FAILED/);
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const status = await workflow.execute("recovery-persist-failure", { action: "status" }, undefined, undefined, harness.context);
    assert.equal(status.details.error.code, "WORKFLOW_STATE_INVALID_TYPE");
    assert.equal(status.details.error.sourceEntryId, "source-entry-b");
  });
});

test("隔离恢复记录要求受信任、空闲和可靠 session 身份", async () => {
  for (const options of [
    { trusted: false, expected: /受信任项目/ },
    { trusted: true, isIdle: false, expected: /Agent 正忙/ },
    { trusted: true, sessionId: "", expected: /无法读取当前 sessionId/ },
  ]) {
    await withTempDirectory(async (directory) => {
      const source = {
        type: "custom",
        customType: "pi-init-workflow",
        id: "source-entry-gated",
        data: "损坏的原始记录",
      };
      const harness = createExtensionHarness([source], { cwd: directory, ...options });
      await emitExtensionEvent(harness, "session_start");
      await harness.commands.get("pi-init").handler(
        "workflow discard-recovery source-entry-gated --confirm-unknown-outcome",
        harness.context,
      );
      assert.equal(harness.branch.length, 1);
      assert.match(harness.notifications.at(-1).message, options.expected);
    });
  }
});

test("损坏记录显式声明其他 session 时仍拒绝隔离", async () => {
  await withTempDirectory(async (directory) => {
    const source = {
      type: "custom",
      customType: "pi-init-workflow",
      id: "source-entry-other-session",
      data: { sessionId: "other-session", version: 99 },
    };
    const harness = createExtensionHarness([source], {
      cwd: directory,
      trusted: true,
      sessionId: "current-session",
    });
    await emitExtensionEvent(harness, "session_start");
    await harness.commands.get("pi-init").handler(
      "workflow discard-recovery source-entry-other-session --confirm-unknown-outcome",
      harness.context,
    );
    assert.equal(harness.branch.length, 1);
    assert.match(harness.notifications.at(-1).message, /sessionId 与当前 session 不一致/);
  });
});

test("恢复状态持久化失败保持 blocked 分类并拒绝 discard-recovery", async () => {
  await withTempDirectory(async (directory) => {
    const initial = createWorkflowState({ summary: "恢复状态写入失败", tasks: tasks() }, 100);
    const source = { type: "custom", customType: "pi-init-workflow", id: "source-storage-failure", data: initial };
    const harness = createExtensionHarness([source], {
      cwd: directory,
      trusted: true,
      appendEntry(type) {
        if (type === "pi-init-workflow") throw new Error("恢复状态写入失败");
      },
    });
    await emitExtensionEvent(harness, "session_start");
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const status = await workflow.execute("recovery-storage-failure", { action: "status" }, undefined, undefined, harness.context);
    assert.equal(status.details.error.code, "WORKFLOW_RECOVERY_PERSIST_FAILED");
    assert.equal(status.details.recovery.kind, "blocked");
    assert.equal(status.details.recovery.stateAllowsAction, false);
    assert.doesNotMatch(status.content[0].text, /discard-recovery/);

    await harness.commands.get("pi-init").handler(
      "workflow discard-recovery source-storage-failure --confirm-unknown-outcome",
      harness.context,
    );
    assert.equal(harness.branch.length, 1);
    assert.match(harness.notifications.at(-1).message, /待持久化恢复状态/);
  });
});

test("完成状态写入失败不返回成功或派发后续任务", async () => {
  await withTempDirectory(async (directory) => {
    await writeWorkflowConfig(directory);
    let failAppend = false;
    const initial = startWorkflowTask(
      createWorkflowState({ summary: "完成写入失败", tasks: tasks(), executor: "local" }, 100),
      "first",
      110,
    );
    const branch = [{ type: "custom", customType: "pi-init-workflow", data: initial }];
    const harness = createExtensionHarness(branch, {
      cwd: directory,
      trusted: true,
      model: developerModel,
      availableModels: [developerModel],
      appendEntry() {
        if (failAppend) throw new Error("session entry 写入失败");
      },
    });
    await emitExtensionEvent(harness, "session_start");
    await emitExtensionEvent(harness, "agent_start");
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const beforeDispatchCount = harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length;
    failAppend = true;

    await assert.rejects(
      workflow.execute("complete-first", completeParams(harness), undefined, undefined, harness.context),
      /session entry 写入失败/,
    );

    const status = await workflow.execute("status-after-failure", { action: "status" }, undefined, undefined, harness.context);
    assert.equal(status.details.currentTaskId, "first");
    assert.equal(status.details.tasks[0].status, "in_progress");
    assert.equal(status.details.tasks[0].completionSummary, undefined);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, beforeDispatchCount);
    const persisted = harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow").data;
    assert.equal(persisted.currentTaskId, "first");
    assert.equal(persisted.tasks[0].status, "in_progress");
  });
});