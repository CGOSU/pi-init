import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";

const {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  os,
  path,
  initProjectExtension,
  installLaunchers,
  dateRange,
  formatReport,
  PI_USAGE_VERSION,
  queryUsage,
  shouldRefreshUsage,
  summarizeUsage,
  createScaffold,
  formatEnvironmentInstructions,
  DEFAULT_ROLE_CONFIG,
  DEFAULT_ROLE_MODELS,
  DEFAULT_WORKFLOW_EXECUTOR,
  DEFAULT_WORKFLOW_MODE,
  ROLE_LABELS,
  ROLE_MODE_LABELS,
  ROLE_SWITCH_COMPACTION_THRESHOLD,
  THINKING_LEVELS,
  filterRoleModels,
  findMatchingRole,
  normalizeModelReference,
  resolveRoleConfig,
  resolveRoleMode,
  resolveWorkflowExecutor,
  resolveWorkflowMode,
  resolveRoleModel,
  shouldOrchestrateWorkflow,
  shouldCompactOnRoleSwitch,
  WORKFLOW_MAX_NUDGES,
  WORKFLOW_MAX_TASKS,
  blockWorkflowTask,
  beginWorkflowDelegation,
  cancelWorkflow,
  completeWorkflowTask,
  createWorkflowState,
  getNextWorkflowTask,
  getWorkflowTask,
  getWorkflowTaskDuration,
  getWorkflowExecutionBounds,
  getWorkflowExecutionDuration,
  hydrateWorkflowState,
  markWorkflowTaskStarted,
  recordWorkflowNudge,
  requestWorkflowReplan,
  applyWorkflowReplan,
  resumeWorkflow,
  retryWorkflowTask,
  startWorkflowTask,
  validateWorkflowPlan,
  requestWorkflowDelegationStop,
  workflowProgress,
  SUBTASK_RESULT_MAX_BYTES,
  SUBTASK_RESULT_PROTOCOL,
  extractSubtaskResultJson,
  parseSubtaskResult,
  completeRunTiming,
  createRunTiming,
  getRunTimingDuration,
  isExternalRunSource,
  normalizeNewlines,
  withTempDirectory,
  createExtensionHarness,
  emitExtensionEvent,
  runExternalAgent,
  assertSkillMatchesRoleConfig,
} = helpers;

test("活动 subtask 工作流和会话中断不会伪造普通执行报告", async () => {
  const workflow = beginWorkflowDelegation(
    startWorkflowTask(
      createWorkflowState({
        executor: "subtask",
        summary: "委派任务",
        tasks: [{ id: "task", task: "执行任务", files: ["src"], acceptanceCriteria: ["完成"] }],
      }, 100),
      "task",
      110,
    ),
    { taskId: "task", requestId: "request", type: "workflow-developer" },
    120,
  );
  const branch = [{ type: "custom", customType: "pi-init-workflow", data: workflow }];
  const workflowHarness = createExtensionHarness(branch, { activeTools: ["subtask"] });
  await emitExtensionEvent(workflowHarness, "session_tree");
  await runExternalAgent(workflowHarness, "rpc");
  assert.equal(workflowHarness.entries.length, 0);

  const interruptedHarness = createExtensionHarness();
  await emitExtensionEvent(interruptedHarness, "input", { source: "interactive" });
  await emitExtensionEvent(interruptedHarness, "before_agent_start");
  await emitExtensionEvent(interruptedHarness, "agent_start");
  await emitExtensionEvent(interruptedHarness, "session_shutdown");
  await emitExtensionEvent(interruptedHarness, "agent_settled");
  assert.equal(interruptedHarness.entries.length, 0);
});

test("subtask 执行器派发对话 fork，缺少工具阻塞，结果回传后自动推进", async () => {
  const workflow = createWorkflowState({
    executor: "subtask",
    summary: "委派实现任务",
    tasks: [{ id: "implementation", task: "实现特性", files: ["src/feature.js"], acceptanceCriteria: ["测试通过"] }],
  }, 100);
  const harness = createExtensionHarness(
    [{ type: "custom", customType: "pi-init-workflow", data: workflow }],
    { activeTools: ["subtask"] },
  );
  await emitExtensionEvent(harness, "session_tree");
  await emitExtensionEvent(harness, "agent_settled");

  assert.equal(harness.sentMessages.length, 1);
  const dispatch = harness.sentMessages[0].message;
  assert.equal(dispatch.customType, "pi-init-subtask-dispatch");
  assert.equal(dispatch.display, false);
  assert.match(dispatch.content, /PI-INIT SUBTASK WORKFLOW/);
  assert.match(dispatch.content, /task 参数必须原样使用下面整段文本/);
  assert.match(dispatch.content, /实现特性/);
  const dispatchedState = harness.entries.findLast((entry) => entry.type === "pi-init-workflow")?.data;
  assert.equal(dispatchedState.currentTaskId, "implementation");
  assert.equal(dispatchedState.tasks[0].delegation.status, "spawning");

  const prompt = dispatch.content.split("（逐字不变，不要改写、截断或概括）：\n\n")[1].split("\n\n调用 subtask 工具后")[0];
  const branch = harness.context.sessionManager.getBranch();
  branch.push({
    type: "custom_message",
    customType: "subtask-result",
    details: {
      name: "pi-init-subtask-dispatch",
      task: prompt,
      status: "done",
      resultText: JSON.stringify({
        protocol: SUBTASK_RESULT_PROTOCOL,
        outcome: "complete",
        completionSummary: "特性已实现",
        verification: ["npm test：通过"],
      }),
    },
  });
  await emitExtensionEvent(harness, "agent_settled");
  const finished = harness.entries.findLast((entry) => entry.type === "pi-init-workflow")?.data;
  assert.equal(finished.status, "completed");
  assert.equal(finished.tasks[0].status, "completed");
  assert.equal(finished.tasks[0].completionSummary, "特性已实现");
  assert.equal(finished.tasks[0].delegation.status, "completed");

  const missingToolHarness = createExtensionHarness(
    [{ type: "custom", customType: "pi-init-workflow", data: workflow }],
    { activeTools: [] },
  );
  await emitExtensionEvent(missingToolHarness, "session_tree");
  await emitExtensionEvent(missingToolHarness, "agent_settled");
  assert.equal(missingToolHarness.sentMessages.length, 0);
  assert.match(missingToolHarness.notifications.at(-1)?.message ?? "", /subtask 工具/);
  const blocked = missingToolHarness.entries.findLast((entry) => entry.type === "pi-init-workflow")?.data;
  assert.equal(blocked.status, "paused");
  assert.equal(blocked.tasks[0].delegation, undefined);
});

test("普通方向描述会被记录，并在架构重规划后才调度新的本地任务", async () => {
  const architectModel = { provider: "openai-codex", id: "gpt-5.6-terra" };
  const developerModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
  const state = createWorkflowState({
    summary: "原始工作流",
    tasks: [
      { id: "current", task: "当前实现", files: ["src/current.js"], acceptanceCriteria: ["完成"] },
      { id: "old-next", task: "旧后续任务", files: ["src/old-next.js"], acceptanceCriteria: ["完成"] },
    ],
  }, 100);
  const harness = createExtensionHarness(
    [{ type: "custom", customType: "pi-init-workflow", data: state }],
    {
      model: developerModel,
      availableModels: [developerModel, architectModel],
      trusted: true,
    },
  );
  await emitExtensionEvent(harness, "session_start");
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0].message.customType, "pi-init-workflow-task");

  const inputHandler = harness.handlers.get("input")?.[0];
  const inputResult = await inputHandler(
    { text: "新增缓存回归测试", source: "interactive", streamingBehavior: "followUp" },
    harness.context,
  );
  assert.equal(inputResult.action, "handled");
  assert.equal(harness.sentMessages.length, 1);
  const requested = harness.entries.findLast((entry) => entry.type === "pi-init-workflow")?.data;
  assert.equal(requested.status, "running");
  assert.equal(requested.currentTaskId, "current");
  assert.equal(requested.pendingRevision.direction, "新增缓存回归测试");

  const workflowTool = harness.tools.find((tool) => tool.name === "task_workflow");
  await workflowTool.execute("complete-current", {
    action: "complete",
    taskId: "current",
    completionSummary: "当前实现完成",
    verification: ["npm test：通过"],
  }, undefined, undefined, harness.context);
  const waiting = harness.entries.findLast((entry) => entry.type === "pi-init-workflow")?.data;
  assert.equal(waiting.status, "replanning");
  assert.equal(waiting.tasks.some((task) => task.id === "old-next"), true);
  assert.equal(harness.sentMessages.length, 1);

  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(harness.sentMessages.length, 2);
  assert.equal(harness.sentMessages[1].message.customType, "pi-init-workflow-replan");
  assert.match(harness.sentMessages[1].message.content, /新增缓存回归测试/);
  assert.match(harness.sentMessages[1].message.content, /revisionId/);
  assert.equal(harness.context.model.id, architectModel.id);

  await workflowTool.execute("apply-replan", {
    action: "replan",
    revisionId: waiting.pendingRevision.revisionId,
    summary: "缓存扩展后的工作流",
    constraints: [],
    tasks: [{
      id: "cache-tests",
      task: "新增缓存回归测试",
      files: ["test/cache.test.js"],
      acceptanceCriteria: ["测试通过"],
    }],
  }, undefined, undefined, harness.context);
  const applied = harness.entries.findLast((entry) => entry.type === "pi-init-workflow")?.data;
  assert.equal(applied.status, "running");
  assert.equal(applied.tasks.some((task) => task.id === "old-next"), false);

  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(harness.sentMessages.length, 3);
  assert.equal(harness.sentMessages[2].message.customType, "pi-init-workflow-task");
  assert.match(harness.sentMessages[2].message.content, /新增缓存回归测试/);
  assert.doesNotMatch(harness.sentMessages[2].message.content, /旧后续任务/);
  assert.equal(harness.aborts.length, 0);
});

test("subtask 结果遇到方向变更后不重派旧任务并进入架构重规划", async () => {
  const architectModel = { provider: "openai-codex", id: "gpt-5.6-terra" };
  const developerModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
  const state = createWorkflowState({
    executor: "subtask",
    summary: "委派工作流",
    tasks: [{ id: "delegated", task: "委派实现", files: ["src/delegated.js"], acceptanceCriteria: ["完成"] }],
  }, 100);
  const harness = createExtensionHarness(
    [{ type: "custom", customType: "pi-init-workflow", data: state }],
    {
      model: developerModel,
      availableModels: [developerModel, architectModel],
      activeTools: ["subtask"],
      trusted: true,
    },
  );
  await emitExtensionEvent(harness, "session_start");
  assert.equal(harness.sentMessages.length, 1);
  const dispatch = harness.sentMessages[0].message;
  const prompt = dispatch.content.split("（逐字不变，不要改写、截断或概括）：\n\n")[1].split("\n\n调用 subtask 工具后")[0];

  const inputHandler = harness.handlers.get("input")?.[0];
  const inputResult = await inputHandler(
    { text: "把后续改为缓存方案", source: "rpc", streamingBehavior: "followUp" },
    harness.context,
  );
  assert.equal(inputResult.action, "handled");
  const requested = harness.entries.findLast((entry) => entry.type === "pi-init-workflow")?.data;
  assert.equal(requested.pendingRevision.direction, "把后续改为缓存方案");

  harness.context.sessionManager.getBranch().push({
    type: "custom_message",
    customType: "subtask-result",
    details: {
      name: "pi-init-subtask-dispatch",
      task: prompt,
      status: "done",
      resultText: JSON.stringify({
        protocol: SUBTASK_RESULT_PROTOCOL,
        outcome: "complete",
        completionSummary: "委派实现完成",
        verification: ["npm test：通过"],
      }),
    },
  });
  await emitExtensionEvent(harness, "agent_settled");
  const waiting = harness.entries.findLast((entry) => entry.type === "pi-init-workflow")?.data;
  assert.equal(waiting.status, "replanning");
  assert.equal(harness.sentMessages.length, 2);
  assert.equal(harness.sentMessages[1].message.customType, "pi-init-workflow-replan");
  assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-subtask-dispatch").length, 1);
  assert.equal(harness.aborts.length, 0);
});

test("重规划恢复可自动进入架构师，角色校验失败时安全停在边界", async () => {
  const architectModel = { provider: "openai-codex", id: "gpt-5.6-terra" };
  const developerModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
  const requested = requestWorkflowReplan(
    createWorkflowState({
      summary: "恢复测试",
      tasks: [{ id: "future", task: "旧未来任务", files: ["src/future.js"], acceptanceCriteria: ["完成"] }],
    }, 100),
    { revisionId: "revision-reload", direction: "新增恢复任务" },
    110,
  );
  const workflowEntry = { type: "custom", customType: "pi-init-workflow", data: requested };
  const restoredHarness = createExtensionHarness([workflowEntry], {
    model: developerModel,
    availableModels: [developerModel, architectModel],
    trusted: true,
  });
  await emitExtensionEvent(restoredHarness, "session_start");
  assert.equal(restoredHarness.sentMessages.length, 1);
  assert.equal(restoredHarness.sentMessages[0].message.customType, "pi-init-workflow-replan");
  assert.match(restoredHarness.sentMessages[0].message.content, /新增恢复任务/);
  assert.equal(restoredHarness.entries.length, 0);

  const manualHarness = createExtensionHarness([workflowEntry], {
    model: developerModel,
    availableModels: [developerModel, architectModel],
    trusted: true,
  });
  await manualHarness.commands.get("pi-init").handler("mode manual", manualHarness.context);
  await emitExtensionEvent(manualHarness, "session_start");
  assert.equal(manualHarness.sentMessages.length, 0);
  assert.match(manualHarness.notifications.at(-1)?.message ?? "", /架构师重规划/);

  const confirmHarness = createExtensionHarness([workflowEntry], {
    model: developerModel,
    availableModels: [developerModel, architectModel],
    hasUI: false,
    trusted: true,
  });
  await confirmHarness.commands.get("pi-init").handler("mode confirm", confirmHarness.context);
  await emitExtensionEvent(confirmHarness, "session_start");
  assert.equal(confirmHarness.sentMessages.length, 0);
  assert.match(confirmHarness.notifications.at(-1)?.message ?? "", /无法确认/);

  const workflowTool = manualHarness.tools.find((tool) => tool.name === "task_workflow");
  await assert.rejects(
    () => workflowTool.execute("replan-role", {
      action: "replan",
      revisionId: "revision-reload",
      summary: "不应应用",
      tasks: [{ id: "new-task", task: "新任务", files: ["src/new.js"], acceptanceCriteria: ["完成"] }],
    }, undefined, undefined, manualHarness.context),
    /只有架构角色/,
  );
});

