import assert from "node:assert/strict";
import test from "node:test";

import { createWorkflowState } from "../src/workflow.ts";
import { createWorkflowReport } from "../extensions/workflow-report.ts";
import { createExtensionHarness } from "./helpers.js";

test("打开的进度面板按最新持久状态刷新任务集合与状态", async () => {
  const state = {
    workflowState: createWorkflowState({
      summary: "动态进度视图",
      sessionId: "live-view-session",
      tasks: [
        {
          id: "parent-task",
          task: "推进父层工作",
          files: ["src/parent.ts"],
          acceptanceCriteria: ["父任务完成"],
        },
        {
          id: "parent-next",
          task: "继续父层计划",
          files: ["src/parent-next.ts"],
          acceptanceCriteria: ["父计划继续"],
        },
      ],
    }),
    roleModeStatus: "auto",
  };
  let before = "";
  let after = "";
  let childLayer = "";
  const harness = createExtensionHarness([], {
    mode: "tui",
    hasUI: true,
    custom: async (call) => {
      before = call.component.render(100).join("\n");
      call.component.handleInput("\u001b[B");
      state.workflowState = {
        ...state.workflowState,
        tasks: [
          { ...state.workflowState.tasks[0], status: "completed", completionSummary: "父层已恢复" },
          { ...state.workflowState.tasks[1], status: "pending" },
          {
            id: "child-task",
            task: "动态新增的子工作流任务",
            role: "developer-test",
            files: ["src/child.ts"],
            acceptanceCriteria: ["子目标完成"],
            dependsOn: [],
            status: "in_progress",
          },
        ],
        currentTaskId: "child-task",
      };
      after = call.component.render(100).join("\n");
      state.workflowState = {
        ...state.workflowState,
        workflowId: "child-workflow",
        tasks: [
          { ...state.workflowState.tasks[1], task: "子层同名任务", status: "pending" },
          state.workflowState.tasks[2],
        ],
        currentTaskId: "child-task",
      };
      childLayer = call.component.render(100).join("\n");
    },
  });
  const report = createWorkflowReport(state, { pi: {}, roleRuntime: { refreshRoleStatus() {} } });

  await report.showWorkflowProgress(harness.context);

  assert.match(before, /parent-task/);
  assert.doesNotMatch(before, /child-task/);
  assert.match(after, /child-task/);
  assert.match(after, /✓ 已完成 · parent-task/);
  assert.match(after, /当前任务：动态新增的子工作流任务/);
  assert.match(after, /已完成 1\/3/);
  assert.match(after, /→ .*parent-next/);
  assert.doesNotMatch(after, /→ .*child-task/);

  assert.match(childLayer, /→ .*child-task/);
  assert.doesNotMatch(childLayer, /→ .*parent-next/);
});

test("Enter 打开任务详情，Esc 分层返回后才关闭", async () => {
  const state = { workflowState: createWorkflowState({ sessionId: "test-session", summary: "交互检查", tasks: [{ id: "first", task: "需要查看的任务", files: ["src/first.ts"], acceptanceCriteria: ["展示完整验收标准"] }] }), roleModeStatus: "auto" };
  const harness = createExtensionHarness([], { mode: "tui", hasUI: true, custom: async (call) => {
    call.component.render(80);
    call.component.handleInput("\r");
    assert.notEqual(call.done, true, "Enter 不应关闭面板");
    assert.match(call.component.render(80).join("\n"), /展示完整验收标准/);
    call.component.handleInput("\u001b");
    assert.notEqual(call.done, true, "详情 Esc 返回任务列表");
    call.component.handleInput("\u001b");
    assert.equal(call.done, true);
  } });
  await createWorkflowReport(state, { pi: {}, roleRuntime: { refreshRoleStatus() {} } }).showWorkflowProgress(harness.context);
});
