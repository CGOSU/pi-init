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
  withTempDirectory,
  createExtensionHarness,
  emitExtensionEvent,
  runExternalAgent,
} = helpers;

test("生成默认文件结构并引用公共角色 Skill", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "example-app");
    const result = await createScaffold(target, { projectName: "Example App" });

    assert.deepEqual(result.files, [
      "AGENTS.md",
      "docs/clean-code.md",
      "docs/current-state.md",
      "docs/decisions.md",
      "docs/session-log.md",
      "docs/pitfalls.md",
      ".pi/role-models.json",
    ]);
    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    const cleanCode = await readFile(path.join(target, "docs/clean-code.md"), "utf8");
    const roleModels = JSON.parse(await readFile(path.join(target, ".pi/role-models.json"), "utf8"));
    await assert.rejects(
      readFile(path.join(target, ".pi/skills/example-app/SKILL.md"), "utf8"),
      { code: "ENOENT" },
    );
    assert.match(agents, /^# Example App AI 协作指南/);
    assert.match(agents, /## 运行环境与命令约定/);
    assert.match(agents, new RegExp("`" + process.platform + "`"));
    assert.match(agents, new RegExp("`" + process.arch + "`"));
    if (process.platform === "win32") {
      assert.match(agents, /`where\.exe`/);
      assert.match(agents, /Linux-only 的 `which`/);
    }
    assert.match(agents, /git config user\.name CGOSU/);
    assert.match(agents, /git config user\.email dev@cgosu\.com/);
    assert.match(agents, /docs\/clean-code\.md/);
    assert.match(agents, /pi-init-role-routing/);
    assert.match(agents, /通用任务执行流程、证据门控、工具调用和角色交接规则/);
    assert.match(agents, /不要在本文件复制其内容/);
    assert.doesNotMatch(agents, /## 任务执行流程/);
    assert.doesNotMatch(agents, /## 证据与工具调用规则/);
    assert.doesNotMatch(agents, /已有新鲜且精确证据为 0 轮/);
    assert.doesNotMatch(agents, /workflowExecutor/);
    assert.doesNotMatch(agents, /task_workflow/);
    assert.doesNotMatch(agents, /\.pi\/agents\//);
    assert.match(cleanCode, /OBEY Clean Code by Robert C\. Martin/);
    assert.match(cleanCode, /Copyright \(c\) 2026 Maciej Ciemborowicz/);
    assert.match(cleanCode, /## Hard rules/);
    assert.doesNotMatch(agents, /知识库地址远程地址/);
    assert.deepEqual(roleModels, DEFAULT_ROLE_CONFIG);
    assert.deepEqual(resolveRoleConfig(undefined), DEFAULT_ROLE_CONFIG);
    assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.equal(roleModels.mode, "auto");
    assert.equal(roleModels.workflowMode, DEFAULT_WORKFLOW_MODE);
    assert.equal(roleModels.workflowExecutor, DEFAULT_WORKFLOW_EXECUTOR);
    assert.deepEqual(DEFAULT_ROLE_MODELS["developer-test"], {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinkingLevel: "max",
    });

    for (const file of result.files) {
      assert.doesNotMatch(await readFile(path.join(target, file), "utf8"), /\{\{[A-Z_]+\}\}/);
    }
  });
});

test("自定义三职责配置会同步规范化 JSON 且不生成项目级 Skill", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "custom-app");
    const roleModels = {
      mode: "confirm",
      workflowMode: "on",
      workflowExecutor: "subtask",
      architect: {
        provider: "provider-architect",
        model: "model-architect",
        thinkingLevel: "high",
      },
      "developer-test": {
        provider: "provider-developer",
        model: "model-developer",
        thinkingLevel: "low",
      },
      "docs-commit": {
        provider: "provider-docs",
        model: "model-docs",
        thinkingLevel: "minimal",
      },
    };

    await createScaffold(target, { projectName: "Custom App", roleModels });

    const config = JSON.parse(await readFile(path.join(target, ".pi/role-models.json"), "utf8"));
    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    assert.match(agents, /pi-init-role-routing/);
    await assert.rejects(
      readFile(path.join(target, ".pi/skills/custom-app/SKILL.md"), "utf8"),
      { code: "ENOENT" },
    );
    assert.deepEqual(config, resolveRoleConfig(roleModels));
    assert.equal(config.workflowMode, "on");
    assert.equal(config.workflowExecutor, "subtask");
  });
});

test("部分职责配置回退默认值且不生成项目级 Skill", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "partial-app");
    const roleModels = {
      mode: "manual",
      architect: {
        provider: "provider-architect",
        model: "model-architect",
        thinkingLevel: "xhigh",
      },
    };

    await createScaffold(target, { language: "en", roleModels });

    const config = JSON.parse(await readFile(path.join(target, ".pi/role-models.json"), "utf8"));
    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    assert.match(agents, /pi-init-role-routing/);
    await assert.rejects(
      readFile(path.join(target, ".pi/skills/partial-app/SKILL.md"), "utf8"),
      { code: "ENOENT" },
    );
    assert.deepEqual(config, resolveRoleConfig(roleModels));
    assert.deepEqual(config.roleModels["developer-test"], DEFAULT_ROLE_MODELS["developer-test"]);
    assert.deepEqual(config.roleModels["docs-commit"], DEFAULT_ROLE_MODELS["docs-commit"]);
    assert.equal(config.workflowMode, DEFAULT_WORKFLOW_MODE);
  });
});

test("无效职责配置会被拒绝", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "invalid-app");
    const roleModels = {
      architect: {
        provider: "provider",
        model: "model",
        thinkingLevel: "invalid",
      },
    };

    assert.throws(() => resolveRoleConfig(roleModels), /thinkingLevel 无效/);
    await assert.rejects(createScaffold(target, { roleModels }), /thinkingLevel 无效/);
    await assert.rejects(readFile(path.join(target, ".pi/role-models.json"), "utf8"), { code: "ENOENT" });
  });
});

test("dry-run 不创建文件并报告冲突", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "existing-app");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "AGENTS.md"), "keep?", "utf8");

    const result = await createScaffold(target, { dryRun: true });

    assert.equal(result.dryRun, true);
    assert.deepEqual(result.conflicts, ["AGENTS.md"]);
    assert.equal(await readFile(path.join(target, "AGENTS.md"), "utf8"), "keep?");
    await assert.rejects(readFile(path.join(target, "docs/current-state.md"), "utf8"), { code: "ENOENT" });
  });
});

test("重新初始化不会删除已有项目级 Skill", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "legacy-app");
    const legacySkill = path.join(target, ".pi", "skills", "legacy-role", "SKILL.md");
    await mkdir(path.dirname(legacySkill), { recursive: true });
    await writeFile(legacySkill, "keep this legacy skill", "utf8");

    await createScaffold(target, { projectName: "Legacy App" });

    assert.equal(await readFile(legacySkill, "utf8"), "keep this legacy skill");
  });
});

test("职责显示标签保留内部 ID 并提供友好中文名称", () => {
  assert.equal(ROLE_LABELS.architect, "架构设计");
  assert.equal(ROLE_MODE_LABELS.auto, "自动（推荐）");
});

test("职责模型搜索会按 provider、model 或名称过滤并保留空搜索结果", () => {
  const models = [
    { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" },
    { provider: "anthropic", id: "claude-sonnet", name: "Sonnet" },
  ];

  assert.deepEqual(filterRoleModels(models, "LUNA"), [models[0]]);
  assert.deepEqual(filterRoleModels(models, "anthropic/"), [models[1]]);
  assert.deepEqual(filterRoleModels(models, "  "), models);
  assert.deepEqual(filterRoleModels(models, "missing"), []);
});

test("恢复会话角色要求模型和推理强度唯一匹配", () => {
  const config = {
    architect: { provider: "p", model: "m-architect", thinkingLevel: "max" },
    "developer-test": { provider: "p", model: "m-developer", thinkingLevel: "max" },
    "docs-commit": { provider: "p", model: "m-docs", thinkingLevel: "medium" },
  };

  assert.equal(findMatchingRole(config, { provider: "p", id: "m-developer" }, "max"), "developer-test");
  assert.equal(findMatchingRole(config, { provider: "p", id: "m-developer" }, "medium"), undefined);
  assert.equal(
    findMatchingRole(
      { schemaVersion: 2, roleModels: { reviewer: { provider: "p", model: "m-reviewer", thinkingLevel: "high" } } },
      { provider: "p", id: "m-reviewer" },
      "high",
    ),
    "reviewer",
  );
  assert.equal(findMatchingRole(config, undefined, "max"), undefined);
  assert.equal(
    findMatchingRole(
      {
        ...config,
        architect: { provider: "p", model: "m-developer", thinkingLevel: "max" },
      },
      { provider: "p", id: "m-developer" },
      "max",
    ),
    undefined,
  );
});


test("auto 小计划绕过提示按任务角色顺序执行", async () => {
  await withTempDirectory(async (directory) => {
    const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
    const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };
    const configPath = path.join(directory, ".pi", "role-models.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      schemaVersion: 2,
      workflowMode: "auto",
      workflowExecutor: "local",
      roleModels: {
        architect: { provider: architect.provider, model: architect.id, thinkingLevel: "max" },
        "developer-test": { provider: developer.provider, model: developer.id, thinkingLevel: "max" },
      },
    }, null, 2)}\n`);
    const harness = createExtensionHarness([], {
      cwd: directory,
      trusted: true,
      model: architect,
      availableModels: [architect, developer],
    });
    await emitExtensionEvent(harness, "session_start");
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const result = await workflow.execute("plan", {
      action: "plan",
      summary: "验证 auto fast path",
      tasks: [
        { id: "implementation", task: "实现功能", files: ["src/feature.js"], acceptanceCriteria: ["测试通过"] },
        { id: "verification", task: "验证功能", files: ["test/feature.test.js"], acceptanceCriteria: ["验证通过"] },
      ],
    }, undefined, undefined, harness.context);

    assert.equal(result.details.orchestrated, false);
    assert.match(result.content[0].text, /按各任务指定的角色切换后顺序执行/);
    assert.match(result.content[0].text, /架构角色只负责规划，不直接实现/);
    assert.equal(harness.sentMessages.length, 0);
  });
});

test("重规划提示复用新鲜证据并限制定向读取", async () => {
  await withTempDirectory(async (directory) => {
    const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
    const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };
    const state = requestWorkflowReplan(
      createWorkflowState({
        summary: "重规划读取策略",
        tasks: [{ id: "current", role: "developer-test", task: "完成当前任务", files: ["src/current.js"], acceptanceCriteria: ["通过"] }],
      },
      100),
      { revisionId: "revision-read", direction: "新增后续方向" },
      110,
    );
    const harness = createExtensionHarness([
      { type: "custom", customType: "pi-init-workflow", data: state },
    ], {
      cwd: directory,
      trusted: true,
      model: architect,
      availableModels: [architect, developer],
    });

    await emitExtensionEvent(harness, "session_start");

    const message = harness.sentMessages.find(({ message: item }) => item.customType === "pi-init-workflow-replan");
    assert.ok(message);
    assert.match(message.message.content, /不为确认已知事实重复读取/);
    assert.match(message.message.content, /已知证据 0 轮/);
    assert.match(message.message.content, /安全、认证、公共 API/);
    assert.doesNotMatch(message.message.content, /请重新检查仓库和当前事实/);
  });
});

test("subtask 隐藏提示复用新鲜证据并保留高风险检查", async () => {
  await withTempDirectory(async (directory) => {
    const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
    const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };
    const state = createWorkflowState({
      summary: "subtask 读取策略",
      executor: "subtask",
      tasks: [{ id: "current", role: "developer-test", task: "完成当前任务", files: ["src/current.js"], acceptanceCriteria: ["通过"] }],
    }, 100);
    const harness = createExtensionHarness([
      { type: "custom", customType: "pi-init-workflow", data: state },
    ], {
      cwd: directory,
      trusted: true,
      model: developer,
      availableModels: [architect, developer],
      activeTools: ["subtask"],
    });

    await emitExtensionEvent(harness, "session_start");

    const message = harness.sentMessages.find(({ message: item }) => item.customType === "pi-init-subtask-dispatch");
    assert.ok(message);
    assert.match(message.message.content, /do not reread merely to confirm known facts/);
    assert.match(message.message.content, /0 rounds for sufficient evidence/);
    assert.match(message.message.content, /latest implementation, callers, and tests/);
    assert.match(message.message.content, /preflight the exact occurrence count of every oldText.*each matches exactly once.*do not call edit/);
    assert.match(message.message.content, /payload contains only path and edits.*never offset or limit.*regions do not overlap/);
    assert.match(message.message.content, /(?=.*successful edit.*logical snapshot)(?=.*oldText has zero matches.*retry at most once)(?=.*do not create cache files or persistent state)(?=.*Never use fuzzy or regex matching)/);
  });
});

test("英文模板引用公共角色 Skill 且不生成项目级 Skill", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "商城");
    const result = await createScaffold(target, {
      language: "en",
      projectName: "商城",
      description: "A customer portal.",
      testCommand: "npm test",
    });

    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    const cleanCode = await readFile(path.join(target, "docs/clean-code.md"), "utf8");
    assert.equal(result.files.some((file) => file.includes("SKILL.md")), false);
    await assert.rejects(
      readFile(path.join(target, ".pi", "skills", "mall-app", "SKILL.md"), "utf8"),
      { code: "ENOENT" },
    );
    assert.match(agents, /## Project Purpose/);
    assert.match(agents, /## Runtime Environment and Command Conventions/);
    assert.match(agents, new RegExp("`" + process.platform + "`"));
    assert.match(agents, /- Test: `npm test`/);
    assert.match(agents, /docs\/clean-code\.md/);
    assert.match(agents, /pi-init-role-routing/);
    assert.match(agents, /single source for the general task workflow, evidence gating, `read`\/`edit` invocation/);
    assert.match(agents, /load that Skill and the relevant role profile on demand/);
    assert.doesNotMatch(agents, /## Task Execution Workflow/);
    assert.doesNotMatch(agents, /## Evidence and Tool Invocation Rules/);
    assert.doesNotMatch(agents, /0 rounds when fresh/);
    assert.doesNotMatch(agents, /## Task Execution Workflow/);
    assert.doesNotMatch(agents, /workflowExecutor/);
    assert.doesNotMatch(agents, /task_workflow/);
    assert.match(cleanCode, /OBEY Clean Code by Robert C\. Martin/);
    assert.match(agents, /github\.com\/CGOSU\/knowledge\.git/);
    assert.match(agents, /git config user\.name CGOSU/);
  });
});

test("公共角色路由 Skill 随 package 发布并按角色拆分说明", async () => {
  const packageRoot = process.cwd();
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const sharedSkill = await readFile(
    path.join(packageRoot, "skills", "pi-init-role-routing", "SKILL.md"),
    "utf8",
  );
  const roleProfiles = await Promise.all([
    "architect",
    "developer-test",
    "docs-commit",
  ].map((role) => readFile(
    path.join(packageRoot, "skills", "pi-init-role-routing", "roles", `${role}.md`),
    "utf8",
  )));

  assert.ok(manifest.files.includes("skills"));
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.match(sharedSkill, /^---\nname: pi-init-role-routing\n/);
  assert.match(sharedSkill, /roleModels/);
  assert.match(sharedSkill, /switch_role/);
  assert.match(sharedSkill, /task_workflow/);
  assert.match(sharedSkill, /## 证据与工具调用/);
  assert.match(sharedSkill, /`read` 只使用 `path`、`offset` 和 `limit`/);
  assert.match(sharedSkill, /会话内逻辑快照/);
  assert.match(sharedSkill, /调用 `edit` 前.*每个 `oldText`.*恰好匹配 1 次/);
  assert.match(sharedSkill, /edit.*payload.*只允许包含 `path` 和 `edits`.*不得传入 `offset` 或 `limit`/);
  assert.match(sharedSkill, /调用前检查同一文件的 edits 区域互不重叠/);
  assert.match(sharedSkill, /`oldText` 为零匹配.*最多重试一次/);
  assert.match(roleProfiles[1], /逐项预检.*`oldText` 精确匹配 1 次/);
  assert.match(roleProfiles[1], /逻辑快照不落盘/);
  assert.match(roleProfiles[1], /oldText 零匹配执行最小重读.*最多重试一次/);
  assert.match(sharedSkill, /roles\/architect\.md/);
  assert.match(sharedSkill, /roles\/developer-test\.md/);
  assert.match(sharedSkill, /roles\/docs-commit\.md/);
  assert.doesNotMatch([...roleProfiles, sharedSkill].join("\n"), /openai-codex|gpt-5\.6/);
  assert.match(roleProfiles[0], /architect/);
  assert.match(roleProfiles[1], /developer-test/);
  assert.match(roleProfiles[2], /docs-commit/);
});
