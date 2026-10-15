import assert from "node:assert/strict";
import test from "node:test";

import {
  completeWorkflowTask,
  createWorkflowState,
  markWorkflowTaskStarted,
  requestWorkflowNestedGoal,
  setWorkflowHandoffPhase,
  startWorkflowTask,
} from "../src/workflow.ts";
import { createNestedWorkflowState, returnFromNestedWorkflow } from "../src/workflow-nesting.ts";
import {
  formatWorkflowStatusDetailsText,
  formatWorkflowStatusPanelSummary,
  formatWorkflowStatusSummaryText,
  formatWorkflowStatusText,
} from "../extensions/workflow-status-renderer.ts";
import { createWorkflowStatusView } from "../extensions/workflow-status-view.ts";

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
    summary: "独立子层计划",
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
  assert.match(formatWorkflowStatusPanelSummary(activeView), /正在处理子目标/);
  assert.doesNotMatch(formatWorkflowStatusPanelSummary(activeView), new RegExp(`${parent.workflowId}|${child.workflowId}`));

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
  const returnedDetails = formatWorkflowStatusDetailsText(returnedView);
  assert.match(returnedDetails, /已返回的子工作流历史（保留真实终态）/);
  assert.match(returnedDetails, new RegExp(child.workflowId));
  assert.match(returnedDetails, /父任务 parent-a/);
});
