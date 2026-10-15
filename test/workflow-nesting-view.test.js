import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelWorkflow,
  completeWorkflowTask,
  createWorkflowState,
  markWorkflowTaskStarted,
  requestWorkflowNestedGoal,
  setWorkflowHandoffPhase,
  startWorkflowTask,
} from "../src/workflow.ts";
import { createNestedWorkflowState, returnFromNestedWorkflow } from "../src/workflow-nesting.ts";
import {
  formatWorkflowGoalTreeText,
  formatWorkflowStatusDetailsText,
  formatWorkflowStatusPanelSummary,
  formatWorkflowStatusSummaryText,
  formatWorkflowStatusText,
} from "../extensions/workflow-status-renderer.ts";
import { createWorkflowStatusView } from "../extensions/workflow-status-view.ts";
import { reviewReturnedSubworkflow } from "../src/workflow-subworkflow.ts";
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
    verification: ["node --test test/workflow-nesting-view.test.js → pass"],
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
    verification: ["node --test test/workflow-nesting-view.test.js → pass"],
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
