import assert from "node:assert/strict";
import test from "node:test";
import {
  blockWorkflowTask,
  completeWorkflowTask,
  createWorkflowState,
  markWorkflowTaskStarted,
  setWorkflowHandoffPhase,
  startWorkflowTask,
} from "../src/workflow.ts";
import { createWorkflowReport } from "../extensions/workflow-report.ts";
import { createExtensionHarness, emitExtensionEvent, workflowMessageIdentity, withTempDirectory } from "./helpers.js";

function createCompletedWorkflow() {
  const plan = createWorkflowState({
    summary: "报告格式测试",
    sessionId: "test-session",
    tasks: [
      { id: "completed", task: "已完成任务的长描述", files: ["src/completed.js"], acceptanceCriteria: ["完成"] },
      { id: "blocked", task: "被阻塞任务", files: ["src/blocked.js"], acceptanceCriteria: ["解除阻塞"] },
      { id: "legacy-blocked", task: "历史阻塞任务", files: ["src/legacy.js"], acceptanceCriteria: ["保留原因"] },
    ],
  }, 100);
  const completed = completeWorkflowTask(
    markWorkflowTaskStarted(
      setWorkflowHandoffPhase(startWorkflowTask(plan, "completed", 110), "queued"),
      "completed",
      111,
    ),
    {
      taskId: "completed",
      completionSummary: "重复展示时应隐藏的完整完成摘要",
      implementationRationale: "保持报告审阅价值",
      verification: ["针对性测试通过"],
    },
    120,
  );
  return completed;
}

function createActiveWorkflow() {
  return markWorkflowTaskStarted(
    setWorkflowHandoffPhase(startWorkflowTask(createCompletedWorkflow(), "blocked", 130), "queued"),
    "blocked",
    131,
  );
}

function createBlockedHistory() {
  const blocked = blockWorkflowTask(createActiveWorkflow(), { taskId: "blocked", reason: "缺少产品决策" }, 140);
  return {
    ...blocked,
    tasks: blocked.tasks.map((task) => task.id === "legacy-blocked"
      ? { ...task, status: "blocked", blockReason: undefined }
      : task),
  };
}

test("暂停摘要精简已完成任务内容且保留全部真实阻塞原因和恢复建议", () => {
  const workflowState = createBlockedHistory();
  const report = createWorkflowReport({ workflowState }, { pi: {}, roleRuntime: {} });
  const pauseSummary = report.formatWorkflowPauseSummary(workflowState);

  assert.match(pauseSummary, /工作流已暂停/);
  assert.equal((pauseSummary.match(/缺少产品决策/g) ?? []).length, 1);
  assert.match(pauseSummary, /未记录（历史状态未保存阻塞原因）/);
  assert.equal((pauseSummary.match(/建议解决方法：/g) ?? []).length, 2);
  assert.match(pauseSummary, /\/pi-init workflow retry blocked/);
  assert.match(pauseSummary, /\/pi-init workflow retry legacy-blocked/);
  assert.doesNotMatch(pauseSummary, /已完成任务的长描述|重复展示时应隐藏的完整完成摘要/);

  const fullStatus = report.formatWorkflowState(workflowState);
  assert.match(fullStatus, /已完成任务的长描述/);
  assert.match(fullStatus, /重复展示时应隐藏的完整完成摘要/);
});

test("block 工具结果精简且不会再发出重复阻塞通知", async () => {
  await withTempDirectory(async (directory) => {
    const active = createCompletedWorkflow();
    const harness = createExtensionHarness([
      { type: "custom", customType: "pi-init-workflow", data: active },
    ], { cwd: directory, trusted: true });
    await emitExtensionEvent(harness, "session_start");
    await emitExtensionEvent(harness, "agent_start");
    const taskWorkflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const result = await taskWorkflow.execute("block-test", {
      ...workflowMessageIdentity(harness),
      action: "block",
      taskId: "blocked",
      reason: "缺少产品决策",
    }, undefined, undefined, harness.context);

    const content = result.content[0].text;
    assert.equal((content.match(/缺少产品决策/g) ?? []).length, 1);
    assert.equal((content.match(/建议解决方法：/g) ?? []).length, 1);
    assert.match(content, /建议解决方法：/);
    assert.doesNotMatch(content, /已完成任务的长描述|重复展示时应隐藏的完整完成摘要/);
    assert.equal(harness.notifications.some(({ message }) => message.includes("缺少产品决策")), false);
    assert.equal(harness.notifications.some(({ message }) => message.includes("/pi-init workflow retry blocked")), false);
    assert.equal(result.details.tasks.find((task) => task.id === "completed").completionSummary, "重复展示时应隐藏的完整完成摘要");
  });
});
