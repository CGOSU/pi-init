import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRuntimeSamples, durationStats, normalizeProfile, formatProviderObservations, formatContextProjections, formatToolFailureChains } from "../extensions/runtime-diagnostics-report.ts";
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

test("provider hook breakdown deduplicates rounds and leaves legacy details unknown", () => {
  const round = { kind: "summary", runtimeId: "r", captureId: "c", sessionId: "s", run: 1, providerObservations: { requests: 2, missing: 1, missingByHook: { headers: 0, response: 1, assistant: 0 } } };
  const request = { ...round, kind: "provider-request", requestNumber: 1, missingObservations: ["headers", "response"] };
  const legacy = { ...round, run: 2, providerObservations: { requests: 3, missing: 3 } };
  const report = formatProviderObservations([round, round, request, legacy]);
  assert.match(report, /请求摘要：5；观察缺失：4/);
  assert.match(report, /有细项的 2 个请求/);
  assert.match(report, /headers=0，response=1，assistant=0/);
  assert.doesNotMatch(formatProviderObservations([legacy]), /钩子缺失/);
  assert.match(formatProviderObservations([{ ...request, run: 3 }]), /headers=1，response=1，assistant=0/);
});
test("projection summaries deduplicate rounds without backfilling legacy fields", () => {
  const row = { kind: "summary", runtimeId: "r", captureId: "c", sessionId: "s", run: 1, contextProjection: { checks: 2, overBudget: 1, checkpointed: 1 } };
  assert.match(formatContextProjections([row, row]), /投影检查：2；检查点：1；投影预算超额：1/);
  assert.equal(formatContextProjections([{ kind: "summary" }]), "");
});
test("failure chains deduplicate snapshots, isolate windows and tolerate incomplete or cyclic evidence", () => {
  const observation = (id, parent) => ({ event: "tool.result", data: { toolCallId: id, parentToolCallId: parent, isError: true } });
  const row = { kind: "issue", runtimeId: "r", captureId: "c", sessionId: "s", events: [observation("child", "parent"), observation("parent", "root"), observation("root")] };
  assert.match(formatToolFailureChains([row, row]), /失败链：1/);
  assert.match(formatToolFailureChains([row, { ...row, captureId: "other" }]), /失败链：2/);
  assert.equal(formatToolFailureChains([{ ...row, events: [observation("child", "parent")] }]), "");
  assert.equal(formatToolFailureChains([{ ...row, events: [observation("child", "parent")] }, { ...row, captureId: "other", events: [observation("parent")] }]), "");
  assert.match(formatToolFailureChains([{ ...row, events: [observation("child", "parent"), observation("parent", "child")] }]), /失败链：1/);
});
