import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelWorkflow,
  completeWorkflowTask,
  createWorkflowState,
  hydrateWorkflowState,
  markWorkflowTaskStarted,
  requestWorkflowNestedGoal,
  recoverWorkflowState,
  setWorkflowHandoffPhase,
  startWorkflowTask,
} from "../src/workflow.ts";
import { createNestedWorkflowState, returnFromNestedWorkflow } from "../src/workflow-nesting.ts";

function plan(summary, taskId) {
  return {
    summary,
    subworkflowContract: { inputs: ["需求"], expectedOutputs: ["检查结论"], acceptanceCriteria: ["验证通过"], allowedFiles: ["src"] },
    constraints: ["仅在当前层执行，完成后按 parentStack 返回"],
    tasks: [{
      id: taskId,
      task: `${summary} 的工作任务`,
      role: "developer-test",
      files: [`src/${taskId}.ts`],
      acceptanceCriteria: [`${summary} 达成`],
    }],
  };
}

function completeOnlyTask(state, taskId, now) {
  const started = startWorkflowTask(state, taskId, now);
  const executing = setWorkflowHandoffPhase(started, "executing", now + 1);
  const taskStarted = markWorkflowTaskStarted(executing, taskId, now + 1);
  return completeWorkflowTask(taskStarted, {
    taskId,
    completionSummary: `${taskId} 完成`,
    implementationRationale: "按当前层目标执行，不重放父层任务。",
    verification: ["node --test test/workflow-nesting.test.js → pass"],
  }, now + 2);
}

test("子工作流独立持久化；完成后按身份和父层位置恢复，递归层级可重新 hydration", () => {
  const root = createWorkflowState({ ...plan("父工作流", "root-task"), sessionId: "nested-session" }, 100);
  const rootRequest = requestWorkflowNestedGoal(root, { direction: "先完成独立的子目标" }, 101);
  const child = createNestedWorkflowState(rootRequest, plan("子工作流", "child-task"), 102);

  assert.notEqual(child.workflowId, root.workflowId);
  assert.equal(child.plan.summary, "子工作流");
  assert.equal(child.parentStack.length, 1);
  assert.equal(child.parentStack[0].state.workflowId, root.workflowId);
  assert.equal(child.parentStack[0].state.status, "paused");
  assert.equal(child.parentStack[0].state.pauseReason, "waiting-child-workflow");
  assert.equal(child.parentStack[0].state.plan.summary, root.plan.summary);
  assert.equal(child.parentStack[0].state.revisions[0].status, "applied");
  assert.equal(child.parentStack[0].state.pendingRevision, undefined);

  const hydratedChild = hydrateWorkflowState(JSON.parse(JSON.stringify(child)));
  assert.equal(hydratedChild.ok, true, hydratedChild.message);
  assert.equal(hydratedChild.value.parentStack.length, 1);

  const childCompleted = completeOnlyTask(child, "child-task", 110);
  assert.equal(childCompleted.status, "completed");
  const resumedRoot = returnFromNestedWorkflow(childCompleted, "completed", 120);
  assert.ok(resumedRoot);
  assert.equal(resumedRoot.workflowId, root.workflowId);
  assert.equal(resumedRoot.planVersion, root.planVersion);
  assert.equal(resumedRoot.status, "replanning");
  assert.equal(resumedRoot.pauseReason, "child-result-review");
  assert.equal(resumedRoot.tasks[0].status, "pending");
  assert.equal(resumedRoot.continuation.reason, "replan-requested");
  assert.deepEqual(resumedRoot.subworkflowHistory.map(({ workflowId, parentWorkflowId, status }) => ({ workflowId, parentWorkflowId, status })), [
    { workflowId: child.workflowId, parentWorkflowId: root.workflowId, status: "completed" },
  ]);
  const hydratedRoot = hydrateWorkflowState(JSON.parse(JSON.stringify(resumedRoot)));
  assert.equal(hydratedRoot.ok, true, hydratedRoot.message);
});

test("nested task 的 executing 结果未知时恢复保留父层并 fail-closed，不自动重放", () => {
  const root = createWorkflowState({ ...plan("父工作流", "root-task"), sessionId: "unknown-nested-session" }, 150);
  const child = createNestedWorkflowState(
    requestWorkflowNestedGoal(root, { direction: "执行子目标" }, 151),
    plan("子工作流", "child-task"),
    152,
  );
  const started = startWorkflowTask(child, "child-task", 153);
  const executing = setWorkflowHandoffPhase(started, "executing", 154);
  const taskStarted = markWorkflowTaskStarted(executing, "child-task", 154);
  const recovered = recoverWorkflowState(taskStarted, "unknown-nested-session");
  assert.equal(recovered.ok, true, recovered.message);
  assert.equal(recovered.value.status, "paused");
  assert.equal(recovered.value.pauseReason, "handoff-outcome-unknown");
  assert.equal(recovered.value.currentTaskId, undefined);
  assert.equal(recovered.value.tasks[0].status, "blocked");
  assert.equal(recovered.value.tasks[0].outcomeUnknown, true);
  assert.equal(recovered.value.parentStack[0].state.workflowId, root.workflowId);
  const restored = hydrateWorkflowState(JSON.parse(JSON.stringify(recovered.value)));
  assert.equal(restored.ok, true, restored.message);
  assert.equal(restored.value.parentStack[0].state.workflowId, root.workflowId);
});

test("拒绝新建递归子流程，但保留旧多层状态的恢复与取消记录", () => {
  const root = createWorkflowState({ ...plan("父工作流", "root-task"), sessionId: "recursive-session" }, 200);
  const child = createNestedWorkflowState(requestWorkflowNestedGoal(root, { direction: "创建 child" }, 201), plan("子工作流", "child-task"), 202);
  assert.throws(() => requestWorkflowNestedGoal(child, { direction: "创建 grandchild" }, 203), { code: "WORKFLOW_NESTED_DEPTH_LIMIT" });
  const grandchild = createWorkflowState({ ...plan("历史孙工作流", "grandchild-task"), sessionId: child.sessionId }, 204);
  const { parentStack, ...core } = child;
  core.status = "paused";
  core.pauseReason = "waiting-child-workflow";
  delete core.continuation;
  grandchild.parentStack = [...parentStack, { state: core }];
  const restored = hydrateWorkflowState(JSON.parse(JSON.stringify(grandchild)));
  assert.equal(restored.ok, true, restored.message);
  assert.equal(restored.value.parentStack.length, 2);
  const resumedChild = returnFromNestedWorkflow(cancelWorkflow(grandchild, 210), "cancelled", 211);
  assert.equal(resumedChild.workflowId, child.workflowId);
  assert.equal(resumedChild.status, "replanning");
  assert.equal(resumedChild.parentStack.length, 1);
  assert.equal(resumedChild.subworkflowHistory[0].status, "cancelled");
  const hydrated = hydrateWorkflowState(JSON.parse(JSON.stringify(resumedChild)));
  assert.equal(hydrated.ok, true, hydrated.message);
});
