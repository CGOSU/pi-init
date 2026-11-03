import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { summarizeUsage, queryUsage } from "../scripts/pi-usage/refresh.js";
import { withDatabase } from "../scripts/pi-usage/database.js";
import { withTempDirectory } from "./support/temp-directory.js";

const day = "2026-08-09";
const event = (id, model, total, marker, date = day) => ({
  id, type: "message", timestamp: new Date(`${date}T12:00:00`).toISOString(),
  message: { role: "assistant", provider: "test", model: "routed", responseModel: model,
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0,
      cost: { total, ...(marker === undefined ? {} : { totalFromProvider: marker }) } } },
});

test("cost provenance survives import, aggregation, cached reads and incremental updates", async () => {
  await withTempDirectory(async directory => {
    const sessions = path.join(directory, "sessions");
    const db = path.join(directory, "usage.duckdb");
    await mkdir(sessions);
    const file = path.join(sessions, "cost.jsonl");
    const events = [
      event("p1", "provider", 2, true), event("p2", "provider", 3, true),
      event("e1", "estimated", 4, false), event("h1", "historical", 1),
      event("m1", "mixed", 2, true), event("m2", "mixed", 1),
      event("bad1", "invalid", null, true), event("bad2", "invalid-marker", 1, "true"),
      event("zero", "zero", 0, true),
    ];
    await writeFile(file, events.map(JSON.stringify).join("\n") + "\n");
    const summary = await summarizeUsage(sessions, day, db);
    const rows = new Map(summary.rows.map(row => [row.model, row]));
    assert.equal(rows.get("test/provider").costSource, "provider");
    assert.equal(rows.get("test/provider").cost, 5);
    assert.equal(rows.get("test/provider").calls, 2);
    for (const model of ["estimated", "historical", "invalid", "invalid-marker"]) {
      assert.equal(rows.get(`test/${model}`).costSource, "estimated");
    }
    assert.equal(rows.get("test/mixed").costSource, "mixed");
    assert.equal(rows.get("test/mixed").cost, 3);
    assert.equal(rows.get("test/zero").costSource, "provider");
    assert.equal(summary.costSource, "mixed");
    assert.deepEqual(new Map((await queryUsage(day, db)).rows.map(row => [row.model, row])), rows);
    assert.equal((await queryUsage(day, db)).costSource, "mixed");
    const appended = event("p3", "provider", 1, false);
    await appendFile(file, JSON.stringify(appended) + "\n");
    const updated = await summarizeUsage(sessions, day, db);
    assert.equal(updated.rows.find(row => row.model === "test/provider").costSource, "mixed");
    assert.equal(updated.rows.find(row => row.model === "test/provider").cost, 6);
  });
});

test("legacy schema reads conservatively without source files and rebuilds provenance when available", async () => {
  await withTempDirectory(async directory => {
    const sessions = path.join(directory, "sessions");
    const db = path.join(directory, "usage.duckdb");
    await mkdir(sessions);
    await writeFile(path.join(sessions, "cost.jsonl"), [
      event("p", "a", 2, true), event("h", "b", 1),
    ].map(JSON.stringify).join("\n"));
    await summarizeUsage(sessions, day, db);
    await withDatabase(db, undefined, async connection => {
      await connection.run("ALTER TABLE usage_events DROP COLUMN cost_from_provider");
      await connection.run("UPDATE usage_schema SET schema_version = 3");
    });
    const cached = await queryUsage(day, db);
    assert.equal(cached.costSource, "estimated");
    assert.equal(cached.rows.reduce((sum, row) => sum + row.cost, 0), 3);
    assert.ok(cached.rows.every(row => row.costSource === "estimated"));
    const rebuilt = await queryUsage(day, db, undefined, sessions);
    assert.equal(rebuilt.costSource, "mixed");
    assert.equal(rebuilt.rows.find(row => row.model === "test/a").costSource, "provider");
    assert.equal(rebuilt.rows.find(row => row.model === "test/b").costSource, "estimated");
    assert.equal(rebuilt.rows.reduce((sum, row) => sum + row.cost, 0), 3);
    assert.equal(rebuilt.rows.reduce((sum, row) => sum + row.calls, 0), 2);
    assert.deepEqual(
      new Map((await queryUsage(day, db)).rows.map(row => [row.model, row])),
      new Map(rebuilt.rows.map(row => [row.model, row])),
    );
  });
});

test("totals only claim provider origin when every included cost has that origin", async () => {
  await withTempDirectory(async directory => {
    const sessions = path.join(directory, "sessions");
    const db = path.join(directory, "usage.duckdb");
    await mkdir(sessions);
    await writeFile(path.join(sessions, "cost.jsonl"), [
      event("p", "a", 2, true, "2026-08-09"),
      event("p-other", "b", 0, true, "2026-08-09"),
      event("e", "a", 3, false, "2026-08-10"),
    ].map(JSON.stringify).join("\n"));
    assert.equal((await summarizeUsage(sessions, day, db)).costSource, "provider");
    assert.equal((await queryUsage("2026-08-10", db)).costSource, "estimated");
    assert.equal((await queryUsage([day, "2026-08-10"], db)).costSource, "mixed");
    assert.equal((await queryUsage("2026-08-11", db)).costSource, "estimated");
  });
});
