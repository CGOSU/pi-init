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

test("生成默认文件结构和动态 Skill", async () => {
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
      ".pi/skills/example-app/SKILL.md",
    ]);
    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    const cleanCode = await readFile(path.join(target, "docs/clean-code.md"), "utf8");
    const roleModels = JSON.parse(await readFile(path.join(target, ".pi/role-models.json"), "utf8"));
    const skill = normalizeNewlines(
      await readFile(path.join(target, ".pi/skills/example-app/SKILL.md"), "utf8"),
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
    assert.match(agents, /task_workflow/);
    assert.match(agents, /自动推进/);
    assert.match(agents, /workflowExecutor/);
    assert.match(agents, /pi-init\/task-result@1/);
    assert.match(agents, /共享工作区/);
    assert.match(agents, /revisionId/);
    assert.match(agents, /task_workflow\(action="replan"\)/);
    assert.match(agents, /workflow cancel/);
    assert.match(agents, /subtask/);
    assert.doesNotMatch(agents, /pi-subagents/);
    assert.doesNotMatch(agents, /\.pi\/agents\//);
    assert.match(cleanCode, /OBEY Clean Code by Robert C\. Martin/);
    assert.match(cleanCode, /Copyright \(c\) 2026 Maciej Ciemborowicz/);
    assert.match(cleanCode, /## Hard rules/);
    assert.doesNotMatch(agents, /知识库地址远程地址/);
    assert.match(skill, /^---\nname: example-app\n/);
    assert.match(skill, /架构师.+Staff \/ Principal/);
    assert.match(skill, /开发测试工程师.+Senior \/ SDET/);
    assert.match(skill, /文档与收尾工程师.+Technical Writer \/ Release Engineer/);
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
    assert.match(skill, /openai-codex\/gpt-5\.6-sol/);
    assert.match(skill, /开发测试工程师[^\n]+openai-codex\/gpt-5\.6-luna[^\n]+`max`/);
    assert.match(skill, /文档与收尾工程师[^\n]+openai-codex\/gpt-5\.6-luna/);
    assert.match(skill, /`max`/);
    assert.match(skill, /`medium`/);
    assert.match(skill, /必须先调用 `switch_role`/);
    assert.match(skill, /task_workflow\(action=plan\)/);
    assert.match(skill, /workflowExecutor/);
    assert.match(skill, /pi-init\/task-result@1/);
    assert.match(skill, /revisionId/);
    assert.match(skill, /task_workflow\(action="replan"\)/);
    assert.match(skill, /workflow cancel/);
    assert.match(skill, /共享工作区/);
    assert.match(skill, /reviewRequired/);
    assert.match(skill, /task_workflow\(action=complete/);
    assert.match(skill, /\/pi-init workflow resume/);
    assert.match(skill, /\/pi-init config/);
    assert.doesNotMatch(skill, /parallel_develop/);
    assert.match(skill, /受信任项目/);
    assert.match(skill, /## 精确字符串替换/);
    assert.match(skill, /`oldText` → `newText`/);
    assert.match(skill, /必须在原始文件中唯一匹配/);
    assert.match(skill, /多个不相邻改动应在一次编辑中提交/);
    assert.doesNotMatch(skill, /docs\/current-state\.md/);

    for (const file of result.files) {
      assert.doesNotMatch(await readFile(path.join(target, file), "utf8"), /\{\{[A-Z_]+\}\}/);
    }
  });
});

test("自定义三职责配置会同步规范化 JSON 和中文 Skill", async () => {
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
    const skill = normalizeNewlines(
      await readFile(path.join(target, ".pi/skills/custom-app/SKILL.md"), "utf8"),
    );
    assert.deepEqual(config, resolveRoleConfig(roleModels));
    assert.equal(config.workflowMode, "on");
    assert.equal(config.workflowExecutor, "subtask");
    assertSkillMatchesRoleConfig(skill, config);
    assert.match(skill, /\/pi-init config/);
  });
});

test("部分职责配置回退默认值并同步英文 Skill", async () => {
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
    const skill = normalizeNewlines(
      await readFile(path.join(target, ".pi/skills/partial-app/SKILL.md"), "utf8"),
    );
    assert.deepEqual(config, resolveRoleConfig(roleModels));
    assert.deepEqual(config["developer-test"], DEFAULT_ROLE_MODELS["developer-test"]);
    assert.deepEqual(config["docs-commit"], DEFAULT_ROLE_MODELS["docs-commit"]);
    assert.equal(config.workflowMode, DEFAULT_WORKFLOW_MODE);
    assertSkillMatchesRoleConfig(skill, config);
    assert.match(skill, /\/pi-init config/);
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


test("英文模板和显式中文项目 slug 可用", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "商城");
    await createScaffold(target, {
      language: "en",
      projectName: "商城",
      slug: "mall-app",
      description: "A customer portal.",
      testCommand: "npm test",
    });

    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    const cleanCode = await readFile(path.join(target, "docs/clean-code.md"), "utf8");
    const skill = await readFile(path.join(target, ".pi/skills/mall-app/SKILL.md"), "utf8");
    assert.match(agents, /## Project Purpose/);
    assert.match(agents, /## Runtime Environment and Command Conventions/);
    assert.match(agents, new RegExp("`" + process.platform + "`"));
    assert.match(agents, /- Test: `npm test`/);
    assert.match(agents, /docs\/clean-code\.md/);
    assert.match(agents, /Task Execution Workflow/);
    assert.match(agents, /task_workflow/);
    assert.match(agents, /workflowExecutor/);
    assert.match(agents, /pi-init\/task-result@1/);
    assert.match(agents, /shared checkout/);
    assert.match(agents, /revisionId/);
    assert.match(agents, /task_workflow\(action="replan"\)/);
    assert.match(agents, /workflow cancel/);
    assert.match(agents, /subtask/);
    assert.doesNotMatch(agents, /pi-subagents/);
    assert.match(cleanCode, /OBEY Clean Code by Robert C\. Martin/);
    assert.match(agents, /github\.com\/CGOSU\/knowledge\.git/);
    assert.match(agents, /git config user\.name CGOSU/);
    assert.match(skill, /name: mall-app/);
    assert.match(skill, /Architect.+Staff \/ Principal/);
    assert.match(skill, /Development and Test Engineer.+Senior \/ SDET/);
    assert.match(skill, /Documentation and Wrap-up Engineer.+Technical Writer \/ Release Engineer/);
    assert.match(skill, /Call `switch_role` before every role starts/);
    assert.match(skill, /task_workflow\(action=plan\)/);
    assert.match(skill, /workflowExecutor/);
    assert.match(skill, /pi-init\/task-result@1/);
    assert.match(skill, /revisionId/);
    assert.match(skill, /task_workflow\(action="replan"\)/);
    assert.match(skill, /workflow cancel/);
    assert.match(skill, /shared checkout/);
    assert.match(skill, /reviewRequired/);
    assert.match(skill, /task_workflow\(action=complete/);
    assert.match(skill, /\/pi-init workflow resume/);
    assert.doesNotMatch(skill, /parallel_develop/);
    assert.match(skill, /trusted projects/);
    assert.match(skill, /## Exact String Replacement/);
    assert.match(skill, /`oldText` → `newText`/);
    assert.match(skill, /must match exactly once in the original file/);
    assert.match(skill, /multiple non-overlapping replacements in one edit operation/);
  });
});
