import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";
import { createRunTimingView } from "../extensions/run-timing-view.ts";
import { formatRunTimingText } from "../extensions/run-timing-renderer.ts";
import { createRunTimingDiagnostics } from "../extensions/run-timing-diagnostics.ts";

const {
  completeRunTiming,
  createRunTiming,
  getRunTimingDuration,
  isExternalRunSource,
  createExtensionHarness,
  runExternalAgent,
} = helpers;

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

test("普通计时视图保留有效零耗时、本地时间与无效数据语义", () => {
  const input = { source: "interactive", startedAt: 100, completedAt: 100 };
  const before = structuredClone(input);
  const zeroDuration = createRunTimingView(input);
  assert.deepEqual(zeroDuration, {
    source: "interactive",
    startedAt: { kind: "available", milliseconds: 100 },
    completedAt: { kind: "available", milliseconds: 100 },
    duration: { kind: "available", milliseconds: 0 },
  });
  assert.match(formatRunTimingText(zeroDuration), /总耗时：0 毫秒/);
  assert.match(formatRunTimingText(createRunTimingView({
    source: "rpc",
    startedAt: 0,
    completedAt: 0,
  })), /开始时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
  assert.deepEqual(input, before);

  const invalid = createRunTimingView({ source: "unknown", startedAt: "100", completedAt: 99 });
  assert.equal(invalid.source, "unknown");
  assert.equal(invalid.startedAt.kind, "unavailable");
  assert.equal(invalid.completedAt.kind, "available");
  assert.equal(invalid.duration.kind, "unavailable");
  const invalidText = formatRunTimingText(invalid);
  assert.match(invalidText, /来源：未知来源/);
  assert.match(invalidText, /开始时间：不可用（无效的开始时间）/);
  assert.match(invalidText, /结束时间：1970-/);
  assert.match(invalidText, /总耗时：不可用（无效或不完整的时间戳）/);
});

test("普通执行时间条目 TUI renderer 消费结构化计时视图", () => {
  const harness = createExtensionHarness();
  const renderer = harness.renderers.get("pi-init-run-timing");
  const valid = renderer({ data: { source: "rpc", startedAt: 100, completedAt: 100 } }, {}, harness.context.ui.theme)
    .render(160).join("\n");
  assert.match(valid, /RPC 输入/);
  assert.match(valid, /总耗时：0 毫秒/);

  const invalid = renderer({ data: { source: "rpc", startedAt: 200, completedAt: 100 } }, {}, harness.context.ui.theme)
    .render(160).join("\n");
  assert.match(invalid, /总耗时：不可用（无效或不完整的时间戳）/);
});

test("普通执行扩展按首次开始和最终 settled 写入普通计时条目", async () => {
  const harness = createExtensionHarness();
  await runExternalAgent(harness, "interactive");
  await runExternalAgent(harness, "rpc", { toolName: "read" });
  await runExternalAgent(harness, "extension");

  const runEntries = harness.entries.filter(({ type }) => type === "pi-init-run-timing");
  assert.equal(runEntries.length, 2);
  assert.deepEqual(runEntries.map(({ type, data }) => ({ type, source: data.source })), [
    { type: "pi-init-run-timing", source: "interactive" },
    { type: "pi-init-run-timing", source: "rpc" },
  ]);
  for (const entry of runEntries) {
    assert.equal(typeof entry.data.startedAt, "number");
    assert.equal(typeof entry.data.completedAt, "number");
    assert.equal(getRunTimingDuration(entry.data), entry.data.completedAt - entry.data.startedAt);
  }
});
test("基础计时不依赖 Provider 和工具生命周期事件，重复启动只记一次总耗时", t => {
  let now = 100;
  t.mock.method(Date, "now", () => now);
  const entries = [];
  const timing = createRunTimingDiagnostics({ appendEntry: (type, data) => entries.push({ type, data }) }, () => false);
  assert.equal(timing.captureInput("interactive"), true);
  timing.beforeAgentStart(false);
  timing.agentStart();
  now = 150;
  timing.agentStart();
  now = 200;
  timing.settle();
  timing.settle();
  assert.deepEqual(entries, [{ type: "pi-init-run-timing", data: { source: "interactive", startedAt: 100, completedAt: 200 } }]);
});

test("内部续跑、活动工作流与 reset 不产生或泄漏普通计时", t => {
  let now = 100;
  let workflowActive = false;
  t.mock.method(Date, "now", () => now);
  const entries = [];
  const timing = createRunTimingDiagnostics({ appendEntry: (type, data) => entries.push({ type, data }) }, () => workflowActive);
  assert.equal(timing.captureInput("extension"), false);
  timing.captureInput("rpc");
  timing.beforeAgentStart(true);
  timing.agentStart();
  timing.settle();
  timing.captureInput("rpc");
  timing.beforeAgentStart(false);
  workflowActive = true;
  timing.agentStart();
  workflowActive = false;
  timing.settle();
  timing.captureInput("interactive");
  timing.beforeAgentStart(false);
  timing.agentStart();
  timing.reset();
  timing.settle();
  assert.deepEqual(entries, []);
  now = 300;
  timing.captureInput("rpc");
  timing.beforeAgentStart(false);
  timing.agentStart();
  now = 400;
  timing.settle();
  assert.deepEqual(entries, [{ type: "pi-init-run-timing", data: { source: "rpc", startedAt: 300, completedAt: 400 } }]);
});

test("旧计时记录携带额外阶段字段仍按原有起止时间显示", () => {
  const basic = { source: "rpc", startedAt: 100, completedAt: 200 };
  assert.deepEqual(createRunTimingView({ ...basic, inputAt: 50, providerRequestCount: 3, toolDurations: [{ name: "read", durationMs: 10 }] }), createRunTimingView(basic));
});

