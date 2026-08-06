import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createScaffold, formatEnvironmentInstructions } from "../src/scaffold.js";
import {
  DEFAULT_ROLE_CONFIG,
  DEFAULT_ROLE_MODELS,
  ROLE_LABELS,
  ROLE_MODE_LABELS,
  THINKING_LEVELS,
  filterRoleModels,
  resolveRoleConfig,
  resolveRoleMode,
  resolveRoleModel,
} from "../src/roles.js";
import {
  DEFAULT_PARALLEL_CONCURRENCY,
  isPathAllowed,
  MAX_PARALLEL_DEVELOPERS,
  validateParallelTasks,
} from "../src/parallel.js";
import { runParallelDevelop, spawnPiWorker } from "../src/parallel-runner.js";

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

function assertSkillMatchesRoleConfig(skill, config) {
  for (const role of ["architect", "developer-test", "docs-commit"]) {
    const { provider, model, thinkingLevel } = config[role];
    assert.match(skill, new RegExp("`" + provider + "/" + model + "`"));
    assert.match(skill, new RegExp("`" + thinkingLevel + "`"));
  }
}

test("运行环境说明按平台生成", () => {
  const windows = formatEnvironmentInstructions("zh-CN", { platform: "win32", arch: "arm64" });
  assert.match(windows, /Windows \(`win32`\)，CPU 架构：`arm64`/);
  assert.match(windows, /`where\.exe`/);
  assert.match(windows, /`.cmd` shim/);
  assert.match(windows, /Linux-only 的 `which`/);

  const linux = formatEnvironmentInstructions("en", { platform: "linux", arch: "x64" });
  assert.match(linux, /Linux \(`linux`\), CPU architecture: `x64`/);
  assert.match(linux, /POSIX shells/);
  assert.doesNotMatch(linux, /where\.exe/);
});

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
    assert.doesNotMatch(agents, /知识库地址远程地址/);
    assert.match(skill, /^---\nname: example-app\n/);
    assert.match(skill, /架构师.+Staff \/ Principal/);
    assert.match(skill, /开发测试工程师.+Senior \/ SDET/);
    assert.match(skill, /文档与收尾工程师.+Technical Writer \/ Release Engineer/);
    assert.deepEqual(roleModels, DEFAULT_ROLE_CONFIG);
    assert.deepEqual(resolveRoleConfig(undefined), DEFAULT_ROLE_CONFIG);
    assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.equal(roleModels.mode, "auto");
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
    assert.match(skill, /\/pi-init config/);
    assert.match(skill, /调用 `parallel_develop`/);
    assert.match(skill, /受信任项目/);
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
  assert.equal(DEFAULT_PARALLEL_CONCURRENCY, 2);
});

test("子代理 JSON 事件流会实时解析工具活动、摘要和指标", async () => {
  await withTempDirectory(async (directory) => {
    const retry = { type: "auto_retry_start", attempt: 1, maxAttempts: 1 };
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "完成摘要" }],
        stopReason: "stop",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 3,
          cacheWrite: 4,
          totalTokens: 30,
          cost: { total: 0.05 },
        },
      },
    };
    const script = [retry, event].map((value) => `console.log(JSON.stringify(${JSON.stringify(value)}))`).join(";");
    const events = [];
    const result = await spawnPiWorker(
      { command: process.execPath, args: ["-e", script] },
      { cwd: directory, timeout: 1000, onEvent: (value) => events.push(value) },
    );

    assert.equal(result.code, 0);
    assert.equal(result.summary, "完成摘要");
    assert.deepEqual(events, [retry, event]);
    assert.deepEqual(result.metrics, {
      elapsedMs: 0,
      turns: 1,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      totalTokens: 30,
      cost: 0.05,
      autoRetries: 1,
    });
  });
});

async function git(cwd, args) {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout;
}

function fakeParallelExec() {
  return async (command, args, options = {}) => {
    const result = await execFileAsync(command, args, { cwd: options.cwd, encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
  };
}

function fakeParallelSpawn(worker) {
  return async (invocation, options) => {
    await worker(invocation.args, options.cwd, options);
    options.onEvent?.({ type: "tool_execution_start", toolName: "test", args: {} });
    options.onEvent?.({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "worker complete" }] },
    });
    return {
      stdout: "",
      stderr: "",
      summary: "worker complete",
      code: 0,
      killed: false,
      aborted: false,
      timedOut: false,
    };
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
      exec: fakeParallelExec(),
      spawnWorker: fakeParallelSpawn(async (args, cwd) => {
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
    assert.ok(updates.filter(({ details }) => details.status === "running").length >= 2);
    const finalTasks = updates.at(-1).details.tasks;
    assert.deepEqual(finalTasks.map(({ id, status }) => ({ id, status })), [
      { id: "a", status: "completed" },
      { id: "b", status: "completed" },
    ]);
    assert.equal(result.results.length, 2);
    assert.deepEqual(result.results.map(({ changedFiles }) => changedFiles), [["a.txt"], ["b.txt"]]);
    assert.equal(normalizeNewlines(await readFile(path.join(directory, "a.txt"), "utf8")), "a.txt\n");
    assert.equal(normalizeNewlines(await readFile(path.join(directory, "b.txt"), "utf8")), "b.txt\n");
    assert.equal((await git(directory, ["worktree", "list", "--porcelain"])).split("\nworktree ").length, 1);
  });
});

test("并行开发默认限制同时运行 worker 数量并返回阶段耗时", async () => {
  await withTempDirectory(async (directory) => {
    await createGitFixture(directory);
    let active = 0;
    let maxActive = 0;
    const result = await runParallelDevelop({
      exec: fakeParallelExec(),
      cwd: directory,
      planInput: "实现三个互不冲突的文件",
      taskInput: [
        { id: "a", task: "task-a", files: ["a.txt"] },
        { id: "b", task: "task-b", files: ["b.txt"] },
        { id: "c", task: "task-c", files: ["c.txt"] },
      ],
      target: { provider: "test", model: "model", thinkingLevel: "off" },
      heartbeatMs: 0,
      spawnWorker: async (invocation, options) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const task = invocation.args.at(-1);
        const file = `${task.at(-1)}.txt`;
        await new Promise((resolve) => setTimeout(resolve, 20));
        await writeFile(path.join(options.cwd, file), `${file}\n`, "utf8");
        active -= 1;
        return {
          stdout: "",
          stderr: "",
          summary: "worker complete",
          code: 0,
          killed: false,
          aborted: false,
          timedOut: false,
          metrics: { turns: 1, outputTokens: 5 },
        };
      },
    });

    assert.equal(maxActive, DEFAULT_PARALLEL_CONCURRENCY);
    assert.equal(result.results.length, 3);
    assert.ok(result.metrics.setupMs >= 0);
    assert.ok(result.metrics.workersMs >= 20);
    assert.ok(result.metrics.mergeMs >= 0);
    assert.ok(result.metrics.totalMs >= result.metrics.workersMs);
    assert.ok(result.tasks.every((task) => task.metrics.elapsedMs >= 20));
  });
});

test("并行开发报告实时事件、心跳并自动重试基础设施错误", async () => {
  await withTempDirectory(async (directory) => {
    await createGitFixture(directory);
    const attempts = new Map();
    const updates = [];
    const result = await runParallelDevelop({
      exec: fakeParallelExec(),
      spawnWorker: async (invocation, options) => {
        const id = invocation.args.at(-1).includes("task-a") ? "a" : "b";
        const attempt = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, attempt);
        if (id === "a" && attempt === 1) {
          options.onEvent?.({ type: "auto_retry_start", attempt: 1, maxAttempts: 1 });
          return {
            stdout: "",
            stderr: "",
            summary: "",
            stopReason: "error",
            errorMessage: "terminated",
            code: 0,
            killed: false,
            aborted: false,
            timedOut: false,
          };
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
        options.onEvent?.({ type: "tool_execution_start", toolName: "test", args: { id } });
        await writeFile(path.join(options.cwd, `${id}.txt`), `${id}\n`, "utf8");
        return {
          stdout: "",
          stderr: "",
          summary: `completed ${id}`,
          code: 0,
          killed: false,
          aborted: false,
          timedOut: false,
        };
      },
      cwd: directory,
      planInput: "报告状态并重试基础设施错误",
      taskInput: [
        { id: "a", task: "task-a", files: ["a.txt"] },
        { id: "b", task: "task-b", files: ["b.txt"] },
      ],
      target: { provider: "test", model: "model", thinkingLevel: "off" },
      heartbeatMs: 5,
      workerTimeoutMs: 1000,
      onUpdate: (update) => updates.push(update),
    });

    assert.deepEqual(Object.fromEntries(attempts), { a: 2, b: 1 });
    assert.ok(updates.some(({ details }) => details.tasks?.some((task) => task.status === "retrying")));
    assert.ok(updates.some(({ details }) => details.tasks?.some((task) => task.current?.includes("test"))));
    assert.deepEqual(result.tasks.map(({ id, status }) => ({ id, status })), [
      { id: "a", status: "completed" },
      { id: "b", status: "completed" },
    ]);
  });
});

test("并行开发拒绝重命名导致的范围外删除", async () => {
  await withTempDirectory(async (directory) => {
    await createGitFixture(directory);
    await writeFile(path.join(directory, "outside.txt"), "outside\n", "utf8");
    await git(directory, ["add", "outside.txt"]);
    await git(directory, ["commit", "-m", "outside"]);

    let error;
    try {
      await runParallelDevelop({
        exec: fakeParallelExec(),
        spawnWorker: fakeParallelSpawn(async (args, cwd) => {
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
      });
      assert.fail("应拒绝未声明范围的修改");
    } catch (caught) {
      error = caught;
    }

    assert.match(error.message, /未声明范围：.*outside\.txt/);
    assert.match(error.message, /失败现场和日志已保留/);
    for (const index of [1, 2]) {
      await execFileAsync("git", ["worktree", "remove", "--force", path.join(error.tempRoot, `worktree-${index}`)], {
        cwd: directory,
        encoding: "utf8",
      });
    }
    await rm(error.tempRoot, { recursive: true, force: true });
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
    assert.match(agents, /## Runtime Environment and Command Conventions/);
    assert.match(agents, new RegExp("`" + process.platform + "`"));
    assert.match(agents, /- Test: `npm test`/);
    assert.match(agents, /github\.com\/CGOSU\/knowledge\.git/);
    assert.match(agents, /git config user\.name CGOSU/);
    assert.match(skill, /name: mall-app/);
    assert.match(skill, /Architect.+Staff \/ Principal/);
    assert.match(skill, /Development and Test Engineer.+Senior \/ SDET/);
    assert.match(skill, /Documentation and Wrap-up Engineer.+Technical Writer \/ Release Engineer/);
    assert.match(skill, /Call `switch_role` before every role starts/);
    assert.match(skill, /call `parallel_develop`/);
    assert.match(skill, /trusted projects/);
  });
});
