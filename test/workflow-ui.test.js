import assert from "node:assert/strict";
import test from "node:test";
import {
  beginWorkflowDelegation,
  createWorkflowState,
  emitExtensionEvent,
  createExtensionHarness,
  markWorkflowTaskStarted,
  startWorkflowTask,
} from "./helpers.js";

test("协作工作流显示后台运行状态并在会话关闭时清理", async () => {
  const planned = createWorkflowState({
    executor: "collaboration",
    summary: "后台状态反馈",
    tasks: [{ id: "task", role: "developer-test", task: "等待协作 Agent", files: ["src/task/"], acceptanceCriteria: ["完成"] }],
  }, 100);
  const started = markWorkflowTaskStarted(startWorkflowTask(planned, "task", 110), "task", 120);
  const running = beginWorkflowDelegation(started, {
    taskId: "task",
    requestId: "request-1",
    type: "collaboration",
  }, 125);
  const harness = createExtensionHarness([
    { type: "custom", customType: "pi-init-workflow", data: running },
  ], { mode: "rpc" });

  await emitExtensionEvent(harness, "session_start");

  const status = [...harness.statusCalls].reverse().find((call) => call.name === "pi-init-workflow");
  assert.ok(status);
  assert.match(status.text, /协作 Agent/);
  assert.match(status.text, /0\/1/);
  assert.match(status.text, /task/);

  await emitExtensionEvent(harness, "session_shutdown");
  assert.equal(harness.statusCalls.at(-1)?.name, "pi-init-workflow");
  assert.equal(harness.statusCalls.at(-1)?.text, undefined);
});
