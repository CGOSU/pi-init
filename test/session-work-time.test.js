import assert from "node:assert/strict";
import test from "node:test";
import {
  completeSessionWorkTime,
  createSessionWorkTime,
  getSessionWorkTime,
  startSessionWorkTime,
} from "../src/session-work-time.ts";
import { createSessionWorkTimeTracker } from "../extensions/session-work-time.ts";
import { createActivityStatus } from "../extensions/activity-status.ts";
import { createExtensionHarness, emitExtensionEvent } from "./support/extension-harness.js";

test("session 工作时间累计多个 Agent 工作区间，不包含闲置时间", () => {
  let state = createSessionWorkTime();
  state = startSessionWorkTime(state, 1_000);
  assert.equal(getSessionWorkTime(state, 6_000), 5_000);
  state = completeSessionWorkTime(state, 6_500);
  state = startSessionWorkTime(state, 10_000);
  state = completeSessionWorkTime(state, 13_000);

  assert.equal(getSessionWorkTime(state, 20_000), 8_500);
});

test("从已有普通执行记录恢复 session 累计工作时间", () => {
  const branch = [
    {
      type: "custom",
      customType: "pi-init-run-timing",
      data: { source: "interactive", startedAt: 0, completedAt: 1_000 },
    },
    {
      type: "custom",
      customType: "pi-init-run-timing",
      data: { source: "rpc", startedAt: 2_000, completedAt: 4_000 },
    },
  ];
  const harness = createExtensionHarness(branch, { mode: "rpc" });
  let now = 5_000;
  const tracker = createSessionWorkTimeTracker(() => now);
  tracker.restore(harness.context);
  tracker.start(harness.context);
  now = 6_000;
  tracker.complete(harness.context);

  assert.deepEqual(tracker.snapshot(harness.context), {
    totalMilliseconds: 4_000,
    lastStartedAt: 5_000,
    lastCompletedAt: 6_000,
  });
});

test("独立 session 记录恢复累计时间", () => {
  const branch = [{
    type: "custom",
    customType: "pi-init-session-work-time",
    data: {
      totalMilliseconds: 4_671_000,
      lastStartedAt: 5_000_000,
      lastCompletedAt: 5_002_000,
    },
  }];
  const harness = createExtensionHarness(branch, { mode: "rpc" });
  let now = 6_000_000;
  const tracker = createSessionWorkTimeTracker(() => now);
  tracker.restore(harness.context);
  tracker.start(harness.context);
  now = 6_001_000;
  tracker.complete(harness.context);

  assert.deepEqual(tracker.snapshot(harness.context), {
    totalMilliseconds: 4_672_000,
    lastStartedAt: 6_000_000,
    lastCompletedAt: 6_001_000,
  });
});

test("空闲 UI 将累计工作时间放入统一活动 widget，下一轮开始时清除", () => {
  let now = 1_000;
  const harness = createExtensionHarness([], { mode: "tui" });
  const activityStatus = createActivityStatus();
  const tracker = createSessionWorkTimeTracker(() => now, activityStatus);
  tracker.reset(harness.context);
  tracker.start(harness.context);
  now = 4_670_000;
  tracker.complete(harness.context);
  tracker.show(harness.context);

  assert.equal(harness.widgets.size, 1);
  assert.ok(harness.widgets.has("pi-init-activity"));

  now = 5_000_000;
  tracker.start(harness.context);
  assert.equal(harness.widgets.size, 0);
  now = 5_002_000;
  tracker.complete(harness.context);
  tracker.show(harness.context);
  assert.equal(harness.widgets.size, 1);
});

test("session 生命周期保存累计工作时间，关闭时不重复累计", async (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const harness = createExtensionHarness([], { mode: "tui" });
  await emitExtensionEvent(harness, "session_start");
  await emitExtensionEvent(harness, "agent_start");
  now += 1_000;
  await emitExtensionEvent(harness, "agent_settled");
  const saved = harness.entries.filter(({ type }) => type === "pi-init-session-work-time");
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].data, { totalMilliseconds: 1_000, lastStartedAt: 1_000, lastCompletedAt: 2_000 });

  now += 5_000;
  await emitExtensionEvent(harness, "session_shutdown");
  assert.deepEqual(harness.entries.filter(({ type }) => type === "pi-init-session-work-time"), saved);
});
