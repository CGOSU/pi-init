import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createScaffold } from "../src/scaffold.js";
import {
  DEFAULT_ROLE_CONFIG,
  DEFAULT_ROLE_MODELS,
  resolveRoleMode,
  resolveRoleModel,
} from "../src/roles.js";
import {
  isPathAllowed,
  MAX_PARALLEL_DEVELOPERS,
  validateParallelTasks,
} from "../src/parallel.js";
import { runParallelDevelop } from "../src/parallel-runner.js";

const execFileAsync = promisify(execFile);

function normalizeNewlines(value) {
  return value.replaceAll("\r\n", "\n");
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-init-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("生成默认文件结构和动态 Skill", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "example-app");
    const result = await createScaffold(target, { projectName: "Example App" });

    assert.deepEqual(result.files, [
      "AGENTS.md",
      "docs/current-state.md",
      "docs/decisions.md",
      "docs/session-log.md",
      "docs/pitfalls.md",
      ".pi/role-models.json",
      ".pi/skills/example-app/SKILL.md",
    ]);
    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    const roleModels = JSON.parse(await readFile(path.join(target, ".pi/role-models.json"), "utf8"));
    const skill = await readFile(path.join(target, ".pi/skills/example-app/SKILL.md"), "utf8");
    assert.match(agents, /^# Example App AI 协作指南/);
    assert.match(agents, /git config user\.name CGOSU/);
    assert.match(agents, /git config user\.email dev@cgosu\.com/);
    assert.doesNotMatch(agents, /知识库地址远程地址/);
    assert.match(skill, /^---\nname: example-app\n/);
    assert.match(skill, /架构师.+Staff \/ Principal/);
    assert.match(skill, /开发测试工程师.+Senior \/ SDET/);
    assert.match(skill, /文档与提交工程师.+Technical Writer \/ Release Engineer/);
    assert.deepEqual(roleModels, DEFAULT_ROLE_CONFIG);
    assert.equal(roleModels.mode, "auto");
    assert.deepEqual(DEFAULT_ROLE_MODELS["developer-test"], {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinkingLevel: "max",
    });
    assert.match(skill, /openai-codex\/gpt-5\.6-sol/);
    assert.match(skill, /开发测试工程师[^\n]+openai-codex\/gpt-5\.6-luna[^\n]+`max`/);
    assert.match(skill, /文档与提交工程师[^\n]+openai-codex\/gpt-5\.6-luna/);
    assert.match(skill, /`max`/);
    assert.match(skill, /`medium`/);
    assert.match(skill, /必须先调用 `switch_role`/);
    assert.match(skill, /调用 `parallel_develop`/);
    assert.match(skill, /受信任项目/);
    assert.doesNotMatch(skill, /docs\/current-state\.md/);

    for (const file of result.files) {
      assert.doesNotMatch(await readFile(path.join(target, file), "utf8"), /\{\{[A-Z_]+\}\}/);
    }
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

test("职责模型配置支持默认值、覆盖和校验", () => {
  assert.equal(resolveRoleMode(undefined), "auto");
  assert.equal(resolveRoleMode({ mode: "manual" }), "manual");
  assert.throws(() => resolveRoleMode({ mode: "sometimes" }), /职责切换模式无效/);
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

test("并行开发任务要求独立且受限的文件范围", () => {
  const tasks = validateParallelTasks([
    { id: "api", task: "实现 API", files: ["src/api"] },
    { id: "tests", task: "补充测试", files: ["test/api.test.js"] },
  ]);

  assert.equal(tasks.length, 2);
  assert.equal(isPathAllowed("src/api/router.js", tasks[0].files), true);
  assert.equal(isPathAllowed("src/other.js", tasks[0].files), false);
  assert.throws(
    () => validateParallelTasks([
      { id: "one", task: "one", files: ["src"] },
      { id: "two", task: "two", files: ["src/utils"] },
    ]),
    /文件范围重叠/,
  );
  assert.throws(
    () => validateParallelTasks([
      { id: "one", task: "one", files: ["src/*.js"] },
      { id: "two", task: "two", files: ["test"] },
    ]),
    /不支持通配符/,
  );
  assert.equal(MAX_PARALLEL_DEVELOPERS, 4);
});

async function git(cwd, args) {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout;
}

function fakeParallelExec(worker) {
  return async (command, args, options = {}) => {
    if (command !== "git") {
      await worker(args, options.cwd);
      return { stdout: "worker complete\n", stderr: "", code: 0, killed: false };
    }
    const result = await execFileAsync(command, args, { cwd: options.cwd, encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
  };
}

async function createGitFixture(directory) {
  await git(directory, ["init"]);
  await git(directory, ["config", "user.name", "test"]);
  await git(directory, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(directory, "base.txt"), "base\n", "utf8");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "-m", "init"]);
}

test("并行开发创建隔离 worktree 并合并独立修改", async () => {
  await withTempDirectory(async (directory) => {
    await createGitFixture(directory);
    const started = [];
    const updates = [];
    const result = await runParallelDevelop({
      exec: fakeParallelExec(async (args, cwd) => {
        const file = args.at(-1).includes("task-a") ? "a.txt" : "b.txt";
        await writeFile(path.join(cwd, file), `${file}\n`, "utf8");
      }),
      cwd: directory,
      planInput: "实现两个互不冲突的文件",
      taskInput: [
        { id: "a", task: "task-a", files: ["a.txt"] },
        { id: "b", task: "task-b", files: ["b.txt"] },
      ],
      target: { provider: "test", model: "model", thinkingLevel: "off" },
      onStarted: (event) => started.push(event),
      onUpdate: (update) => updates.push(update),
    });

    assert.deepEqual(started.map(({ started: count }) => count).sort(), [1, 2]);
    assert.ok(started.every(({ total }) => total === 2));
    assert.equal(updates[0].details.status, "starting");
    assert.equal(updates.filter(({ details }) => details.status === "running").length, 2);
    assert.equal(result.results.length, 2);
    assert.deepEqual(result.results.map(({ changedFiles }) => changedFiles), [["a.txt"], ["b.txt"]]);
    assert.equal(normalizeNewlines(await readFile(path.join(directory, "a.txt"), "utf8")), "a.txt\n");
    assert.equal(normalizeNewlines(await readFile(path.join(directory, "b.txt"), "utf8")), "b.txt\n");
    assert.equal((await git(directory, ["worktree", "list", "--porcelain"])).split("\nworktree ").length, 1);
  });
});

test("并行开发拒绝重命名导致的范围外删除", async () => {
  await withTempDirectory(async (directory) => {
    await createGitFixture(directory);
    await writeFile(path.join(directory, "outside.txt"), "outside\n", "utf8");
    await git(directory, ["add", "outside.txt"]);
    await git(directory, ["commit", "-m", "outside"]);

    await assert.rejects(
      runParallelDevelop({
        exec: fakeParallelExec(async (args, cwd) => {
          if (args.at(-1).includes("rename-task")) {
            await git(cwd, ["mv", "outside.txt", "inside.txt"]);
          }
        }),
        cwd: directory,
        planInput: "限制每个任务只能修改声明范围",
        taskInput: [
          { id: "rename", task: "rename-task", files: ["inside.txt"] },
          { id: "noop", task: "noop-task", files: ["noop.txt"] },
        ],
        target: { provider: "test", model: "model", thinkingLevel: "off" },
      }),
      /未声明范围：.*outside\.txt/,
    );

    assert.equal(normalizeNewlines(await readFile(path.join(directory, "outside.txt"), "utf8")), "outside\n");
    await assert.rejects(readFile(path.join(directory, "inside.txt"), "utf8"), { code: "ENOENT" });
    assert.equal(await git(directory, ["status", "--porcelain"]), "");
  });
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
    const skill = await readFile(path.join(target, ".pi/skills/mall-app/SKILL.md"), "utf8");
    assert.match(agents, /## Project Purpose/);
    assert.match(agents, /- Test: `npm test`/);
    assert.match(agents, /github\.com\/CGOSU\/knowledge\.git/);
    assert.match(agents, /git config user\.name CGOSU/);
    assert.match(skill, /name: mall-app/);
    assert.match(skill, /Architect.+Staff \/ Principal/);
    assert.match(skill, /Development and Test Engineer.+Senior \/ SDET/);
    assert.match(skill, /Documentation and Commit Engineer.+Technical Writer \/ Release Engineer/);
    assert.match(skill, /Call `switch_role` before every role starts/);
    assert.match(skill, /call `parallel_develop`/);
    assert.match(skill, /trusted projects/);
  });
});
