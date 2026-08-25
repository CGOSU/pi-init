import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";
import { formatReport, parseUsageRange, summarizeUsage } from "../scripts/pi-usage.js";

const { mkdir, path, withTempDirectory, writeFile } = helpers;

function localDate(day, hour, minute) {
  return new Date(2026, 7, day, hour, minute).toISOString();
}

function usage(input, output, cost) {
  return { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } };
}

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
