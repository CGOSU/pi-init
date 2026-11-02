import assert from "node:assert/strict";
import test from "node:test";
import { createCacheMissReminder, cacheMissSample, CACHE_MISS_NOTICE } from "../extensions/cache-miss-reminder.ts";

function message(input, read, inputCost = input * 10 / 1_000_000) {
  return { role: "assistant", provider: "test", model: "model", timestamp: 1, stopReason: "toolUse", content: [], usage: { input, cacheRead: read, cacheWrite: 0, output: 1, cost: { input: inputCost, cacheRead: read / 1_000_000, cacheWrite: 0, output: 0 } } };
}
function fixture(entries = []) {
  const handlers = new Map(), notices = [], statuses = [];
  let sessionId = "s1";
  const pi = {
    on(name, fn) { handlers.set(name, fn); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  };
  const ctx = { hasUI: true, model: { provider: "test", id: "model", cost: { cacheRead: 1 } }, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries, getBranch: () => entries },
    ui: { notify(text) { notices.push(text); }, setStatus(key, text) { statuses.push({ key, text }); } },
  };
  const reminder = createCacheMissReminder(pi, (_ctx, count) => statuses.push({ count }));
  handlers.get("session_start")({}, ctx);
  return { pi, ctx, entries, notices, statuses, reminder, handlers, session(value) { sessionId = value; handlers.get("session_start")({}, ctx); } };
}

test("threshold is inclusive, estimates partial misses, and persists one delivered notice per session", () => {
  const h = fixture();
  h.reminder.observe(h.ctx, message(0, 100000));
  h.reminder.observe(h.ctx, message(100000, 0, 0.599)); // $0.499 differential
  assert.equal(h.notices.length, 0);
  h.reminder.observe(h.ctx, message(100000, 0, 0.6)); // $0.50 differential
  assert.equal(h.notices.length, 1);
  assert.equal(h.entries.at(-1).data.phase, "sent");
  h.reminder.observe(h.ctx, message(200000, 0));
  assert.equal(h.notices.length, 1);
  assert.equal(h.statuses.at(-1).count, 1);
  const resumed = fixture(h.entries);
  resumed.reminder.observe(resumed.ctx, message(0, 200000));
  resumed.reminder.observe(resumed.ctx, message(200000, 0));
  assert.equal(resumed.notices.length, 0);
  assert.equal(resumed.statuses.at(-1).count, 1);
  h.session("s2");
  assert.equal(h.statuses.at(-1).count, undefined);
  h.reminder.observe(h.ctx, message(0, 200000));
  h.reminder.observe(h.ctx, message(200000, 0));
  assert.equal(h.notices.length, 2);
});

test("the observed 220k partial miss reaches the threshold without requiring cacheRead=0", () => {
  const h = fixture();
  h.reminder.observe(h.ctx, message(241575, 25088));
  h.reminder.observe(h.ctx, message(219647, 24832));
  assert.equal(h.notices.length, 1);
  assert.ok(h.notices[0].includes("$1.98")); // Business threshold result, not a style assertion.
});

test("cold start, invalid usage or prices, failed replies and compaction do not create speculative notices", () => {
  const h = fixture();
  h.reminder.observe(h.ctx, message(200000, 0));
  h.reminder.observe(h.ctx, message(200000, 0));
  assert.equal(h.notices.length, 0);
  for (const bad of [
    { ...message(200000, 0), stopReason: "error" },
    { ...message(200000, 0), stopReason: "aborted" },
    { ...message(200000, 0), usage: undefined },
    { ...message(200000, 0), usage: { ...message(200000, 0).usage, input: NaN } },
    { ...message(200000, 0), usage: { ...message(200000, 0).usage, cost: {} } },
  ]) {
    h.reminder.observe(h.ctx, message(0, 200000));
    h.reminder.observe(h.ctx, bad);
    h.reminder.observe(h.ctx, message(200000, 0));
    assert.equal(h.notices.length, 0);
  }
  h.reminder.observe(h.ctx, message(0, 200000));
  h.handlers.get("session_compact")({}, h.ctx);
  h.reminder.observe(h.ctx, message(200000, 0));
  assert.equal(h.notices.length, 0);
  const noPrice = { ...h.ctx, model: undefined };
  assert.equal(cacheMissSample(message(200000, 0), noPrice).ok, false);
});

test("headless usage neither consumes the notice nor increments delivered counts", () => {
  const h = fixture();
  h.ctx.hasUI = false;
  h.reminder.observe(h.ctx, message(0, 200000));
  h.reminder.observe(h.ctx, message(200000, 0));
  assert.equal(h.notices.length, 0);
  assert.equal(h.entries.length, 0);
  assert.equal(h.statuses.at(-1).count, undefined);
  h.ctx.hasUI = true;
  h.reminder.observe(h.ctx, message(200000, 0));
  assert.equal(h.notices.length, 1);
});

test("UI or persistence failure cannot inflate delivered counts or replay an uncertain notification", () => {
  const h = fixture();
  h.ctx.ui.notify = () => { throw new Error("UI unavailable"); };
  h.reminder.observe(h.ctx, message(0, 200000));
  h.reminder.observe(h.ctx, message(200000, 0));
  assert.equal(h.entries.at(-1).data.phase, "notifying");
  assert.equal(h.statuses.at(-1).count, undefined);
  const resumed = fixture(h.entries);
  resumed.reminder.observe(resumed.ctx, message(0, 200000));
  resumed.reminder.observe(resumed.ctx, message(200000, 0));
  assert.equal(resumed.notices.length, 0);
  const failedStorage = fixture();
  failedStorage.pi.appendEntry = () => { throw new Error("disk full"); };
  failedStorage.reminder.observe(failedStorage.ctx, message(0, 200000));
  failedStorage.reminder.observe(failedStorage.ctx, message(200000, 0));
  assert.equal(failedStorage.notices.length, 0);
  assert.equal(failedStorage.statuses.at(-1).count, undefined);
  assert.equal(h.entries[0].customType, CACHE_MISS_NOTICE);
});
