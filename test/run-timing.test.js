import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";

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

