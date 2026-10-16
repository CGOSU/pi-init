import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";

const {
  mkdir,
  readFile,
  path,
  createScaffold,
  DEFAULT_ROLE_CONFIG,
  resolveRoleConfig,
  unwrapRoleResult,
  withTempDirectory,
  writeFile,
} = helpers;

test("默认脚手架生成约定文件并替换项目变量", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "example-app");
    const result = await createScaffold(target, {
      projectName: "Example App",
      description: "A customer portal.",
      testCommand: "npm test",
    });

    assert.deepEqual(result.files, [
      "AGENTS.md",
      "docs/clean-code.md",
      "docs/current-state.md",
      "docs/decisions.md",
      "docs/session-log.md",
      "docs/pitfalls.md",
      ".pi/role-models.json",
      ".pi/pi-init-state.json",
    ]);
    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    const roleModels = JSON.parse(await readFile(path.join(target, ".pi/role-models.json"), "utf8"));
    const templateState = JSON.parse(await readFile(path.join(target, ".pi/pi-init-state.json"), "utf8"));

    assert.match(agents, /^# Example App AI 协作指南/);
    assert.match(agents, /A customer portal\./);
    assert.match(agents, /npm test/);
    assert.deepEqual(roleModels, DEFAULT_ROLE_CONFIG);
    assert.equal(templateState.schemaVersion, 1);
    assert.equal(templateState.templateSchemaVersion, 1);
    assert.equal(templateState.language, "zh-CN");
    assert.equal(templateState.managedBlocks["fast-path-wrap-up"].file, "AGENTS.md");
    assert.match(templateState.managedBlocks["fast-path-wrap-up"].hash, /^[0-9a-f]{64}$/);
    await assert.rejects(
      readFile(path.join(target, ".pi/skills/example-app/SKILL.md"), "utf8"),
      { code: "ENOENT" },
    );
    for (const file of result.files) {
      assert.doesNotMatch(await readFile(path.join(target, file), "utf8"), /\{\{[A-Z_]+\}\}/);
    }
  });
});

test("自定义职责模型配置按既有 schema 规范化并持久化", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "custom-app");
    const roleModels = {
      mode: "confirm",
      workflowMode: "on",
      workflowExecutor: "local",
      architect: { provider: "provider-architect", model: "model-architect", thinkingLevel: "high" },
      "developer-test": { provider: "provider-developer", model: "model-developer", thinkingLevel: "low" },
      "docs-commit": { provider: "provider-docs", model: "model-docs", thinkingLevel: "minimal" },
    };

    await createScaffold(target, { projectName: "Custom App", roleModels });

    const config = JSON.parse(await readFile(path.join(target, ".pi/role-models.json"), "utf8"));
    assert.deepEqual(config, unwrapRoleResult(resolveRoleConfig(roleModels)));
  });
});

test("英文模板保留用户输入并支持部分职责映射", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "partial-app");
    const roleModels = {
      mode: "manual",
      architect: { provider: "provider-architect", model: "model-architect", thinkingLevel: "xhigh" },
    };

    const result = await createScaffold(target, {
      language: "en",
      projectName: "Mall App",
      description: "A customer portal.",
      testCommand: "npm test",
      roleModels,
    });

    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    const config = JSON.parse(await readFile(path.join(target, ".pi/role-models.json"), "utf8"));
    const templateState = JSON.parse(await readFile(path.join(target, ".pi/pi-init-state.json"), "utf8"));
    assert.equal(result.language, "en");
    assert.equal(templateState.language, "en");
    assert.match(agents, /## Project Purpose/);
    assert.match(agents, /A customer portal\./);
    assert.match(agents, /npm test/);
    assert.deepEqual(config, unwrapRoleResult(resolveRoleConfig(roleModels)));
  });
});

test("无效职责模型配置失败且不生成配置文件", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "invalid-app");
    const roleModels = {
      architect: { provider: "provider", model: "model", thinkingLevel: "invalid" },
    };

    await assert.rejects(
      createScaffold(target, { roleModels }),
      { code: "ROLE_MODEL_THINKING_LEVEL_INVALID" },
    );
    await assert.rejects(readFile(path.join(target, ".pi/role-models.json"), "utf8"), { code: "ENOENT" });
  });
});

test("dry-run 报告冲突但不写入或覆盖文件", async () => {
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

test("重新初始化保留已有项目级 Skill", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "legacy-app");
    const legacySkill = path.join(target, ".pi", "skills", "legacy-role", "SKILL.md");
    await mkdir(path.dirname(legacySkill), { recursive: true });
    await writeFile(legacySkill, "keep this legacy skill", "utf8");

    await createScaffold(target, { projectName: "Legacy App" });

    assert.equal(await readFile(legacySkill, "utf8"), "keep this legacy skill");
  });
});

test("公共角色路由 Skill 由 package 元数据发布", async () => {
  const packageRoot = process.cwd();
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const sharedSkill = await readFile(
    path.join(packageRoot, "skills", "pi-init-role-routing", "SKILL.md"),
    "utf8",
  );

  assert.ok(manifest.files.includes("skills"));
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.match(sharedSkill, /^---\nname: pi-init-role-routing\n/);
});
