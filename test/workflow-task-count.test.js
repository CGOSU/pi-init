import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { taskWorkflowParameters } from "../extensions/contracts.ts";
import * as helpers from "./helpers.js";

const {
  applyWorkflowReplan,
  completeWorkflowTask,
  createExtensionHarness,
  createWorkflowState,
  emitExtensionEvent,
  hydrateWorkflowState,
  markWorkflowTaskStarted,
  mkdir,
  path,
  requestWorkflowReplan,
  startWorkflowTask,
  validateWorkflowPlan,
  withTempDirectory,
  writeFile,
} = helpers;

const architectModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
const developerModel = { provider: "openai-codex", id: "gpt-5.6-luna" };

function manyTasks(count, prefix = "task") {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    task: `任务 ${index}`,
    files: [`src/${prefix}-${index}.js`],
    acceptanceCriteria: ["完成"],
  }));
}

function createPlanTasks(count, prefix = "task") {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    task: `任务 ${index}`,
    files: [`src/${prefix}-${index}.js`],
    acceptanceCriteria: ["完成"],
    dependsOn: index === 0 ? [] : [`${prefix}-${index - 1}`],
  }));
}

async function writeWorkflowConfig(directory, workflowMode = "on") {
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  await writeFile(
    path.join(directory, ".pi", "role-models.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      mode: "auto",
      workflowMode,
      workflowExecutor: "local",
      roleModels: {
        architect: { provider: architectModel.provider, model: architectModel.id, thinkingLevel: "max" },
        "developer-test": { provider: developerModel.provider, model: developerModel.id, thinkingLevel: "max" },
      },
    }, null, 2)}\n`,
  );
}

async function planThroughTool(directory, planParams = {}) {
  await writeWorkflowConfig(directory);
  const harness = createExtensionHarness([], {
    cwd: directory,
    trusted: true,
    model: architectModel,
    availableModels: [architectModel, developerModel],
  });
  await emitExtensionEvent(harness, "session_start");
  const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
  await switchRole.execute("architect", { role: "architect" }, undefined, undefined, harness.context);
  const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
  return { harness, workflow };
}

test("初始规划接受超过 12 个任务并保留依赖顺序", () => {
  const tasks = createPlanTasks(15);
  const plan = validateWorkflowPlan({ summary: "规模超过建议上限", tasks });

  assert.equal(plan.tasks.length, 15);
  assert.deepEqual(plan.tasks.at(-1).dependsOn, ["task-13"]);
  assert.deepEqual(createWorkflowState({ summary: "规模超过建议上限", tasks }).tasks.map((task) => task.id), tasks.map((task) => task.id));
});

test("工具 schema 接受超过 12 个任务且不设数量上限", () => {
  const schema = taskWorkflowParameters.properties.tasks;
  assert.equal(schema.maxItems, undefined);
  assert.equal(schema.minItems, 0, "普通 replan 可仅保留/撤销任务；plan 与目标插入仍由运行时要求非空");

  const params = {
    action: "plan",
    summary: "工具入口规模",
    tasks: createPlanTasks(14),
  };
  assert.equal(Check(taskWorkflowParameters, params), true);
  assert.equal(Check(taskWorkflowParameters, { ...params, action: "replan", tasks: [] }), true);
  assert.throws(() => createWorkflowState({ ...params, tasks: [] }), /至少需要一个任务/);
  assert.equal(
    Check(taskWorkflowParameters, { ...params, tasks: [{ id: "task-0", task: "任务 0", files: ["src/task-0.js"] }] }),
    false,
  );
});

test("工具入口接受超过 12 个任务的真实规划", async () => {
  await withTempDirectory(async (directory) => {
    const { harness, workflow } = await planThroughTool(directory);
    const tasks = createPlanTasks(14);
    const result = await workflow.execute("plan", {
      action: "plan",
      summary: "工具入口规模",
      tasks,
      reviewRequired: true,
    }, undefined, undefined, harness.context);

    assert.equal(result.details.tasks.length, 14);
    assert.equal(result.details.currentTaskId, undefined);
    const persisted = harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow").data;
    assert.equal(persisted.tasks.length, 14);
  });
});

test("单次新增超过 12 个任务且总数超过 12 的重规划可应用并保留已完成结果", () => {
  const planned = manyTasks(13);
  const state = createWorkflowState({ summary: "重规划规模", tasks: planned }, 100);
  const firstCompleted = completeWorkflowTask(
    markWorkflowTaskStarted(startWorkflowTask(state, "task-0"), "task-0"),
    {
      taskId: "task-0",
      completionSummary: "完成首个任务",
      implementationRationale: "保留真实完成结果与验证",
      verification: ["node --test test/workflow-core.test.js"],
    },
    110,
  );
  const requested = requestWorkflowReplan(firstCompleted, { revisionId: "revision-scale", direction: "继续扩张" }, 120);
  const added = createPlanTasks(14, "extra");

  const applied = applyWorkflowReplan(requested, {
    revisionId: "revision-scale",
    summary: "新增超过 12 个任务",
    retainTaskIds: planned.slice(1).map((task) => task.id),
    tasks: added,
  }, 130);

  const completed = applied.tasks.find((task) => task.id === "task-0");
  assert.equal(completed.status, "completed");
  assert.equal(completed.completionSummary, "完成首个任务");
  assert.equal(completed.implementationRationale, "保留真实完成结果与验证");
  assert.deepEqual(completed.verification, ["node --test test/workflow-core.test.js"]);
  assert.equal(applied.tasks.filter((task) => task.status === "pending").length, 26);
  assert.equal(applied.tasks.length, 27);
  assert.equal(applied.planVersion, 1);
  assert.deepEqual(applied.revisions.at(-1).addedTaskIds, added.map((task) => task.id));
  assert.deepEqual(applied.revisions.at(-1).retainedTaskIds, planned.slice(1).map((task) => task.id));
});

test("重规划可以只保留未开始任务并让活动任务总数超过 12", () => {
  const state = createWorkflowState({ summary: "仅新增", tasks: manyTasks(13) }, 100);
  const requested = requestWorkflowReplan(state, { revisionId: "revision-growth", direction: "扩张" }, 110);
  const added = createPlanTasks(13, "extra");

  const applied = applyWorkflowReplan(requested, {
    revisionId: "revision-growth",
    summary: "新增一批任务",
    tasks: added,
  }, 120);

  assert.equal(applied.tasks.length, 13);
  assert.equal(applied.status, "running");
  assert.equal(applied.revisions.at(-1).replacedTaskIds.length, 13);
});

test("超过 12 个任务的状态可以保存恢复且版本和任务契约不变", () => {
  const tasks = createPlanTasks(16);
  const state = createWorkflowState({ summary: "恢复规模", tasks, executor: "local" }, 100);
  const restored = hydrateWorkflowState(JSON.parse(JSON.stringify(state)));

  assert.equal(restored.ok, true);
  assert.equal(restored.value.version, state.version);
  assert.equal(restored.value.tasks.length, 16);
  assert.deepEqual(restored.value.tasks.at(-1).dependsOn, tasks.at(-1).dependsOn);
});

test("超过 12 个任务的非法输入与身份、角色拒绝不被放宽", () => {
  assert.throws(
    () => validateWorkflowPlan({ summary: "空", tasks: [] }),
    /至少需要一个任务/,
  );
  assert.throws(
    () => validateWorkflowPlan({ summary: "重复", tasks: [...createPlanTasks(13), createPlanTasks(13)[0]] }),
    /id 重复/,
  );
  assert.throws(
    () => validateWorkflowPlan({
      summary: "悬空依赖",
      tasks: [...createPlanTasks(13), { id: "extra", task: "额外", files: ["src/extra.js"], acceptanceCriteria: ["完成"], dependsOn: ["missing"] }],
    }),
    /不存在的任务/,
  );
  assert.throws(
    () => validateWorkflowPlan({
      summary: "architect 执行",
      tasks: [...createPlanTasks(13), { id: "extra", role: "architect", task: "额外", files: ["src/extra.js"], acceptanceCriteria: ["完成"] }],
    }),
    { code: "WORKFLOW_EXECUTION_ROLE_FORBIDDEN" },
  );
});

test("超过 12 个任务时重规划仍拒绝复用历史 ID 并保留未提交身份校验", async () => {
  const planned = [...manyTasks(13), { id: "done", task: "已完成", files: ["src/done.js"], acceptanceCriteria: ["完成"] }];
  const completedState = completeWorkflowTask(
    markWorkflowTaskStarted(startWorkflowTask(createWorkflowState({ summary: "复用历史 ID", tasks: planned }, 100), "task-0"), "task-0"),
    { taskId: "task-0", completionSummary: "完成", implementationRationale: "保留历史 ID 校验", verification: ["通过"] },
    110,
  );
  const requested = requestWorkflowReplan(completedState, { revisionId: "revision-reuse", direction: "复用" }, 120);
  assert.throws(
    () => applyWorkflowReplan(requested, {
      revisionId: "revision-reuse",
      summary: "复用",
      tasks: [{ id: "task-1", task: "复用", files: ["src/reuse.js"], acceptanceCriteria: ["完成"] }],
    }),
    /不能复用历史任务 ID/,
  );

  await withTempDirectory(async (directory) => {
    await writeWorkflowConfig(directory);
    const state = startWorkflowTask(createWorkflowState({ summary: "身份", tasks: manyTasks(13), sessionId: "test-session", executor: "local" }, 100), "task-0", 110);
    const harness = createExtensionHarness([{ type: "custom", customType: "pi-init-workflow", data: state }], {
      cwd: directory,
      trusted: true,
      sessionId: "test-session",
      model: developerModel,
      availableModels: [architectModel, developerModel],
    });
    await emitExtensionEvent(harness, "session_start");
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    await assert.rejects(
      workflow.execute("complete-without-identity", {
        action: "complete",
        taskId: "task-0",
        completionSummary: "完成",
        implementationRationale: "身份校验不被放宽",
        verification: ["通过"],
      }, undefined, undefined, harness.context),
      /WORKFLOW_ACTION_IDENTITY_MISSING/,
    );
    const latest = harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow").data;
    assert.equal(latest.tasks.length, 13);
    assert.equal(latest.tasks[0].status, "in_progress");
  });
});
