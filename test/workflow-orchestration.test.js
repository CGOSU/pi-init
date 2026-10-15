import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowMessages } from "../extensions/workflow-messages.ts";
import { createWorkflowState, ensureWorkflowReplanHandoff, requestWorkflowReplan, cancelWorkflow, recoverWorkflowState, retryWorkflowTask, startWorkflowTask, workflowHandoffIdentity, workflowReplanIdentity } from "../src/workflow.ts";
import { selectWorkflowScheduleEffect, transitionWorkflowDispatch } from "../src/workflow-orchestrator.ts";

function replanHarness(options = {}) {
  const initial = createWorkflowState({
    sessionId: "test-session", summary: "可靠交接", tasks: [
      { id: "first", task: "执行任务", role: "developer-test", files: ["src"], acceptanceCriteria: ["测试通过"] },
    ],
  }, 100);
  const state = { workflowState: ensureWorkflowReplanHandoff(requestWorkflowReplan(initial, { direction: "调整计划" }, 101)) };
  const sent = [];
  const notifications = [];
  const persisted = [];
  const ctx = { ui: { notify: (message) => notifications.push(message) } };
  let messages;
  messages = createWorkflowMessages(state, {
    pi: { sendMessage: (message) => {
      assert.equal(state.workflowState.continuation.phase, "dispatching", "必须先持久化派发意图");
      sent.push(message);
      options.send?.({ messages, state, ctx });
    } },
    setInternalContinuationPending: (value) => { state.internalContinuationPending = value; },
    persistWorkflowState: (next) => {
      options.persist?.(next);
      persisted.push(next);
      state.workflowState = next;
      return next;
    },
  });
  return { state, sent, notifications, persisted, ctx, messages };
}

test("重规划交接已 queued 后重复调度不重复发送", () => {
  const h = replanHarness();
  assert.equal(h.messages.sendWorkflowReplanMessage(h.ctx), true);
  assert.equal(h.messages.sendWorkflowReplanMessage(h.ctx), false);
  assert.equal(h.sent.length, 1);
  assert.equal(h.state.workflowState.continuation.phase, "queued");
});

test("发送重规划消息时重入调度不重复发送", () => {
  const h = replanHarness({ send: ({ messages, ctx }) => {
    if (h.sent.length === 1) assert.equal(messages.sendWorkflowReplanMessage(ctx), false);
  } });
  assert.equal(h.messages.sendWorkflowReplanMessage(h.ctx), true);
  assert.equal(h.sent.length, 1);
});

test("派发后 queued 持久化失败不自动重放重规划", () => {
  const h = replanHarness({ persist: (next) => {
    if (next.continuation.phase === "queued") throw new Error("disk full");
  } });
  assert.equal(h.messages.sendWorkflowReplanMessage(h.ctx), false);
  assert.equal(h.state.workflowState.continuation.phase, "dispatching");
  assert.equal(h.messages.sendWorkflowReplanMessage(h.ctx), false);
  assert.equal(h.sent.length, 1);
});

test("派发意图持久化失败不发送，恢复存储后允许首次发送", () => {
  let fail = true;
  const h = replanHarness({ persist: () => { if (fail) throw new Error("disk full"); } });
  assert.equal(h.messages.sendWorkflowReplanMessage(h.ctx), false);
  assert.equal(h.sent.length, 0);
  assert.equal(h.state.workflowState.continuation.phase, "pending");
  fail = false;
  assert.equal(h.messages.sendWorkflowReplanMessage(h.ctx), true);
  assert.equal(h.sent.length, 1);
});

function preparedTask() {
  return startWorkflowTask(createWorkflowState({
    sessionId: "test-session", summary: "依赖顺序", tasks: [
      { id: "first", task: "实现", role: "developer-test", files: ["src"], acceptanceCriteria: ["测试通过"] },
      { id: "second", task: "收尾", role: "docs-commit", files: ["docs"], acceptanceCriteria: ["文档准确"], dependsOn: ["first"] },
    ],
  }, 100), "first", 101);
}

test("交接转换不修改输入，重复事件不再次产生发送效果", () => {
  const initial = preparedTask();
  const snapshot = structuredClone(initial);
  const identity = workflowHandoffIdentity(initial);
  const event = { type: "task-dispatch-requested", identity };
  const sent = transitionWorkflowDispatch(initial, event, 102);
  assert.deepEqual(initial, snapshot);
  assert.equal(sent.state.handoff.phase, "dispatching");
  assert.deepEqual(sent.effects, [{ kind: "send-task", identity }]);
  assert.deepEqual(transitionWorkflowDispatch(initial, event, 102), sent, "同一输入与时间产生同一转换");
  const repeated = transitionWorkflowDispatch(sent.state, event, 103);
  assert.equal(repeated.state, sent.state);
  assert.deepEqual(repeated.effects, []);
  const queued = transitionWorkflowDispatch(sent.state, { type: "task-queued", identity }, 104);
  assert.equal(queued.state.handoff.phase, "queued");
  assert.deepEqual(transitionWorkflowDispatch(queued.state, event, 105).effects, []);
});

test("任务真实启动后迟到 queued 不回退状态，重复启动不更改时间", () => {
  const initial = preparedTask();
  const identity = workflowHandoffIdentity(initial);
  const dispatching = transitionWorkflowDispatch(initial, { type: "task-dispatch-requested", identity }, 102).state;
  const started = transitionWorkflowDispatch(dispatching, { type: "task-started", identity }, 103).state;
  assert.equal(started.handoff.phase, "executing");
  assert.equal(started.tasks[0].executionStartedAt, 103);
  assert.equal(transitionWorkflowDispatch(started, { type: "task-queued", identity }, 104).state, started);
  assert.equal(transitionWorkflowDispatch(started, { type: "task-started", identity }, 105).state, started);
  assert.deepEqual(transitionWorkflowDispatch(started, { type: "task-dispatch-requested", identity }, 106).effects, []);
  const reminder = transitionWorkflowDispatch(started, { type: "task-reminder-requested", identity }, 107);
  assert.equal(reminder.state, started);
  assert.equal(reminder.effects.length, 1, "只有显式提醒事件允许继续当前任务");
});

test("任务与重规划事件校验每个身份字段，旧回调不能推进新状态", () => {
  const task = preparedTask();
  const replan = replanHarness().state.workflowState;
  for (const [current, identity, type] of [
    [task, workflowHandoffIdentity(task), "task-dispatch-requested"],
    [replan, workflowReplanIdentity(replan), "replan-dispatch-requested"],
  ]) {
    for (const key of Object.keys(identity)) {
      const stale = { ...identity, [key]: typeof identity[key] === "number" ? identity[key] + 1 : "stale" };
      const result = transitionWorkflowDispatch(current, { type, identity: stale }, 200);
      assert.equal(result.state, current, key);
      assert.deepEqual(result.effects, [], key);
    }
    const changed = { ...current, recoveryGeneration: current.recoveryGeneration + 1 };
    assert.deepEqual(transitionWorkflowDispatch(changed, { type, identity }, 201).effects, []);
    const cancelled = cancelWorkflow(current, 202);
    assert.deepEqual(transitionWorkflowDispatch(cancelled, { type, identity }, 203).effects, []);
  }
});

test("调度决策按依赖推进，暂停、终态、压缩和已派发阶段不产生执行动作", () => {
  const initial = preparedTask();
  assert.deepEqual(selectWorkflowScheduleEffect(initial), { kind: "dispatch-task", taskId: "first" });
  for (const phase of ["dispatching", "queued", "uncertain"]) {
    assert.equal(selectWorkflowScheduleEffect({ ...initial, handoff: { ...initial.handoff, phase } }), undefined);
  }
  for (const status of ["paused", "completed", "cancelled"]) {
    assert.equal(selectWorkflowScheduleEffect({ ...initial, status }), undefined);
  }
  assert.equal(selectWorkflowScheduleEffect({ ...initial, continuation: { kind: "schedule", phase: "compacting" } }), undefined);
  assert.equal(selectWorkflowScheduleEffect({ ...initial, handoff: { ...initial.handoff, taskId: "second" } }), undefined);
  const pending = structuredClone(initial);
  pending.currentTaskId = undefined;
  delete pending.handoff;
  pending.tasks[0].status = "pending";
  assert.deepEqual(selectWorkflowScheduleEffect(pending), { kind: "start-task", taskId: "first" });
  pending.tasks[0].status = "completed";
  assert.deepEqual(selectWorkflowScheduleEffect(pending), { kind: "start-task", taskId: "second" });
  const replan = replanHarness().state.workflowState;
  assert.deepEqual(selectWorkflowScheduleEffect(replan), { kind: "replan" });
  for (const phase of ["dispatching", "queued", "compacting"]) {
    assert.equal(selectWorkflowScheduleEffect({ ...replan, continuation: { ...replan.continuation, phase } }), undefined);
  }
});

test("派发后崩溃恢复为结果未知，显式确认重试使用全新尝试身份", () => {
  const initial = preparedTask();
  const identity = workflowHandoffIdentity(initial);
  const dispatching = transitionWorkflowDispatch(initial, { type: "task-dispatch-requested", identity }, 102).state;
  const recovered = recoverWorkflowState(dispatching, "test-session", 103);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.value.status, "paused");
  assert.equal(recovered.value.tasks[0].outcomeUnknown, true);
  assert.equal(selectWorkflowScheduleEffect(recovered.value), undefined);
  assert.throws(() => retryWorkflowTask(recovered.value, "first", 104), /显式确认/);
  const retried = retryWorkflowTask(recovered.value, "first", 104, { confirmUnknownOutcome: true });
  const next = startWorkflowTask(retried, "first", 105);
  assert.notEqual(next.handoff.attemptId, identity.attemptId);
  assert.notEqual(next.handoff.handoffId, identity.handoffId);
  assert.deepEqual(transitionWorkflowDispatch(next, { type: "task-started", identity }, 106).effects, []);
  assert.equal(next.handoff.phase, "prepared");
});

test("重规划发送过程中切换身份，迟到排队回执不覆盖新状态", () => {
  let replacement;
  const h = replanHarness({ send: ({ state }) => {
    replacement = { ...state.workflowState, recoveryGeneration: state.workflowState.recoveryGeneration + 1 };
    state.workflowState = replacement;
  } });
  assert.equal(h.messages.sendWorkflowReplanMessage(h.ctx), true);
  assert.equal(h.state.workflowState, replacement);
  assert.equal(h.state.workflowState.continuation.phase, "dispatching");
  assert.equal(h.persisted.length, 1);
});
