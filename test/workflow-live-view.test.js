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
      tasks: [{
        id: "parent-task",
        task: "推进父层工作",
        files: ["src/parent.ts"],
        acceptanceCriteria: ["父任务完成"],
      }],
    }),
    roleModeStatus: "auto",
  };
  let before = "";
  let after = "";
  const harness = createExtensionHarness([], {
    mode: "tui",
    hasUI: true,
    custom: async (call) => {
      before = call.component.render(100).join("\n");
      state.workflowState = {
        ...state.workflowState,
        tasks: [
          { ...state.workflowState.tasks[0], status: "completed", completionSummary: "父层已恢复" },
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
    },
  });
  const report = createWorkflowReport(state, { pi: {}, roleRuntime: { refreshRoleStatus() {} } });

  await report.showWorkflowProgress(harness.context);

  assert.match(before, /parent-task/);
  assert.doesNotMatch(before, /child-task/);
  assert.match(after, /child-task/);
  assert.match(after, /✓ 已完成 · parent-task/);
  assert.match(after, /当前任务位置/);
});
