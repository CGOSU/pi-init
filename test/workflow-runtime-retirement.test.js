import assert from "node:assert/strict";
import test from "node:test";
import { cancelWorkflow, createWorkflowState, hydrateWorkflowState, startWorkflowTask, workflowActionIdentity, workflowHandoffIdentity } from "../src/workflow.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowCompaction } from "../extensions/workflow-compaction.ts";
import { createWorkflowDispatch } from "../extensions/workflow-dispatch.ts";
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

test("显式命令和工具取消都清除工作流状态段", async () => {
  for (const source of ["command", "tool"]) {
    await withTempDirectory(async (cwd) => {
      const initial = createWorkflowState({
        summary: `显式取消 ${source}`,
        sessionId: "test-session",
        reviewRequired: true,
        tasks: [{ id: "task", task: "等待审阅", files: ["src/task.js"], acceptanceCriteria: ["完成"] }],
      }, 100);
      const harness = createExtensionHarness([{
        type: "custom",
        customType: "pi-init-workflow",
        data: initial,
      }], { cwd, trusted: true, mode: "rpc" });
      await emitExtensionEvent(harness, "session_start");
      const currentStatus = () => harness.statusCalls
        .filter(({ name }) => name === "pi-init-activity")
        .at(-1)?.text ?? "";
      assert.match(currentStatus(), /已暂停/);

      if (source === "command") {
        await harness.commands.get("pi-init").handler("workflow cancel", harness.context);
      } else {
        const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
        const current = harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow").data;
        const result = await workflow.execute("explicit-cancel", {
          action: "cancel",
          workflowId: current.workflowId,
          planVersion: current.planVersion,
          sessionId: current.sessionId,
          recoveryGeneration: current.recoveryGeneration,
        }, undefined, undefined, harness.context);
        assert.match(result.content[0].text, /工作流已取消/);
      }

      const persisted = harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow")?.data;
      assert.equal(persisted.status, "cancelled");
      assert.doesNotMatch(currentStatus(), /已暂停|\b\d+\/\d+\b/);
    });
  }
});

test("AbortSignal 仅中止本次工作流工具操作，不改变暂停工作流", async () => {
  await withTempDirectory(async (cwd) => {
    const initial = createWorkflowState({
      summary: "中止工具调用",
      sessionId: "test-session",
      reviewRequired: true,
      tasks: [{ id: "task", task: "保持暂停", files: ["src/task.js"], acceptanceCriteria: ["完成"] }],
    }, 100);
    const harness = createExtensionHarness([{
      type: "custom",
      customType: "pi-init-workflow",
      data: initial,
    }], { cwd, trusted: true, mode: "rpc" });
    await emitExtensionEvent(harness, "session_start");
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const beforeEntries = harness.branch.length;
    const controller = new AbortController();
    controller.abort();

    const result = await workflow.execute("abort-operation", { action: "cancel" }, controller.signal, undefined, harness.context);
    assert.match(result.content[0].text, /本次工作流工具操作已中止；工作流状态未更改/);
    assert.equal(harness.branch.length, beforeEntries);
    assert.equal(harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow")?.data.status, "paused");
    assert.ok(harness.statusCalls.some(({ text }) => text?.includes("已暂停")));
  });
});

test("结束工作流只撤销其压缩续跑，保留真实压缩与角色恢复", async () => {
  const workflow = startWorkflowTask(createWorkflowState({
    summary: "结束时压缩仍在运行",
    sessionId: "test-session",
    tasks: [{ id: "task", role: "docs-commit", task: "待交接任务", files: ["docs/task.md"], acceptanceCriteria: ["完成"] }],
  }, 100), "task", 110);
  const state = createExtensionRuntimeState();
  state.workflowState = workflow;
  state.roleTransitionGeneration = 1;
  state.activeRole = { role: "docs-commit", provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "max" };
  const identity = workflowActionIdentity(workflow);
  const handoffIdentity = workflowHandoffIdentity(workflow);
  state.pendingRoleCompaction = {
    fromRole: "developer-test",
    toRole: "docs-commit",
    sessionId: "test-session",
    contextGeneration: state.roleContextGeneration,
    roleTransitionGeneration: 1,
    targetRole: state.activeRole,
    continuation: { kind: "workflow-task", taskId: "task", identity: handoffIdentity },
  };
  let completeCompaction;
  let dispatches = 0;
  let acknowledgements = 0;
  const notifications = [];
  const compactionStates = [];
  const ctx = {
    sessionManager: { getSessionId: () => "test-session", getBranch: () => [{ type: "user" }] },
    ui: { setStatus() {}, notify(message, level) { notifications.push({ message, level }); } },
    compact({ onComplete }) { completeCompaction = onComplete; },
  };
  const controller = createWorkflowCompaction({ sendMessage() {} }, state, {
    activityStatus: { setCompaction(_ctx, value) { compactionStates.push(value); } },
    setWorkflowDispatchInFlight() {},
    getActiveRole: () => state.activeRole,
    requireRoleRecovery() {},
    sendWorkflowTaskMessage() { dispatches++; },
    async scheduleWorkflow() {},
    sendWorkflowReplanMessage() {},
    acknowledgeRoleRecovery() { acknowledgements++; },
  }, { watchdogMs: 5 });

  assert.equal(controller.start(ctx), true);
  state.workflowState = cancelWorkflow(workflow, 120);
  assert.equal(controller.retireWorkflowContinuation(identity), true);
  assert.equal(state.roleCompactionInFlight, true);
  assert.deepEqual(compactionStates, ["compacting"]);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.roleCompactionPhase, "stalled");
  assert.doesNotMatch(notifications[0].message, /\/pi-init workflow resume/);
  assert.match(notifications[0].message, /不会派发工作流任务/);
  completeCompaction?.({});

  assert.equal(dispatches, 0);
  assert.equal(acknowledgements, 1);
  assert.equal(state.roleCompactionInFlight, false);
  assert.deepEqual(compactionStates, ["compacting", "stalled", undefined]);
});

test("迟到的重规划异常不告警旧工作流或清除新工作流调度", async () => {
  const initial = createWorkflowState({
    summary: "重规划选择迟到",
    sessionId: "test-session",
    tasks: [{ id: "task", task: "待重规划", files: ["src/task.js"], acceptanceCriteria: ["完成"] }],
  }, 100);
  const workflow = {
    ...initial,
    status: "replanning",
    pendingRevision: { revisionId: "revision-1", direction: "调整剩余任务", requestedAt: 110 },
    continuation: { kind: "replan", revisionId: "revision-1", phase: "pending", handoffId: "handoff-1" },
  };
  const state = createExtensionRuntimeState();
  state.workflowState = workflow;
  const notifications = [];
  let rejectSelection;
  const selection = new Promise((_resolve, reject) => { rejectSelection = reject; });
  const dispatch = createWorkflowDispatch(state, {
    roleRuntime: {
      activeRoleFor: () => undefined,
      automaticRole: () => selection,
    },
    messages: { sendWorkflowReplanMessage() {} },
    report: { persistWorkflowState(next) { state.workflowState = next; }, updateWorkflowStatus() {} },
    setCurrentContext() {},
  });
  const ctx = { ui: { notify(message, level) { notifications.push({ message, level }); } } };

  const dispatching = dispatch.scheduleWorkflowReplan(ctx);
  state.workflowState = cancelWorkflow(workflow, 120);
  state.workflowDispatchInFlight = false;
  state.workflowState = localWorkflow();
  state.workflowDispatchInFlight = true;
  rejectSelection(new Error("迟到的角色切换失败"));
  await dispatching;

  assert.equal(state.workflowDispatchInFlight, true);
  assert.equal(notifications.some(({ message }) => message.includes("暂停等待架构师重规划")), false);
});
