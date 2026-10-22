import assert from "node:assert/strict";
import test from "node:test";

import {
  createExtensionHarness,
  emitExtensionEvent,
  mkdir,
  path,
  withTempDirectory,
  workflowMessageIdentity,
  writeFile,
} from "./helpers.js";
import { workflowActionIdentity } from "../src/workflow.ts";

const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
const docs = { provider: "openai-codex", id: "gpt-5.6-docs" };
const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };

async function makeHarness(directory, branch = [], options = {}) {
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  await writeFile(path.join(directory, ".pi", "role-models.json"), `${JSON.stringify({
    schemaVersion: 2,
    mode: "auto",
    workflowMode: "on",
    roleModels: {
      architect: { provider: architect.provider, model: architect.id, thinkingLevel: "max" },
      "docs-commit": { provider: docs.provider, model: docs.id, thinkingLevel: "high" },
      "developer-test": { provider: developer.provider, model: developer.id, thinkingLevel: "max" },
    },
  }, null, 2)}\n`);
  const harness = createExtensionHarness(branch, {
    cwd: directory,
    trusted: true,
    model: architect,
    availableModels: [architect, docs, developer],
    sessionId: "nested-lifecycle-session",
    ...options,
  });
  await emitExtensionEvent(harness, "session_start");
  return harness;
}

function workflowTool(harness) {
  return harness.tools.find((tool) => tool.name === "task_workflow");
}

function execute(harness, params) {
  return workflowTool(harness).execute("nested-lifecycle-test", params, undefined, undefined, harness.context);
}

function latestWorkflow(harness) {
  return harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow")?.data;
}

async function startMessage(harness, customType) {
  const identity = workflowMessageIdentity(harness, customType);
  assert.ok(identity, `expected ${customType} message identity`);
  await emitExtensionEvent(harness, "agent_start");
  await emitExtensionEvent(harness, "message_start", { message: { role: "custom", customType, details: identity } });
  return identity;
}

async function completeCurrentTask(harness, taskId, summary) {
  const identity = await startMessage(harness, "pi-init-workflow-task");
  assert.equal(identity.taskId, taskId);
  await execute(harness, {
    action: "complete",
    ...identity,
    completionSummary: summary,
    implementationRationale: "按当前工作流层级推进，保留父层计划，不重复既有副作用。",
    verification: ["node --test test/workflow-nested-lifecycle.test.js → pass"],
  });
  return identity;
}

test("新目标与原任务共用扁平队列，完成目标分组不等于完成原计划", async () => {
  await withTempDirectory(async directory => {
    const harness = await makeHarness(directory);
    await execute(harness, { action: "plan", summary: "父目标：保持原计划", constraints: ["不能丢失原有成果"], tasks: [
      { id: "parent-first", task: "完成第一项", files: ["src"], acceptanceCriteria: ["已验证"], role: "developer-test" },
      { id: "parent-second", task: "继续第二项", files: ["src"], acceptanceCriteria: ["已验证"], role: "developer-test" },
    ] });
    const rootWorkflowId = latestWorkflow(harness).workflowId;
    await emitExtensionEvent(harness, "agent_settled");
    await emitExtensionEvent(harness, "input", { text: "插入目标：检查新子系统", source: "interactive" });
    assert.equal(latestWorkflow(harness).pendingRevision.kind, "goal");
    assert.equal(latestWorkflow(harness).currentTaskId, "parent-first", "新目标不抢占正在执行的任务");
    await completeCurrentTask(harness, "parent-first", "原第一项已完成");
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.context.model.id, architect.id);
    const identity = workflowMessageIdentity(harness, "pi-init-workflow-replan");
    await execute(harness, { action: "replan", ...identity, summary: "检查新子系统", retainTaskIds: ["parent-second"], tasks: [
      { id: "check-subsystem", task: "检查子系统", files: ["src"], acceptanceCriteria: ["有验证结论"], role: "developer-test", priority: 10 },
    ] });
    const queued = latestWorkflow(harness);
    assert.equal(queued.workflowId, rootWorkflowId);
    assert.equal(queued.plan.summary, "父目标：保持原计划");
    assert.equal(queued.parentStack, undefined);
    assert.equal(queued.tasks.length, 3);
    assert.equal(queued.tasks[0].completionSummary, "原第一项已完成");
    assert.equal(queued.goals[0].parentId, rootWorkflowId);
    assert.equal(queued.tasks[2].goalId, queued.goals[0].id);
    const restarted = await makeHarness(directory, harness.branch.slice());
    assert.equal(latestWorkflow(restarted).workflowId, rootWorkflowId);
    assert.equal(latestWorkflow(restarted).goals[0].id, queued.goals[0].id);
    assert.equal(latestWorkflow(restarted).tasks[0].status, "completed");
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(workflowMessageIdentity(harness, "pi-init-workflow-task").taskId, "check-subsystem");
    const oldGoalAttempt = await completeCurrentTask(harness, "check-subsystem", "新目标任务已验证");
    assert.equal(latestWorkflow(harness).status, "running");
    assert.equal(latestWorkflow(harness).workflowId, rootWorkflowId);
    assert.equal(latestWorkflow(harness).pendingRevision, undefined);
    assert.equal(latestWorkflow(harness).subworkflowHistory, undefined);
    await assert.rejects(execute(harness, { action: "complete", ...oldGoalAttempt, completionSummary: "旧结果", implementationRationale: "不能覆盖新状态", verification: ["旧验证"] }), error => error.code === "WORKFLOW_ACTION_IDENTITY_STALE");
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(workflowMessageIdentity(harness, "pi-init-workflow-task").taskId, "parent-second");
    await completeCurrentTask(harness, "parent-second", "原计划第二项已验证");
    assert.equal(latestWorkflow(harness).status, "completed");
    assert.equal(latestWorkflow(harness).workflowId, rootWorkflowId);
    assert.ok(harness.branch.filter(entry => entry.type === "custom" && entry.customType === "pi-init-workflow").every(entry => !entry.data.parentStack?.length));
  });
});

test("插入目标写入失败保持原队列与请求，重提后仅追加一次", async () => {
  await withTempDirectory(async directory => {
    let fail = false;
    const harness = await makeHarness(directory, [], { appendEntry: (type, data) => { if (fail && type === "pi-init-workflow" && data.goals?.length) throw new Error("goal append failed"); } });
    await execute(harness, { action: "plan", summary: "保留队列", tasks: [{ id: "original", task: "原任务", files: ["src"], acceptanceCriteria: ["已验证"] }] });
    await execute(harness, { action: "request-goal", ...workflowActionIdentity(latestWorkflow(harness)), summary: "临时检查" });
    await emitExtensionEvent(harness, "agent_settled");
    const before = latestWorkflow(harness);
    const params = { action: "replan", ...workflowMessageIdentity(harness, "pi-init-workflow-replan"), summary: "临时检查", retainTaskIds: ["original"], tasks: [{ id: "check", task: "检查", files: ["src"], acceptanceCriteria: ["已验证"] }] };
    fail = true;
    await assert.rejects(execute(harness, params), /goal append failed/);
    assert.equal(latestWorkflow(harness), before);
    assert.equal(before.goals, undefined);
    fail = false;
    await execute(harness, params);
    assert.equal(latestWorkflow(harness).workflowId, before.workflowId);
    assert.equal(latestWorkflow(harness).tasks.length, 2);
    assert.equal(latestWorkflow(harness).goals.length, 1);
    assert.equal(latestWorkflow(harness).parentStack, undefined);
  });
});
