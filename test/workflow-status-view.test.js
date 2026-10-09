import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkflowState,
  markWorkflowTaskStarted,
  setWorkflowHandoffPhase,
  startWorkflowTask,
  workflowActionIdentity,
  workflowHandoffIdentity,
} from "../src/workflow.ts";
import { createWorkflowStatusView } from "../extensions/workflow-status-view.ts";
import { formatWorkflowStatusPanelSummary, formatWorkflowStatusText } from "../extensions/workflow-status-renderer.ts";

const idleRuntime = { roleCompactionPhase: "idle", workflowDispatchInFlight: false };

function createRunningWorkflow() {
  const planned = createWorkflowState({
    summary: "状态视图测试",
    sessionId: "status-session",
    workflowId: "status-workflow",
    tasks: [
      { id: "task-a", task: "检查状态", files: ["src/status.ts"], acceptanceCriteria: ["状态可读"] },
      { id: "task-b", task: "保留历史", files: ["src/history.ts"], acceptanceCriteria: ["历史完整"] },
    ],
  }, 100);
  const queued = setWorkflowHandoffPhase(startWorkflowTask(planned, "task-a", 110), "queued", 115);
  return markWorkflowTaskStarted(queued, "task-a", 120);
}

test("状态视图复用活动身份、当前阶段和单一时间快照而不修改工作流", () => {
  const state = createRunningWorkflow();
  const before = structuredClone(state);
  const view = createWorkflowStatusView(state, idleRuntime, 170);

  assert.equal(view.kind, "workflow");
  if (view.kind !== "workflow") return;
  assert.equal(view.activity, "executing");
  assert.deepEqual(view.progress, { completed: 0, total: 2, currentTaskId: "task-a" });
  assert.deepEqual(view.identity.action, workflowActionIdentity(state));
  assert.deepEqual(view.identity.handoff, workflowHandoffIdentity(state));
  assert.deepEqual(view.elapsed, { kind: "available", milliseconds: 50 });
  assert.match(formatWorkflowStatusText(view), /当前任务结果身份 JSON（complete\/block）/);
  assert.match(formatWorkflowStatusText(view), /handoff 正在执行/);
  assert.match(formatWorkflowStatusPanelSummary(view), /handoff  .*attempt/);
  assert.deepEqual(state, before);
});

test("状态视图区分无活动工作流和恢复错误", () => {
  const noWorkflow = createWorkflowStatusView(undefined, idleRuntime, 100);
  const restoreError = createWorkflowStatusView(undefined, {
    ...idleRuntime,
    workflowRestoreError: { code: "WORKFLOW_STATE_INVALID", message: "保存记录损坏" },
  }, 100);

  assert.equal(noWorkflow.kind, "no-workflow");
  assert.equal(formatWorkflowStatusText(noWorkflow), "当前没有活动工作流。");
  assert.deepEqual(restoreError, {
    kind: "restore-error",
    code: "WORKFLOW_STATE_INVALID",
    message: "保存记录损坏",
  });
  assert.match(formatWorkflowStatusPanelSummary(restoreError), /无法恢复已保存的工作流/);
});

test("状态视图对暂停、压缩等待、dispatch 和缺失时间保留准确语义", () => {
  const state = createRunningWorkflow();
  const waiting = {
    ...state,
    tasks: state.tasks.map((task) => task.id === "task-a" ? { ...task, executionStartedAt: undefined } : task),
  };
  const dispatching = createWorkflowStatusView(waiting, { ...idleRuntime, workflowDispatchInFlight: true }, 170);
  assert.equal(dispatching.kind === "workflow" ? dispatching.activity : "unexpected", "dispatching");
  const compactView = createWorkflowStatusView(waiting, {
    ...idleRuntime,
    roleCompactionPhase: "compacting",
    pendingRoleCompaction: { fromRole: "architect", toRole: "developer-test" },
  }, 170);
  assert.equal(compactView.kind === "workflow" ? compactView.activity : "unexpected", "compacting");

  const missingTime = createWorkflowState({
    summary: "无时间状态",
    sessionId: "missing-time-session",
    tasks: [{ id: "pending", task: "待执行", files: ["src/pending.ts"], acceptanceCriteria: ["执行"] }],
  }, 100);
  const missingView = createWorkflowStatusView(missingTime, idleRuntime, 150);
  assert.equal(missingView.kind === "workflow" ? missingView.elapsed.kind : "unexpected", "unavailable");
  assert.match(formatWorkflowStatusText(missingView), /总任务已运行时间：不可用（工作流未记录有效的开始时间）/);
  assert.doesNotMatch(formatWorkflowStatusText(missingView), /总任务已运行时间：0 毫秒/);
});

test("状态视图保留暂停原因、revision 与任务历史", () => {
  const state = createRunningWorkflow();
  const paused = {
    ...state,
    status: "paused",
    pauseReason: "task-blocked",
    pendingRevision: { revisionId: "rev-2", direction: "缩小改动范围", requestedAt: 155 },
    tasks: state.tasks.map((task) => task.id === "task-a"
      ? { ...task, status: "blocked", blockReason: "等待权限确认", outcomeUnknown: true }
      : task),
    updatedAt: 160,
  };
  const view = createWorkflowStatusView(paused, idleRuntime, 170);
  assert.equal(view.kind, "workflow");
  if (view.kind !== "workflow") return;
  assert.equal(view.activity, "paused");
  assert.equal(view.pause.blockedTasks[0]?.reason, "等待权限确认");
  assert.equal(view.pause.blockedTasks[0]?.recoverySteps[0]?.kind, "verify-external-effects");
  assert.deepEqual(view.pendingRevision, { revisionId: "rev-2", direction: "缩小改动范围" });
  assert.equal(view.tasks.length, 2);
  const report = formatWorkflowStatusText(view);
  assert.match(report, /暂停类别：task-blocked/);
  assert.match(report, /等待权限确认/);
  assert.match(report, /待处理 revision：rev-2/);
  assert.match(report, /用户方向：缩小改动范围/);
});
