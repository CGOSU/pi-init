import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRuntime } from "../scripts/diagnostics/runtime-report.js";

const profile = { provider: "openai-codex", model: "gpt-test", role: "developer-test", thinkingLevel: "high" };
const identity = { sourceCommit: "a".repeat(40), sourceFingerprint: "b".repeat(64) };
const at = seconds => `2026-11-04T13:00:${String(seconds).padStart(2, "0")}.000Z`;

function record(kind, changes = {}, line = 1, sourceId = "runtime") {
  return { sourceId, line, row: {
    version: 1, kind, runtimeId: "runtime-1", captureId: "capture-1", sessionId: "session-1",
    extensionVersion: "2.0.11", runtimeIdentity: identity, run: 1, timestamp: at(1), dropped: 0,
    ...changes,
  } };
}

function summary(changes = {}, line = 1) {
  return record("summary", { profile, durationMs: 100, tokens: { totalTokens: 1000 }, outcome: "normal-stop",
    aborted: false, incomplete: false, issueOccurrences: 0, overflow: 0, profileChanged: false, degraded: false,
    providerObservations: { requests: 2, missing: 0, missingByHook: { headers: 0, response: 0, assistant: 0 } },
    ...changes,
  }, line);
}

test("累计问题快照按scope折叠，乱序不影响最大次数与最新触发来源", () => {
  const rows = [
    record("issue", { id: "issue-1", category: "tool-failure", code: "UNKNOWN", toolName: "read", count: 3,
      firstSeen: at(1), lastSeen: at(4), latestTrigger: { sequence: 8, timestamp: at(4), event: "tool.result", data: { toolCallId: "call-4", isError: true } } }, 10),
    record("issue", { id: "issue-1", category: "tool-failure", code: "UNKNOWN", toolName: "read", count: 1,
      firstSeen: at(1), lastSeen: at(5), latestTrigger: { sequence: 9, timestamp: at(5), event: "tool.result", data: { toolCallId: "call-5", isError: true } } }, 20),
    record("issue", { id: "issue-1", category: "tool-failure", code: "UNKNOWN", toolName: "read", count: 2,
      captureId: "capture-2", firstSeen: at(2), lastSeen: at(3) }, 30),
  ];
  const report = summarizeRuntime(rows);
  assert.deepEqual(report, summarizeRuntime([...rows].reverse()));
  assert.equal(report.issues.observations, 5);
  assert.equal(report.issues.entries.length, 2);
  const issue = report.issues.entries.find(item => item.scope.captureId === "capture-1");
  assert.equal(issue.count, 3);
  assert.equal(issue.lastSeen, at(5));
  assert.equal(issue.latestTrigger.toolCallId, "call-5");
  assert.deepEqual(issue.countSource, { sourceId: "runtime", line: 10 });
  assert.deepEqual(issue.latestSource, { sourceId: "runtime", line: 20 });
});

test("回合去重后分开呈现全体与健康样本，不把错误或缺失用量补零", () => {
  const rows = [summary({}, 1), summary({}, 2),
    summary({ run: 2, outcome: "error", durationMs: 300, issueOccurrences: 1, tokens: {} }, 3),
    summary({ run: 3, outcome: "aborted", aborted: true, durationMs: 500, tokens: { totalTokens: 10 } }, 4),
    summary({ run: 4, outcome: undefined, durationMs: undefined, tokens: undefined }, 5),
  ];
  const result = summarizeRuntime(rows).rounds;
  assert.equal(result.count, 4);
  assert.deepEqual(result.outcomes, { "normal-stop": 1, error: 1, aborted: 1, unknown: 1 });
  assert.equal(result.healthySamples, 1);
  assert.deepEqual(result.durationMs.all, { count: 3, p50: 300, p95: 500 });
  assert.deepEqual(result.durationMs.healthy, { count: 1, p50: 100, p95: 100 });
  assert.equal(result.totalTokens.all.count, 2);
  assert.equal(result.totalTokens.healthy.count, 1);
});

test("同版本按真实commit与源码指纹分组，历史缺身份不从其他行推断", () => {
  const report = summarizeRuntime([
    summary({}, 1),
    summary({ run: 2, runtimeIdentity: { ...identity, sourceCommit: "c".repeat(40) } }, 2),
    summary({ run: 3, runtimeIdentity: { ...identity, sourceFingerprint: "d".repeat(64) } }, 3),
    summary({ run: 4, runtimeIdentity: undefined }, 4),
  ]);
  assert.equal(report.versions.length, 4);
  assert.equal(report.versions.filter(item => item.comparable).length, 3);
  const unknown = report.versions.find(item => item.identity.sourceCommit === "unknown");
  assert.equal(unknown.identity.sourceFingerprint, "unknown");
  assert.equal(unknown.rounds.count, 1);
  assert.deepEqual(unknown.sourceRefs, [{ sourceId: "runtime", line: 4 }]);
});

test("较新回合摘要优先且保留早期丢弃与溢出告警", () => {
  const rows = [summary({ timestamp: at(1), durationMs: 10, dropped: 2, overflow: 3, incomplete: true }, 1),
    summary({ timestamp: at(3), durationMs: 30 }, 2)];
  const report = summarizeRuntime(rows);
  assert.deepEqual(report, summarizeRuntime([...rows].reverse()));
  assert.equal(report.rounds.count, 1);
  assert.equal(report.rounds.durationMs.all.p50, 30);
  assert.equal(report.rounds.healthySamples, 0);
  assert.equal(report.integrity.droppedReportedMax, 2);
  assert.equal(report.integrity.overflowReportedMax, 3);
  assert.ok(report.integrity.flags.includes("dropped-records"));
  assert.ok(report.integrity.flags.includes("overflow"));
});

test("版本可来自显式加载身份，但互相矛盾的版本不擅自归属", () => {
  const loadedIdentity = { ...identity, extensionVersion: "2.0.11" };
  const report = summarizeRuntime([
    summary({ extensionVersion: undefined, runtimeIdentity: loadedIdentity }, 1),
    summary({ run: 2, extensionVersion: "2.0.12", runtimeIdentity: loadedIdentity }, 2),
  ]);
  assert.equal(report.versions.length, 2);
  assert.equal(report.versions.find(item => item.identity.extensionVersion === "2.0.11").comparable, true);
  assert.equal(report.versions.find(item => item.identity.extensionVersion === "unknown").comparable, false);
  assert.ok(report.integrity.flags.includes("unknown-version"));
});

test("Provider优先使用回合汇总，缺汇总时仅计已观察请求且保留缺失未知", () => {
  const report = summarizeRuntime([
    summary({ providerObservations: { requests: 2, missing: 1, missingByHook: { headers: 0, response: 1, assistant: 0 } } }),
    record("provider-request", { requestNumber: 1, missingObservations: ["response"] }, 2),
    summary({ run: 2, providerObservations: undefined }, 3),
    record("provider-request", { run: 2, requestNumber: 3, missingObservations: [] }, 4),
    record("provider-request", { run: 2, requestNumber: 4 }, 5),
  ]);
  assert.equal(report.provider.requests, 4);
  assert.equal(report.provider.missing, 1);
  assert.equal(report.provider.missingKnownRequests, 3);
  assert.equal(report.provider.unknownRuns, 1);
  assert.equal(report.provider.missingByHook.response, 1);
  assert.equal(report.provider.hookKnownRequests, 3);
});

test("缓存区分原始显式零、正值和未知，并对请求重复记录去重", () => {
  const observed = { correlation: "ordered-hooks", cacheOutcome: "assistant", rawUsageState: "observed" };
  const rows = [
    record("cache-request", { requestNumber: 1, ...observed, rawReadState: "positive", rawReadTokens: 20 }, 1),
    record("cache-request", { requestNumber: 2, ...observed, rawReadState: "zero", rawReadTokens: 0 }, 2),
    record("cache-request", { requestNumber: 3, rawReadState: "zero", rawReadTokens: 0 }, 3),
    record("cache-request", { requestNumber: 1, timestamp: at(0) }, 4),
  ];
  const report = summarizeRuntime(rows);
  assert.deepEqual(report, summarizeRuntime([...rows].reverse()));
  assert.deepEqual({ ...report.cache, sourceRefs: [] }, { requests: 3, positiveRead: 1, zeroRead: 1, unknownRead: 1, sourceRefs: [] });
});

test("缺少scope不猜身份，坏记录与未知版本显式报告，白名单不泄露正文", () => {
  const secret = "DO_NOT_EMIT_PRIVATE_BODY";
  const rows = [
    summary({ captureId: undefined }, 1),
    record("issue", { id: "issue", count: 1, category: "tool-failure", code: "UNKNOWN", message: secret,
      snapshot: { source: secret }, events: [{ data: { secret } }],
      latestTrigger: { event: "tool.result", timestamp: at(1), data: { toolCallId: "call", output: secret, arguments: secret } },
      evidenceTruncated: true, incomplete: true,
    }, 2),
    record("unknown-kind", { body: secret }, 3),
    record("summary", { version: 99, body: secret }, 4),
    { sourceId: "runtime", line: 5, row: null },
  ];
  const report = summarizeRuntime(rows);
  assert.equal(report.records.unscoped, 1);
  assert.equal(report.records.invalid, 1);
  assert.equal(report.records.unsupported, 2);
  assert.deepEqual(report.records.sources, [{ sourceId: "runtime", input: 5, accepted: 1, invalid: 1, unsupported: 2, unscoped: 1 }]);
  assert.equal(report.rounds.count, 0);
  assert.equal(report.integrity.incomplete, true);
  assert.ok(report.integrity.flags.includes("missing-scope"));
  assert.ok(report.integrity.flags.includes("evidence-truncated"));
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test("缺少完整健康标志的旧回合不进入基线，输入保持不变", () => {
  const rows = [summary({ aborted: undefined, incomplete: undefined, dropped: undefined, overflow: undefined,
    profileChanged: undefined, degraded: undefined }, 1)];
  const original = structuredClone(rows);
  const report = summarizeRuntime(rows);
  assert.equal(report.rounds.count, 1);
  assert.equal(report.rounds.healthySamples, 0);
  assert.ok(report.integrity.flags.includes("missing-health-fields"));
  assert.deepEqual(rows, original);
  assert.deepEqual(summarizeRuntime([]).rounds.durationMs.all, { count: 0, p50: null, p95: null });
});

test("问题新旧以触发时刻判断，不被较晚写入的旧快照覆盖", () => {
  const rows = [
    record("issue", { id: "issue", count: 2, firstSeen: at(1), lastSeen: at(4), timestamp: at(8),
      latestTrigger: { timestamp: at(4), event: "tool.result", data: { toolCallId: "new-call" } } }, 2),
    record("issue", { id: "issue", count: 1, firstSeen: at(1), lastSeen: at(2), timestamp: at(9),
      latestTrigger: { timestamp: at(2), event: "tool.result", data: { toolCallId: "old-call" } } }, 3),
  ];
  const report = summarizeRuntime(rows);
  assert.deepEqual(report, summarizeRuntime([...rows].reverse()));
  assert.equal(report.issues.entries[0].latestTrigger.toolCallId, "new-call");
  assert.equal(report.issues.entries[0].lastSeen, at(4));
});

test("元数据字段不能借通用标签校验将文件路径带入报告", () => {
  const paths = ["/Users/private/project", "C:\\private\\project", "C:/private/project", "../private/project", "relative/private/project"];
  for (const path of paths) {
    const rows = [
      record("issue", { id: "issue", count: 1, toolName: path, code: path,
        latestTrigger: { event: path, timestamp: at(1), data: {
          toolName: path, toolCallId: path, parentToolCallId: path, action: path, code: path,
        } },
      }),
      ...["runtimeId", "captureId", "sessionId", "id"].map((field, index) => record("issue", { id: "issue", count: 1, [field]: path }, index + 2)),
      record("issue", { id: "issue", count: 1 }, 8, path),
    ];
    const report = summarizeRuntime(rows);
    assert.equal(JSON.stringify(report).includes("private"), false, path);
    assert.equal(report.issues.entries[0].toolName, "unknown");
    assert.equal(report.issues.entries[0].latestTrigger.code, "UNKNOWN");
  }
});

test("模型保留合法命名空间，拒绝绝对路径与上级引用，错误码保持大写格式", () => {
  const rows = [summary({ profile: { ...profile, model: "meta-llama/llama-3.3" } }),
    ...["/Users/private/project", "C:/private/project", "../private/project", "org/../private"].map((model, index) =>
      summary({ run: index + 2, profile: { ...profile, provider: model, model, role: model, thinkingLevel: model } }, index + 2)),
    record("issue", { id: "issue", count: 1, code: "ERR_TEST", toolName: "read",
      latestTrigger: { event: "tool.result", timestamp: at(1), data: { toolCallId: "call_example|ctc_123/2/0", parentToolCallId: "call_example|ctc_123/2", action: "request-replan", code: "lowercase-code" } },
    }, 10),
  ];
  const report = summarizeRuntime(rows);
  assert.equal(JSON.stringify(report).includes("private"), false);
  assert.ok(report.versions.some(item => item.profile.model === "meta-llama/llama-3.3"));
  const issue = report.issues.entries[0];
  assert.equal(issue.code, "ERR_TEST");
  assert.equal(issue.latestTrigger.code, "UNKNOWN");
  assert.equal(issue.latestTrigger.toolCallId, "call_example|ctc_123/2/0");
  assert.equal(issue.latestTrigger.parentToolCallId, "call_example|ctc_123/2");
});
