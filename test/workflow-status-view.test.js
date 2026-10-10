import assert from "node:assert/strict";
import test from "node:test";
import {
  blockWorkflowTask,
  cancelWorkflow,
  completeWorkflowTask,
  createWorkflowState,
  markWorkflowTaskStarted,
  requestWorkflowReplan,
  setWorkflowHandoffPhase,
  startWorkflowTask,
  workflowActionIdentity,
  workflowHandoffIdentity,
} from "../src/workflow.ts";
import { createWorkflowStatusView } from "../extensions/workflow-status-view.ts";
import {
  formatWorkflowControlCenterLabel,
  formatWorkflowStatusPanelSummary,
  formatWorkflowStatusText,
  workflowStatusBar,
} from "../extensions/workflow-status-renderer.ts";

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
  assert.deepEqual(view.progress, { completed: 0, total: 2, currentTaskId: "task-a", currentTaskPosition: 1 });
  assert.deepEqual(view.identity.action, workflowActionIdentity(state));
  assert.deepEqual(view.identity.handoff, workflowHandoffIdentity(state));
  assert.deepEqual(view.elapsed, { kind: "available", milliseconds: 50 });
  assert.match(formatWorkflowStatusText(view), /当前任务结果身份 JSON（complete\/block）/);
  const details = formatWorkflowStatusText(view);
  assert.match(details, /handoff 正在执行/);
  assert.match(details, /已完成任务（completed\/total）：0\/2/);
  assert.match(details, /当前任务位置：第 1\/2 项/);
  const panel = formatWorkflowStatusPanelSummary(view);
  assert.match(panel, /handoff  .*attempt/);
  assert.match(panel, /当前任务位置  第 1\/2 项/);
  assert.match(workflowStatusBar(view)?.text ?? "", /当前项 1\/2/);
  assert.match(formatWorkflowControlCenterLabel(view), /当前第 1\/2 项/);
  assert.deepEqual(state, before);
});

test("当前位置按当前任务在真实列表中的一基索引计算，不用完成数推算", () => {
  const state = createRunningWorkflow();
  state.tasks[0] = { ...state.tasks[0], status: "superseded", startedAt: undefined, executionStartedAt: undefined };
  state.tasks[1] = { ...state.tasks[1], status: "in_progress", startedAt: 120, executionStartedAt: 120 };
  state.currentTaskId = "task-b";
  state.handoff = { ...state.handoff, taskId: "task-b" };

  const view = createWorkflowStatusView(state, idleRuntime, 170);

  assert.equal(view.kind, "workflow");
  if (view.kind !== "workflow") return;
  assert.deepEqual(view.progress, { completed: 0, total: 2, currentTaskId: "task-b", currentTaskPosition: 2 });
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

test("启动展示要求当前任务与handoff身份及真实启动时间一致", () => {
  const state = createRunningWorkflow();
  const staleHandoff = {
    ...state,
    handoff: { ...state.handoff, workflowId: "stale-workflow" },
  };
  const staleView = createWorkflowStatusView(staleHandoff, idleRuntime, 170);
  assert.equal(staleView.kind === "workflow" ? staleView.activity : "unexpected", "waiting-task");
  if (staleView.kind === "workflow") {
    assert.equal(staleView.progress.currentTaskPosition, 1);
    assert.equal(staleView.identity.handoff, undefined);
    assert.equal(staleView.identity.handoffUnavailable, true);
  }

  const queuedWithOldTimestamp = {
    ...state,
    handoff: { ...state.handoff, phase: "queued" },
  };
  const queuedView = createWorkflowStatusView(queuedWithOldTimestamp, idleRuntime, 170);
  assert.equal(queuedView.kind === "workflow" ? queuedView.activity : "unexpected", "waiting-task");
});

test("状态视图对暂停、压缩等待、dispatch 和缺失时间保留准确语义", () => {
  const state = createRunningWorkflow();
  const waiting = {
    ...state,
    handoff: { ...state.handoff, phase: "queued", startedAt: undefined },
    tasks: state.tasks.map((task) => task.id === "task-a"
      ? { ...task, startedAt: undefined, executionStartedAt: undefined }
      : task),
  };
  const dispatchingState = { ...waiting, handoff: { ...waiting.handoff, phase: "dispatching" } };
  const dispatching = createWorkflowStatusView(dispatchingState, { ...idleRuntime, workflowDispatchInFlight: true }, 170);
  assert.equal(dispatching.kind === "workflow" ? dispatching.activity : "unexpected", "dispatching");

  const compactingState = { ...waiting, handoff: { ...waiting.handoff, phase: "compacting" } };
  const compactIdentity = workflowHandoffIdentity(compactingState);
  const pendingRoleCompaction = {
    fromRole: "architect",
    toRole: "developer-test",
    sessionId: compactingState.sessionId,
    contextGeneration: 4,
    roleTransitionGeneration: 5,
    continuation: { kind: "workflow-task", taskId: "task-a", identity: compactIdentity },
  };
  const compactView = createWorkflowStatusView(compactingState, {
    ...idleRuntime,
    roleCompactionPhase: "compacting",
    roleContextGeneration: 4,
    roleTransitionGeneration: 5,
    pendingRoleCompaction,
  }, 170);
  assert.equal(compactView.kind === "workflow" ? compactView.activity : "unexpected", "compacting");
  const activeCompaction = createWorkflowStatusView(compactingState, {
    ...idleRuntime,
    roleCompactionPhase: "compacting",
    roleCompactionOperationId: "operation-a",
    roleContextGeneration: 4,
    roleTransitionGeneration: 5,
    activeRoleCompaction: { operationId: "operation-a", transition: pendingRoleCompaction },
  }, 170);
  assert.equal(activeCompaction.kind === "workflow" ? activeCompaction.activity : "unexpected", "compacting");
  const staleCompaction = createWorkflowStatusView(compactingState, {
    ...idleRuntime,
    roleCompactionPhase: "compacting",
    roleContextGeneration: 6,
    roleTransitionGeneration: 5,
    pendingRoleCompaction,
  }, 170);
  assert.equal(staleCompaction.kind === "workflow" ? staleCompaction.activity : "unexpected", "waiting-task");

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

test("暂停、重规划、无当前任务和终态不携带活动任务位置", () => {
  const state = createRunningWorkflow();
  const pausedState = blockWorkflowTask(state, { taskId: "task-a", reason: "等待确认" }, 130);
  const paused = createWorkflowStatusView(pausedState, idleRuntime, 140);
  assert.equal(paused.kind === "workflow" ? paused.progress.currentTaskPosition : -1, undefined);
  assert.equal(paused.kind === "workflow" ? paused.progress.currentTaskId : "unexpected", undefined);

  const requested = requestWorkflowReplan(state, { direction: "调整剩余任务" });
  const replanningState = completeWorkflowTask(requested, {
    taskId: "task-a",
    completionSummary: "首项完成",
    implementationRationale: "推进重规划边界",
    verification: ["状态测试"],
  }, 140);
  const replanning = createWorkflowStatusView(replanningState, idleRuntime, 150);
  assert.equal(replanning.kind === "workflow" ? replanning.progress.completed : -1, 1);
  assert.equal(replanning.kind === "workflow" ? replanning.progress.currentTaskPosition : -1, undefined);

  const cancelled = createWorkflowStatusView(cancelWorkflow(state, 150), idleRuntime, 160);
  assert.equal(cancelled.kind === "workflow" ? cancelled.progress.currentTaskPosition : -1, undefined);

  const noCurrentTask = createWorkflowState({
    summary: "尚无当前任务",
    sessionId: "no-current-session",
    tasks: [{ id: "pending", task: "等待派发", files: ["src/pending.ts"], acceptanceCriteria: ["启动"] }],
  }, 100);
  const waiting = createWorkflowStatusView(noCurrentTask, idleRuntime, 110);
  assert.equal(waiting.kind === "workflow" ? waiting.progress.currentTaskPosition : -1, undefined);
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
