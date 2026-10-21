import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRuntimeSamples, durationStats, normalizeProfile } from "../extensions/runtime-diagnostics-report.ts";
const profile = { provider: "test", model: "model", role: "session", thinkingLevel: "high" };
function samples(version, ms, options = {}) {
  return Array.from({ length: 8 }, (_, index) => ({ version: 1, kind: "summary", extensionVersion: version, runtimeId: "runtime", captureId: version, sessionId: "session", run: index + 1, timestamp: version === "old" ? "2026-01-01T00:00:00Z" : "2026-01-02T00:00:00Z", profile, durationMs: ms, tokens: { totalTokens: ms }, outcome: "normal-stop", issueOccurrences: 0, dropped: 0, overflow: 0, aborted: false, incomplete: false, ...options }));
}
test("分位数使用 nearest-rank，空样本不补零，配置不允许自由文本", () => {
  assert.deepEqual(durationStats([]), { count: 0 });
  assert.deepEqual(durationStats([10, 20, 30, 40]), { count: 4, p50: 20, p95: 40 });
  assert.equal(normalizeProfile({ ...profile, model: "bad\nmodel" }), undefined);
});
test("同配置不同版本有足够完整样本时才提供观察比值，不重复统计同一回合", () => {
  const old = samples("old", 100);
  const result = analyzeRuntimeSamples([...old, ...old, ...samples("new", 50)]);
  assert.equal(result.rounds, 16);
  assert.equal(result.comparisons.length, 1);
  assert.equal(result.comparisons[0].durationRatio, 0.5);
  assert.equal(result.comparisons[0].beforeVersion, "old");
  assert.equal(result.comparisons[0].tokenRatio, 0.5);
});
test("小样本、不同模型和缺失版本不进行版本对照", () => {
  for (const other of [samples("new", 50).slice(0, 7), samples("new", 50, { profile: { ...profile, model: "other" } }), samples(undefined, 50)]) {
    assert.equal(analyzeRuntimeSamples([...samples("old", 100), ...other]).comparisons.length, 0);
  }
});
test("取消、未知结束、错误、混合模型、丢弃样本不进入健康基线", () => {
  for (const changes of [{ aborted: true }, { outcome: "unknown" }, { issueOccurrences: 1 }, { incomplete: true }, { profileChanged: true }, { dropped: 1 }, { overflow: 1 }, { degraded: true }]) {
    const result = analyzeRuntimeSamples([...samples("old", 100), ...samples("new", 50, changes)]);
    assert.equal(result.comparisons.length, 0);
  }
});
test("缺失或部分 token 不补零；缺失模型维度不冒充可比样本", () => {
  const result = analyzeRuntimeSamples([...samples("old", 100, { tokens: {} }), ...samples("new", 50, { tokens: { input: 2 } })]);
  assert.equal(result.comparisons[0].tokenRatio, undefined);
  assert.equal(analyzeRuntimeSamples(samples("old", 100, { profile: undefined })).comparisons.length, 0);
});
