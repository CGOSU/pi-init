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

test("移除 Provider 锁后原生模型切换不再被回滚或拦截", async () => {
  const safe = { provider: "openai-codex", id: "gpt-5.6-luna" };
  const other = { provider: "openrouter", id: "anthropic/claude-haiku-4.5" };

  const restored = createExtensionHarness([], {
    model: other,
    availableModels: [other, safe],
    trusted: true,
  });
  await emitExtensionEvent(restored, "session_start");
  assert.deepEqual(restored.context.model, other);
  assert.equal(restored.aborts.length, 0);

  const switched = createExtensionHarness([], {
    model: other,
    availableModels: [other, safe],
    trusted: true,
  });
  await emitExtensionEvent(switched, "model_select", {
    model: other,
    previousModel: safe,
    source: "set",
  });
  assert.deepEqual(switched.context.model, other);
  assert.equal(switched.aborts.length, 0);

  const inputHandler = (switched.handlers.get("input") ?? [])[0];
  assert.deepEqual(
    await inputHandler({ source: "interactive", text: "继续工作" }, switched.context),
    { action: "continue" },
  );

  const status = switched.statusCalls.filter((call) => call.name === "pi-init").at(-1);
  assert.match(status?.text ?? "", /claude-haiku-4\.5/);
});

test("手动模式原生模型切换写回配置且不重复写入", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, ".pi"), { recursive: true });
    await writeFile(path.join(directory, ".pi", "role-models.json"), JSON.stringify({ mode: "manual" }));

    const safe = { provider: "openai-codex", id: "gpt-5.6-luna" };
    const unsafe = { provider: "openrouter", id: "anthropic/claude-haiku-4.5" };
    const harness = createExtensionHarness([], {
      cwd: directory,
      model: safe,
      availableModels: [safe, unsafe],
      trusted: true,
    });
    await emitExtensionEvent(harness, "session_start");
    assert.deepEqual(harness.context.model, safe);

    harness.context.model = unsafe;
    await emitExtensionEvent(harness, "model_select", { model: unsafe, previousModel: safe, source: "user" });
    assert.deepEqual(harness.context.model, unsafe);

    const piInitStatus = harness.statusCalls.filter((call) => call.name === "pi-init").at(-1);
    assert.match(piInitStatus?.text ?? "", /claude-haiku-4\.5/);
    assert.match(piInitStatus?.text ?? "", /手动/);

    const persisted = JSON.parse(await readFile(path.join(directory, ".pi", "role-models.json"), "utf8"));
    assert.deepEqual(persisted["developer-test"], {
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
      thinkingLevel: "max",
    });
    assert.equal(persisted.providerPolicy, undefined);
    assert.match(harness.notifications.at(-1)?.message ?? "", /已写入 \.pi\/role-models\.json/);

    const notificationsBefore = harness.notifications.length;
    const fileBefore = await readFile(path.join(directory, ".pi", "role-models.json"), "utf8");
    await emitExtensionEvent(harness, "model_select", { model: unsafe, previousModel: unsafe, source: "user" });
    assert.equal(harness.notifications.length, notificationsBefore);
    assert.equal(await readFile(path.join(directory, ".pi", "role-models.json"), "utf8"), fileBefore);

    const inputHandler = (harness.handlers.get("input") ?? [])[0];
    assert.deepEqual(
      await inputHandler({ source: "interactive", text: "继续" }, harness.context),
      { action: "continue" },
    );

  });
});

test("手动模式下无活动角色的原生切换只提示不写文件", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, ".pi"), { recursive: true });
    await writeFile(path.join(directory, ".pi", "role-models.json"), JSON.stringify({ mode: "manual" }));

    const model = { provider: "openai-codex", id: "gpt-5.6-luna" };
    const harness = createExtensionHarness([], {
      cwd: directory,
      model,
      availableModels: [model],
      trusted: true,
      thinkingLevel: "off",
    });
    await emitExtensionEvent(harness, "session_start");

    const next = { provider: "openrouter", id: "anthropic/claude-haiku-4.5" };
    harness.context.model = next;
    await emitExtensionEvent(harness, "model_select", { model: next, previousModel: model, source: "user" });

    const persisted = JSON.parse(await readFile(path.join(directory, ".pi", "role-models.json"), "utf8"));
    assert.deepEqual(persisted, { mode: "manual" });
    assert.match(harness.notifications.at(-1)?.message ?? "", /无活动角色/);
  });
});

test("角色模型选择器展示全部已注册模型并可暂存跨 Provider 选择", async () => {
  const safe = { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" };
  const other = { provider: "openrouter", id: "anthropic/claude-sonnet-4", name: "Sonnet" };
  const harness = createExtensionHarness([], {
    model: safe,
    availableModels: [safe, other],
    trusted: true,
    input: async () => "",
    select: async (title, items) => title.startsWith("选择 架构设计 模型")
      ? items.find((item) => item.includes("openrouter")) ?? items[0]
      : title.startsWith("推理强度")
        ? items[0]
        : undefined,
  });
  const command = harness.commands.get("pi-init");
  await command.handler("config architect", harness.context);

  assert.equal(harness.selectCalls[0]?.title, "选择 架构设计 模型");
  assert.ok(harness.selectCalls[0].items.some((item) => item.includes("openrouter")));
  assert.match(harness.notifications.at(-1)?.message ?? "", /已暂存/);
});

test("TUI 工作流状态使用弹窗并显示任务进度", async () => {
  const state = createWorkflowState({
    summary: "冻结认证改造",
    reviewRequired: true,
    tasks: [
      { id: "schema", task: "更新结构", files: ["src/schema.js"], acceptanceCriteria: ["测试通过"] },
      { id: "docs", task: "更新文档", files: ["README.md"], acceptanceCriteria: ["文档同步"], role: "docs-commit", dependsOn: ["schema"] },
    ],
  }, 100);
  state.startedAt = 115;
  state.updatedAt = 125;
  state.tasks[0] = {
    ...state.tasks[0],
    status: "completed",
    startedAt: 115,
    completedAt: 125,
    completionSummary: "结构完成",
  };
  const harness = createExtensionHarness(
    [{ type: "custom", customType: "pi-init-workflow", data: state }],
    {
      mode: "tui",
      custom: async (call) => {
        call.component.handleInput("\u001b");
        assert.equal(call.done, true);
      },
    },
  );
  await emitExtensionEvent(harness, "session_start");
  await harness.commands.get("pi-init").handler("workflow status", harness.context);

  assert.equal(harness.customCalls.length, 1);
  assert.equal(harness.customCalls[0].options.overlay, true);
  assert.equal(harness.customCalls[0].options.overlayOptions.anchor, "center");
  assert.equal(harness.customCalls[0].options.overlayOptions.width, "80%");
  const rendered = harness.customCalls[0].component.render(100).join("\n");
  const narrowRendered = harness.customCalls[0].component.render(60).join("\n");
  assert.match(rendered, /┌/);
  assert.match(rendered, /│/);
  assert.match(rendered, /工作流任务进度/);
  assert.match(rendered, /冻结认证改造/);
  assert.match(rendered, /总任务开始时间\s+.*1970/);
  assert.match(rendered, /总任务已运行时间\s+10 毫秒/);
  assert.match(rendered, /已完成 · schema\s+耗时：10 毫秒/);
  assert.match(narrowRendered, /已完成 · schema\s+耗时：10 毫秒/);
  assert.match(rendered, /暂停原因  architecture-review/);
  assert.match(rendered, /待处理 · docs/);
});

test("非 TUI 工作流状态继续使用通知文本", async () => {
  const state = createWorkflowState({
    summary: "冻结认证改造",
    tasks: [{ id: "schema", task: "更新结构", files: ["src/schema.js"], acceptanceCriteria: ["测试通过"] }],
  }, 100);
  state.status = "completed";
  state.startedAt = 115;
  state.completedAt = 125;
  state.tasks[0] = {
    ...state.tasks[0],
    status: "completed",
    startedAt: 115,
    completedAt: 125,
    completionSummary: "结构完成",
  };
  const harness = createExtensionHarness(
    [{ type: "custom", customType: "pi-init-workflow", data: state }],
    { mode: "rpc" },
  );
  await emitExtensionEvent(harness, "session_start");
  await harness.commands.get("pi-init").handler("workflow status", harness.context);

  assert.equal(harness.customCalls.length, 0);
  assert.match(harness.notifications.at(-1)?.message ?? "", /状态：completed/);
  assert.match(harness.notifications.at(-1)?.message ?? "", /总任务开始时间：.*1970/);
  assert.match(harness.notifications.at(-1)?.message ?? "", /总任务已运行时间：10 毫秒/);
  assert.match(harness.notifications.at(-1)?.message ?? "", /- \[completed\] schema.*耗时：10 毫秒/);
});

test("活动工作流状态显示当前已运行时间", async () => {
  const startedAt = Date.now() - 2_000;
  const state = createWorkflowState({
    summary: "运行时间测试",
    tasks: [{ id: "schema", task: "执行任务", files: ["src/schema.js"], acceptanceCriteria: ["测试通过"] }],
  }, startedAt - 100);
  state.status = "running";
  state.startedAt = startedAt;
  state.currentTaskId = "schema";
  state.tasks[0] = {
    ...state.tasks[0],
    status: "in_progress",
    startedAt,
    executionStartedAt: startedAt,
  };
  const harness = createExtensionHarness([
    { type: "custom", customType: "pi-init-workflow", data: state },
  ]);
  await emitExtensionEvent(harness, "session_start");
  await harness.commands.get("pi-init").handler("workflow status", harness.context);

  const message = harness.notifications.at(-1)?.message ?? "";
  assert.match(message, /总任务已运行时间：(?:\d+ 秒|\d+ 毫秒)/);
});

test("task_workflow 区分中间任务和最终工作流报告并保留样式", () => {
  const harness = createExtensionHarness();
  const workflowTool = harness.tools.find((tool) => tool.name === "task_workflow");
  assert.ok(workflowTool);
  const theme = {
    fg: (color, text) => `<${color}>${text}</${color}>`,
    bold: (text) => `<bold>${text}</bold>`,
  };
  const planned = createWorkflowState({
    summary: "冻结认证改造",
    tasks: [
      { id: "schema", task: "更新结构", files: ["src/schema.js"], acceptanceCriteria: ["测试通过"] },
      { id: "docs", task: "更新文档", files: ["README.md"], acceptanceCriteria: ["文档同步"], dependsOn: ["schema"] },
    ],
  }, 100);
  const firstStarted = markWorkflowTaskStarted(startWorkflowTask(planned, "schema", 110), "schema", 115);
  const intermediate = completeWorkflowTask(
    firstStarted,
    { taskId: "schema", completionSummary: "结构完成", verification: ["npm test：通过"] },
    125,
  );
  const finalStarted = markWorkflowTaskStarted(startWorkflowTask(intermediate, "docs", 150), "docs", 155);
  const completed = completeWorkflowTask(
    finalStarted,
    { taskId: "docs", completionSummary: "文档完成", verification: ["git diff --check：通过"] },
    175,
  );

  const taskReport = [
    "任务完成报告",
    "任务：schema · 更新结构",
    "总耗时：10 毫秒",
    "摘要：结构完成",
  ].join("\n");
  const taskRendered = workflowTool.renderResult(
    { isError: false, content: [{ type: "text", text: taskReport }], details: intermediate },
    { expanded: false },
    theme,
  ).render(240).join("\n");
  assert.match(taskRendered, /<accent><bold>◆ 任务完成报告<\/bold><\/accent>/);
  assert.match(taskRendered, /<warning><bold>总耗时：10 毫秒<\/bold><\/warning>/);
  assert.doesNotMatch(taskRendered, /工作流完成报告/);
  assert.doesNotMatch(taskRendered, /整体总耗时/);

  const workflowReport = [
    "工作流完成报告",
    "目标：冻结认证改造",
    "进度：2/2",
    "任务摘要：",
    "- schema：结构完成",
    "- docs：文档完成",
    "开始时间：1970-01-01 00:00:00+00:00",
    "结束时间：1970-01-01 00:00:00+00:00",
    "总耗时：60 毫秒",
    "验证：",
    "- schema：npm test：通过",
    "- docs：git diff --check：通过",
  ].join("\n");
  const workflowRendered = workflowTool.renderResult(
    { isError: false, content: [{ type: "text", text: workflowReport }], details: completed },
    { expanded: false },
    theme,
  ).render(240).join("\n");
  assert.match(workflowRendered, /<accent><bold>◆ 工作流完成报告<\/bold><\/accent>/);
  assert.match(workflowRendered, /<success><bold>目标：冻结认证改造<\/bold><\/success>/);
  assert.match(workflowRendered, /<success><bold>进度：2\/2<\/bold><\/success>/);
  assert.match(workflowRendered, /<success><bold>任务摘要：<\/bold><\/success>/);
  assert.match(workflowRendered, /<success><bold>验证：<\/bold><\/success>/);
  assert.match(workflowRendered, /<warning><bold>总耗时：60 毫秒<\/bold><\/warning>/);
  assert.match(workflowRendered, /开始时间：1970-01-01 00:00:00\+00:00/);
  assert.match(workflowRendered, /结束时间：1970-01-01 00:00:00\+00:00/);
  assert.match(workflowRendered, /schema：结构完成/);
  assert.match(workflowRendered, /docs：git diff --check：通过/);
});

