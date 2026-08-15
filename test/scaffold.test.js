import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import initProjectExtension from "../extensions/init-project.ts";
import { installLaunchers } from "../scripts/install-launchers.js";
import {
  dateRange,
  formatReport,
  PI_USAGE_VERSION,
  queryUsage,
  shouldRefreshUsage,
  summarizeUsage,
} from "../scripts/pi-usage.js";
import { createScaffold, formatEnvironmentInstructions } from "../src/scaffold.js";
import {
  DEFAULT_PROVIDER_POLICY,
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
  assertModelAllowed,
  assertProviderAllowed,
  isModelAllowed,
  isProviderAllowed,
  normalizeModelReference,
  resolveProviderPolicy,
  resolveRoleConfig,
  resolveRoleMode,
  resolveWorkflowExecutor,
  resolveWorkflowMode,
  resolveRoleModel,
  shouldOrchestrateWorkflow,
  shouldCompactOnRoleSwitch,
} from "../src/roles.js";
import {
  WORKFLOW_MAX_NUDGES,
  WORKFLOW_MAX_TASKS,
  bindWorkflowAgent,
  blockWorkflowTask,
  beginWorkflowDelegation,
  cancelWorkflow,
  completeWorkflowTask,
  createWorkflowState,
  getNextWorkflowTask,
  getWorkflowTaskDuration,
  getWorkflowExecutionBounds,
  getWorkflowExecutionDuration,
  hydrateWorkflowState,
  markWorkflowTaskStarted,
  recordWorkflowDelegationFailure,
  recordWorkflowNudge,
  resumeWorkflow,
  retryWorkflowTask,
  startWorkflowTask,
  validateWorkflowPlan,
  requestWorkflowDelegationStop,
  workflowProgress,
} from "../src/workflow.js";
import {
  SUBAGENT_RESULT_MAX_BYTES,
  SUBAGENT_RESULT_PROTOCOL,
  matchesSubagentEvent,
  parseSubagentResult,
  parseSubagentSpawnReply,
  subagentFailureReason,
} from "../src/subagents.js";
import {
  completeRunTiming,
  createRunTiming,
  getRunTimingDuration,
  isExternalRunSource,
} from "../src/run-timing.js";

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

function createExtensionHarness(branch = [], options = {}) {
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  const notifications = [];
  const selectCalls = [];
  const renderers = new Map();
  const tools = [];
  const aborts = [];
  const defaultModel = options.model ?? { provider: "openai-codex", id: "gpt-5.6-luna" };
  const availableModels = options.availableModels ?? [defaultModel];
  let context;
  const pi = {
    on(name, handler) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    events: {
      on() {
        return () => {};
      },
      emit() {},
    },
    appendEntry(type, data) {
      entries.push({ type, data });
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerEntryRenderer(type, renderer) {
      renderers.set(type, renderer);
    },
    registerTool(tool) {
      tools.push(tool);
    },
    getThinkingLevel() {
      return options.thinkingLevel ?? "max";
    },
    setThinkingLevel() {},
    async setModel(model) {
      if (options.setModelResult === false) return false;
      if (context) context.model = model;
      return true;
    },
    sendMessage() {},
  };
  initProjectExtension(pi);

  context = {
    cwd: options.cwd ?? process.cwd(),
    mode: options.mode ?? "rpc",
    hasUI: options.hasUI ?? true,
    model: defaultModel,
    scopedModels: options.scopedModels ?? [],
    modelRegistry: {
      find(provider, id) {
        return availableModels.find((model) => model.provider === provider && model.id === id);
      },
      getAvailable() {
        return availableModels;
      },
    },
    isProjectTrusted() {
      return options.trusted ?? false;
    },
    getContextUsage() {
      return { percent: 0 };
    },
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus() {},
      async select(title, items) {
        selectCalls.push({ title, items });
        return options.select?.(title, items);
      },
      async input(title, placeholder) {
        return options.input?.(title, placeholder);
      },
    },
    abort() {
      aborts.push(true);
    },
    sessionManager: {
      getBranch() {
        return branch;
      },
    },
  };
  return { handlers, commands, entries, notifications, selectCalls, renderers, tools, aborts, context };
}

async function emitExtensionEvent(harness, name, event = {}) {
  for (const handler of harness.handlers.get(name) ?? []) {
    await handler(event, harness.context);
  }
}

async function runExternalAgent(harness, source) {
  await emitExtensionEvent(harness, "input", { source });
  await emitExtensionEvent(harness, "before_agent_start");
  await emitExtensionEvent(harness, "agent_start");
  await emitExtensionEvent(harness, "agent_start");
  await emitExtensionEvent(harness, "agent_settled");
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

test("pi-init 与 pi-usage 共用版本并在报告中输出", async () => {
  const packageManifest = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(PI_USAGE_VERSION, packageManifest.version);
  const report = formatReport({ date: "2026-08-15", sessions: 0, rows: [] });
  assert.ok(report.includes(`Pi usage · 2026-08-15 · v${packageManifest.version}`));
});

test("Pi package 更新时自动刷新 pi-usage 启动器", async () => {
  await withTempDirectory(async (directory) => {
    const packageManifest = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
    assert.equal(packageManifest.scripts.postinstall, "node scripts/install-launchers.js");

    assert.equal(await installLaunchers({ targetDir: directory, platform: "win32" }), true);
    assert.equal(await installLaunchers({ targetDir: directory, platform: "linux" }), true);
    assert.match(await readFile(path.join(directory, "pi-usage.cmd"), "utf8"), /pi-usage\.js/);
    assert.match(await readFile(path.join(directory, "pi-usage"), "utf8"), /pi-usage\.js/);
    const installedUsage = await readFile(path.join(directory, "pi-usage.js"), "utf8");
    assert.match(installedUsage, /DUCKDB_PACKAGE/);
    assert.ok(installedUsage.includes(`const EMBEDDED_PACKAGE_VERSION = "${packageManifest.version}";`));
  });
});

test("npm 生命周期 PATH 中的本地 pi shim 不会遮蔽实际 Pi 目录", async () => {
  await withTempDirectory(async (directory) => {
    const packageDir = path.join(directory, "package");
    const sourceDir = path.join(packageDir, "scripts");
    const localBinDir = path.join(packageDir, "node_modules", ".bin");
    const actualPiDir = path.join(directory, "pi-bin");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(localBinDir, { recursive: true });
    await mkdir(actualPiDir, { recursive: true });
    await writeFile(path.join(packageDir, "package.json"), JSON.stringify({ version: "test-version" }));
    await writeFile(
      path.join(sourceDir, "pi-usage.js"),
      await readFile(path.join(process.cwd(), "scripts", "pi-usage.js")),
    );
    await writeFile(
      path.join(sourceDir, "pi-usage.cmd"),
      await readFile(path.join(process.cwd(), "scripts", "pi-usage.cmd")),
    );
    await writeFile(
      path.join(sourceDir, "pi-usage.sh"),
      await readFile(path.join(process.cwd(), "scripts", "pi-usage.sh")),
    );
    await writeFile(path.join(localBinDir, "pi.cmd"), "local npm shim");
    await writeFile(path.join(actualPiDir, "pi.cmd"), "actual Pi CLI");

    assert.equal(
      await installLaunchers({
        sourceDir,
        platform: "win32",
        pathValue: [localBinDir, actualPiDir].join(";"),
      }),
      true,
    );
    const installedUsage = await readFile(path.join(actualPiDir, "pi-usage.js"), "utf8");
    assert.ok(installedUsage.includes('const EMBEDDED_PACKAGE_VERSION = "test-version";'));
    await assert.rejects(readFile(path.join(localBinDir, "pi-usage.js")));
  });
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

test("pi-usage 流式 checkpoint 处理不完整尾部和同尺寸改写", async () => {
  await withTempDirectory(async (directory) => {
    const sessions = path.join(directory, "sessions");
    const databasePath = path.join(directory, "usage.duckdb");
    const timestamp = new Date();
    timestamp.setHours(12, 0, 0, 0);
    const date = timestamp.toLocaleDateString("sv-SE");
    const message = (input) =>
      JSON.stringify({
        type: "message",
        timestamp: timestamp.toISOString(),
        message: {
          role: "assistant",
          provider: "provider",
          model: "model",
          usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        },
      });
    await mkdir(sessions, { recursive: true });
    const file = path.join(sessions, "stream.jsonl");
    const prefix = [JSON.stringify({ type: "session", cwd: process.cwd() }), message(1)].join("\n");
    await writeFile(file, prefix, "utf8");

    let summary = await summarizeUsage(sessions, date, databasePath);
    assert.equal(summary.rows[0].input, 1);

    const partial = message(2).slice(0, -1);
    await writeFile(file, `${prefix}\n${partial}`, "utf8");
    summary = await summarizeUsage(sessions, date, databasePath);
    assert.equal(summary.rows[0].input, 1);

    const { DuckDBInstance } = await import("@duckdb/node-api");
    const instance = await DuckDBInstance.create(databasePath);
    const connection = await instance.connect();
    try {
      const reader = await connection.runAndReadAll(
        "SELECT imported_offset, file_size, has_incomplete_tail FROM session_files",
      );
      const checkpoint = reader.getRowObjects()[0];
      assert.ok(checkpoint.imported_offset < checkpoint.file_size);
      assert.equal(checkpoint.has_incomplete_tail, true);
    } finally {
      connection.disconnectSync();
      instance.closeSync();
    }

    const completed = `${prefix}\n${message(2).slice(0, -1)}}`;
    await writeFile(file, completed, "utf8");
    summary = await summarizeUsage(sessions, date, databasePath);
    assert.equal(summary.rows[0].calls, 2);
    assert.equal(summary.rows[0].input, 3);

    await writeFile(file, completed.replace('"input":2', '"input":3'), "utf8");
    summary = await summarizeUsage(sessions, date, databasePath);
    assert.equal(summary.rows[0].calls, 2);
    assert.equal(summary.rows[0].input, 4);

    const progress = [];
    await summarizeUsage(sessions, date, databasePath, undefined, {
      onProgress: (event) => progress.push(event),
    });
    const completedRefresh = progress.find((event) => event.type === "complete");
    assert.ok(completedRefresh);
    assert.equal(completedRefresh.stats.filesSkipped, 1);
    assert.deepEqual(completedRefresh.stats.durationDates, []);
  });
});

test("pi-usage 柱状图使用分数块区分接近的 token 数", () => {
  const report = formatReport({
    date: "2026-08-10",
    sessions: 2,
    rows: [
      {
        model: "model-large",
        calls: 1,
        input: 0,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        tokens: 100,
        cost: 0,
      },
      {
        model: "model-close",
        calls: 1,
        input: 0,
        output: 99,
        cacheRead: 0,
        cacheWrite: 0,
        tokens: 99,
        cost: 0,
      },
    ],
  });

  assert.match(report, /model-large\s+█{24}\s+100/);
  assert.match(report, /model-close\s+█{23}▊\s+99/);
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
      ".pi/agents/pi-init-developer-test.md",
      ".pi/agents/pi-init-docs-commit.md",
      "docs/clean-code.md",
      "docs/current-state.md",
      "docs/decisions.md",
      "docs/session-log.md",
      "docs/pitfalls.md",
      ".pi/role-models.json",
      ".pi/skills/example-app/SKILL.md",
    ]);
    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    const developerAgent = await readFile(path.join(target, ".pi/agents/pi-init-developer-test.md"), "utf8");
    const docsAgent = await readFile(path.join(target, ".pi/agents/pi-init-docs-commit.md"), "utf8");
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
    for (const agent of [developerAgent, docsAgent]) {
      assert.match(agent, /^---\n/);
      assert.match(agent, /tools: read, bash, edit, write/);
      assert.match(agent, /extensions: false/);
      assert.match(agent, /skills: false/);
      assert.match(agent, /allowed_subagents: none/);
      assert.match(agent, /shared checkout/);
      assert.match(agent, /Do not create worktrees, branches, merges, commits, or pushes/);
      assert.match(agent, /pi-init\/task-result@1/);
      assert.doesNotMatch(agent, /isolation:\s*worktree/);
    }
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
      providerPolicy: {
        mode: "locked",
        allowedProviders: ["provider-architect", "provider-developer", "provider-docs"],
      },
      mode: "confirm",
      workflowMode: "on",
      workflowExecutor: "subagents",
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
    assert.equal(config.workflowExecutor, "subagents");
    assertSkillMatchesRoleConfig(skill, config);
    assert.match(skill, /\/pi-init config/);
  });
});

test("部分职责配置回退默认值并同步英文 Skill", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "partial-app");
    const roleModels = {
      providerPolicy: {
        mode: "locked",
        allowedProviders: ["openai-codex", "provider-architect"],
      },
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

test("普通执行计时限定外部来源并拒绝无效时间边界", () => {
  assert.equal(isExternalRunSource("interactive"), true);
  assert.equal(isExternalRunSource("rpc"), true);
  assert.equal(isExternalRunSource("extension"), false);
  assert.equal(isExternalRunSource(undefined), false);

  const started = createRunTiming("interactive", 100);
  assert.deepEqual(started, { source: "interactive", startedAt: 100 });
  assert.equal(getRunTimingDuration(started), undefined);
  assert.equal(createRunTiming("extension", 100), undefined);
  assert.equal(createRunTiming("interactive", Number.NaN), undefined);
  assert.equal(createRunTiming("interactive", Number.POSITIVE_INFINITY), undefined);

  const completed = completeRunTiming(started, 175);
  assert.deepEqual(completed, { source: "interactive", startedAt: 100, completedAt: 175 });
  assert.equal(getRunTimingDuration(completed), 75);
  assert.equal(completeRunTiming(started, 99), undefined);
  assert.equal(completeRunTiming(started, Number.NaN), undefined);
  assert.equal(completeRunTiming({ source: "extension", startedAt: 100 }, 175), undefined);
  assert.equal(getRunTimingDuration({ ...completed, completedAt: 99 }), undefined);
  assert.equal(getRunTimingDuration({ ...completed, completedAt: Number.POSITIVE_INFINITY }), undefined);
});

test("普通执行扩展按首次开始和最终 settled 写入 TUI 时间报告", async () => {
  const harness = createExtensionHarness();
  await runExternalAgent(harness, "interactive");
  await runExternalAgent(harness, "rpc");
  await runExternalAgent(harness, "extension");

  assert.equal(harness.entries.length, 2);
  assert.deepEqual(harness.entries.map(({ type, data }) => ({ type, source: data.source })), [
    { type: "pi-init-run-timing", source: "interactive" },
    { type: "pi-init-run-timing", source: "rpc" },
  ]);
  for (const entry of harness.entries) {
    assert.equal(typeof entry.data.startedAt, "number");
    assert.equal(typeof entry.data.completedAt, "number");
    assert.equal(getRunTimingDuration(entry.data), entry.data.completedAt - entry.data.startedAt);
  }

  const renderer = harness.renderers.get("pi-init-run-timing");
  assert.equal(typeof renderer, "function");
  const component = renderer(
    { data: harness.entries[0].data },
    { expanded: false },
    {
      fg: (color, text) => `<${color}>${text}</${color}>`,
      bold: (text) => `<bold>${text}</bold>`,
    },
  );
  const rendered = component.render(240).join("\n");
  assert.match(rendered, /<accent><bold>◆ 普通执行时间报告<\/bold><\/accent>/);
  assert.match(rendered, /<warning><bold>总耗时：/);
  assert.match(rendered, /开始时间：/);
  assert.match(rendered, /结束时间：/);
  assert.match(rendered, /总耗时：/);
  assert.match(rendered, /仅表示本次 Agent 执行，不代表工作流任务或业务任务已完成/);
});

test("Provider 锁在会话恢复、原生模型切换和输入前阻断非法模型", async () => {
  const safe = { provider: "openai-codex", id: "gpt-5.6-luna" };
  const unsafe = { provider: "openrouter", id: "anthropic/claude-haiku-4.5" };

  const restored = createExtensionHarness([], {
    model: unsafe,
    availableModels: [unsafe, safe],
    trusted: true,
  });
  await emitExtensionEvent(restored, "session_start");
  assert.deepEqual(restored.context.model, safe);
  assert.equal(restored.aborts.length, 0);

  const switched = createExtensionHarness([], {
    model: unsafe,
    availableModels: [unsafe, safe],
    trusted: true,
  });
  await emitExtensionEvent(switched, "model_select", {
    model: unsafe,
    previousModel: safe,
    source: "set",
  });
  assert.deepEqual(switched.context.model, safe);
  assert.equal(switched.aborts.length, 0);

  const noFallback = createExtensionHarness([], {
    model: unsafe,
    availableModels: [unsafe],
    trusted: true,
  });
  await emitExtensionEvent(noFallback, "session_start");
  const result = await (noFallback.handlers.get("input") ?? [])[0]({
    source: "interactive",
    text: "继续工作",
  }, noFallback.context);
  assert.deepEqual(result, { action: "handled" });
  assert.match(noFallback.notifications.at(-1)?.message ?? "", /无法恢复到可用的安全模型/);
});

test("Agent 子代理在 spawn 前继承安全模型并拒绝模糊或跨 Provider 模型", async () => {
  const safe = { provider: "openai-codex", id: "gpt-5.6-luna" };
  const harness = createExtensionHarness([], {
    model: safe,
    availableModels: [safe],
    trusted: true,
  });
  const handler = (harness.handlers.get("tool_call") ?? [])[0];
  assert.equal(typeof handler, "function");

  const inherited = { toolName: "Agent", input: {} };
  assert.equal(await handler(inherited, harness.context), undefined);
  assert.equal(inherited.input.model, "openai-codex/gpt-5.6-luna");

  const fuzzy = await handler({ toolName: "Agent", input: { model: "haiku" } }, harness.context);
  assert.equal(fuzzy.block, true);
  assert.equal(fuzzy.terminate, true);
  assert.match(fuzzy.reason, /必须显式指定 provider\/model/);

  const crossProvider = await handler(
    { toolName: "Agent", input: { model: "openrouter/anthropic/claude-sonnet-4" } },
    harness.context,
  );
  assert.equal(crossProvider.block, true);
  assert.match(crossProvider.reason, /不在允许列表中/);
});

test("角色模型选择器只展示 providerPolicy 允许的模型", async () => {
  const safe = { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" };
  const unsafe = { provider: "openrouter", id: "anthropic/claude-sonnet-4", name: "Sonnet" };
  const harness = createExtensionHarness([], {
    model: safe,
    availableModels: [safe, unsafe],
    trusted: true,
    input: async () => "",
    select: async (title, items) => title.startsWith("选择 架构设计 模型")
      ? items[0]
      : title.startsWith("推理强度")
        ? "max"
        : undefined,
  });
  const command = harness.commands.get("pi-init");
  await command.handler("config architect", harness.context);

  assert.equal(harness.selectCalls[0]?.title, "选择 架构设计 模型");
  assert.ok(harness.selectCalls[0].items.every((item) => !item.includes("openrouter")));
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
    "任务 ID：schema",
    "总耗时：10 毫秒",
    "完成摘要：结构完成",
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
    "工作流目标：冻结认证改造",
    "整体工作总结：",
    "完成进度：2/2",
    "- schema：结构完成",
    "- docs：文档完成",
    "工作复盘：",
    "冻结时间：1970-01-01T00:00:00.100Z",
    "实际开始时间：1970-01-01T00:00:00.115Z",
    "结束时间：1970-01-01T00:00:00.175Z",
    "整体总耗时：60 毫秒",
    "汇总验证：",
    "- schema：npm test：通过",
    "- docs：git diff --check：通过",
  ].join("\n");
  const workflowRendered = workflowTool.renderResult(
    { isError: false, content: [{ type: "text", text: workflowReport }], details: completed },
    { expanded: false },
    theme,
  ).render(240).join("\n");
  assert.match(workflowRendered, /<accent><bold>◆ 工作流完成报告<\/bold><\/accent>/);
  assert.match(workflowRendered, /<success><bold>工作流目标：冻结认证改造<\/bold><\/success>/);
  assert.match(workflowRendered, /<success><bold>整体工作总结：<\/bold><\/success>/);
  assert.match(workflowRendered, /<success><bold>完成进度：2\/2<\/bold><\/success>/);
  assert.match(workflowRendered, /<success><bold>工作复盘：<\/bold><\/success>/);
  assert.match(workflowRendered, /<warning><bold>整体总耗时：60 毫秒<\/bold><\/warning>/);
  assert.match(workflowRendered, /实际开始时间：1970-01-01T00:00:00\.115Z/);
  assert.match(workflowRendered, /结束时间：1970-01-01T00:00:00\.175Z/);
  assert.match(workflowRendered, /schema：结构完成/);
  assert.match(workflowRendered, /docs：git diff --check：通过/);
});

test("活动 subagents 工作流和会话中断不会伪造普通执行报告", async () => {
  const workflow = bindWorkflowAgent(
    beginWorkflowDelegation(
      startWorkflowTask(
        createWorkflowState({
          executor: "subagents",
          summary: "委派任务",
          tasks: [{ id: "task", task: "执行任务", files: ["src"], acceptanceCriteria: ["完成"] }],
        }, 100),
        "task",
        110,
      ),
      { taskId: "task", requestId: "request", type: "workflow-developer" },
      120,
    ),
    { taskId: "task", agentId: "agent" },
    130,
  );
  const branch = [{ type: "custom", customType: "pi-init-workflow", data: workflow }];
  const workflowHarness = createExtensionHarness(branch);
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
  const extension = await readFile(path.join(process.cwd(), "extensions", "init-project.ts"), "utf8");
  assert.match(
    extension,
    /pi\.on\("agent_settled",\s*async \(_event, ctx\) => \{[\s\S]*?startPendingRoleCompaction\(ctx\);\s*await scheduleWorkflow\(ctx\);\s*\}\);/,
  );
  assert.doesNotMatch(extension, /pi\.on\("turn_end"[\\s\\S]{0,160}startPendingRoleCompaction/);
});

test("扩展注册顺序工作流并提供自动推进和显式审阅入口", async () => {
  const extension = await readFile(path.join(process.cwd(), "extensions", "init-project.ts"), "utf8");
  assert.match(extension, /name: "task_workflow"/);
  assert.match(extension, /action: StringEnum\(\["plan", "status", "complete", "block", "resume", "retry", "cancel"\]/);
  assert.match(extension, /workflowMode: Type\.Optional\(StringEnum\(WORKFLOW_MODES/);
  assert.match(extension, /workflowEnabled: Type\.Optional\(Type\.Boolean/);
  assert.match(extension, /workflowExecutor: Type\.Optional\(StringEnum\(WORKFLOW_EXECUTORS/);
  assert.match(extension, /workflowExecutorLabel/);
  assert.match(extension, /function workflowStatusLabel\(state = workflowState\)[\s\S]*?\["completed", "cancelled"\][\s\S]*?inactiveWorkflowStateLabel/);
  assert.match(extension, /getWorkflowTaskDuration/);
  assert.match(extension, /markWorkflowTaskStarted/);
  assert.match(extension, /pi\.on\("agent_start"[\s\S]*?markWorkflowTaskStarted\(workflowState, task\.id\)/);
  assert.match(extension, /function formatWorkflowTaskCompletion\(task: ReturnType<typeof getWorkflowTask>\)/);
  assert.match(extension, /function formatWorkflowCompletion\(state: ReturnType<typeof createWorkflowState>\)/);
  for (const field of ["任务 ID：", "任务：", "角色：", "开始时间：", "结束时间：", "总耗时：", "完成摘要：", "验证结果：", "工作流目标：", "整体工作总结：", "完成进度：", "工作复盘：", "冻结时间：", "实际开始时间：", "整体总耗时：", "汇总验证："]) {
    assert.match(extension, new RegExp(field));
  }
  assert.doesNotMatch(extension, /工作流摘要：|任务进度：|各任务摘要：/);
  assert.match(extension, /历史任务未记录开始时间/);
  assert.match(extension, /async function configureWorkflow\(ctx: ExtensionCommandContext\)/);
  assert.match(extension, /requested === "workflow"/);
  assert.match(extension, /value: "workflow-config", label: `◆ 变更 · 工作流策略：[\s\S]*?配置当前会话的 task_workflow 编排策略/);
  assert.match(extension, /value: "off"[\s\S]*?value: "on"[\s\S]*?value: "auto"/);
  assert.match(extension, /case "plan":[\s\S]*?config\.workflowMode[\s\S]*?\/pi-init config workflow/);
  assert.match(extension, /createWorkflowState\(\{ \.\.\.plan, executor: config\.workflowExecutor \}\)/);
  assert.match(extension, /case "plan":[\s\S]*?if \(activeRoleFor\(ctx\)\?\.role !== "architect"\)/);
  assert.match(extension, /validateWorkflowPlan\([\s\S]*?shouldOrchestrateConfiguredWorkflow/);
  assert.match(extension, /function shouldOrchestrateConfiguredWorkflow\([\s\S]*?运行时版本不一致[\s\S]*?pi update --extensions[\s\S]*?\/reload/);
  assert.match(extension, /已跳过工作流编排[\s\S]*?不超过 2 个任务/);
  assert.match(extension, /switch \(params\.action\)[\s\S]*?case "plan":/);
  assert.match(extension, /reviewRequired=true only when the user's initial request explicitly asks/);
  assert.match(extension, /自动进入任务/);
  assert.match(extension, /value: "workflow-config", label: `◆ 变更 · 工作流策略：/);
  assert.match(extension, /工作流状态  \$\{workflowStateLabel\(\)\}/);
  assert.match(extension, /setStatus\(\s*"pi-init",[\s\S]*?工作流 · \$\{workflowStatusLabel\(\)\}/);
  const roleMenu = extension.match(/function roleMenuItems[\s\S]*?\n}\n/)?.[0] ?? "";
  assert.doesNotMatch(roleMenu, /value: "workflow"/);
  assert.match(extension, /\/pi-init workflow retry/);
  assert.match(extension, /subagents:rpc:spawn/);
  assert.match(extension, /subagents:rpc:spawn:reply:/);
  assert.match(extension, /subagents:completed/);
  assert.match(
    extension,
    /async function handleSubagentCompleted[\s\S]*?formatWorkflowTaskCompletion\(completedTask\)[\s\S]*?await scheduleWorkflow\(ctx\);/,
  );
  assert.match(
    extension,
    /case "complete":[\s\S]*?const taskCompletionReport = formatWorkflowTaskCompletion\(completedTask\)[\s\S]*?formatWorkflowCompletion\(next\)[\s\S]*?content: \[\{ type: "text", text: `\$\{completionReport\}/,
  );
  assert.match(
    extension,
    /handleSubagentCompleted[\s\S]*?const taskCompletionReport = formatWorkflowTaskCompletion\(completedTask\)[\s\S]*?formatWorkflowCompletion\(next\)[\s\S]*?ctx\.ui\.notify\(completionReport, "info"\)/,
  );
  assert.match(extension, /subagents:failed/);
  assert.match(extension, /parseSubagentResult/);
  assert.match(extension, /matchesSubagentEvent/);
  assert.match(extension, /Do not create worktrees, merge branches, commit, or push/);
  assert.doesNotMatch(extension, /from ["']@tintinweb\/pi-subagents/);
  assert.doesNotMatch(extension, /isolation:\s*["']worktree/);
  assert.match(extension, /A restored delegated task stays attached to its original worker/);
  assert.match(extension, /name: "switch_role"/);
  assert.doesNotMatch(extension, /parallel_develop/);
  assert.match(
    extension,
    /const selectedIndex = options\.selectedValue === undefined[\s\S]*?list\.setSelectedIndex\(selectedIndex\);/,
  );
  assert.match(
    extension,
    /let selectedAction: string \| undefined;[\s\S]*?\], \{ summary, selectedValue: selectedAction \}\);[\s\S]*?selectedAction = action;/,
  );
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

test("provider 策略默认锁定 openai-codex 并拒绝模糊模型", () => {
  assert.deepEqual(resolveProviderPolicy(undefined), DEFAULT_PROVIDER_POLICY);
  assert.deepEqual(resolveRoleConfig(undefined).providerPolicy, DEFAULT_PROVIDER_POLICY);
  assert.equal(isProviderAllowed("openai-codex"), true);
  assert.equal(isProviderAllowed("openrouter"), false);
  assert.equal(isModelAllowed("openai-codex/gpt-5.6-luna"), true);
  assert.equal(isModelAllowed("openrouter/anthropic/claude-haiku-4.5"), false);
  assert.equal(isModelAllowed("haiku"), false);
  assert.equal(isModelAllowed({ provider: "openai-codex", id: "gpt-5.6-luna" }), true);
  assert.deepEqual(normalizeModelReference("openai-codex/gpt-5.6-luna"), {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
  });
  assert.deepEqual(
    assertModelAllowed(
      { provider: "openai-codex", model: "gpt-5.6-luna" },
      DEFAULT_PROVIDER_POLICY,
    ),
    { provider: "openai-codex", model: "gpt-5.6-luna" },
  );
  assert.equal(assertProviderAllowed("openai-codex", DEFAULT_PROVIDER_POLICY), "openai-codex");
  assert.throws(() => resolveProviderPolicy({ allowedProviders: [] }), /非空数组/);
  assert.throws(
    () => resolveProviderPolicy({ allowedProviders: ["openai-codex", "  "] }),
    /allowedProviders\[1\].*无效/,
  );
  assert.throws(
    () => resolveProviderPolicy({ allowedProviders: ["openai-codex", "openai-codex"] }),
    /不能包含重复/,
  );
  assert.throws(
    () => resolveRoleConfig({
      architect: { provider: "openrouter", model: "claude", thinkingLevel: "max" },
    }),
    /不在允许列表中/,
  );
  assert.throws(() => assertModelAllowed("sonnet", DEFAULT_PROVIDER_POLICY), /必须显式指定/);
  assert.throws(
    () => assertModelAllowed("openrouter/anthropic/claude-sonnet-4", DEFAULT_PROVIDER_POLICY),
    /不在允许列表中/,
  );
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
  assert.equal(resolveWorkflowExecutor({ workflowExecutor: "subagents" }), "subagents");
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
  assert.equal(resolveRoleConfig({ workflowExecutor: "subagents" }).workflowExecutor, "subagents");
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
  assert.equal(first.tasks[0].startedAt, undefined);
  const firstStarted = markWorkflowTaskStarted(first, "schema", 115);
  assert.equal(firstStarted.tasks[0].startedAt, 115);
  assert.equal(firstStarted.tasks[0].executionStartedAt, 115);
  assert.equal(firstStarted.startedAt, 115);
  assert.equal(getWorkflowExecutionBounds(firstStarted).startedAt, 115);
  assert.equal(markWorkflowTaskStarted(firstStarted, "schema", 119), firstStarted);
  const second = completeWorkflowTask(
    firstStarted,
    { taskId: "schema", completionSummary: "结构和迁移已完成", verification: ["npm test：通过"] },
    120,
  );
  assert.equal(second.currentTaskId, undefined);
  assert.equal(second.tasks[0].completedAt, 120);
  assert.equal(getWorkflowTaskDuration(second.tasks[0]), 5);
  assert.equal(second.completedAt, undefined);
  assert.equal(getWorkflowExecutionDuration(second), 5);
  assert.equal(getNextWorkflowTask(second).id, "service");
  const secondStarted = markWorkflowTaskStarted(startWorkflowTask(second, "service", 130), "service", 135);
  const third = completeWorkflowTask(
    secondStarted,
    { taskId: "service", completionSummary: "服务已切换", verification: ["npm test：通过"] },
    140,
  );
  assert.equal(getNextWorkflowTask(third).id, "docs");
  const finishedStarted = markWorkflowTaskStarted(startWorkflowTask(third, "docs", 150), "docs", 155);
  const finished = completeWorkflowTask(
    finishedStarted,
    { taskId: "docs", completionSummary: "文档已同步", verification: ["git diff --check：通过"] },
    160,
  );
  assert.equal(finished.status, "completed");
  assert.equal(finished.startedAt, 115);
  assert.equal(finished.completedAt, 160);
  assert.deepEqual(getWorkflowExecutionBounds(finished), { startedAt: 115, completedAt: 160 });
  assert.equal(getWorkflowExecutionDuration(finished), 45);
  assert.deepEqual(workflowProgress(finished), { completed: 3, total: 3, blocked: 0, currentTaskId: undefined });
});

test("工作流状态从 version 1 迁移到本地执行器并保留任务进度", () => {
  const legacy = {
    version: 1,
    status: "running",
    plan: { summary: "旧工作流", constraints: [] },
    tasks: [{
      id: "legacy-task",
      task: "继续旧任务",
      role: "developer-test",
      files: ["src/legacy.js"],
      acceptanceCriteria: ["测试通过"],
      dependsOn: [],
      status: "in_progress",
    }],
    currentTaskId: "legacy-task",
    nudgeCount: 1,
    createdAt: 10,
    updatedAt: 20,
  };
  const restored = hydrateWorkflowState(legacy);
  assert.equal(restored.version, 2);
  assert.equal(restored.executor, "local");
  assert.equal(restored.currentTaskId, "legacy-task");
  assert.equal(restored.tasks[0].status, "in_progress");
  assert.equal(restored.tasks[0].startedAt, undefined);
  assert.equal(getWorkflowTaskDuration(restored.tasks[0]), undefined);
  const staleStarted = hydrateWorkflowState({
    ...legacy,
    tasks: [{ ...legacy.tasks[0], startedAt: 5 }],
  });
  const refreshedStart = markWorkflowTaskStarted(staleStarted, "legacy-task", 30);
  assert.equal(refreshedStart.tasks[0].startedAt, 30);
  assert.equal(refreshedStart.tasks[0].executionStartedAt, 30);
  assert.equal(restored.tasks[0].delegation, undefined);

  const legacyCompleted = hydrateWorkflowState({
    ...legacy,
    status: "completed",
    currentTaskId: undefined,
    tasks: [{ ...legacy.tasks[0], status: "completed", startedAt: 40, completedAt: 70 }],
  });
  assert.deepEqual(getWorkflowExecutionBounds(legacyCompleted), { startedAt: 40, completedAt: 70 });
  assert.equal(getWorkflowExecutionDuration(legacyCompleted), 30);
  assert.equal(getWorkflowExecutionDuration({ startedAt: 80, completedAt: 70, tasks: [] }), undefined);
  assert.throws(
    () => hydrateWorkflowState({ ...legacy, startedAt: 80, completedAt: 70 }),
    /completedAt 早于 startedAt/,
  );
});

test("subagents 工作流保存绑定、失败和取消状态", () => {
  const planned = createWorkflowState({
    executor: "subagents",
    summary: "委派实现任务",
    tasks: [{
      id: "implementation",
      task: "执行实现",
      files: ["src/feature.js"],
      acceptanceCriteria: ["测试通过"],
    }],
  }, 100);
  const started = startWorkflowTask(planned, "implementation", 110);
  const spawning = beginWorkflowDelegation(
    started,
    { taskId: "implementation", requestId: "request-1", type: "workflow-developer" },
    120,
  );
  assert.deepEqual(spawning.tasks[0].delegation, {
    requestId: "request-1",
    type: "workflow-developer",
    status: "spawning",
    createdAt: 120,
  });
  const running = bindWorkflowAgent(spawning, { taskId: "implementation", agentId: "agent-1" }, 130);
  assert.equal(running.tasks[0].delegation.status, "running");
  assert.equal(running.tasks[0].delegation.agentId, "agent-1");
  const failed = recordWorkflowDelegationFailure(
    running,
    { taskId: "implementation", agentId: "agent-1", reason: "子代理返回无效结果" },
    140,
  );
  assert.equal(failed.tasks[0].delegation.status, "failed");
  assert.equal(failed.tasks[0].delegation.reason, "子代理返回无效结果");
  const blocked = blockWorkflowTask(failed, { taskId: "implementation", reason: "结果协议无效" }, 150);
  assert.equal(blocked.status, "paused");
  assert.equal(blocked.tasks[0].delegation.status, "failed");

  const retried = retryWorkflowTask(blocked, "implementation", 160);
  assert.equal(retried.tasks[0].startedAt, undefined);
  assert.equal(retried.tasks[0].executionStartedAt, undefined);
  assert.equal(retried.tasks[0].completedAt, undefined);
  const rebound = bindWorkflowAgent(
    beginWorkflowDelegation(startWorkflowTask(retried, "implementation", 170), {
      taskId: "implementation",
      requestId: "request-2",
      type: "workflow-developer",
    }, 180),
    { taskId: "implementation", agentId: "agent-2" },
    190,
  );
  const cancelled = cancelWorkflow(rebound, 200);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.tasks[0].delegation.status, "stop-requested");
  assert.equal(requestWorkflowDelegationStop(cancelled), cancelled);
});

test("子代理结果协议严格验证完成、阻塞和异常结果", () => {
  const complete = parseSubagentResult(JSON.stringify({
    protocol: SUBAGENT_RESULT_PROTOCOL,
    outcome: "complete",
    completionSummary: "实现完成",
    verification: ["npm test：通过", "npm test：通过"],
  }));
  assert.deepEqual(complete, {
    outcome: "complete",
    completionSummary: "实现完成",
    verification: ["npm test：通过"],
  });
  assert.deepEqual(parseSubagentResult(JSON.stringify({
    protocol: SUBAGENT_RESULT_PROTOCOL,
    outcome: "blocked",
    reason: "缺少凭据",
  })), { outcome: "blocked", reason: "缺少凭据" });
  assert.throws(
    () => parseSubagentResult(JSON.stringify({
      protocol: SUBAGENT_RESULT_PROTOCOL,
      outcome: "complete",
      completionSummary: "完成",
      verification: [],
    })),
    /verification 必须是非空数组/,
  );
  assert.throws(
    () => parseSubagentResult(JSON.stringify({
      protocol: SUBAGENT_RESULT_PROTOCOL,
      outcome: "complete",
      completionSummary: "完成",
      verification: ["通过"],
      extra: true,
    })),
    /不支持的字段/,
  );
  assert.throws(
    () => parseSubagentResult("x".repeat(SUBAGENT_RESULT_MAX_BYTES + 1)),
    /结果过大/,
  );
  assert.deepEqual(parseSubagentSpawnReply({ success: true, data: { id: "agent-1" } }), { id: "agent-1" });
  assert.throws(() => parseSubagentSpawnReply({ success: false, error: "未安装" }), /未安装/);
  assert.equal(matchesSubagentEvent({ id: "agent-1", type: "workflow-developer" }, {
    agentId: "agent-1",
    type: "workflow-developer",
  }), true);
  assert.equal(matchesSubagentEvent({ id: "agent-2", type: "workflow-developer" }, { agentId: "agent-1" }), false);
  assert.match(subagentFailureReason({ error: "子代理失败" }), /子代理失败/);
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
  assert.equal(
    getWorkflowTaskDuration({ startedAt: 20, completedAt: 10 }),
    undefined,
  );
  assert.throws(
    () => hydrateWorkflowState({
      version: 2,
      status: "completed",
      plan: { summary: "无效时间", constraints: [] },
      tasks: [{
        id: "task",
        task: "任务",
        role: "developer-test",
        files: ["src"],
        acceptanceCriteria: ["完成"],
        dependsOn: [],
        status: "completed",
        startedAt: 20,
        completedAt: 10,
      }],
    }),
    /completedAt 早于 startedAt/,
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
    const developerAgent = await readFile(path.join(target, ".pi/agents/pi-init-developer-test.md"), "utf8");
    const docsAgent = await readFile(path.join(target, ".pi/agents/pi-init-docs-commit.md"), "utf8");
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
    for (const agent of [developerAgent, docsAgent]) {
      assert.match(agent, /tools: read, bash, edit, write/);
      assert.match(agent, /extensions: false/);
      assert.match(agent, /skills: false/);
      assert.match(agent, /allowed_subagents: none/);
    }
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
