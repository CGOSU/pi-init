import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowState } from "../src/workflow.ts";
import {
  createWorkflowCompletionView,
  createWorkflowTaskCompletionView,
} from "../extensions/workflow-completion-view.ts";
import {
  formatWorkflowCompletionText,
  formatWorkflowTaskCompletionText,
} from "../extensions/workflow-completion-renderer.ts";

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
  const text = formatWorkflowTaskCompletionText(view);
  assert.match(text, /耗时：0 毫秒/);
  assert.match(text, /npm test：失败：1 个测试失败/);
  assert.doesNotMatch(text, /node --test：通过|验证全部通过|0 errors/);
  assert.deepEqual(task, before);
});

test("缺失任务时间不伪装成零耗时，失败验证缺失时省略验证报告", () => {
  const view = createWorkflowTaskCompletionView(completedTask({
    startedAt: undefined,
    completedAt: 150,
    verification: ["node --test：通过"],
  }));
  assert.deepEqual(view.duration, { kind: "unavailable", reason: "missing-or-invalid-time" });
  const text = formatWorkflowTaskCompletionText(view);
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
  const text = formatWorkflowCompletionText(view);
  assert.match(text, /最终任务[\s\S]*ID：task-final/);
  assert.doesNotMatch(text, /task-later/);
  assert.match(text, /总耗时：60 毫秒/);
});

test("缺失整体时间保留不可用原因且没有完成任务时不捏造任务摘要", () => {
  const state = createWorkflowState({
    summary: "保留历史边界",
    sessionId: "missing-time-session",
    tasks: [{ id: "pending", task: "待执行", files: ["src/pending.ts"], acceptanceCriteria: ["执行"] }],
  }, 100);
  const view = createWorkflowCompletionView({ ...state, status: "completed" });
  const text = formatWorkflowCompletionText(view);
  assert.equal(view.finalTask, undefined);
  assert.match(text, /内容：无/);
  assert.match(text, /开始时间：不可用（工作流未记录有效的开始时间）/);
  assert.match(text, /结束时间：不可用（工作流未记录有效的结束时间）/);
  assert.match(text, /总耗时：不可用（工作流缺少有效的整体开始或结束时间）/);
});
