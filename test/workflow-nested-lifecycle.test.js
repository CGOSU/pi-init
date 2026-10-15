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

const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
const docs = { provider: "openai-codex", id: "gpt-5.6-docs" };
const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };

async function makeHarness(directory, branch = []) {
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

test("新目标创建独立子工作流，完成后恢复父层并继续原后续任务", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    await execute(harness, {
      action: "plan",
      summary: "父目标：维护原工作流进度",
      constraints: ["新目标作为子工作流执行，不覆盖父计划"],
      tasks: [
        { id: "parent-first", task: "完成父层第一项", files: ["src/parent-first.ts"], acceptanceCriteria: ["第一项完成"], role: "developer-test" },
        { id: "parent-second", task: "继续父层第二项", files: ["src/parent-second.ts"], acceptanceCriteria: ["第二项完成"], role: "developer-test" },
      ],
    });
    const rootWorkflowId = latestWorkflow(harness).workflowId;

    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.context.model.id, developer.id);
    const taskIdentity = workflowMessageIdentity(harness, "pi-init-workflow-task");
    assert.equal(taskIdentity.taskId, "parent-first");
    let inputResult;
    for (const handler of harness.handlers.get("input") ?? []) {
      inputResult = await handler({ text: "子流程：检查新的子系统", source: "interactive" }, harness.context) ?? inputResult;
    }
    assert.equal(inputResult?.action, "handled");
    assert.equal(latestWorkflow(harness).pendingRevision.kind, "nested");
    assert.equal(latestWorkflow(harness).pendingRevision.requestedFromTaskId, "parent-first");

    await completeCurrentTask(harness, "parent-first", "父层第一项完成");
    assert.equal(latestWorkflow(harness).status, "replanning");
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.context.model.id, architect.id);
    const replanIdentity = workflowMessageIdentity(harness, "pi-init-workflow-replan");
    assert.ok(replanIdentity);
    await execute(harness, {
      action: "replan",
      ...replanIdentity,
      revisionId: latestWorkflow(harness).pendingRevision.revisionId,
      summary: "子目标：检查新子系统",
      subworkflowContract: { inputs: ["父目标"], expectedOutputs: ["新子系统检查完成"], acceptanceCriteria: ["检查结果明确"], allowedFiles: ["src"] },
      constraints: ["子工作流完成后返回父工作流"],
      tasks: [{
        id: "child-check",
        task: "检查新子系统",
        files: ["src/new-subsystem.ts"],
        acceptanceCriteria: ["检查结果明确"],
        role: "developer-test",
      }],
    });
    const childState = latestWorkflow(harness);
    assert.notEqual(childState.workflowId, rootWorkflowId);
    assert.equal(childState.parentStack.at(-1).state.workflowId, rootWorkflowId);
    assert.equal(childState.parentStack.at(-1).state.tasks.find(({ id }) => id === "parent-first").status, "completed");

    const reloadedHarness = await makeHarness(directory, harness.branch.slice());
    const recoveredChild = latestWorkflow(reloadedHarness);
    assert.equal(recoveredChild.workflowId, childState.workflowId);
    assert.equal(recoveredChild.planVersion, childState.planVersion);
    assert.equal(recoveredChild.parentStack.at(-1).state.workflowId, rootWorkflowId);
    assert.deepEqual(recoveredChild.parentStack.at(-1).state.tasks.map(({ id, status }) => ({ id, status })), [
      { id: "parent-first", status: "completed" },
      { id: "parent-second", status: "pending" },
    ]);

    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.context.model.id, developer.id);
    const childIdentity = await completeCurrentTask(harness, "child-check", "新子系统检查完成");

    const returnedParent = latestWorkflow(harness);
    assert.equal(returnedParent.workflowId, rootWorkflowId);
    assert.equal(returnedParent.plan.summary, "父目标：维护原工作流进度");
    assert.equal(returnedParent.planVersion, 0);
    assert.equal(returnedParent.status, "replanning");
    assert.equal(returnedParent.pauseReason, "child-result-review");
    assert.deepEqual(returnedParent.tasks.map(({ id, status }) => ({ id, status })), [
      { id: "parent-first", status: "completed" },
      { id: "parent-second", status: "pending" },
    ]);
    assert.equal(returnedParent.subworkflowHistory[0].workflowId, childState.workflowId);
    assert.equal(returnedParent.subworkflowHistory[0].parentTaskId, "parent-first");
    assert.equal(returnedParent.subworkflowHistory[0].status, "completed");
    await assert.rejects(execute(harness, {
      action: "complete",
      ...childIdentity,
      completionSummary: "迟到的子工作流结果",
      implementationRationale: "该 attempt 已结束",
      verification: ["not replayed"],
    }), (error) => error.code === "WORKFLOW_ACTION_IDENTITY_STALE");
    assert.equal(latestWorkflow(harness).workflowId, rootWorkflowId);

    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.context.model.id, architect.id);
    const reviewIdentity = workflowMessageIdentity(harness, "pi-init-workflow-replan");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task" && message.details.workflowId === rootWorkflowId && message.details.taskId === "parent-second").length, 0);
    await assert.rejects(execute(harness, { action: "replan", ...reviewIdentity, summary: "跳过结果验收", retainTaskIds: ["parent-second"], tasks: [{ id: "bypass", task: "绕过验收", role: "developer-test", files: ["src"], acceptanceCriteria: ["完成"] }] }), /必须先 review-child/);
    await execute(harness, { action: "review-child", ...reviewIdentity, childReview: { childWorkflowId: childState.workflowId, decision: "continue", parentPlanValid: true, reason: "子目标输出已验证，未改变父层第二项依赖", acceptedOutputs: ["新子系统检查完成"], verification: ["已核对输出、父计划与依赖"] } });
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(workflowMessageIdentity(harness, "pi-init-workflow-task").taskId, "parent-second");
    assert.equal(latestWorkflow(harness).workflowId, rootWorkflowId);
  });
});
