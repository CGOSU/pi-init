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
        "docs/current-state.md",
      "docs/decisions.md",
      "docs/session-log.md",
      "docs/pitfalls.md",
      ".pi/role-models.json",
      ]);
    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    const roleModels = JSON.parse(await readFile(path.join(target, ".pi/role-models.json"), "utf8"));

    assert.match(agents, /^# Example App AI 协作指南/);
    assert.match(agents, /A customer portal\./);
    assert.match(agents, /npm test/);
    assert.deepEqual(roleModels, DEFAULT_ROLE_CONFIG);
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
    assert.equal(result.language, "en");
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

test("dry-run 报告保留文件但不写入或覆盖文件", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "existing-app");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "AGENTS.md"), "keep?", "utf8");

    const result = await createScaffold(target, { dryRun: true });

    assert.equal(result.dryRun, true);
    assert.deepEqual(result.conflicts, []);
      assert.deepEqual(result.preserved, ["AGENTS.md"]);
      assert.ok(!result.files.includes("AGENTS.md"));
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

import fsPromises, { lstat, symlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
test("重复初始化逐字节保留维护者文件和旧状态", async () => {
  await withTempDirectory(async (directory) => {
    const first = await createScaffold(directory);
    const files = [...first.files, "docs/clean-code.md", ".pi/pi-init-state.json"];
    const bytes = Buffer.from([0xff, 0x00, 0x0d, 0x0a, 0x61]);
    for (const file of files) await writeFile(path.join(directory, file), bytes);
    for (const dryRun of [true, false]) {
      const result = await createScaffold(directory, { language: "en", projectName: "Changed", dryRun });
      assert.deepEqual(result.files, []);
      assert.deepEqual(result.conflicts, []);
      assert.deepEqual(result.preserved, first.files);
      for (const file of files) assert.deepEqual(await readFile(path.join(directory, file)), bytes);
    }
  });
});
test("新项目 dry-run 不创建目录，实际初始化不生成旧规范或状态", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "missing");
    const preview = await createScaffold(target, { dryRun: true });
    await assert.rejects(lstat(target), { code: "ENOENT" });
    const actual = await createScaffold(target);
    assert.deepEqual(actual.files, preview.files);
    assert.deepEqual(actual.preserved, []);
    for (const file of ["docs/clean-code.md", ".pi/pi-init-state.json"]) {
      await assert.rejects(lstat(path.join(target, file)), { code: "ENOENT" });
    }
  });
});
test("现有及悬挂符号链接均保留", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "project");
    await mkdir(target);
    const external = path.join(directory, "external");
    await writeFile(external, "external bytes");
    await symlink(external, path.join(target, "AGENTS.md"));
    await mkdir(path.join(target, ".pi"));
    const missing = path.join(directory, "missing");
    await symlink(missing, path.join(target, ".pi/role-models.json"));
    for (const dryRun of [true, false]) {
      const result = await createScaffold(target, { dryRun });
      for (const file of ["AGENTS.md", ".pi/role-models.json"]) {
        assert.ok(result.preserved.includes(file));
        assert.ok(!result.files.includes(file));
        assert.ok((await lstat(path.join(target, file))).isSymbolicLink());
      }
      assert.equal(await readFile(external, "utf8"), "external bytes");
      await assert.rejects(lstat(missing), { code: "ENOENT" });
    }
  });
});
test("exclusive create 保留检查之后出现的文件和悬挂链接", async () => {
  await withTempDirectory(async (directory) => {
    const original = fsPromises.writeFile;
    try {
      fsPromises.writeFile = async (file, content, options) => {
        assert.equal(options.flag, "wx");
        if (path.basename(file) === "AGENTS.md") await original(file, "racing writer");
        if (path.basename(file) === "role-models.json") await symlink(path.join(directory, "missing"), file);
        return original(file, content, options);
      };
      syncBuiltinESMExports();
      const result = await createScaffold(directory);
      assert.deepEqual(result.preserved, ["AGENTS.md", ".pi/role-models.json"]);
      assert.ok(!result.files.includes("AGENTS.md"));
      assert.ok(!result.files.includes(".pi/role-models.json"));
      assert.equal(await readFile(path.join(directory, "AGENTS.md"), "utf8"), "racing writer");
      assert.ok((await lstat(path.join(directory, ".pi/role-models.json"))).isSymbolicLink());
      await assert.rejects(lstat(path.join(directory, "missing")), { code: "ENOENT" });
    } finally {
      fsPromises.writeFile = original;
      syncBuiltinESMExports();
    }
  });
});

test("project AGENTS contains project context rather than a copy of plugin policy", async () => {
  await withTempDirectory(async directory => {
    await createScaffold(directory, { projectName: "Owned", description: "Project-specific purpose", testCommand: "npm run focused" });
    const agents = await readFile(path.join(directory, "AGENTS.md"), "utf8");
    assert.match(agents, /Project-specific purpose/);
    assert.match(agents, /npm run focused/);
    assert.match(agents, /项目特有约束/);
    assert.doesNotMatch(agents, /pi-init:managed|Fast Path|task_workflow|dev@cgosu.com/);
    const guide = await readFile(path.join(process.cwd(), "skills/pi-init-role-routing/references/clean-code.md"), "utf8");
    assert.match(guide, /Clean Code/);
    await assert.rejects(readFile(path.join(directory, "docs/clean-code.md")), { code: "ENOENT" });
  });
});
