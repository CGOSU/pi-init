import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowState, getNextWorkflowTask, hydrateWorkflowState, startWorkflowTask, completeWorkflowTask, blockWorkflowTask, setWorkflowHandoffPhase, markWorkflowTaskStarted, cloneState, requestWorkflowReplan, markWorkflowTaskOutcomeUnknown, applyWorkflowReplan } from "../src/workflow.ts";
import { requestWorkflowGoal, createWorkflowGoalState, workflowGoalProgress } from "../src/workflow-goals.ts";
import { createWorkflowStatusView } from "../extensions/workflow-status-view.ts";
import { formatWorkflowGoalTreeText, formatWorkflowStatusText } from "../extensions/workflow-status-renderer.ts";

function task(id, priority = 0, dependsOn = []) { return { id, task: id, files: ["src"], acceptanceCriteria: ["已验证"], priority, dependsOn }; }
function root() { return createWorkflowState({ summary: "原始目标", sessionId: "flat-session", tasks: [task("original")] }, 100); }
test("扁平队列先满足依赖再按优先级，同优先级保持原顺序", () => {
  const state = createWorkflowState({ summary: "优先级", sessionId: "flat-session", tasks: [task("first"), task("urgent", 5), task("dependent", 10, ["first"]), task("same", 5)] }, 100);
  assert.equal(getNextWorkflowTask(state).id, "urgent");
  const started = startWorkflowTask(state, "urgent", 101);
  assert.equal(getNextWorkflowTask(started), undefined, "新任务不抢占正在执行的任务");
});
test("任务优先级与归属字段不得被恢复静默丢弃", () => {
  const state = createWorkflowState({ summary: "恢复", sessionId: "flat-session", tasks: [task("urgent", 5)] }, 100);
  assert.equal(state.tasks[0].priority, 5);
  const restored = hydrateWorkflowState(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.ok, true);
  assert.equal(restored.value.tasks[0].priority, 5);
});

function insert(state = root(), options = {}) {
  const requested = requestWorkflowGoal(state, { direction: "插入新目标" }, 101);
  return createWorkflowGoalState(requested, { summary: "新目标", tasks: [task("inserted", 1)], retainTaskIds: state.tasks.filter(task => task.status === "pending").map(task => task.id), ...options }, 102);
}
function complete(state, id, now = 110) {
  const started = markWorkflowTaskStarted(setWorkflowHandoffPhase(startWorkflowTask(state, id, now), "queued", now + 1), id, now + 2);
  return completeWorkflowTask(started, { taskId: id, completionSummary: "已交付", implementationRationale: "按共享队列执行", verification: ["实际验证通过"] }, now + 3);
}
test("插入目标保留工作流身份、原任务和父计划，不创建运行栈", () => {
  const original = root(); const snapshot = structuredClone(original);
  const result = insert(original);
  assert.equal(result.workflowId, original.workflowId);
  assert.equal(result.planVersion, original.planVersion + 1);
  assert.equal(result.plan.summary, original.plan.summary);
  assert.equal(result.parentStack, undefined);
  assert.deepEqual(result.tasks[0], original.tasks[0]);
  assert.equal(result.tasks[1].goalId, result.goals[0].id);
  assert.equal(result.goals[0].parentId, original.workflowId);
  assert.equal(getNextWorkflowTask(result).id, "inserted");
  assert.deepEqual(original, snapshot);
  assert.equal(hydrateWorkflowState(result).ok, true);
});
test("分组不是调度栈；插入任务可依赖原任务，完成分组不等于父目标完成", () => {
  const result = insert(root(), { tasks: [task("inserted", 5, ["original"])] });
  assert.equal(getNextWorkflowTask(result).id, "original");
  const afterOriginal = complete(result, "original");
  assert.equal(getNextWorkflowTask(afterOriginal).id, "inserted");
  assert.equal(workflowGoalProgress(afterOriginal)[0].status, "pending");
  const independent = insert(); const afterGroup = complete(independent, "inserted");
  assert.equal(workflowGoalProgress(afterGroup)[0].status, "completed");
  assert.equal(afterGroup.status, "running");
  assert.equal(getNextWorkflowTask(afterGroup).id, "original");
});
test("目标可多级归属，但不产生多层执行器或父计划快照", () => {
  const first = insert();
  const request = requestWorkflowGoal(first, { direction: "细化目标", parentGoalId: first.goals[0].id }, 120);
  const next = createWorkflowGoalState(request, { summary: "细分目标", tasks: [task("sub")], retainTaskIds: ["original", "inserted"] }, 121);
  assert.equal(next.workflowId, first.workflowId);
  assert.equal(next.parentStack, undefined);
  assert.equal(next.goals[1].parentId, first.goals[0].id);
  assert.equal(workflowGoalProgress(next)[0].total, 2);
  const copy = cloneState(next); copy.goals[0].constraints.push("不影响原记录");
  assert.equal(next.goals[0].constraints.length, 0);
  assert.equal(hydrateWorkflowState(next).ok, true);
});
test("不允许静默丢弃原任务、复用 ID、无效归属或非整数优先级", () => {
  assert.throws(() => insert(root(), { retainTaskIds: [] }), /retainTaskIds/);
  assert.throws(() => insert(root(), { tasks: [task("original")] }), /复用/);
  assert.throws(() => createWorkflowState({ summary: "错误", sessionId: "s", tasks: [task("bad", NaN)] }), /priority/);
  const state = insert(); state.tasks[1].goalId = "missing";
  assert.equal(hydrateWorkflowState(state).ok, false);
  const cycle = insert(); cycle.goals[0].parentId = cycle.goals[0].id;
  assert.equal(hydrateWorkflowState(cycle).ok, false);
});
test("暂停任务可以规划插入目标，但不会自动重试或假定副作用已消失", () => {
  let paused = root(); paused = markWorkflowTaskStarted(setWorkflowHandoffPhase(startWorkflowTask(paused, "original", 103), "queued", 104), "original", 105);
  paused = blockWorkflowTask(paused, { taskId: "original", reason: "保留现场，需要先处理其他目标" }, 106);
  const queued = insert(paused);
  assert.equal(queued.tasks[0].status, "blocked");
  const finished = complete(queued, "inserted", 120);
  assert.equal(finished.status, "paused");
  assert.equal(finished.pauseReason, "dependency-blocked");
  assert.equal(finished.tasks[0].status, "blocked");
});

test("旧嵌套状态不再恢复为扁平队列，原数据保持不变", () => {
  const root = createWorkflowState({ summary: "flat", sessionId: "flat-session", tasks: [task("old-root")] });
  const source = { ...root, version: 6, parentStack: [{ state: root }] };
  const before = structuredClone(source);
  assert.equal(hydrateWorkflowState(source).code, "WORKFLOW_FEATURE_RETIRED");
  assert.deepEqual(source, before);
});test("目标分组按验收汇总展示，不把分组结束当作父目标成功", () => {
  const queued = insert(); const next = complete(queued, "inserted");
  const view = createWorkflowStatusView(next, { roleCompactionPhase: "idle", workflowDispatchInFlight: false }, 120);
  const text = formatWorkflowGoalTreeText(view);
  assert.match(text, /共享队列，不挂起父目标/);
  assert.match(text, /新目标 · 已验收 · 1\/1/);
  assert.doesNotMatch(text, /等待子目标/);
  assert.match(formatWorkflowStatusText(view), /目标归属 JSON/);
  assert.equal(next.status, "running");
  next.tasks[1].verification = [];
  assert.equal(workflowGoalProgress(next)[0].status, "review-required");
});
test("发现原任务失效可将插入请求转成普通重规划，不需要重试或取消丢进度", () => {
  const requested = requestWorkflowGoal(root(), { direction: "插入检查" }, 101);
  const replanned = requestWorkflowReplan(requested, { direction: "检查发现原任务必须替换" }, 102);
  assert.equal(replanned.pendingRevision.kind, "replan");
  assert.equal(replanned.pendingRevision.childGoal, undefined);
  assert.match(replanned.pendingRevision.direction, /插入检查/);
  assert.match(replanned.pendingRevision.direction, /原任务必须替换/);
  assert.ok(replanned.recoveryGeneration > requested.recoveryGeneration);
  assert.equal(replanned.tasks[0].status, "pending");
  assert.equal(hydrateWorkflowState(replanned).ok, true);
});

test("撤销目标只通过普通重规划调整队列，保留原任务并审计替换记录", () => {
  const queued = insert(); const original = queued.tasks[0];
  const request = requestWorkflowReplan(queued, { direction: "撤销新目标的未执行任务" }, 130);
  const next = applyWorkflowReplan(request, { revisionId: request.pendingRevision.revisionId, summary: queued.plan.summary, tasks: [], retainTaskIds: ["original"] }, 131);
  assert.equal(next.tasks.length, 1);
  assert.deepEqual(next.tasks[0], original);
  assert.equal(next.status, "running");
  assert.equal(next.revisions.at(-1).replacedTasks[0].status, "superseded");
  assert.equal(workflowGoalProgress(next)[0].status, "inactive");
  assert.equal(hydrateWorkflowState(next).ok, true);
  queued.tasks[0].dependsOn = ["inserted"];
  const unsafe = requestWorkflowReplan(queued, { direction: "撤销被依赖任务" }, 132);
  assert.throws(() => applyWorkflowReplan(unsafe, { revisionId: unsafe.pendingRevision.revisionId, summary: queued.plan.summary, tasks: [], retainTaskIds: ["original"] }, 133), /依赖不存在/);
});

test("归属分组本身不改变调度，省略优先级的新任务追加到同级队尾", () => {
  const requested = requestWorkflowGoal(root(), { direction: "普通追加目标" }, 101);
  const next = createWorkflowGoalState(requested, { summary: "普通目标", tasks: [{ ...task("normal"), priority: undefined }], retainTaskIds: ["original"] }, 102);
  assert.equal(next.tasks[1].priority, 0);
  assert.equal(getNextWorkflowTask(next).id, "original");
});

test("未知结果不能通过替换任务绕过显式副作用核对，审计仍保留未知标记", () => {
  const unknown = markWorkflowTaskOutcomeUnknown(startWorkflowTask(root(), "original", 103), { taskId: "original", reason: "执行结果未确认" }, 104);
  const requested = requestWorkflowReplan(unknown, { direction: "调整方案" }, 105);
  const input = { revisionId: requested.pendingRevision.revisionId, summary: "新方案", tasks: [task("replacement")] };
  assert.throws(() => applyWorkflowReplan(requested, input, 106), { code: "WORKFLOW_UNKNOWN_OUTCOME_CONFIRMATION_REQUIRED" });
  const next = applyWorkflowReplan(requested, { ...input, confirmUnknownOutcome: true, reason: "已查询旧操作状态，确认新任务不会重放已发生写操作" }, 107);
  assert.equal(next.revisions.at(-1).replacedTasks[0].outcomeUnknown, true);
  assert.match(next.revisions.at(-1).direction, /已查询旧操作状态/);
  assert.equal(hydrateWorkflowState(next).ok, true);
});
