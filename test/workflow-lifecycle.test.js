import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowActions } from "../extensions/workflow-actions.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowState, requestWorkflowNestedGoal, workflowActionIdentity, recoverWorkflowState, startWorkflowTask, workflowHandoffIdentity, ensureWorkflowReplanHandoff, workflowReplanIdentity } from "../src/workflow.ts";
import { createNestedWorkflowState } from "../src/workflow-nesting.ts";
import { transitionWorkflowDispatch, transitionWorkflowLifecycle } from "../src/workflow-orchestrator.ts";

function plan(summary, id) {
  return { summary, subworkflowContract: { inputs: ["需求"], expectedOutputs: ["目标完成"], acceptanceCriteria: ["测试通过"], allowedFiles: ["src"] }, tasks: [{ id, task: summary, role: "developer-test", files: ["src"], acceptanceCriteria: ["测试通过"] }] };
}

function nestedState() {
  const parent = createWorkflowState({ ...plan("父目标", "parent-task"), sessionId: "test-session" }, 100);
  return createNestedWorkflowState(requestWorkflowNestedGoal(parent, { direction: "子目标" }, 101), plan("子目标", "child-task"), 102);
}

function actionHarness(initial, options = {}) {
  const state = createExtensionRuntimeState();
  state.workflowState = initial;
  const retired = [];
  const order = [];
  const ctx = {
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => "test-session",
      getBranch: () => [{ type: "custom_message", customType: "pi-init-workflow-task", details: workflowHandoffIdentity(initial) }, { type: "custom_message", customType: "pi-init-workflow-replan", details: workflowReplanIdentity(initial) }],
    },
    ui: { notify() {} },
  };
  const actions = createWorkflowActions(state, {
    roleRuntime: {
      activeRoleFor: () => ({ role: options.role ?? "developer-test" }),
      retireWorkflowContinuation: (identity) => { order.push("retire"); retired.push(identity); },
    },
    report: {
      persistWorkflowState: (next) => {
        order.push("persist");
        if (options.fail) throw new Error("session write failed");
        state.workflowState = next;
        return next;
      },
      formatWorkflowState: () => "状态",
    },
    dispatch: { scheduleWorkflow: async () => { order.push("schedule"); } },
    coordination: { isLinkedToWorkflow: () => false },
  });
  return { state, actions, ctx, retired, order };
}

test("子工作流取消写入失败不提前撤销续跑", async () => {
  const initial = nestedState();
  const h = actionHarness(initial, { fail: true });
  await assert.rejects(h.actions.runTaskWorkflowAction({ action: "cancel", ...workflowActionIdentity(initial) }, undefined, h.ctx), /session write failed/);
  assert.equal(h.state.workflowState, initial);
  assert.deepEqual(h.retired, []);
  assert.deepEqual(h.order, ["persist"]);
});

test("子工作流取消提交后才撤销旧身份续跑，不使用递增后的身份", async () => {
  const initial = nestedState();
  const h = actionHarness(initial);
  await h.actions.runTaskWorkflowAction({ action: "cancel", ...workflowActionIdentity(initial) }, undefined, h.ctx);
  assert.deepEqual(h.order, ["persist", "retire"]);
  assert.deepEqual(h.retired, [workflowActionIdentity(initial)]);
  assert.equal(h.state.workflowState.workflowId, initial.parentStack[0].state.workflowId);
  assert.equal(h.state.workflowState.status, "replanning");
  assert.equal(h.state.workflowState.pauseReason, "child-result-review");
});

function executingState(initial = nestedState()) {
  const prepared = startWorkflowTask(initial, undefined, 110);
  const identity = workflowHandoffIdentity(prepared);
  const dispatching = transitionWorkflowDispatch(prepared, { type: "task-dispatch-requested", identity }, 111).state;
  return transitionWorkflowDispatch(dispatching, { type: "task-started", identity }, 112).state;
}

function completionEvent(state) {
  return {
    type: "task-completed", identity: workflowHandoffIdentity(state),
    completionSummary: "目标完成", implementationRationale: "保留父层进度，不重复副作用", verification: ["测试通过"],
  };
}

function completionParams(state) {
  const { type, identity, ...result } = completionEvent(state);
  return { action: "complete", ...identity, ...result };
}

test("子工作流完成写入失败不撤销续跑、不返回父层；成功后使用原身份撤销", async () => {
  const initial = executingState();
  const failed = actionHarness(initial, { fail: true });
  await assert.rejects(failed.actions.runTaskWorkflowAction(completionParams(initial), undefined, failed.ctx), /session write failed/);
  assert.equal(failed.state.workflowState, initial);
  assert.deepEqual(failed.order, ["persist"]);
  const h = actionHarness(initial);
  const result = await h.actions.runTaskWorkflowAction(completionParams(initial), undefined, h.ctx);
  assert.deepEqual(h.order, ["persist", "retire"]);
  assert.deepEqual(h.retired, [workflowActionIdentity(initial)]);
  assert.equal(h.state.workflowState.workflowId, initial.parentStack[0].state.workflowId);
  assert.equal(h.state.workflowState.subworkflowHistory[0].tasks[0].status, "completed");
  assert.match(result.content[0].text, /子流程已完成/);
});

test("生命周期转换确定、输入不变，返回父层与完成子层分开保存", () => {
  const initial = executingState();
  const snapshot = structuredClone(initial);
  const event = completionEvent(initial);
  const result = transitionWorkflowLifecycle(initial, event, 120);
  assert.deepEqual(initial, snapshot);
  assert.deepEqual(transitionWorkflowLifecycle(initial, event, 120), result);
  assert.equal(result.taskState.workflowId, initial.workflowId);
  assert.equal(result.taskState.status, "completed");
  assert.equal(result.state.workflowId, initial.parentStack[0].state.workflowId);
  assert.equal(result.returnedToParent, true);
  assert.deepEqual(result.effects, [{ kind: "retire-continuation", identity: workflowActionIdentity(initial) }]);
});

test("完成与阻塞事件校验全部 handoff 身份字段，迟到结果不能绑定父层", () => {
  const initial = executingState();
  const completed = transitionWorkflowLifecycle(initial, completionEvent(initial), 120);
  for (const event of [completionEvent(initial), { type: "task-blocked", identity: workflowHandoffIdentity(initial), reason: "缺少权限" }]) {
    for (const key of Object.keys(event.identity)) {
      const value = event.identity[key];
      const identity = { ...event.identity, [key]: typeof value === "number" ? value + 1 : "stale" };
      assert.throws(() => transitionWorkflowLifecycle(initial, { ...event, identity }, 121), { code: "WORKFLOW_ACTION_IDENTITY_STALE" }, key);
    }
    assert.throws(() => transitionWorkflowLifecycle(completed.state, event, 122), { code: "WORKFLOW_ACTION_IDENTITY_STALE" });
    assert.throws(() => transitionWorkflowLifecycle(completed.taskState, event, 122), { code: "WORKFLOW_ACTION_IDENTITY_STALE" });
  }
});

test("queued 任务在验收时补记真实启动，prepared 阶段仍拒绝", () => {
  const prepared = startWorkflowTask(nestedState(), undefined, 110);
  const identity = workflowHandoffIdentity(prepared);
  const dispatching = transitionWorkflowDispatch(prepared, { type: "task-dispatch-requested", identity }, 111).state;
  const queued = transitionWorkflowDispatch(dispatching, { type: "task-queued", identity }, 112).state;
  assert.throws(() => transitionWorkflowLifecycle(prepared, completionEvent(prepared), 115), { code: "WORKFLOW_TASK_NOT_STARTED" });
  assert.throws(() => transitionWorkflowLifecycle(prepared, { type: "task-blocked", identity, reason: "阻塞" }, 115), { code: "WORKFLOW_TASK_NOT_STARTED" });

  const completed = transitionWorkflowLifecycle(queued, completionEvent(queued), 120);
  assert.equal(completed.taskState.tasks[0].status, "completed");
  assert.equal(completed.taskState.tasks[0].startedAt, 120);
  assert.equal(completed.taskState.tasks[0].executionStartedAt, 120);
  assert.equal(completed.taskState.tasks[0].completedAt, 120);

  const blocked = transitionWorkflowLifecycle(queued, { type: "task-blocked", identity, reason: "阻塞" }, 120);
  assert.equal(blocked.taskState.tasks[0].status, "blocked");
  assert.equal(blocked.taskState.tasks[0].executionStartedAt, 120);
});

test("未知结果重试仍须显式确认，重试后旧事件失效", () => {
  const initial = executingState();
  const recovered = recoverWorkflowState(initial, "test-session", 120);
  assert.equal(recovered.ok, true);
  const event = { type: "task-retried", identity: workflowActionIdentity(recovered.value), taskId: "child-task", confirmUnknownOutcome: false };
  assert.throws(() => transitionWorkflowLifecycle(recovered.value, event, 121), { code: "WORKFLOW_UNKNOWN_OUTCOME_CONFIRMATION_REQUIRED" });
  const retried = transitionWorkflowLifecycle(recovered.value, { ...event, confirmUnknownOutcome: true }, 122);
  assert.equal(retried.state.status, "running");
  assert.equal(retried.state.tasks[0].status, "pending");
  assert.deepEqual(retried.effects, []);
  assert.throws(() => transitionWorkflowLifecycle(retried.state, { ...event, confirmUnknownOutcome: true }, 123), { code: "WORKFLOW_ACTION_IDENTITY_STALE" });
});

test("命令重试先持久化再调度，写入失败不调度", async () => {
  const initial = executingState();
  const blocked = transitionWorkflowLifecycle(initial, { type: "task-blocked", identity: workflowHandoffIdentity(initial), reason: "缺少权限" }, 120).state;
  const failed = actionHarness(blocked, { fail: true });
  await failed.actions.workflowCommand("retry", "child-task", failed.ctx);
  assert.deepEqual(failed.order, ["persist"]);
  assert.equal(failed.state.workflowState, blocked);
  const h = actionHarness(blocked);
  await h.actions.workflowCommand("retry", "child-task", h.ctx);
  assert.deepEqual(h.order, ["persist", "schedule"]);
  assert.equal(h.state.workflowState.tasks[0].status, "pending");
});

test("架构审阅恢复由生命周期事件推进，重复恢复身份被拒绝", () => {
  const initial = createWorkflowState({ ...plan("审阅目标", "review-task"), sessionId: "test-session", reviewRequired: true }, 100);
  const event = { type: "workflow-resumed", identity: workflowActionIdentity(initial) };
  const next = transitionWorkflowLifecycle(initial, event, 120);
  assert.equal(next.state.status, "running");
  assert.equal(next.state.continuation.reason, "resume");
  assert.deepEqual(next.effects, []);
  assert.throws(() => transitionWorkflowLifecycle(next.state, event, 121), { code: "WORKFLOW_ACTION_IDENTITY_STALE" });
});

test("命令取消与工具一致，返回父层等待结果处置", async () => {
  const initial = nestedState();
  const h = actionHarness(initial);
  await h.actions.workflowCommand("cancel", undefined, h.ctx);
  assert.equal(h.state.workflowState.workflowId, initial.parentStack[0].state.workflowId);
  assert.equal(h.state.workflowState.status, "replanning");
  assert.deepEqual(h.order, ["persist", "retire"]);
  assert.deepEqual(h.retired, [workflowActionIdentity(initial)]);
});

test("最终完成一次提交终态，提交失败不清除调度标记", async () => {
  const root = createWorkflowState({ ...plan("最终目标", "root-task"), sessionId: "test-session" }, 100);
  const initial = executingState(root);
  const failed = actionHarness(initial, { fail: true });
  failed.state.workflowDispatchInFlight = true;
  await assert.rejects(failed.actions.runTaskWorkflowAction(completionParams(initial), undefined, failed.ctx), /session write failed/);
  assert.equal(failed.state.workflowDispatchInFlight, true);
  assert.deepEqual(failed.retired, []);
  const h = actionHarness(initial);
  h.state.workflowDispatchInFlight = true;
  await h.actions.runTaskWorkflowAction(completionParams(initial), undefined, h.ctx);
  assert.equal(h.state.workflowState.status, "completed");
  assert.equal(h.state.workflowDispatchInFlight, false);
  assert.deepEqual(h.order, ["persist", "retire"]);
  assert.deepEqual(h.retired, [workflowActionIdentity(initial)]);
});

test("工具重试和恢复的写入失败不报告成功或改变业务状态", async () => {
  const running = executingState();
  const blocked = transitionWorkflowLifecycle(running, { type: "task-blocked", identity: workflowHandoffIdentity(running), reason: "权限不足" }, 120).state;
  const review = createWorkflowState({ ...plan("需审阅", "review-task"), sessionId: "test-session", reviewRequired: true }, 100);
  for (const [initial, action, taskId] of [[blocked, "retry", "child-task"], [review, "resume", undefined]]) {
    const h = actionHarness(initial, { fail: true });
    await assert.rejects(h.actions.runTaskWorkflowAction({ action, taskId, ...workflowActionIdentity(initial) }, undefined, h.ctx), /session write failed/);
    assert.equal(h.state.workflowState, initial);
    assert.deepEqual(h.order, ["persist"]);
  }
});

test("结果验收写入失败不会启动父队列，成功才解除结果审阅门", async () => {
  const initial = executingState();
  const completed = transitionWorkflowLifecycle(initial, completionEvent(initial), 120);
  const pending = ensureWorkflowReplanHandoff(completed.state);
  pending.continuation.phase = "queued";
  const params = { action: "review-child", ...workflowReplanIdentity(pending), childReview: { childWorkflowId: initial.workflowId, decision: "continue", parentPlanValid: true, reason: "全部输出已核实，父计划有效", acceptedOutputs: ["目标完成"], verification: ["核查通过"] } };
  const failed = actionHarness(pending, { fail: true, role: "architect" });
  await assert.rejects(failed.actions.runTaskWorkflowAction(params, undefined, failed.ctx), /session write failed/);
  assert.equal(failed.state.workflowState, pending);
  assert.deepEqual(failed.order, ["persist"]);
  const h = actionHarness(pending, { role: "architect" });
  await h.actions.runTaskWorkflowAction(params, undefined, h.ctx);
  assert.equal(h.state.workflowState.status, "running");
  assert.equal(h.state.workflowState.subworkflowHistory[0].reviews[0].decision, "continue");
  assert.deepEqual(h.order, ["persist"]);
});
test("cancel-all 命令与工具都终止整棵流程并保留取消历史", async () => {
  const initial = nestedState();
  const command = actionHarness(initial);
  await command.actions.workflowCommand("cancel-all", undefined, command.ctx);
  const tool = actionHarness(initial);
  await tool.actions.runTaskWorkflowAction({ action: "cancel-all", ...workflowActionIdentity(initial) }, undefined, tool.ctx);
  for (const h of [command, tool]) {
    assert.equal(h.state.workflowState.workflowId, initial.parentStack[0].state.workflowId);
    assert.equal(h.state.workflowState.status, "cancelled");
    assert.equal(h.state.workflowState.subworkflowHistory[0].status, "cancelled");
    assert.deepEqual(h.order, ["persist", "retire"]);
    assert.deepEqual(h.retired, [workflowActionIdentity(initial)]);
  }
});
