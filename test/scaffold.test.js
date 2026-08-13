import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  dateRange,
  formatReport,
  queryUsage,
  shouldRefreshUsage,
  summarizeUsage,
} from "../scripts/pi-usage.js";
import { createScaffold, formatEnvironmentInstructions } from "../src/scaffold.js";
import {
  DEFAULT_ROLE_CONFIG,
  DEFAULT_ROLE_MODELS,
  ROLE_LABELS,
  ROLE_MODE_LABELS,
  ROLE_SWITCH_COMPACTION_THRESHOLD,
  THINKING_LEVELS,
  filterRoleModels,
  findMatchingRole,
  resolveRoleConfig,
  resolveRoleMode,
  resolveRoleModel,
  shouldCompactOnRoleSwitch,
} from "../src/roles.js";
import {
  DEFAULT_PARALLEL_CONCURRENCY,
  isPathAllowed,
  MAX_PARALLEL_DEVELOPERS,
  validateParallelTasks,
} from "../src/parallel.js";
import { getPiInvocation, runParallelDevelop, spawnPiWorker } from "../src/parallel-runner.js";
import {
  WORKFLOW_MAX_NUDGES,
  WORKFLOW_MAX_TASKS,
  blockWorkflowTask,
  cancelWorkflow,
  completeWorkflowTask,
  createWorkflowState,
  getNextWorkflowTask,
  recordWorkflowNudge,
  resumeWorkflow,
  retryWorkflowTask,
  startWorkflowTask,
  validateWorkflowPlan,
  workflowProgress,
} from "../src/workflow.js";

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

test("跨平台 Pi 用量统计启动器指向共享脚本", async () => {
  const files = {
    windowsUsage: await readFile(path.join(process.cwd(), "scripts", "pi-usage.cmd"), "utf8"),
    posixUsage: await readFile(path.join(process.cwd(), "scripts", "pi-usage.sh"), "utf8"),
  };

  assert.match(files.windowsUsage, /pi-usage\.js/);
  assert.match(files.posixUsage, /pi-usage\.js/);
});

test("pi-usage 默认日期范围从本地午夜开始", () => {
  const range = dateRange();
  const now = new Date();
  assert.equal(range.date, now.toLocaleDateString("sv-SE"));
  assert.equal(range.start.getHours(), 0);
  assert.equal(range.start.getMinutes(), 0);
  assert.equal(range.start.getSeconds(), 0);
  assert.equal(range.start.getMilliseconds(), 0);
  assert.equal(range.end.getTime() - range.start.getTime(), 24 * 60 * 60 * 1000);
});

test("pi-usage 仅在超过一小时或跨自然日时自动检查", () => {
  const now = new Date(2026, 7, 9, 12, 0, 0, 0);
  const sameDay = now.toLocaleDateString("sv-SE");
  assert.equal(
    shouldRefreshUsage({ checkedMs: now.getTime() - 59 * 60 * 1000, checkedDate: sameDay }, now),
    false,
  );
  assert.equal(
    shouldRefreshUsage({ checkedMs: now.getTime() - 60 * 60 * 1000, checkedDate: sameDay }, now),
    true,
  );
  assert.equal(
    shouldRefreshUsage({ checkedMs: now.getTime() - 5 * 60 * 1000, checkedDate: "2026-08-08" }, now),
    true,
  );
});

test("pi-usage 汇总指定日期的 session 用量并按模型分组", async () => {
  await withTempDirectory(async (directory) => {
    const sessions = path.join(directory, "sessions");
    const today = new Date();
    const todayAtNoon = new Date(today);
    todayAtNoon.setHours(12, 0, 0, 0);
    const yesterdayAtNoon = new Date(todayAtNoon);
    yesterdayAtNoon.setDate(yesterdayAtNoon.getDate() - 1);
    const date = todayAtNoon.toLocaleDateString("sv-SE");
    const usage = (input, output, total, cacheRead = 0, cacheWrite = 0) => ({
      input,
      output,
      cacheRead,
      cacheWrite,
      cost: { total },
    });
    await mkdir(path.join(sessions, "project-a"), { recursive: true });
    await mkdir(path.join(sessions, "project-b"), { recursive: true });
    await writeFile(
      path.join(sessions, "project-a", "a.jsonl"),
      [
        JSON.stringify({ type: "session", cwd: process.cwd() }),
        JSON.stringify({
          type: "message",
          timestamp: todayAtNoon.toISOString(),
          message: {
            role: "assistant",
            provider: "provider",
            model: "model",
            responseModel: "response-model",
            usage: usage(10, 5, 0.1, 20, 5),
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: yesterdayAtNoon.toISOString(),
          message: { role: "assistant", provider: "old", model: "model", usage: usage(99, 99, 9) },
        }),
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(sessions, "project-b", "b.jsonl"),
      JSON.stringify({
        type: "message",
        timestamp: todayAtNoon.toISOString(),
        message: { role: "toolResult", usage: usage(2, 3, 0.02) },
      }),
      "utf8",
    );

    const summary = await summarizeUsage(sessions, date, path.join(directory, "usage.duckdb"));
    const report = formatReport(summary);
    assert.equal(summary.sessions, 2);
    assert.match(report, new RegExp(`Pi usage · ${date}`));
    assert.match(report, /provider\/response-model/);
    assert.match(report, /Tools\/summaries/);
    assert.match(report, /Total/);
    assert.match(report, /40/);
    assert.match(report, /Cache ratio\s+│\s+25 \/ 45 \(55\.6%\)/);
    assert.match(report, /Model usage \(tokens\)/);
    assert.match(report, /provider\/response-model\s+█+\s+40/);
    assert.doesNotMatch(report, /Git changes/);
    assert.match(report, /Active\s+│\s+0s/);
    assert.match(report, /Metric\s+│\s+Duration/);
    assert.equal((report.match(/┌/g) ?? []).length, 3);
    assert.equal((report.match(/└/g) ?? []).length, 3);
    assert.doesNotMatch(report, /\u001b\[/);
    const coloredReport = formatReport(summary, { color: true });
    assert.match(coloredReport, /\u001b\[36;1m│ Metric/);
    assert.match(coloredReport, /\u001b\[33;1m│ Total/);
    assert.doesNotMatch(report, /old\/model/);
    const changedFile = path.join(sessions, "project-a", "a.jsonl");
    await writeFile(
      changedFile,
      `${await readFile(changedFile, "utf8")}\n${JSON.stringify({
        type: "message",
        timestamp: todayAtNoon.toISOString(),
        message: {
          role: "assistant",
          provider: "provider",
          model: "model",
          responseModel: "response-model",
          usage: usage(100, 0, 1),
        },
      })}`,
      "utf8",
    );
    const cachedAfterChange = await queryUsage(date, path.join(directory, "usage.duckdb"), undefined, sessions);
    assert.equal(cachedAfterChange.rows.find((row) => row.model === "provider/response-model").input, 10);
    await summarizeUsage(sessions, date, path.join(directory, "usage.duckdb"));
    const refreshed = await queryUsage(date, path.join(directory, "usage.duckdb"));
    assert.equal(refreshed.rows.find((row) => row.model === "provider/response-model").input, 110);
    await rm(sessions, { recursive: true, force: true });
    const cached = await queryUsage(date, path.join(directory, "usage.duckdb"));
    assert.equal(cached.sessions, 2);
    await assert.rejects(
      summarizeUsage(sessions, "not-a-date", path.join(directory, "usage.duckdb")),
      /日期必须是 YYYY-MM-DD/,
    );
  });
});

test("pi-usage 按模型汇总加权平均 token 速度", async () => {
  await withTempDirectory(async (directory) => {
    const sessions = path.join(directory, "sessions");
    const start = new Date();
    start.setHours(12, 0, 0, 0);
    const date = start.toLocaleDateString("sv-SE");
    const usage = (output) => ({
      input: 1,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0 },
    });
    const assistant = (timestamp, provider, model, output) =>
      JSON.stringify({
        type: "message",
        timestamp: timestamp.toISOString(),
        message: { role: "assistant", provider, model, usage: usage(output) },
      });
    const speed = (timestamp, provider, model, outputTokens, elapsedMs) =>
      JSON.stringify({
        type: "custom",
        timestamp: timestamp.toISOString(),
        customType: "pi-token-speed",
        data: { version: 1, provider, model, outputTokens, elapsedMs },
      });
    const firstModelStart = new Date(start);
    const secondModelStart = new Date(start.getTime() + 60_000);
    const otherModelStart = new Date(start.getTime() + 120_000);
    await mkdir(path.join(sessions, "project"), { recursive: true });
    await writeFile(
      path.join(sessions, "project", "speed.jsonl"),
      [
        JSON.stringify({ type: "session", cwd: process.cwd() }),
        assistant(firstModelStart, "provider-a", "model-a", 100),
        speed(new Date(firstModelStart.getTime() + 10_000), "provider-a", "model-a", 100, 10_000),
        assistant(secondModelStart, "provider-a", "model-a", 10),
        speed(new Date(secondModelStart.getTime() + 2_000), "provider-a", "model-a", 10, 2_000),
        assistant(otherModelStart, "provider-b", "model-b", 20),
        speed(new Date(otherModelStart.getTime() + 2_000), "provider-b", "model-b", 20, 2_000),
        speed(new Date(otherModelStart.getTime() + 3_000), "provider-c", "invalid", 0, 1_000),
      ].join("\n"),
      "utf8",
    );

    const summary = await summarizeUsage(sessions, date, path.join(directory, "usage.duckdb"));
    const modelA = summary.rows.find((row) => row.model === "provider-a/model-a");
    const modelB = summary.rows.find((row) => row.model === "provider-b/model-b");
    assert.ok(modelA);
    assert.ok(modelB);
    assert.ok(Math.abs(modelA.avgTps - 110 / 12) < 0.000001);
    assert.equal(modelB.avgTps, 10);
    assert.equal(summary.rows.find((row) => row.model === "provider-c/invalid"), undefined);
    assert.ok(Math.abs(summary.speed.avgTps - 130 / 14) < 0.000001);

    const report = formatReport(summary);
    assert.match(report, /Avg TPS/);
    assert.match(report, /9\.2/);
    assert.match(report, /10\.0/);
  });
});

test("pi-usage TPS schema migration only backfills speed samples", async () => {
  await withTempDirectory(async (directory) => {
    const sessions = path.join(directory, "sessions");
    const databasePath = path.join(directory, "usage.duckdb");
    const timestamp = new Date();
    timestamp.setHours(12, 0, 0, 0);
    const date = timestamp.toLocaleDateString("sv-SE");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      path.join(sessions, "speed.jsonl"),
      [
        JSON.stringify({ type: "session", cwd: process.cwd() }),
        JSON.stringify({
          type: "message",
          timestamp: timestamp.toISOString(),
          message: {
            role: "assistant",
            provider: "provider",
            model: "model",
            usage: { input: 1, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
          },
        }),
        JSON.stringify({
          type: "custom",
          timestamp: timestamp.toISOString(),
          customType: "pi-token-speed",
          data: { version: 1, provider: "provider", model: "model", outputTokens: 100, elapsedMs: 10_000 },
        }),
      ].join("\n"),
      "utf8",
    );

    await summarizeUsage(sessions, date, databasePath);
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const instance = await DuckDBInstance.create(databasePath);
    const connection = await instance.connect();
    try {
      await connection.run("DELETE FROM speed_events");
      await connection.run("UPDATE usage_events SET input_tokens = 999 WHERE model = 'provider/model'");
      await connection.run("UPDATE usage_schema SET schema_version = 1 WHERE schema_key = 'usage'");
    } finally {
      connection.disconnectSync();
      instance.closeSync();
    }

    const summary = await summarizeUsage(sessions, date, databasePath);
    const row = summary.rows.find((value) => value.model === "provider/model");
    assert.equal(row.input, 999);
    assert.equal(row.avgTps, 10);
  });
});

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
    assert.match(skill, /reviewRequired/);
    assert.match(skill, /task_workflow\(action=complete/);
    assert.match(skill, /\/pi-init workflow resume/);
    assert.match(skill, /\/pi-init config/);
    assert.match(skill, /调用 `parallel_develop`/);
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

test("角色切换压缩等待 agent 完全结束而不是回合结束", async () => {
  const extension = await readFile(path.join(process.cwd(), "extensions", "init-project.ts"), "utf8");
  assert.match(
    extension,
    /pi\.on\("agent_settled",\s*async \(_event, ctx\) => \{\s*startPendingRoleCompaction\(ctx\);\s*await scheduleWorkflow\(ctx\);\s*\}\);/,
  );
  assert.doesNotMatch(extension, /pi\.on\("turn_end"[\\s\\S]{0,160}startPendingRoleCompaction/);
});

test("扩展注册顺序工作流并提供自动推进和显式审阅入口", async () => {
  const extension = await readFile(path.join(process.cwd(), "extensions", "init-project.ts"), "utf8");
  assert.match(extension, /name: "task_workflow"/);
  assert.match(extension, /action: StringEnum\(\["plan", "status", "complete", "block", "resume", "retry", "cancel"\]/);
  assert.match(extension, /reviewRequired=true only when the user's initial request explicitly asks/);
  assert.match(extension, /自动进入任务/);
  assert.match(extension, /\/pi-init workflow retry/);
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

test("架构工作流按依赖顺序推进并在完成后选择下一任务", () => {
  const planned = createWorkflowState(
    {
      summary: "完成用户认证改造",
      constraints: ["保留现有登录接口"],
      tasks: [
        {
          id: "schema",
          task: "更新认证数据结构",
          files: ["src/auth/schema.js"],
          acceptanceCriteria: ["迁移可重复执行", "新增回归测试"],
        },
        {
          id: "service",
          task: "实现认证服务",
          files: ["src/auth/service.js"],
          acceptanceCriteria: ["服务使用新结构"],
          dependsOn: ["schema"],
        },
        {
          id: "docs",
          task: "更新认证文档",
          role: "docs-commit",
          files: ["README.md"],
          acceptanceCriteria: ["文档与实际行为一致"],
          dependsOn: ["service"],
        },
      ],
    },
    100,
  );

  assert.equal(planned.status, "running");
  assert.equal(getNextWorkflowTask(planned).id, "schema");
  const first = startWorkflowTask(planned, "schema", 110);
  assert.equal(first.currentTaskId, "schema");
  const second = completeWorkflowTask(
    first,
    { taskId: "schema", completionSummary: "结构和迁移已完成", verification: ["npm test：通过"] },
    120,
  );
  assert.equal(second.currentTaskId, undefined);
  assert.equal(getNextWorkflowTask(second).id, "service");
  const third = completeWorkflowTask(
    startWorkflowTask(second, "service", 130),
    { taskId: "service", completionSummary: "服务已切换", verification: ["npm test：通过"] },
    140,
  );
  assert.equal(getNextWorkflowTask(third).id, "docs");
  const finished = completeWorkflowTask(
    startWorkflowTask(third, "docs", 150),
    { taskId: "docs", completionSummary: "文档已同步", verification: ["git diff --check：通过"] },
    160,
  );
  assert.equal(finished.status, "completed");
  assert.deepEqual(workflowProgress(finished), { completed: 3, total: 3, blocked: 0, currentTaskId: undefined });
});

test("架构工作流只有明确审阅要求时才暂停，并支持阻塞重试", () => {
  const review = createWorkflowState(
    {
      summary: "先审阅架构",
      reviewRequired: true,
      tasks: [{ id: "implementation", task: "实现方案", files: ["src"], acceptanceCriteria: ["测试通过"] }],
    },
    200,
  );
  assert.equal(review.status, "paused");
  assert.equal(review.pauseReason, "architecture-review");
  const running = resumeWorkflow(review, 210);
  const started = startWorkflowTask(running, "implementation", 220);
  const blocked = blockWorkflowTask(started, { taskId: "implementation", reason: "缺少产品决策" }, 230);
  assert.equal(blocked.status, "paused");
  assert.equal(blocked.tasks[0].status, "blocked");
  assert.throws(() => resumeWorkflow(blocked), /retry/);
  const retried = retryWorkflowTask(blocked, "implementation", 240);
  assert.equal(retried.status, "running");
  assert.equal(retried.tasks[0].status, "pending");
});

test("架构工作流未提交完成时有限次提醒后暂停", () => {
  const state = startWorkflowTask(
    createWorkflowState({
      summary: "提醒测试",
      tasks: [{ id: "task", task: "执行任务", files: ["src"], acceptanceCriteria: ["完成"] }],
    }),
    "task",
  );
  const nudged = recordWorkflowNudge(state);
  assert.equal(nudged.status, "running");
  assert.equal(nudged.nudgeCount, 1);
  const paused = recordWorkflowNudge(nudged);
  assert.equal(paused.status, "paused");
  assert.equal(paused.tasks[0].status, "blocked");
  assert.equal(paused.pauseReason, "task-not-completed");
  assert.equal(WORKFLOW_MAX_NUDGES, 2);
});

test("架构工作流拒绝重复任务、未知依赖和循环依赖", () => {
  assert.throws(
    () => validateWorkflowPlan({
      summary: "重复",
      tasks: [
        { id: "same", task: "a", files: ["a"], acceptanceCriteria: ["a"] },
        { id: "same", task: "b", files: ["b"], acceptanceCriteria: ["b"] },
      ],
    }),
    /id 重复/,
  );
  assert.throws(
    () => validateWorkflowPlan({
      summary: "未知依赖",
      tasks: [{ id: "a", task: "a", files: ["a"], acceptanceCriteria: ["a"], dependsOn: ["missing"] }],
    }),
    /不存在的任务/,
  );
  assert.throws(
    () => validateWorkflowPlan({
      summary: "循环",
      tasks: [
        { id: "a", task: "a", files: ["a"], acceptanceCriteria: ["a"], dependsOn: ["b"] },
        { id: "b", task: "b", files: ["b"], acceptanceCriteria: ["b"], dependsOn: ["a"] },
      ],
    }),
    /循环/,
  );
  assert.equal(WORKFLOW_MAX_TASKS, 12);
  assert.throws(
    () => cancelWorkflow({ status: "completed" }),
    /已经结束/,
  );
});

test("并行开发任务按目标文件系统处理大小写", () => {
  assert.doesNotThrow(() =>
    validateParallelTasks(
      [
        { id: "upper", task: "upper", files: ["src/Foo"] },
        { id: "lower", task: "lower", files: ["src/foo"] },
      ],
      { ignoreCase: false },
    ),
  );
  assert.throws(
    () =>
      validateParallelTasks(
        [
          { id: "upper", task: "upper", files: ["src/Foo"] },
          { id: "lower", task: "lower", files: ["src/foo"] },
        ],
        { ignoreCase: true },
      ),
    /文件范围重叠/,
  );
  assert.equal(isPathAllowed("src/Foo", ["src/foo"], { ignoreCase: true }), true);
  assert.equal(isPathAllowed("src/Foo", ["src/foo"], { ignoreCase: false }), false);
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

test("Windows Node/Bun 备用入口通过 cmd.exe 安全传参", () => {
  const invocation = getPiInvocation(["--model", "model name", "x&y"], {
    currentScript: "C:\\missing\\pi-entry.js",
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    platform: "win32",
  });

  assert.equal(invocation.command, process.env.ComSpec || "cmd.exe");
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(invocation.args[3], /model\^ name/);
  assert.match(invocation.args[3], /x\^&y/);
});

test("Windows 备用入口可以实际启动 Pi CLI", async () => {
  if (process.platform !== "win32") return;

  const invocation = getPiInvocation(["--version"], {
    currentScript: "C:\\missing\\pi-entry.js",
    execPath: process.execPath,
    platform: "win32",
  });
  const result = await spawnPiWorker(invocation, { cwd: process.cwd(), timeout: 5000 });

  assert.equal(result.code, 0);
  assert.equal(result.spawnError, undefined);
  assert.match(result.stdout, /\d+\.\d+\.\d+/);
});

test("子代理超时时会终止整个进程树", async () => {
  await withTempDirectory(async (directory) => {
    const pidFile = path.join(directory, "child.pid");
    const script = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const result = await spawnPiWorker(
      { command: process.execPath, args: ["-e", script] },
      { cwd: directory, timeout: 100 },
    );

    assert.equal(result.timedOut, true);
    const childPid = Number(await readFile(pidFile, "utf8"));
    let alive = true;
    for (let attempt = 0; attempt < 10 && alive; attempt += 1) {
      try {
        process.kill(childPid, 0);
      } catch (error) {
        alive = error.code === "EPERM";
      }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (alive) {
      if (process.platform === "win32") {
        await execFileAsync("taskkill.exe", ["/pid", String(childPid), "/t", "/f"]);
      } else {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The child may exit during cleanup.
        }
      }
    }
    assert.equal(alive, false, `子进程 ${childPid} 仍在运行`);
  });
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
    const cleanCode = await readFile(path.join(target, "docs/clean-code.md"), "utf8");
    const skill = await readFile(path.join(target, ".pi/skills/mall-app/SKILL.md"), "utf8");
    assert.match(agents, /## Project Purpose/);
    assert.match(agents, /## Runtime Environment and Command Conventions/);
    assert.match(agents, new RegExp("`" + process.platform + "`"));
    assert.match(agents, /- Test: `npm test`/);
    assert.match(agents, /docs\/clean-code\.md/);
    assert.match(agents, /Task Execution Workflow/);
    assert.match(agents, /task_workflow/);
    assert.match(cleanCode, /OBEY Clean Code by Robert C\. Martin/);
    assert.match(agents, /github\.com\/CGOSU\/knowledge\.git/);
    assert.match(agents, /git config user\.name CGOSU/);
    assert.match(skill, /name: mall-app/);
    assert.match(skill, /Architect.+Staff \/ Principal/);
    assert.match(skill, /Development and Test Engineer.+Senior \/ SDET/);
    assert.match(skill, /Documentation and Wrap-up Engineer.+Technical Writer \/ Release Engineer/);
    assert.match(skill, /Call `switch_role` before every role starts/);
    assert.match(skill, /task_workflow\(action=plan\)/);
    assert.match(skill, /reviewRequired/);
    assert.match(skill, /task_workflow\(action=complete/);
    assert.match(skill, /\/pi-init workflow resume/);
    assert.match(skill, /call `parallel_develop`/);
    assert.match(skill, /trusted projects/);
    assert.match(skill, /## Exact String Replacement/);
    assert.match(skill, /`oldText` → `newText`/);
    assert.match(skill, /must match exactly once in the original file/);
    assert.match(skill, /multiple non-overlapping replacements in one edit operation/);
  });
});
