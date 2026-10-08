import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";

const {
  createExtensionHarness,
  createWorkflowState,
  emitExtensionEvent,
  workflowMessageIdentity,
  startWorkflowTask,
  markWorkflowTaskStarted,
  withTempDirectory,
  mkdir,
  path,
  writeFile,
} = helpers;

const developerModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
const architectModel = { provider: "openai-codex", id: "gpt-5.6-sol" };

function tasks() {
  return [{ id: "first", task: "执行第一项", files: ["src/first.js"], acceptanceCriteria: ["完成"] }];
}

async function writeConfig(directory, role = "developer-test", model = developerModel) {
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  await writeFile(path.join(directory, ".pi", "role-models.json"), `${JSON.stringify({
    schemaVersion: 2,
    mode: "auto",
    workflowMode: "on",
    roleModels: { [role]: { provider: model.provider, model: model.id, thinkingLevel: "max" } },
  }, null, 2)}\n`);
}

async function taskHarness(directory, { state, sessionId = "test-session", model = developerModel, role = "developer-test", appendEntry } = {}) {
  await writeConfig(directory, role, model);
  const initial = state ?? createWorkflowState({ summary: "attempt identity", tasks: tasks() }, 100);
  const harness = createExtensionHarness([
    { type: "custom", customType: "pi-init-workflow", data: initial },
  ], {
    cwd: directory,
    trusted: true,
    sessionId,
    appendEntry,
    model,
    availableModels: [developerModel, architectModel],
  });
  await emitExtensionEvent(harness, "session_start");
  return harness;
}

function completeParams(identity) {
  return {
    ...identity,
    action: "complete",
    taskId: "first",
    completionSummary: "第一项完成",
    implementationRationale: "按当前 attempt 验收",
    verification: ["node --test 通过"],
  };
}

test("complete 必须匹配当前 handoff，重复或缺少身份的结果不能推进状态", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await taskHarness(directory);
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const identity = workflowMessageIdentity(harness);
    await emitExtensionEvent(harness, "agent_start");

    await assert.rejects(
      workflow.execute("missing-identity", { ...completeParams(identity), handoffId: undefined }, undefined, undefined, harness.context),
      { code: "WORKFLOW_ACTION_IDENTITY_MISSING" },
    );
    const completed = await workflow.execute("complete", completeParams(identity), undefined, undefined, harness.context);
    assert.equal(completed.details.status, "completed");
    assert.equal(completed.details.recoveryGeneration, identity.recoveryGeneration + 1);
    await assert.rejects(
      workflow.execute("duplicate-complete", completeParams(identity), undefined, undefined, harness.context),
      { code: "WORKFLOW_ACTION_IDENTITY_STALE" },
    );
  });
});

test("恢复已排队/已启动的任务转为未知结果，旧回调被隔离且 retry 要显式确认", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await taskHarness(directory);
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const oldIdentity = workflowMessageIdentity(harness);
    await emitExtensionEvent(harness, "agent_start");

    await emitExtensionEvent(harness, "session_tree");
    const restored = harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow").data;
    assert.equal(restored.status, "paused");
    assert.equal(restored.pauseReason, "handoff-outcome-unknown");
    assert.equal(restored.tasks[0].outcomeUnknown, true);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1);
    await assert.rejects(
      workflow.execute("late-old-result", completeParams(oldIdentity), undefined, undefined, harness.context),
      { code: "WORKFLOW_ACTION_IDENTITY_STALE" },
    );

    const command = harness.commands.get("pi-init");
    await command.handler("workflow retry first", harness.context);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1);
    assert.equal(harness.notifications.some(({ message }) => message.includes("核对外部副作用")), true);

    await command.handler("workflow retry first --confirm-unknown-outcome", harness.context);
    const messages = harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task");
    assert.equal(messages.length, 2);
    const nextIdentity = messages.at(-1).message.details;
    assert.notEqual(nextIdentity.attemptId, oldIdentity.attemptId);
    assert.notEqual(nextIdentity.handoffId, oldIdentity.handoffId);
    assert.notEqual(nextIdentity.recoveryGeneration, oldIdentity.recoveryGeneration);
  });
});

test("执行时间戳优先于损坏的 prepared 阶段，恢复不会重放已有启动证据的 attempt", async () => {
  await withTempDirectory(async (directory) => {
    const prepared = createWorkflowState({ summary: "启动证据", tasks: tasks() }, 100);
    const executed = markWorkflowTaskStarted(startWorkflowTask(prepared, "first", 110), "first", 120);
    const inconsistent = { ...executed, handoff: { ...executed.handoff, phase: "prepared" } };
    const harness = await taskHarness(directory, { state: inconsistent });
    const restored = harness.entries.findLast((entry) => entry.type === "pi-init-workflow").data;
    assert.equal(restored.status, "paused");
    assert.equal(restored.tasks[0].outcomeUnknown, true);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 0);
  });
});

test("排队状态持久化失败时按未知结果暂停，不能以普通 block 方式免确认重试", async () => {
  await withTempDirectory(async (directory) => {
    let failedQueuedWrite = false;
    const harness = await taskHarness(directory, {
      appendEntry(type, data) {
        if (!failedQueuedWrite && type === "pi-init-workflow" && data.handoff?.phase === "queued") {
          failedQueuedWrite = true;
          throw new Error("排队状态写入失败");
        }
      },
    });
    const state = harness.entries.findLast((entry) => entry.type === "pi-init-workflow").data;
    assert.equal(state.status, "paused");
    assert.equal(state.pauseReason, "handoff-outcome-unknown");
    assert.equal(state.tasks[0].outcomeUnknown, true);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1);

    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1);
    await harness.commands.get("pi-init").handler("workflow retry first", harness.context);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1);
    assert.equal(harness.notifications.some(({ message }) => message.includes("执行结果未知")), true);
  });
});

test("legacy local in_progress 状态只迁移为需核对暂停，不自动重放且不改旧 entry", async () => {
  await withTempDirectory(async (directory) => {
    const legacy = {
      version: 3,
      executor: "local",
      status: "running",
      plan: { summary: "旧任务", constraints: [] },
      tasks: [{
        id: "first",
        task: "可能已执行的旧任务",
        role: "developer-test",
        files: ["src/first.js"],
        acceptanceCriteria: ["完成"],
        dependsOn: [],
        status: "in_progress",
        executionStartedAt: 120,
      }],
      currentTaskId: "first",
      nudgeCount: 0,
      revisions: [],
      createdAt: 100,
      updatedAt: 120,
    };
    const original = JSON.stringify(legacy);
    const harness = await taskHarness(directory, { state: legacy });
    const migrated = harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow").data;
    assert.equal(migrated.tasks[0].status, "blocked");
    assert.equal(migrated.tasks[0].outcomeUnknown, true);
    assert.equal(migrated.status, "paused");
    assert.equal(harness.branch[0].data, legacy);
    assert.equal(JSON.stringify(harness.branch[0].data), original);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 0);
  });
});

test("forked session 的旧 workflow 状态 fail-closed", async () => {
  await withTempDirectory(async (directory) => {
    const state = createWorkflowState({ summary: "fork guard", tasks: tasks(), sessionId: "original-session" }, 100);
    const harness = await taskHarness(directory, {
      state,
      sessionId: "forked-session",
      model: architectModel,
      role: "architect",
    });
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const status = await workflow.execute("status", { action: "status" }, undefined, undefined, harness.context);
    assert.equal(status.details.error.code, "WORKFLOW_SESSION_MISMATCH");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 0);
    assert.equal(harness.branch.length, 1);

    const newPlan = await workflow.execute("new-fork-plan", {
      action: "plan",
      summary: "当前 session 的新工作流",
      tasks: [{ id: "new-task", task: "新的安全任务", files: ["src/new.js"], acceptanceCriteria: ["完成"] }],
    }, undefined, undefined, harness.context);
    assert.equal(newPlan.details.sessionId, "forked-session");
    assert.notEqual(newPlan.details.workflowId, state.workflowId);
    await assert.rejects(
      workflow.execute("old-session-result", {
        workflowId: state.workflowId,
        planVersion: state.planVersion,
        sessionId: state.sessionId,
        recoveryGeneration: state.recoveryGeneration,
        taskId: "first",
        attemptId: "old-attempt",
        handoffId: "old-handoff",
        ...completeParams({}),
      }, undefined, undefined, harness.context),
      { code: "WORKFLOW_SESSION_MISMATCH" },
    );
  });
});

test("新用户方向使旧 revision handoff 失效，只有最新身份能应用计划", async () => {
  await withTempDirectory(async (directory) => {
    const initial = createWorkflowState({ summary: "待重规划", tasks: tasks() }, 100);
    const { requestWorkflowReplan } = helpers;
    const replanning = requestWorkflowReplan(initial, { revisionId: "revision-1", direction: "第一条方向" }, 110);
    const harness = await taskHarness(directory, { state: replanning, model: architectModel, role: "architect" });
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const oldIdentity = workflowMessageIdentity(harness, "pi-init-workflow-replan");
    const params = {
      ...oldIdentity,
      action: "replan",
      revisionId: "revision-1",
      summary: "新计划",
      tasks: [{ id: "replacement", task: "新任务", files: ["src/new.js"], acceptanceCriteria: ["完成"] }],
    };

    await emitExtensionEvent(harness, "input", { source: "interactive", text: "追加第二条方向" });
    await assert.rejects(
      workflow.execute("stale-replan", params, undefined, undefined, harness.context),
      { code: "WORKFLOW_ACTION_IDENTITY_STALE" },
    );
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-replan").length, 2);
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-replan").length, 2);
    const currentIdentity = workflowMessageIdentity(harness, "pi-init-workflow-replan");
    const applied = await workflow.execute("current-replan", {
      ...params,
      ...currentIdentity,
    }, undefined, undefined, harness.context);
    assert.equal(applied.details.planVersion, 1);
    assert.equal(applied.details.plan.summary, "新计划");
    await assert.rejects(
      workflow.execute("duplicate-replan", params, undefined, undefined, harness.context),
      /没有等待应用的工作流重规划/,
    );
  });
});
