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

test("角色配置先写会话，显式保存才落盘", async () => {
  await withTempDirectory(async (directory) => {
    const configPath = path.join(directory, ".pi", "role-models.json");
    const original = `${JSON.stringify(DEFAULT_ROLE_CONFIG, null, 2)}\n`;
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, original, "utf8");

    const harness = createExtensionHarness([], { cwd: directory, trusted: true });
    const choices = ["始终编排", "保持主会话顺序执行"];
    harness.context.ui.select = async () => choices.shift();
    const command = harness.commands.get("pi-init");
    assert.ok(command);

    await command.handler("config workflow", harness.context);
    assert.equal(await readFile(configPath, "utf8"), original);
    assert.match(harness.notifications.at(-1)?.message ?? "", /当前会话工作流/);

    await command.handler("save", harness.context);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.workflowMode, "on");
    assert.equal(saved.workflowExecutor, "local");
    assert.match(harness.notifications.at(-1)?.message ?? "", /已保存角色配置/);
  });
});

test("角色切换压缩等待 agent 完全结束而不是回合结束", async () => {
  const architectModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
  const developerModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
  const harness = createExtensionHarness([], {
    model: architectModel,
    availableModels: [architectModel, developerModel],
  });
  let compactCalls = 0;
  harness.context.compact = () => {
    compactCalls++;
  };

  const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
  assert.ok(switchRole);
  await switchRole.execute("architect", { role: "architect" }, undefined, undefined, harness.context);
  harness.context.getContextUsage = () => ({ percent: 60 });
  await switchRole.execute("developer-test", { role: "developer-test" }, undefined, undefined, harness.context);

  await emitExtensionEvent(harness, "turn_end");
  assert.equal(compactCalls, 0);
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(compactCalls, 1);
});

test("角色切换遇到 Pi 已完成的自动压缩时不重复压缩", async () => {
  const architectModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
  const developerModel = { provider: "openai-codex", id: "gpt-5.6-luna" };
  const harness = createExtensionHarness([{ type: "compaction" }], {
    model: architectModel,
    availableModels: [architectModel, developerModel],
  });
  let compactCalls = 0;
  harness.context.compact = () => {
    compactCalls++;
  };
  const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
  assert.ok(switchRole);

  await switchRole.execute("architect", { role: "architect" }, undefined, undefined, harness.context);
  harness.context.getContextUsage = () => ({ percent: 60 });
  await switchRole.execute("developer-test", { role: "developer-test" }, undefined, undefined, harness.context);
  await emitExtensionEvent(harness, "agent_settled");

  assert.equal(compactCalls, 0);
  assert.equal(harness.context.model.id, developerModel.id);
  assert.equal(harness.notifications.some(({ message }) => message.includes("Already compacted")), false);
});

test("扩展注册工作流工具、命令和生命周期处理器", async () => {
  const harness = createExtensionHarness();
  const toolNames = harness.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, ["init_project", "switch_role", "task_workflow"]);
  assert.ok(harness.commands.has("pi-init"));
  assert.ok(harness.handlers.has("session_start"));
  assert.ok(harness.handlers.has("input"));
  assert.ok(harness.handlers.has("agent_start"));
  assert.ok(harness.handlers.has("agent_settled"));
  assert.ok(harness.renderers.has("pi-init-run-timing"));

  const workflowTool = harness.tools.find((tool) => tool.name === "task_workflow");
  assert.ok(workflowTool);
  assert.equal(typeof workflowTool.renderResult, "function");
  const status = await workflowTool.execute("status", { action: "status" }, undefined, undefined, harness.context);
  assert.match(status.content[0].text, /当前没有活动工作流/);

  const state = createWorkflowState({
    summary: "注册行为测试",
    tasks: [{ id: "task", task: "验证注册", files: ["test"], acceptanceCriteria: ["通过"] }],
  });
  const activeHarness = createExtensionHarness([
    { type: "custom", customType: "pi-init-workflow", data: state },
  ]);
  await emitExtensionEvent(activeHarness, "session_start");
  assert.equal(activeHarness.sentMessages[0].message.customType, "pi-init-workflow-task");
  assert.match(activeHarness.sentMessages[0].message.content, /验证注册/);
});

test("自动跨角色且上下文达到阈值时才触发压缩", () => {
  assert.equal(ROLE_SWITCH_COMPACTION_THRESHOLD, 50);
  const usage = { percent: 50 };

  assert.equal(
    shouldCompactOnRoleSwitch({
      mode: "auto",
      previousRole: "architect",
      nextRole: "developer-test",
      contextUsage: usage,
    }),
    true,
  );
  assert.equal(
    shouldCompactOnRoleSwitch({
      mode: "auto",
      previousRole: "architect",
      nextRole: "architect",
      contextUsage: { percent: 90 },
    }),
    false,
  );
  assert.equal(
    shouldCompactOnRoleSwitch({
      mode: "auto",
      previousRole: undefined,
      nextRole: "architect",
      contextUsage: usage,
    }),
    false,
  );
  assert.equal(
    shouldCompactOnRoleSwitch({
      mode: "confirm",
      previousRole: "architect",
      nextRole: "developer-test",
      contextUsage: { percent: 90 },
    }),
    false,
  );
  assert.equal(
    shouldCompactOnRoleSwitch({
      mode: "auto",
      previousRole: "architect",
      nextRole: "developer-test",
      contextUsage: { percent: 49.9 },
    }),
    false,
  );
  assert.equal(
    shouldCompactOnRoleSwitch({
      mode: "auto",
      previousRole: "architect",
      nextRole: "developer-test",
      contextUsage: { percent: null },
    }),
    false,
  );
});

test("精确模型引用拒绝模糊名称且不再依赖 Provider 白名单", () => {
  assert.deepEqual(normalizeModelReference("openai-codex/gpt-5.6-luna"), {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
  });
  assert.deepEqual(normalizeModelReference("openrouter/anthropic/claude-haiku-4.5"), {
    provider: "openrouter",
    model: "anthropic/claude-haiku-4.5",
  });
  assert.deepEqual(normalizeModelReference({ provider: "openai-codex", id: "gpt-5.6-luna" }), {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
  });
  assert.throws(() => normalizeModelReference("haiku"), /必须显式指定 provider\/model/);
  assert.throws(() => normalizeModelReference("sonnet"), /必须显式指定 provider\/model/);
  assert.throws(() => normalizeModelReference("/model"), /必须显式指定 provider\/model/);
  assert.throws(() => normalizeModelReference("provider/"), /必须显式指定 provider\/model/);
  assert.deepEqual(
    resolveRoleConfig({
      providerPolicy: { mode: "locked", allowedProviders: ["openai-codex"] },
      architect: { provider: "openrouter", model: "claude", thinkingLevel: "max" },
    }).architect,
    { provider: "openrouter", model: "claude", thinkingLevel: "max" },
  );
  assert.equal(resolveRoleConfig(undefined).providerPolicy, undefined);
});

test("职责模型配置支持默认值、覆盖和校验", () => {
  assert.equal(resolveRoleMode(undefined), "auto");
  assert.equal(resolveRoleMode({ mode: "manual" }), "manual");
  assert.throws(() => resolveRoleMode({ mode: "sometimes" }), /职责切换模式无效/);
  assert.equal(resolveWorkflowMode(undefined), DEFAULT_WORKFLOW_MODE);
  assert.equal(resolveWorkflowMode({ workflowMode: "off" }), "off");
  assert.equal(resolveWorkflowMode({ workflowMode: "on" }), "on");
  assert.equal(resolveWorkflowMode({ workflowMode: "auto" }), "auto");
  assert.throws(() => resolveWorkflowMode({ workflowMode: "sometimes" }), /workflowMode 无效/);
  assert.equal(resolveWorkflowMode({ workflowEnabled: true }), "on");
  assert.equal(resolveWorkflowMode({ workflowEnabled: false }), "off");
  assert.equal(resolveWorkflowMode({ workflowMode: "auto", workflowEnabled: false }), "auto");
  assert.equal(resolveWorkflowExecutor(undefined), DEFAULT_WORKFLOW_EXECUTOR);
  assert.equal(resolveWorkflowExecutor({ workflowExecutor: "local" }), "local");
  assert.equal(resolveWorkflowExecutor({ workflowExecutor: "subtask" }), "subtask");
  assert.equal(resolveWorkflowExecutor({ workflowExecutor: "subagents" }), "subtask");
  assert.throws(() => resolveWorkflowExecutor({ workflowExecutor: "remote" }), /workflowExecutor 无效/);
  assert.throws(
    () => resolveWorkflowMode({ workflowEnabled: "yes" }),
    /workflowEnabled.*布尔值/,
  );
  assert.equal(shouldOrchestrateWorkflow({ mode: "off", taskCount: 1 }), false);
  assert.equal(shouldOrchestrateWorkflow({ mode: "off", taskCount: 3 }), false);
  assert.equal(shouldOrchestrateWorkflow({ mode: "on", taskCount: 1 }), true);
  assert.equal(shouldOrchestrateWorkflow({ mode: "on", taskCount: 12 }), true);
  assert.equal(shouldOrchestrateWorkflow({ mode: "auto", taskCount: 1 }), false);
  assert.equal(shouldOrchestrateWorkflow({ mode: "auto", taskCount: 2 }), false);
  assert.equal(shouldOrchestrateWorkflow({ mode: "auto", taskCount: 3 }), true);
  assert.throws(
    () => shouldOrchestrateWorkflow({ mode: "auto", taskCount: 0 }),
    /工作流任务数无效/,
  );
  assert.equal(resolveRoleConfig({ workflowExecutor: "subagents" }).workflowExecutor, "subtask");
  assert.deepEqual(resolveRoleModel(undefined, "architect"), DEFAULT_ROLE_MODELS.architect);
  assert.deepEqual(
    resolveRoleModel(
      {
        "docs-commit": {
          provider: "custom",
          model: "writer",
          thinkingLevel: "low",
        },
      },
      "docs-commit",
    ),
    { provider: "custom", model: "writer", thinkingLevel: "low" },
  );
  assert.throws(
    () => resolveRoleModel({ architect: { provider: "", model: "x", thinkingLevel: "max" } }, "architect"),
    /provider 无效/,
  );
});

