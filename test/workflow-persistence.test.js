import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";
import { createWorkflowReport } from "../extensions/workflow-report.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";

const { createExtensionHarness, createWorkflowState, emitExtensionEvent, markWorkflowTaskStarted, startWorkflowTask, withTempDirectory, mkdir, path, writeFile } = helpers;

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

function completeParams() {
  return {
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

test("完成状态写入失败不返回成功或派发后续任务", async () => {
  await withTempDirectory(async (directory) => {
    await writeWorkflowConfig(directory);
    let failAppend = false;
    const initial = markWorkflowTaskStarted(
      startWorkflowTask(createWorkflowState({ summary: "完成写入失败", tasks: tasks(), executor: "local" }, 100), "first", 110),
      "first",
      111,
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
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const beforeDispatchCount = harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length;
    failAppend = true;

    await assert.rejects(
      workflow.execute("complete-first", completeParams(), undefined, undefined, harness.context),
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