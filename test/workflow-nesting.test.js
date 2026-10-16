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
import { formatWorkflowGoalTreeText, formatWorkflowStatusDetailsText, formatWorkflowStatusPanelSummary, formatWorkflowStatusSummaryText, formatWorkflowStatusText } from "../extensions/workflow-status-renderer.ts";
import { createWorkflowStatusView } from "../extensions/workflow-status-view.ts";
import { reviewReturnedSubworkflow } from "../src/workflow-subworkflow.ts";

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
const contract = { inputs: ["需求"], expectedOutputs: ["检查结论"], acceptanceCriteria: ["验证通过"], allowedFiles: ["src"] };


const runtime = {
  workflowRestoreError: undefined,
  roleCompactionPhase: undefined,
  pendingRoleCompaction: undefined,
  workflowDispatchInFlight: false,
};

function task(id) {
  return { id, task: `执行 ${id}`, role: "developer-test", files: [`src/${id}.ts`], acceptanceCriteria: [`完成 ${id}`] };
}

test("工作流视图显示当前嵌套路径，并在返回父层后呈现真实子流程历史", () => {
  let parent = createWorkflowState({ summary: "父层计划", sessionId: "nested-view-session", tasks: [task("parent-a"), task("parent-b")] }, 10);
  const started = startWorkflowTask(parent, "parent-a", 11);
  const executing = setWorkflowHandoffPhase(started, "executing", 12);
  const taskStarted = markWorkflowTaskStarted(executing, "parent-a", 12);
  const waitingForChild = requestWorkflowNestedGoal(taskStarted, { direction: "检查新目标" }, 13);
  parent = completeWorkflowTask(waitingForChild, {
    taskId: "parent-a",
    completionSummary: "父层第一项已完成",
    implementationRationale: "在安全任务边界启动子目标。",
    verification: ["node --test test/workflow-nesting.test.js → pass"],
  }, 14);
  const child = createNestedWorkflowState(parent, {
    summary: "独立子层计划", subworkflowContract: contract,
    constraints: [],
    tasks: [task("child-a")],
  }, 15);
  const activeView = createWorkflowStatusView(child, runtime, 16);
  const activeText = formatWorkflowStatusSummaryText(activeView);
  assert.deepEqual(activeView.lineage.map(({ workflowId }) => workflowId), [parent.workflowId, child.workflowId]);
  assert.equal(activeView.lineage[0].parentTaskId, "parent-a");
  assert.match(activeText, /目标：独立子层计划/);
  assert.match(activeText, /正在处理子目标；父工作流暂停等待返回/);
  assert.doesNotMatch(activeText, new RegExp(`${parent.workflowId}|${child.workflowId}|parent-a`));
  const activeDetails = formatWorkflowStatusDetailsText(activeView);
  assert.match(activeDetails, /工作流层级（由外向内）/);
  assert.match(activeDetails, /父任务 parent-a 触发/);
  const panelSummary = formatWorkflowStatusPanelSummary(activeView);
  assert.match(panelSummary, /└── ⏸ 父层计划 · 等待子目标/);
  assert.match(panelSummary, /└── ● 独立子层计划 · 当前 · 等待调度/);
  assert.match(panelSummary, /父层计划[\s\S]*独立子层计划/);
  assert.doesNotMatch(panelSummary, new RegExp(`${parent.workflowId}|${child.workflowId}`));

  const childStarted = startWorkflowTask(child, "child-a", 17);
  const childExecuting = setWorkflowHandoffPhase(childStarted, "executing", 18);
  const childTaskStarted = markWorkflowTaskStarted(childExecuting, "child-a", 18);
  const childCompleted = completeWorkflowTask(childTaskStarted, {
    taskId: "child-a",
    completionSummary: "子层完成",
    implementationRationale: "子目标已完成并记录结果。",
    verification: ["node --test test/workflow-nesting.test.js → pass"],
  }, 19);
  const resumedParent = returnFromNestedWorkflow(childCompleted, "completed", 20);
  const returnedView = createWorkflowStatusView(resumedParent, runtime, 21);
  const returnedText = formatWorkflowStatusSummaryText(returnedView);
  assert.equal(returnedView.lineage.length, 1);
  assert.equal(returnedView.subworkflows[0].status, "completed");
  assert.match(returnedText, /已返回子目标：1 完成，0 取消/);
  assert.doesNotMatch(returnedText, new RegExp(`${child.workflowId}|parent-a`));
  const returnedTree = formatWorkflowGoalTreeText(returnedView);
  assert.match(returnedTree, /└── ✓ 独立子层计划 · 已完成 · 已完成 1\/1/);
  assert.match(returnedTree, /父层计划[\s\S]*子层计划/);
  const acceptedParent = reviewReturnedSubworkflow(resumedParent, { childWorkflowId: child.workflowId, decision: "continue", parentPlanValid: true, reason: "输出满足且父计划有效", acceptedOutputs: contract.expectedOutputs, verification: ["已核对输出与父依赖"] }, 21);
  const cancelledChild = createNestedWorkflowState(requestWorkflowNestedGoal(acceptedParent, { direction: "取消目标分支" }, 21), {
    summary: "取消子层计划", subworkflowContract: contract,
    constraints: [],
    tasks: [task("cancelled-child-a")],
  }, 22);
  const cancelledParent = returnFromNestedWorkflow(cancelWorkflow(cancelledChild, 23), "cancelled", 24);
  const cancelledTree = formatWorkflowGoalTreeText(createWorkflowStatusView(cancelledParent, runtime, 25));
  assert.match(cancelledTree, /└── × 取消子层计划 · 已取消 · 已完成 0\/1/);
  const secondChild = createNestedWorkflowState(requestWorkflowNestedGoal(acceptedParent, { direction: "继续到第二个子目标" }, 21), {
    summary: "第二子层计划", subworkflowContract: contract,
    constraints: [],
    tasks: [task("second-child-a")],
  }, 22);
  assert.throws(() => requestWorkflowNestedGoal(secondChild, { direction: "进一步拆分目标" }, 23), { code: "WORKFLOW_NESTED_DEPTH_LIMIT" });
  const grandchild = createWorkflowState({ summary: "孙层计划", sessionId: secondChild.sessionId, tasks: [task("grandchild-a")] }, 24);
  const { parentStack, ...core } = secondChild;
  core.status = "paused"; core.pauseReason = "waiting-child-workflow"; delete core.continuation;
  grandchild.parentStack = [...parentStack, { state: core }];
  const deepTree = formatWorkflowGoalTreeText(createWorkflowStatusView(grandchild, runtime, 25));
  const rootIndex = deepTree.indexOf("父层计划");
  const returnedChildIndex = deepTree.indexOf("子层计划");
  const secondChildIndex = deepTree.indexOf("第二子层计划");
  const grandchildIndex = deepTree.indexOf("孙层计划");
  assert.ok(rootIndex >= 0 && rootIndex < returnedChildIndex && returnedChildIndex < secondChildIndex && secondChildIndex < grandchildIndex);
  assert.match(deepTree, /├── ✓ 独立子层计划/);
  assert.match(deepTree, /└── ⏸ 第二子层计划[\s\S]*└── ● 孙层计划/);
  const returnedDetails = formatWorkflowStatusDetailsText(returnedView);
  assert.match(returnedDetails, /已返回的子工作流历史（保留真实终态）/);
  assert.match(returnedDetails, new RegExp(child.workflowId));
  assert.match(returnedDetails, /父任务 parent-a/);
});
