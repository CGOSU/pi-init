import assert from "node:assert/strict";
import test from "node:test";
import { scanSessionFile } from "../scripts/pi-usage/core.js";
import * as helpers from "./helpers.js";
import { formatReport, parseUsageRange, summarizeUsage } from "../scripts/pi-usage.js";

const { mkdir, path, withTempDirectory, writeFile } = helpers;

function localDate(day, hour, minute) {
  return new Date(2026, 7, day, hour, minute).toISOString();
}

function usage(input, output, cost) {
  return { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } };
}

test("pi-usage 为复制的 session entry 生成稳定 key", async () => {
  await withTempDirectory(async (directory) => {
    const sessions = path.join(directory, "sessions");
    const timestamp = new Date();
    timestamp.setHours(12, 0, 0, 0);
    const assistant = {
      type: "message",
      id: "assistant-entry",
      timestamp: timestamp.toISOString(),
      message: {
        role: "assistant",
        provider: "provider",
        model: "model",
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      },
    };
    const speed = {
      type: "custom",
      id: "speed-entry",
      timestamp: timestamp.toISOString(),
      customType: "pi-token-speed",
      data: { version: 1, provider: "provider", model: "model", outputTokens: 2, elapsedMs: 1_000 },
    };
    const legacy = {
      type: "message",
      timestamp: timestamp.toISOString(),
      message: {
        role: "assistant",
        provider: "legacy",
        model: "model",
        usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      },
    };
    const contents = [
      JSON.stringify({ type: "session", id: "session-entry", cwd: process.cwd() }),
      JSON.stringify(assistant),
      JSON.stringify(speed),
      JSON.stringify(legacy),
    ].join("\n");
    await mkdir(path.join(sessions, "project-a"), { recursive: true });
    await mkdir(path.join(sessions, "project-b"), { recursive: true });
    const firstFile = path.join(sessions, "project-a", "first.jsonl");
    const copiedFile = path.join(sessions, "project-b", "copied.jsonl");
    await writeFile(firstFile, contents, "utf8");
    await writeFile(copiedFile, contents, "utf8");

    const first = await scanSessionFile(firstFile);
    const copied = await scanSessionFile(copiedFile);
    assert.equal(first.events[0].entryKey, copied.events[0].entryKey);
    assert.equal(
      first.activityEvents.find((event) => event.eventType === "assistant").entryKey,
      copied.activityEvents.find((event) => event.eventType === "assistant").entryKey,
    );
    assert.equal(first.speedEvents[0].entryKey, copied.speedEvents[0].entryKey);
    assert.match(first.events[1].entryKey, /^legacy:[0-9a-f]{64}$/);
    assert.equal(first.events[1].entryKey, copied.events[1].entryKey);

    const newFile = path.join(sessions, "project-b", "new.jsonl");
    await writeFile(newFile, contents.replace('"assistant-entry"', '"new-assistant-entry"'), "utf8");
    const added = await scanSessionFile(newFile);
    assert.notEqual(first.events[0].entryKey, added.events[0].entryKey);
  });
});

test("pi-usage 去重 fork session 的 usage、speed 和 activity", async () => {
  await withTempDirectory(async (directory) => {
    const sessions = path.join(directory, "sessions");
    const date = "2026-08-24";
    const timestamp = (minute) => localDate(24, 12, minute);
    const assistant = (id, minute, input, output, cost) => ({
      type: "message",
      id,
      timestamp: timestamp(minute),
      message: {
        role: "assistant",
        provider: "provider",
        responseModel: "model",
        usage: usage(input, output, cost),
      },
    });
    const user = {
      type: "message",
      id: "user-entry",
      timestamp: timestamp(2),
      message: { role: "user", content: "continue" },
    };
    const speed = (id, minute, outputTokens, elapsedMs) => ({
      type: "custom",
      id,
      timestamp: timestamp(minute),
      customType: "pi-token-speed",
      data: { version: 1, provider: "provider", model: "model", outputTokens, elapsedMs },
    });
    const history = [
      { type: "session", id: "source-session", timestamp: timestamp(0), cwd: process.cwd() },
      assistant("assistant-old", 1, 10, 5, 0.1),
      user,
      speed("speed-old", 1, 10, 1_000),
    ];
    const forkHistory = [
      { type: "session", id: "fork-session", timestamp: timestamp(10), cwd: process.cwd() },
      ...history.slice(1),
      assistant("assistant-new", 11, 20, 10, 0.2),
      speed("speed-new", 11, 40, 2_000),
    ];
    const files = [
      ["a-source.jsonl", history],
      ["b-copy.jsonl", history],
      ["c-fork.jsonl", forkHistory],
    ];
    const project = path.join(sessions, "project");
    await mkdir(project, { recursive: true });
    for (const [name, entries] of files) {
      await writeFile(path.join(project, name), entries.map(JSON.stringify).join("\n"), "utf8");
    }

    const summary = await summarizeUsage(sessions, date, path.join(directory, "usage.duckdb"));
    const model = summary.rows.find((row) => row.model === "provider/model");
    assert.ok(model);
    assert.equal(summary.sessions, 2);
    assert.deepEqual([model.calls, model.input, model.output, model.tokens], [2, 30, 15, 45]);
    assert.equal(Number(model.cost.toFixed(4)), 0.3);
    assert.ok(Math.abs(model.avgTps - 50 / 3) < 0.000001);
    assert.ok(Math.abs(summary.speed.avgTps - 50 / 3) < 0.000001);
    assert.equal(summary.duration.activeSeconds, 180);
    assert.equal(summary.duration.sessionSpanSeconds, 180);
    assert.equal(summary.duration.modelWaitSeconds, 120);
  });
});

test("pi-usage 解析快捷范围、月份和自定义日期范围", () => {
  const today = parseUsageRange();
  const yesterday = parseUsageRange("yesterday");
  const expectedYesterday = new Date(today.start);
  expectedYesterday.setDate(expectedYesterday.getDate() - 1);
  assert.equal(yesterday.startDate, expectedYesterday.toLocaleDateString("sv-SE"));
  assert.equal(parseUsageRange("7d").endDate, today.endDate);
  assert.equal(parseUsageRange("7d").start.getTime(), today.start.getTime() - 6 * 86400000);
  assert.deepEqual(
    [parseUsageRange("2026-08").startDate, parseUsageRange("2026-08").endDate],
    ["2026-08-01", "2026-08-31"],
  );
  assert.deepEqual(
    [parseUsageRange(["2026-08-01", "2026-08-25"]).startDate, parseUsageRange(["2026-08-01", "2026-08-25"]).endDate],
    ["2026-08-01", "2026-08-25"],
  );
  assert.throws(() => parseUsageRange("0d"), /正整数/);
  assert.throws(() => parseUsageRange(["2026-08-25", "2026-08-01"]), /开始日期不能晚于结束日期/);
  assert.throws(() => parseUsageRange(["7d", "2026-08-25"]), /日期必须是 YYYY-MM-DD/);
});

test("pi-usage 跨日汇总去重 session 并合计用量和时长", async () => {
  await withTempDirectory(async (directory) => {
    const sessions = path.join(directory, "sessions");
    const sessionFile = path.join(sessions, "project", "session.jsonl");
    await mkdir(path.dirname(sessionFile), { recursive: true });
    const message = (timestamp, role, model, values) => ({
      type: "message",
      timestamp,
      message: {
        role,
        ...(role === "assistant" ? { provider: "provider", responseModel: model } : {}),
        usage: usage(...values),
      },
    });
    await writeFile(
      sessionFile,
      [
        { type: "session", cwd: process.cwd() },
        message(localDate(24, 12, 0), "assistant", "model", [10, 5, 0.1]),
        message(localDate(24, 12, 2), "toolResult", undefined, [1, 1, 0.01]),
        message(localDate(25, 12, 0), "assistant", "model", [20, 10, 0.2]),
        message(localDate(25, 12, 2), "toolResult", undefined, [2, 2, 0.02]),
      ].map(JSON.stringify).join("\n"),
      "utf8",
    );

    const summary = await summarizeUsage(
      sessions,
      ["2026-08-24", "2026-08-25"],
      path.join(directory, "usage.duckdb"),
    );
    const model = summary.rows.find((row) => row.model === "provider/model");
    assert.equal(summary.date, "2026-08-24 → 2026-08-25");
    assert.equal(summary.sessions, 1);
    assert.deepEqual([model.calls, model.input, model.output, model.tokens], [2, 30, 15, 45]);
    assert.equal(Number(model.cost.toFixed(4)), 0.3);
    assert.equal(summary.duration.activeSeconds, 240);
    assert.equal(summary.duration.sessionSpanSeconds, 240);
    assert.match(formatReport(summary), /Pi usage · 2026-08-24 → 2026-08-25/);
  });
});
