import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { scanSessionFile } from "../scripts/pi-usage/core.js";
import { withDatabase } from "../scripts/pi-usage/database.js";
import { queryUsage, summarizeUsage } from "../scripts/pi-usage/refresh.js";
import { withTempDirectory } from "./support/temp-directory.js";

const date = "2026-11-05";
const user = (seconds) => ({ type: "message", timestamp: new Date(2026, 10, 5, 12, 0, seconds).toISOString(), message: { role: "user" } });
const assistant = (seconds) => ({ type: "message", timestamp: new Date(2026, 10, 5, 12, 0, seconds).toISOString(), message: { role: "assistant", provider: "test", model: "model", usage: { input: 1, output: 1, cost: { total: 0 } } } });
const jsonl = (entries) => entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";

test("incremental refresh rolls back checkpoints, events and summaries together after failure", async () => {
  await withTempDirectory(async (directory) => {
    const sessions = path.join(directory, "sessions");
    const database = path.join(directory, "usage.duckdb");
    const file = path.join(sessions, "session.jsonl");
    await mkdir(sessions);
    const initial = [user(0), assistant(30)];
    await writeFile(file, jsonl(initial));
    const before = await summarizeUsage(sessions, date, database);
    assert.equal(before.duration.activeSeconds, 30);
    await writeFile(file, jsonl([...initial, user(60), assistant(90)]));
    await assert.rejects(summarizeUsage(sessions, date, database, undefined, {
      onProgress(event) {
        if (event.type === "file") throw new Error("injected refresh failure");
      },
    }), /injected refresh failure/);
    const afterFailure = await queryUsage(date, database);
    assert.deepEqual(afterFailure.rows, before.rows);
    assert.deepEqual(afterFailure.duration, before.duration);
    const recovered = await summarizeUsage(sessions, date, database);
    assert.equal(recovered.rows[0].calls, 2);
    assert.equal(recovered.duration.activeSeconds, 90);
  });
});

test("session scanning skips invalid record shapes without losing subsequent valid usage", async () => {
  await withTempDirectory(async (directory) => {
    const file = path.join(directory, "session.jsonl");
    await writeFile(file, jsonl([null, 17, "not an entry", [], assistant(30)]));
    const result = await scanSessionFile(file);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].input, 1);
    assert.equal(result.checkpoint.hasIncompleteTail, false);
    assert.equal(result.checkpoint.importedOffset, result.metadata.fileSize);
  });
});

test("database instance is released when opening its connection fails", async (t) => {
  await withTempDirectory(async (directory) => {
    let closed = false;
    t.mock.method(DuckDBInstance, "create", async () => ({
      connect: async () => { throw new Error("connect failed"); },
      closeSync: () => { closed = true; },
    }));
    await assert.rejects(withDatabase(path.join(directory, "usage.duckdb"), directory, async () => { }), /connect failed/);
    assert.equal(closed, true);
  });
});

test("database instance is released even when connection cleanup throws", async (t) => {
  await withTempDirectory(async (directory) => {
    let closed = false;
    t.mock.method(DuckDBInstance, "create", async () => ({
      connect: async () => ({ run: async () => { }, disconnectSync: () => { throw new Error("disconnect failed"); } }),
      closeSync: () => { closed = true; },
    }));
    await assert.rejects(withDatabase(path.join(directory, "usage.duckdb"), directory, async () => { }), /disconnect failed/);
    assert.equal(closed, true);
  });
});
