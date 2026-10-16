import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowStatusView } from "../extensions/workflow-status-view.ts";
import {
  formatWorkflowControlCenterLabel,
  formatWorkflowStatusDetailsText,
  formatWorkflowStatusPanelSummary,
  formatWorkflowStatusSummaryText,
  formatWorkflowStatusText,
  renderWorkflowStatusResult,
  workflowStatusBar,
  workflowStatusTaskItems,
} from "../extensions/workflow-status-renderer.ts";
import { createWorkflowPauseView } from "../extensions/workflow-pause-view.ts";
import { createWorkflowCompletionView, createWorkflowTaskCompletionView } from "../extensions/workflow-completion-view.ts";
import {
  blockWorkflowTask,
  cancelWorkflow,
  completeWorkflowTask,
  createWorkflowState,
  markWorkflowTaskOutcomeUnknown,
  markWorkflowTaskStarted,
  requestWorkflowReplan,
  setWorkflowHandoffPhase,
  startWorkflowTask,
  workflowActionIdentity,
  workflowHandoffIdentity,
} from "../src/workflow.ts";
import {
  formatWorkflowCompletionDetailsText,
  formatWorkflowCompletionSummaryText,
  formatWorkflowCompletionText,
  formatWorkflowTaskCompletionDetailsText,
  formatWorkflowTaskCompletionSummaryText,
  formatWorkflowTaskCompletionText,
  renderWorkflowCompletion,
  renderWorkflowTaskCompletion,
} from "../extensions/workflow-completion-renderer.ts";
const idleRuntime = { roleCompactionPhase: "idle", workflowDispatchInFlight: false };
const theme = { fg: (_color, text) => text, bold: (text) => text };

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
  const summary = formatWorkflowStatusSummaryText(view);
  assert.match(summary, /任务执行中 · 已完成 0\/2/);
  assert.match(summary, /目标：状态视图测试/);
  assert.match(summary, /当前任务：检查状态/);
  assert.doesNotMatch(summary, /workflowId|sessionId|handoff|JSON/);
  const details = formatWorkflowStatusDetailsText(view);
  assert.match(details, /当前任务结果身份 JSON（complete\/block）/);
  assert.match(details, /handoff 正在执行/);
  assert.match(details, /已完成任务（completed\/total）：0\/2/);
  assert.match(details, /当前任务位置：第 1\/2 项/);
  const panel = formatWorkflowStatusPanelSummary(view);
  assert.match(panel, /└── ● 状态视图测试 · 当前 · 任务执行中/);
  assert.doesNotMatch(panel, /handoff|attempt|workflowId/);
  assert.match(workflowStatusBar(view)?.text ?? "", /当前项 1\/2/);
  assert.match(formatWorkflowControlCenterLabel(view), /任务执行中 · 已完成 0\/2/);
  const items = workflowStatusTaskItems(view);
  assert.equal(items[0].description, "检查状态");
  assert.doesNotMatch(items[0].description, /developer-test|耗时|completionSummary/);
  const collapsed = renderWorkflowStatusResult(view, false, theme).render(200).join("\n");
  const expanded = renderWorkflowStatusResult(view, true, theme).render(500).join("\n");
  assert.doesNotMatch(collapsed, /status-session|handoffId|workflowId/);
  assert.match(collapsed, /目标：状态视图测试/);
  assert.match(expanded, /sessionId：status-session/);
  assert.match(expanded, /当前任务结果身份 JSON/);
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
  const summary = formatWorkflowStatusSummaryText(missingView);
  assert.match(summary, /目标：无时间状态/);
  assert.doesNotMatch(summary, /开始时间|已运行时间/);
  const details = formatWorkflowStatusDetailsText(missingView);
  assert.match(details, /总任务已运行时间：不可用（工作流未记录有效的开始时间）/);
  assert.doesNotMatch(details, /总任务已运行时间：0 毫秒/);
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
  const summary = formatWorkflowStatusSummaryText(view);
  assert.match(summary, /已暂停 · 已完成 0\/2/);
  assert.match(summary, /等待权限确认/);
  assert.match(summary, /等待重规划：缩小改动范围/);
  assert.doesNotMatch(summary, /task-blocked|rev-2/);
  const details = formatWorkflowStatusDetailsText(view);
  assert.match(details, /暂停类别：task-blocked/);
  assert.match(details, /待处理 revision：rev-2/);
  assert.match(details, /用户方向：缩小改动范围/);
});
function createRunningTask() {
  const workflow = createWorkflowState({
    summary: "暂停视图测试",
    sessionId: "pause-view-test",
    tasks: [{ id: "task-a", task: "执行任务", files: ["src/task.ts"], acceptanceCriteria: ["完成"] }],
  }, 1);
  const queued = setWorkflowHandoffPhase(startWorkflowTask(workflow, "task-a", 2), "queued");
  return markWorkflowTaskStarted(queued, "task-a", 3);
}

test("普通阻塞的展示视图保留原因并表达 retry 与 replan", () => {
  const blocked = blockWorkflowTask(createRunningTask(), { taskId: "task-a", reason: "缺少产品决策" }, 4);
  const view = createWorkflowPauseView(blocked);
  const task = view.blockedTasks[0];

  assert.equal(task.reason, "缺少产品决策");
  assert.equal(task.reasonRecorded, true);
  assert.deepEqual(task.recoverySteps, [
    { kind: "retry-task", taskId: "task-a", confirmUnknownOutcome: false },
    { kind: "replan", route: "task_workflow" },
  ]);
});

test("未知执行结果按安全顺序表达核对与显式确认重试", () => {
  const unknown = markWorkflowTaskOutcomeUnknown(createRunningTask(), {
    taskId: "task-a",
    reason: "交接结果未知",
  }, 4);
  const view = createWorkflowPauseView(unknown);

  assert.equal(view.reason.kind, "handoff-outcome-unknown");
  assert.deepEqual(view.blockedTasks[0].recoverySteps, [
    { kind: "verify-external-effects" },
    { kind: "retry-task", taskId: "task-a", confirmUnknownOutcome: true },
    { kind: "replan", route: "architect" },
  ]);
});

test("缺失原因与未来暂停类别在展示视图中明确区分", () => {
  const blocked = blockWorkflowTask(createRunningTask(), { taskId: "task-a", reason: "临时原因" }, 4);
  const missingReason = createWorkflowPauseView({
    ...blocked,
    tasks: blocked.tasks.map((task) => task.id === "task-a" ? { ...task, blockReason: undefined } : task),
  });
  assert.equal(missingReason.blockedTasks[0].reasonRecorded, false);
  assert.equal(missingReason.blockedTasks[0].reason, "未记录（历史状态未保存阻塞原因）");

  const review = createWorkflowState({
    summary: "审阅工作流",
    sessionId: "pause-view-review",
    reviewRequired: true,
    tasks: [{ id: "task-a", task: "待执行任务", files: ["src/task.ts"], acceptanceCriteria: ["完成"] }],
  }, 1);
  assert.deepEqual(createWorkflowPauseView(review).recoverySteps, [{ kind: "resume" }]);
  const unrecognized = createWorkflowPauseView({ ...review, pauseReason: "future-pause-reason" });
  assert.equal(unrecognized.reason.kind, "unrecognized");
  assert.equal(unrecognized.reason.code, "future-pause-reason");
  assert.deepEqual(unrecognized.recoverySteps, []);
});
function completedTask(overrides = {}) {
  return {
    id: "task-final",
    task: "完成最终任务",
    role: "developer-test",
    files: ["src/final.ts"],
    acceptanceCriteria: ["完成"],
    dependsOn: [],
    status: "completed",
    startedAt: 100,
    completedAt: 100,
    completionSummary: "已完成",
    implementationRationale: "遵循现有模式",
    verification: ["node --test：通过", "npm test：失败：1 个测试失败", "0 errors"],
    ...overrides,
  };
}

test("任务完成视图保留真实失败、零耗时和未声明通过的语义", () => {
  const task = completedTask();
  const before = structuredClone(task);
  const view = createWorkflowTaskCompletionView(task);
  assert.deepEqual(view.duration, { kind: "available", milliseconds: 0 });
  assert.deepEqual(view.task.verificationFailures, ["npm test：失败：1 个测试失败"]);
  const text = formatWorkflowTaskCompletionSummaryText(view);
  assert.match(text, /已完成：完成最终任务/);
  assert.match(text, /结果：已完成/);
  assert.match(text, /npm test：失败：1 个测试失败/);
  assert.doesNotMatch(text, /task-final|耗时|实现原因/);
  const details = formatWorkflowTaskCompletionDetailsText(view);
  assert.match(details, /耗时：0 毫秒/);
  assert.match(details, /npm test：失败：1 个测试失败/);
  assert.doesNotMatch(details, /node --test：通过|验证全部通过|0 errors/);
  const collapsed = renderWorkflowTaskCompletion(view, "next-task", theme, false).render(200).join("\n");
  const expanded = renderWorkflowTaskCompletion(view, "next-task", theme, true).render(200).join("\n");
  assert.match(collapsed, /npm test：失败：1 个测试失败/);
  assert.doesNotMatch(collapsed, /task-final|耗时|实现原因/);
  assert.match(expanded, /task-final/);
  assert.match(expanded, /实现原因：遵循现有模式/);
  assert.deepEqual(task, before);
});

test("缺失任务时间不伪装成零耗时，失败验证缺失时省略验证报告", () => {
  const view = createWorkflowTaskCompletionView(completedTask({
    startedAt: undefined,
    completedAt: 150,
    verification: ["node --test：通过"],
  }));
  assert.deepEqual(view.duration, { kind: "unavailable", reason: "missing-or-invalid-time" });
  const text = formatWorkflowTaskCompletionDetailsText(view);
  assert.match(text, /耗时：不可用（历史任务未记录有效的开始时间）/);
  assert.doesNotMatch(text, /验证：/);
});

test("最终报告使用本次明确验收任务而不从 currentTaskId 选择其他任务", () => {
  const planned = createWorkflowState({
    summary: "最终交付",
    sessionId: "completion-session",
    tasks: [
      { id: "task-final", task: "完成最终任务", files: ["src/final.ts"], acceptanceCriteria: ["完成"] },
      { id: "task-later", task: "后续任务", files: ["src/later.ts"], acceptanceCriteria: ["不得作为最终项"] },
    ],
  }, 100);
  const final = completedTask({ id: "task-final", startedAt: 100, completedAt: 160 });
  const state = {
    ...planned,
    status: "completed",
    startedAt: 100,
    completedAt: 160,
    currentTaskId: "task-later",
    tasks: [final, { ...planned.tasks[1], status: "pending" }],
  };
  const view = createWorkflowCompletionView(state, final);
  assert.equal(view.finalTask?.id, "task-final");
  assert.deepEqual(view.progress, { completed: 1, total: 2 });
  assert.deepEqual(view.duration, { kind: "available", milliseconds: 60 });
  const text = formatWorkflowCompletionSummaryText(view);
  assert.match(text, /目标：最终交付/);
  assert.match(text, /已完成任务：1\/2/);
  assert.match(text, /最终结果：已完成/);
  assert.doesNotMatch(text, /task-final|task-later|总耗时/);
  const details = formatWorkflowCompletionDetailsText(view);
  assert.match(details, /最终任务[\s\S]*ID：task-final/);
  assert.doesNotMatch(details, /task-later/);
  assert.match(details, /总耗时：60 毫秒/);
  const collapsed = renderWorkflowCompletion(view, theme, false).render(200).join("\n");
  const expanded = renderWorkflowCompletion(view, theme, true).render(200).join("\n");
  assert.match(collapsed, /结果：已完成/);
  assert.doesNotMatch(collapsed, /task-final|总耗时/);
  assert.match(expanded, /task-final/);
  assert.match(expanded, /总耗时：60 毫秒/);
});

test("缺失整体时间保留不可用原因且没有完成任务时不捏造任务摘要", () => {
  const state = createWorkflowState({
    summary: "保留历史边界",
    sessionId: "missing-time-session",
    tasks: [{ id: "pending", task: "待执行", files: ["src/pending.ts"], acceptanceCriteria: ["执行"] }],
  }, 100);
  const view = createWorkflowCompletionView({ ...state, status: "completed" });
  const text = formatWorkflowCompletionSummaryText(view);
  assert.equal(view.finalTask, undefined);
  assert.match(text, /工作流完成报告/);
  assert.doesNotMatch(text, /开始时间|结束时间|总耗时/);
  const details = formatWorkflowCompletionDetailsText(view);
  assert.match(details, /内容：无/);
  assert.match(details, /开始时间：不可用（工作流未记录有效的开始时间）/);
  assert.match(details, /结束时间：不可用（工作流未记录有效的结束时间）/);
  assert.match(details, /总耗时：不可用（工作流缺少有效的整体开始或结束时间）/);
});
