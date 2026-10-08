import assert from "node:assert/strict";
import test from "node:test";
import {
  blockWorkflowTask,
  createWorkflowState,
  markWorkflowTaskOutcomeUnknown,
  markWorkflowTaskStarted,
  setWorkflowHandoffPhase,
  startWorkflowTask,
} from "../src/workflow.ts";
import { createWorkflowPauseView } from "../extensions/workflow-pause-view.ts";

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
