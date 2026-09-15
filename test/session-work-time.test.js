import assert from "node:assert/strict";
import test from "node:test";
import {
  completeSessionWorkTime,
  createSessionWorkTime,
  formatSessionWorkTime,
  getSessionWorkTime,
  startSessionWorkTime,
} from "../src/session-work-time.js";
import { createSessionWorkTimeTracker } from "../extensions/session-work-time.ts";
import * as helpers from "./helpers.js";

const { createExtensionHarness, emitExtensionEvent } = helpers;

test("session 工作时间累计多个 Agent 工作区间，不包含闲置时间", () => {
  let state = createSessionWorkTime();
  state = startSessionWorkTime(state, 1_000);
  assert.equal(getSessionWorkTime(state, 6_000), 5_000);
  state = completeSessionWorkTime(state, 6_500);
  state = startSessionWorkTime(state, 10_000);
  state = completeSessionWorkTime(state, 13_000);

  assert.equal(getSessionWorkTime(state, 20_000), 8_500);
  assert.equal(formatSessionWorkTime(0), "0s");
  assert.equal(formatSessionWorkTime(1 * 3_600_000 + 17 * 60_000 + 49_000), "1h 17m 49s");
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
  const harness = createExtensionHarness(branch, { mode: "tui" });
  const tracker = createSessionWorkTimeTracker(() => 5_000);
  tracker.restore(harness.context);

  const widget = [...harness.widgets.values()][0];
  const component = widget.content({}, harness.context.ui.theme);
  const rendered = component.render(80).join("\n");
  assert.match(rendered, /─ ⏱ Worked for 3s/);
  assert.doesNotMatch(rendered, /开始时间|结束时间/);
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
  const harness = createExtensionHarness(branch, { mode: "tui" });
  const tracker = createSessionWorkTimeTracker(() => 6_000_000);
  tracker.restore(harness.context);

  const widget = [...harness.widgets.values()][0];
  const component = widget.content({}, harness.context.ui.theme);
  const rendered = component.render(80).join("\n");
  assert.match(rendered, /─ ⏱ Worked for 1h 17m 51s/);
  assert.doesNotMatch(rendered, /开始时间|结束时间/);
});

test("空闲 UI 显示累计 Worked for，开始下一轮时清除", () => {
  let now = 1_000;
  const harness = createExtensionHarness([], { mode: "tui" });
  const tracker = createSessionWorkTimeTracker(() => now);
  tracker.reset(harness.context);
  tracker.start(harness.context);
  now = 4_670_000;
  tracker.complete(harness.context);
  tracker.show(harness.context);

  const widget = [...harness.widgets.values()][0];
  const component = widget.content({}, harness.context.ui.theme);
  const rendered = component.render(80).join("\n");
  assert.match(rendered, /─ ⏱ Worked for 1h 17m 49s/);
  assert.doesNotMatch(rendered, /开始时间|结束时间/);

  now = 5_000_000;
  tracker.start(harness.context);
  assert.equal(harness.widgets.size, 0);
  now = 5_002_000;
  tracker.complete(harness.context);
  tracker.show(harness.context);
  const nextWidget = [...harness.widgets.values()][0];
  const nextComponent = nextWidget.content({}, harness.context.ui.theme);
  const nextRendered = nextComponent.render(80).join("\n");
  assert.match(nextRendered, /─ ⏱ Worked for 1h 17m 51s/);
  assert.doesNotMatch(nextRendered, /开始时间|结束时间/);
});

test("session 生命周期在 TUI 空闲时显示累计工作时间", async () => {
  const harness = createExtensionHarness([], { mode: "tui" });
  await emitExtensionEvent(harness, "session_start");
  await emitExtensionEvent(harness, "agent_start");
  assert.equal(harness.widgets.size, 0);
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(harness.widgets.size, 1);
  assert.equal(harness.entries.filter(({ type }) => type === "pi-init-session-work-time").length, 1);

  await emitExtensionEvent(harness, "session_shutdown");
  assert.equal(harness.widgets.size, 0);
});
