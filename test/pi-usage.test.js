import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";

const {
  createReceiptSvg,
  parseArguments,
  PI_USAGE_VERSION,
  receiptFileName,
  dateRange,
  queryUsage,
  shouldRefreshUsage,
  summarizeUsage,
  installLaunchers,
  withTempDirectory,
  mkdir,
  readFile,
  rm,
  writeFile,
  path,
} = helpers;

test("跨平台 Pi 用量统计启动器指向共享脚本", async () => {
  const files = {
    windowsUsage: await readFile(path.join(process.cwd(), "scripts", "pi-usage.cmd"), "utf8"),
    posixUsage: await readFile(path.join(process.cwd(), "scripts", "pi-usage.sh"), "utf8"),
  };

  assert.match(files.windowsUsage, /pi-usage\.js/);
  assert.match(files.posixUsage, /pi-usage\.js/);
});

test("pi-init 与 pi-usage 共用版本号", async () => {
  const packageManifest = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(PI_USAGE_VERSION, packageManifest.version);
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
    const installedVersion = await readFile(path.join(directory, "pi-usage-lib", "version.js"), "utf8");
    const installedCore = await readFile(path.join(directory, "pi-usage-lib", "core.js"), "utf8");
    assert.match(installedUsage, /\.\/pi-usage-lib\/version\.js/);
    assert.match(installedCore, /DUCKDB_PACKAGE/);
    assert.ok(installedVersion.includes(`const EMBEDDED_PACKAGE_VERSION = "${packageManifest.version}";`));
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
    const supportSourceDir = path.join(process.cwd(), "scripts", "pi-usage");
    const supportTargetDir = path.join(sourceDir, "pi-usage");
    await mkdir(supportTargetDir, { recursive: true });
    for (const supportFile of [
      "version.js",
      "core.js",
      "database.js",
      "refresh.js",
      "report.js",
      "receipt.js",
      "cli.js",
    ]) {
      await writeFile(
        path.join(supportTargetDir, supportFile),
        await readFile(path.join(supportSourceDir, supportFile), "utf8"),
      );
    }
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
    const installedVersion = await readFile(path.join(actualPiDir, "pi-usage-lib", "version.js"), "utf8");
    assert.ok(installedVersion.includes('const EMBEDDED_PACKAGE_VERSION = "test-version";'));
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
    assert.equal(summary.sessions, 2);
    assert.ok(Number.isFinite(Date.parse(summary.updatedAt)));
    assert.equal(summary.rows.find((row) => row.model === "provider/response-model").tokens, 40);
    assert.equal(summary.rows.find((row) => row.model === "Tools/summaries").calls, 1);
    assert.equal(summary.rows.find((row) => row.model === "old/model"), undefined);
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
    assert.equal(cachedAfterChange.updatedAt, summary.updatedAt);
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
    assert.match(completedRefresh.stats.latestUpdatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
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

  });
});

test("pi-usage schema migration rebuilds usage and speed data", async () => {
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

    const progress = [];
    const summary = await summarizeUsage(sessions, date, databasePath, undefined, {
      onProgress: (event) => progress.push(event),
    });
    const row = summary.rows.find((value) => value.model === "provider/model");
    assert.equal(row.input, 1);
    assert.equal(row.avgTps, 10);
    const completeRefresh = progress.find((event) => event.type === "complete");
    assert.ok(completeRefresh);
    assert.equal(completeRefresh.stats.schemaMigrated, true);
    assert.equal(completeRefresh.stats.filesRebuilt, 1);
  });
});

test("pi-usage 对账单 SVG 汇总费用并转义动态文本", () => {
  const svg = createReceiptSvg(
    {
      date: "2026-09-22",
      sessions: 8,
      rows: [
        {
          model: 'provider/<model>&"',
          calls: 2,
          input: 2_549_990,
          output: 16_310,
          cacheRead: 2_490_000,
          cacheWrite: 0,
          tokens: 2_566_300,
          cost: 77.69,
        },
      ],
    },
    { generatedAt: new Date(2026, 8, 22, 20, 18) },
  );

  assert.match(svg, /每日 AI 对账单/);
  assert.match(svg, /2026年9月22日/);
  assert.match(svg, /20:18/);
  assert.match(svg, /US\$78/);
  assert.match(svg, /US\$77\.69/);
  assert.match(svg, /&lt;model&gt;&amp;&quot;/);
  assert.match(svg, /缓存命中率/);
  assert.match(svg, /会话数/);
  assert.doesNotMatch(svg, /<model>/);
});

test("pi-usage 对账单参数和默认文件名可预测", () => {
  const parsed = parseArguments(["--receipt", "--receipt-output", "receipt.svg", "2026-09-22"], "agent");
  assert.equal(parsed.receipt, true);
  assert.equal(parsed.receiptOutput, "receipt.svg");
  assert.deepEqual(parsed.rangeArguments, ["2026-09-22"]);
  assert.equal(parsed.databasePath, path.join("agent", "pi-usage.duckdb"));
  assert.equal(receiptFileName("2026-08-01 → 2026-08-25"), "pi-usage-receipt-2026-08-01-2026-08-25.svg");
  assert.throws(() => parseArguments(["--receipt-output"], "agent"), /--receipt-output 需要输出路径/);
});

test("pi-usage 空数据对账单明确显示无记录", () => {
  const svg = createReceiptSvg({ date: "2026-09-22", sessions: 0, rows: [] });
  assert.match(svg, /暂无模型用量记录/);
  assert.match(svg, /US\$0/);
});

