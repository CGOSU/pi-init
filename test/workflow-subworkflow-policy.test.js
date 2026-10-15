import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowState, requestWorkflowNestedGoal, cancelWorkflow, cloneState, completeWorkflowTask, hydrateWorkflowState, markWorkflowTaskStarted, resumeWorkflow, setWorkflowHandoffPhase, startWorkflowTask } from "../src/workflow.ts";
import { createNestedWorkflowState, returnFromNestedWorkflow, cancelWorkflowTree } from "../src/workflow-nesting.ts";
import { reviewReturnedSubworkflow, normalizeSubworkflowContract } from "../src/workflow-subworkflow.ts";
import { createWorkflowPauseView } from "../extensions/workflow-pause-view.ts";

const contract = { inputs: ["当前需求"], expectedOutputs: ["检查结论"], acceptanceCriteria: ["有验证依据"], allowedFiles: ["src"] };
function root() { return createWorkflowState({ sessionId: "policy-session", summary: "父目标", tasks: [{ id: "parent", task: "继续父目标", files: ["src"], acceptanceCriteria: ["通过"] }] }, 100); }
function child() { return createNestedWorkflowState(requestWorkflowNestedGoal(root(), { direction: "独立检查" }, 101), { summary: "子目标", subworkflowContract: contract, tasks: [{ id: "child", task: "检查", files: ["src"], acceptanceCriteria: ["通过"] }] }, 102); }
test("新子流程必须提供独立输入输出契约", () => {
  assert.throws(() => createNestedWorkflowState(requestWorkflowNestedGoal(root(), { direction: "检查" }, 101), { summary: "检查", tasks: [{ id: "check", task: "检查", files: ["src"], acceptanceCriteria: ["通过"] }] }, 102), /契约/);
});
test("只允许一层活动子流程，不通过递归替代任务拆分", () => {
  assert.throws(() => requestWorkflowNestedGoal(child(), { direction: "再拆一层" }, 103), { code: "WORKFLOW_NESTED_DEPTH_LIMIT" });
});
test("取消子流程返回后先审阅结果，不直接启动父计划", () => {
  const returned = returnFromNestedWorkflow(cancelWorkflow(child(), 104), "cancelled", 105);
  assert.equal(returned.status, "replanning");
  assert.equal(returned.pauseReason, "child-result-review");
  assert.ok(returned.pendingRevision);
});

function completedReturn() {
  const prepared = startWorkflowTask(child(), undefined, 110);
  const executing = markWorkflowTaskStarted(setWorkflowHandoffPhase(prepared, "queued", 111), "child", 112);
  return returnFromNestedWorkflow(completeWorkflowTask(executing, { taskId: "child", completionSummary: "检查结论", implementationRationale: "明确父计划影响", verification: ["真实检查通过"] }, 113), "completed", 114);
}
function review(state, overrides = {}) {
  return { childWorkflowId: state.subworkflowHistory[0].workflowId, decision: "continue", parentPlanValid: true, reason: "输出、验证与父计划依赖均已核对", acceptedOutputs: ["检查结论"], verification: ["已核对父任务输入与子输出"], ...overrides };
}
test("子结果未审阅前不派发父任务，完整验收后才恢复原队列", () => {
  const pending = completedReturn();
  assert.equal(pending.status, "replanning");
  const snapshot = structuredClone(pending);
  const accepted = reviewReturnedSubworkflow(pending, review(pending), 120);
  assert.equal(accepted.status, "running");
  assert.equal(accepted.tasks[0].status, "pending");
  assert.equal(accepted.pendingRevision, undefined);
  assert.equal(accepted.subworkflowHistory[0].reviews[0].decision, "continue");
  assert.deepEqual(pending, snapshot);
  const restored = hydrateWorkflowState(JSON.parse(JSON.stringify(accepted)));
  assert.equal(restored.ok, true, restored.message);
  const copy = cloneState(accepted, 121);
  copy.subworkflowHistory[0].reviews[0].verification.push("新核查");
  assert.equal(accepted.subworkflowHistory[0].reviews[0].verification.length, 1);
});
test("缺输出、缺验证、父计划失效或旧子身份都不能直接继续", () => {
  const pending = completedReturn();
  for (const overrides of [{ acceptedOutputs: [] }, { parentPlanValid: false }, { verification: [] }, { childWorkflowId: "stale" }]) {
    assert.throws(() => reviewReturnedSubworkflow(pending, review(pending, overrides), 120));
  }
  const legacy = cloneState(pending, 121);
  delete legacy.subworkflowHistory[0].contract;
  assert.throws(() => reviewReturnedSubworkflow(legacy, review(legacy), 122), /契约/);
  const cancelled = returnFromNestedWorkflow(cancelWorkflow(child(), 110), "cancelled", 111);
  assert.throws(() => reviewReturnedSubworkflow(cancelled, review(cancelled), 120), /取消/);
});
test("影响父计划则保留重规划，阻塞则暂停且 resume 仅重开审阅", () => {
  const pending = completedReturn();
  const changed = reviewReturnedSubworkflow(pending, review(pending, { decision: "replan", parentPlanValid: false }), 120);
  assert.equal(changed.status, "replanning");
  assert.ok(changed.pendingRevision);
  const blocked = reviewReturnedSubworkflow(pending, review(pending, { decision: "block", parentPlanValid: false }), 120);
  assert.equal(blocked.status, "paused");
  assert.equal(blocked.pauseReason, "child-result-review");
  assert.equal(hydrateWorkflowState(blocked).ok, true);
  const view = createWorkflowPauseView(blocked);
  assert.equal(view.reason.kind, "child-result-review");
  assert.deepEqual(view.recoverySteps, [{ kind: "resume" }]);
  const resumed = resumeWorkflow(blocked, 121);
  assert.equal(resumed.status, "replanning");
  assert.equal(resumed.continuation.phase, "pending");
  assert.ok(resumed.recoveryGeneration > blocked.recoveryGeneration);
});
test("篡改持久审阅为取消后继续会被 hydration 拒绝", () => {
  const pending = completedReturn();
  const accepted = reviewReturnedSubworkflow(pending, review(pending), 120);
  accepted.subworkflowHistory[0].status = "cancelled";
  const restored = hydrateWorkflowState(accepted);
  assert.equal(restored.ok, false);
  assert.match(restored.message, /取消/);
});
test("取消全部关闭父子流程并保留历史，取消执行中任务不伪装无副作用", () => {
  const cancelled = cancelWorkflowTree(child(), 120);
  assert.equal(cancelled.workflowId, cancelled.subworkflowHistory[0].parentWorkflowId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pendingRevision, undefined);
  assert.equal(hydrateWorkflowState(cancelled).ok, true);
  const executing = markWorkflowTaskStarted(setWorkflowHandoffPhase(startWorkflowTask(root(), "parent", 121), "queued", 122), "parent", 123);
  const stopped = cancelWorkflowTree(executing, 124);
  assert.equal(stopped.tasks[0].status, "blocked");
  assert.equal(stopped.tasks[0].outcomeUnknown, true);
  assert.equal(hydrateWorkflowState(stopped).ok, true);
});
test("子任务声明范围受契约约束，拒绝父目录与绝对路径", () => {
  for (const file of ["../secret", "/tmp/file", "C:/secret", "..\\secret"]) {
    assert.throws(() => normalizeSubworkflowContract({ ...contract, allowedFiles: [file] }));
  }
  assert.throws(() => createNestedWorkflowState(requestWorkflowNestedGoal(root(), { direction: "检查" }, 101), { summary: "越界", subworkflowContract: contract, tasks: [{ id: "outside", task: "写文档", files: ["docs"], acceptanceCriteria: ["通过"] }] }, 102), /allowedFiles/);
});
