import assert from "node:assert/strict";
import test from "node:test";
import { createCacheMissReminder, cacheMissSample, CACHE_MISS_NOTICE, CACHE_MISS_TOTAL } from "../extensions/cache-miss-reminder.ts";

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
  const reminder = createCacheMissReminder(pi, (_ctx, count, totalUsd) => statuses.push({ count, totalUsd }));
  handlers.get("session_start")({}, ctx);
  return { pi, ctx, entries, notices, statuses, reminder, handlers, session(value) { sessionId = value; handlers.get("session_start")({}, ctx); } };
}

test("threshold is exclusive, estimates partial misses, and persists one delivered notice per session", () => {
  const h = fixture();
  h.reminder.observe(h.ctx, message(0, 100000));
  h.reminder.observe(h.ctx, message(100000, 0, 0.599)); // $0.499 differential
  assert.equal(h.notices.length, 0);
  h.reminder.observe(h.ctx, message(100000, 0, 0.6)); // $0.50 differential
  assert.equal(h.notices.length, 0);
  assert.equal(h.statuses.at(-1).count, undefined);
  assert.equal(h.entries.length, 0);
  assert.equal(h.statuses.at(-1).totalUsd, undefined);
  h.reminder.observe(h.ctx, message(100000, 0, 0.601)); // $0.501 differential
  assert.equal(h.notices.length, 1);
  assert.equal(h.entries.at(-1).data.phase, "sent");
  h.reminder.observe(h.ctx, message(200000, 0));
  assert.equal(h.notices.length, 1);
  assert.equal(h.statuses.at(-1).count, 2);
  const resumed = fixture(h.entries);
  assert.equal(resumed.statuses.at(-1).count, 2);
  resumed.reminder.observe(resumed.ctx, message(0, 200000));
  resumed.reminder.observe(resumed.ctx, message(200000, 0));
  assert.equal(resumed.notices.length, 0);
  assert.equal(resumed.statuses.at(-1).count, 3);
  h.session("s2");
  assert.equal(h.statuses.at(-1).count, undefined);
  h.reminder.observe(h.ctx, message(0, 200000));
  h.reminder.observe(h.ctx, message(200000, 0));
  assert.equal(h.notices.length, 2);
  assert.equal(h.statuses.at(-1).count, 1);
  h.session("s1");
  assert.equal(h.statuses.at(-1).count, 3);
});

test("cumulative extra cost excludes small misses, continues after notification and restores per session", () => {
  const h = fixture();
  h.reminder.observe(h.ctx, message(0, 100000));
  h.reminder.observe(h.ctx, message(100000, 0, 0.3)); // $0.20, no notice
  assert.equal(h.statuses.at(-1).totalUsd, undefined);
  assert.equal(h.notices.length, 0);
  h.reminder.observe(h.ctx, message(100000, 0, 0.7)); // $0.60
  assert.ok(Math.abs(h.statuses.at(-1).totalUsd - 0.6) < 1e-12);
  assert.ok(h.notices[0].includes("$0.60"));
  h.reminder.observe(h.ctx, message(100000, 0, 0.7));
  assert.ok(Math.abs(h.statuses.at(-1).totalUsd - 1.2) < 1e-12);
  assert.equal(h.notices.length, 1);
  const restored = fixture(h.entries);
  assert.ok(Math.abs(restored.statuses.at(-1).totalUsd - 1.2) < 1e-12);
  restored.handlers.get("session_compact")({}, restored.ctx);
  restored.reminder.observe(restored.ctx, message(100000, 0));
  assert.ok(Math.abs(restored.statuses.at(-1).totalUsd - 1.2) < 1e-12);
  restored.session("s2");
  assert.equal(restored.statuses.at(-1).totalUsd, undefined);
});

test("provider-reported totals do not change counterfactual cache estimates or notice policy", () => {
  for (const totalFromProvider of [undefined, false, true]) {
    const h = fixture();
    h.reminder.observe(h.ctx, message(0, 100000));
    const sample = message(100000, 0, 0.7);
    sample.usage.cost.total = 99; // A reported total need not equal catalog components.
    sample.usage.cost.totalFromProvider = totalFromProvider;
    h.reminder.observe(h.ctx, sample);
    assert.ok(Math.abs(h.statuses.at(-1).totalUsd - 0.6) < 1e-12);
    assert.equal(h.statuses.at(-1).count, 1);
    assert.match(h.notices[0], /估算.*非账单金额/);
    h.reminder.observe(h.ctx, sample);
    assert.ok(Math.abs(h.statuses.at(-1).totalUsd - 1.2) < 1e-12);
    assert.equal(h.statuses.at(-1).count, 2);
  }
});

test("legacy totals without a threshold are not restored as qualified costs", () => {
  const h = fixture([{ type: "custom", customType: CACHE_MISS_TOTAL, data: { sessionId: "s1", totalUsd: 3 } }]);
  assert.equal(h.statuses.at(-1).totalUsd, undefined);
  h.reminder.observe(h.ctx, message(0, 100000));
  h.reminder.observe(h.ctx, message(100000, 0, 0.7));
  assert.ok(Math.abs(h.statuses.at(-1).totalUsd - 0.6) < 1e-12);
  assert.ok(Math.abs(fixture(h.entries).statuses.at(-1).totalUsd - 0.6) < 1e-12);
});

test("historical totals restore exact sample counts independently of notification and amount", () => {
  const notice = { type: "custom", customType: CACHE_MISS_NOTICE, data: { sessionId: "s1", phase: "sent" } };
  const total = (totalUsd, extra = {}) => ({ type: "custom", customType: CACHE_MISS_TOTAL,
    data: { sessionId: "s1", thresholdUsd: 0.5, totalUsd, ...extra } });
  const entries = [total(100), notice, total(900), total(1000, { sessionId: "s2" }),
    total(2000, { thresholdUsd: undefined }), total(NaN), total(-1), total(0.5)];
  const restored = fixture(entries);
  assert.deepEqual(restored.statuses.at(-1), { count: 2, totalUsd: 900 });
  for (let i = 0; i < 2; i++) {
    restored.handlers.get("session_tree")({}, restored.ctx);
    assert.deepEqual(restored.statuses.at(-1), { count: 2, totalUsd: 900 });
  }
  assert.equal(entries.length, 8); // Restoring does not append or replay samples.
  assert.equal(fixture([notice]).statuses.at(-1).count, undefined);
  assert.equal(fixture([total(900)]).statuses.at(-1).count, 1);
});

test("failed later persistence retains only successful events, while notification storage is independent", () => {
  for (const phase of ["notifying", "sent"]) {
    const h = fixture();
    const append = h.pi.appendEntry;
    h.pi.appendEntry = (type, data) => {
      if (type === CACHE_MISS_NOTICE && data.phase === phase) throw new Error("notice storage failure");
      append(type, data);
    };
    h.reminder.observe(h.ctx, message(0, 200000));
    h.reminder.observe(h.ctx, message(200000, 0));
    assert.equal(h.statuses.at(-1).count, 1);
    assert.equal(fixture(h.entries).statuses.at(-1).count, 1);
    h.pi.appendEntry = () => { throw new Error("disk full"); };
    h.reminder.observe(h.ctx, message(200000, 0));
    assert.equal(h.statuses.at(-1).count, 1);
    assert.equal(h.statuses.at(-1).totalUsd, 1.8);
    h.pi.appendEntry = append;
    h.reminder.observe(h.ctx, message(200000, 0));
    assert.equal(h.statuses.at(-1).count, 2);
    assert.equal(fixture(h.entries).statuses.at(-1).count, 2);
    assert.equal(h.notices.length, 1);
  }
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

test("headless usage neither consumes the notice nor records miss events", () => {
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

test("persisted events count despite failed notification; failed persistence never increments events", () => {
  const h = fixture();
  h.ctx.ui.notify = () => { throw new Error("UI unavailable"); };
  h.reminder.observe(h.ctx, message(0, 200000));
  h.reminder.observe(h.ctx, message(200000, 0));
  assert.equal(h.entries.at(-1).data.phase, "notifying");
  assert.equal(h.statuses.at(-1).count, 1);
  assert.equal(h.statuses.at(-1).totalUsd, 1.8);
  const resumed = fixture(h.entries);
  resumed.reminder.observe(resumed.ctx, message(0, 200000));
  resumed.reminder.observe(resumed.ctx, message(200000, 0));
  assert.equal(resumed.notices.length, 0);
  assert.equal(resumed.statuses.at(-1).count, 2);
  const failedStorage = fixture();
  failedStorage.pi.appendEntry = () => { throw new Error("disk full"); };
  failedStorage.reminder.observe(failedStorage.ctx, message(0, 200000));
  failedStorage.reminder.observe(failedStorage.ctx, message(200000, 0));
  assert.equal(failedStorage.notices.length, 0);
  assert.equal(failedStorage.statuses.at(-1).count, undefined);
  assert.equal(h.entries.find(e => e.customType === CACHE_MISS_NOTICE).data.phase, "notifying");
});
