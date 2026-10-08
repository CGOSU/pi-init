import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowState, hydrateWorkflowState } from "../src/workflow.js";
import {
  createExtensionHarness,
  emitExtensionEvent,
  withTempDirectory,
} from "./helpers.js";

function localWorkflow() {
  return createWorkflowState({
    summary: "历史工作流",
    sessionId: "test-session",
    tasks: [{
      id: "prepare",
      task: "准备变更",
      files: ["src/example.js"],
      acceptanceCriteria: ["状态可安全恢复"],
    }],
  });
}

function assertHydrationError(state, expectedCode) {
  const result = hydrateWorkflowState(state);
  assert.equal(result.ok, false);
  assert.equal(result.code, expectedCode);
  assert.equal(typeof result.message, "string");
}

test("工作流 hydration 结构化区分已退役 Runtime、未知 executor 与损坏状态", () => {
  const local = localWorkflow();
  const restored = hydrateWorkflowState(JSON.parse(JSON.stringify(local)));
  assert.equal(restored.ok, true);
  assert.equal(restored.value.executor, "local");

  assertHydrationError({ ...local, executor: "runtime", authority: "local" }, "WORKFLOW_STATE_RUNTIME_RETIRED");
  assertHydrationError({ ...local, executor: "local", authority: "runtime" }, "WORKFLOW_STATE_RUNTIME_RETIRED");
  assertHydrationError({
    ...local,
    executor: "local",
    authority: "local",
    runtimeAuthority: { kind: "runtime", status: "unknown" },
  }, "WORKFLOW_STATE_RUNTIME_RETIRED");
  assertHydrationError({ ...local, version: 1, executor: "runtime" }, "WORKFLOW_STATE_RUNTIME_RETIRED");
  assertHydrationError({ ...local, executor: "subagents" }, "WORKFLOW_EXECUTOR_INVALID");
  assertHydrationError({ ...local, tasks: [] }, "WORKFLOW_STATE_INVALID");
  assertHydrationError(null, "WORKFLOW_STATE_INVALID_TYPE");
});

test("已保存 Runtime workflow 仅报告恢复错误，不本地重放或改写 session entry", async () => {
  await withTempDirectory(async (cwd) => {
    const data = {
      ...localWorkflow(),
      executor: "runtime",
      authority: "runtime",
      runtimeAuthority: {
        kind: "runtime",
        endpoint: "127.0.0.1:7878",
        status: "running",
      },
    };
    const originalData = structuredClone(data);
    const entry = { type: "custom", customType: "pi-init-workflow", data };
    const harness = createExtensionHarness([entry], { cwd, trusted: true, mode: "rpc" });
    await emitExtensionEvent(harness, "session_start");

    const taskWorkflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const status = await taskWorkflow.execute("retired-status", { action: "status" }, undefined, undefined, harness.context);
    assert.equal(status.details.error.code, "WORKFLOW_STATE_RUNTIME_RETIRED");
    assert.match(status.content[0].text, /WORKFLOW_STATE_RUNTIME_RETIRED/);
    assert.ok(harness.notifications.some(({ message }) => message.includes("WORKFLOW_STATE_RUNTIME_RETIRED")));
    assert.ok(harness.statusCalls.some(({ text }) => text?.includes("WORKFLOW_STATE_RUNTIME_RETIRED")));

    await harness.commands.get("fast").handler("continue old work", harness.context);
    assert.ok(harness.notifications.some(({ message }) => message.includes("/fast 不会启动新任务")));
    assert.deepEqual(harness.sentMessages, []);

    await assert.rejects(
      taskWorkflow.execute("retired-resume", { action: "resume" }, undefined, undefined, harness.context),
      (error) => error.code === "WORKFLOW_STATE_RUNTIME_RETIRED",
    );
    assert.equal(harness.branch.length, 1);
    assert.deepEqual(harness.branch[0], entry);
    assert.deepEqual(harness.branch[0].data, originalData);
    assert.deepEqual(harness.sentMessages, []);
  });
});
