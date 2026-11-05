import test from "node:test";
import assert from "node:assert/strict";
import { summarizeSessions } from "../scripts/diagnostics/session-report.js";

const header = (id = "session-1", cwd = "/private/project") => ({ type: "session", version: 3, id, cwd });
const entry = (id, message) => ({ type: "message", id, message });
const tool = (id, name = "task_workflow", fields = {}) => entry(id, { role: "toolResult", toolName: name, toolCallId: "call-" + id, isError: false, ...fields });
const records = (rows, sourceId = "source-1") => rows.map((row, index) => ({ row, sourceId, line: index + 1 }));

test("session report counts structured result observations and keeps only source references", () => {
  const secret = "Bearer secret-token /private/source.ts private-command private-error";
  const input = records([header(), tool("a", "task_workflow", { details: { ok: false, message: secret }, content: [{ type: "text", text: secret }] }),
    tool("b", "bash", { details: { exitCode: 2 }, input: { command: secret } }),
    tool("c", "read", { isError: true, structuredContent: { ok: false, exit_code: 1 } }),
    tool("d", "read", { content: [{ type: "text", text: '{"ok":false,"exitCode":99}' }] }),
    entry("e", { role: "toolResult", toolName: "unknown_tool", toolCallId: "call-e", details: { ok: "false", exitCode: "1" } }),
    entry("f", { role: "assistant", stopReason: "error", errorMessage: secret, usage: { input: 12, output: 0, cacheRead: 3, cacheWrite: -1, totalTokens: Infinity }, content: [{ type: "text", text: secret }] }),
    entry("g", { role: "assistant", stopReason: "aborted", usage: { input: 2, output: 1 } }),
  ]);
  const before = structuredClone(input);
  const report = summarizeSessions(input);
  assert.deepEqual(input, before, "analysis must not mutate session records");
  assert.equal(report.sessions.length, 1);
  assert.deepEqual(report.totals.toolResults, { total: 5, failed: 3, noFailureFlag: 1, unknown: 1, failureKinds: { toolError: 1, businessRejected: 2, nonzeroExit: 2 } });
  assert.equal(report.totals.assistant.error, 1);
  assert.equal(report.totals.assistant.aborted, 1);
  assert.deepEqual(report.totals.assistant.usage.input, { total: 14, observations: 2 });
  assert.deepEqual(report.totals.assistant.usage.cacheWrite, { total: 0, observations: 0 });
  assert.deepEqual(report.sessions[0].tools[0].sourceRefs[0], { sourceId: "source-1", line: 2, entryId: "a", toolCallId: "call-a" });
  const output = JSON.stringify(report);
  for (const forbidden of [secret, "/private", "private-command", "private-error", "exitCode", "Bearer"]) assert.equal(output.includes(forbidden), false);
  assert.ok(report.coverage.issues.some(item => item.code === "invalid-usage"));
});

test("duplicate files and entries do not double count, conflicting observations are excluded", () => {
  const first = [header(), tool("a"), entry("b", { role: "assistant", stopReason: "stop", usage: { input: 10 } })];
  const duplicates = summarizeSessions([...records(first), ...records(first, "copy")]);
  assert.equal(duplicates.totals.toolResults.total, 1);
  assert.equal(duplicates.totals.assistant.usage.input.total, 10);
  const report = summarizeSessions([...records(first), ...records(first, "copy"), ...records([header(), tool("a", "task_workflow", { isError: true })], "conflict")], { sessionIds: ["session-1"] });
  assert.equal(report.sessions.length, 1);
  assert.equal(report.totals.toolResults.total, 0);
  assert.equal(report.totals.assistant.messages, 1);
  assert.equal(report.totals.assistant.usage.input.total, 10);
  assert.equal(report.coverage.duplicateEntries, 3);
  assert.equal(report.coverage.conflictingEntries, 1);
});

test("association uses real per-source headers and explicit runtime session ids", () => {
  const report = summarizeSessions([
    ...records([header("ordinary"), tool("x", "read")], "ordinary-source"),
    ...records([header("unrelated"), tool("x", "read")], "unrelated-source"),
    ...records([tool("missing-head")], "missing-header"),
    ...records([{ ...header("future"), version: 99 }, tool("future-tool")], "future-source"),
    { row: tool("missing-reference"), line: 1 },
  ], { sessionIds: ["ordinary"] });
  assert.deepEqual(report.sessions.map(item => item.sessionId), ["ordinary"]);
  assert.equal(report.totals.toolResults.total, 1);
  assert.equal(report.coverage.unassociatedSessions, 1);
  assert.deepEqual(report.sessions[0].association, ["runtime-session-id"]);
  for (const code of ["missing-session-header", "unsupported-session-version", "missing-source-reference"]) assert.ok(report.coverage.issues.some(item => item.code === code));
  const mismatch = summarizeSessions([...records([header(), tool("a")]), ...records([header("session-1", "/other/private"), tool("b")], "other")]);
  assert.equal(mismatch.sessions.length, 0);
  assert.ok(mismatch.coverage.issues.some(item => item.code === "conflicting-session-cwd"));
});

test("nested SDK receipts remain separate from top-level results and text is never parsed", () => {
  const report = summarizeSessions(records([header(), { type: "custom", id: "marker", customType: "pi-init-role" },
    tool("a", "codemode", { nestedCalls: { complete: false, calls: [
      { id: "a/1", name: "read", status: "ok", arguments: { path: "/secret" } },
      { id: "a/2", name: "bash", status: "error", error: "private error" },
      { id: "a/3", name: "read", status: "unfinished" },
      { id: "a/1", name: "read", status: "ok" },
    ] }, details: { calls: [{ status: "error" }] }, content: [{ type: "text", text: '{"nestedCalls":{"calls":[{"status":"error"}]}}' }] }),
    tool("b", "codemode", { nestedCalls: { calls: [{ id: "b/1", name: "read", status: "error" }] } }),
    tool("c", "codemode", { nestedCalls: { complete: false, calls: [{ id: "c/1", name: "read", status: "ok", argumentsBytes: 20000 }] } }),
  ]));
  assert.equal(report.totals.toolResults.total, 3);
  assert.equal(report.totals.toolResults.failed, 0);
  assert.deepEqual(report.totals.nested, { receipts: 3, calls: 4, ok: 2, error: 1, unfinished: 1, incompleteReceipts: 3, unknownRecords: 1, omittedCalls: 0 });
  assert.equal(JSON.stringify(report).includes("private error"), false);
});

test("references, nested records and usage totals are bounded and missing schema remains visible", () => {
  const rows = [header(), ...Array.from({ length: 12 }, (_, index) => tool("result-" + index)),
    entry("usage-1", { role: "assistant", stopReason: "stop", usage: { input: Number.MAX_SAFE_INTEGER } }),
    entry("usage-2", { role: "assistant", stopReason: "stop", usage: { input: 1 } }),
    { type: "future-entry", id: "future" }, { type: "message", message: { role: "toolResult" } },
    tool("nested", "codemode", { nestedCalls: { complete: true, calls: Array.from({ length: 300 }, (_, index) => ({ id: String(index), name: "read", status: "ok" })) } })];
  const report = summarizeSessions(records(rows));
  assert.equal(report.sessions[0].tools[0].sourceRefs.length, 8);
  assert.equal(report.sessions[0].tools[0].omittedReferences, 4);
  assert.equal(report.totals.nested.calls, 256);
  assert.equal(report.totals.nested.omittedCalls, 44);
  assert.equal(report.totals.assistant.usage.input.total, Number.MAX_SAFE_INTEGER);
  assert.equal(report.coverage.incomplete, true);
  for (const code of ["unknown-entry-schema", "missing-entry-id", "usage-total-limit", "nested-call-limit"]) assert.ok(report.coverage.issues.some(item => item.code === code));
});

test("failure references survive a bounded prefix of successful observations", () => {
  const report = summarizeSessions(records([header(), ...Array.from({ length: 12 }, (_, index) => tool("ok-" + index)),
    tool("failed", "task_workflow", { isError: true }),
    ...Array.from({ length: 12 }, (_, index) => entry("reply-" + index, { role: "assistant", stopReason: "stop" })),
    entry("error-reply", { role: "assistant", stopReason: "error" }),
  ]));
  assert.equal(report.sessions[0].tools[0].failureSourceRefs[0].entryId, "failed");
  assert.equal(report.sessions[0].assistantFailureSourceRefs[0].entryId, "error-reply");
});

test("fork entry reuse is disclosed without merging different sessions or double counting copies", () => {
  const inherited = [tool("old-result"), entry("old-usage", { role: "assistant", stopReason: "stop", usage: { input: 10 } })];
  const original = [header("original"), ...inherited];
  const fork = [header("fork"), ...inherited, tool("new-result"), entry("new-usage", { role: "assistant", stopReason: "stop", usage: { input: 2 } })];
  const report = summarizeSessions([...records(original, "original-source"), ...records(fork, "fork-source"), ...records(fork, "fork-copy")]);
  assert.deepEqual(report.sessions.map(session => session.toolResults.total), [1, 2]);
  assert.equal(report.totals.toolResults.total, 3, "per-session observations remain attributed to their own session");
  assert.equal(report.totals.assistant.usage.input.total, 22);
  assert.equal(report.coverage.duplicateAcrossSessions, 2);
  assert.equal(report.coverage.duplicateEntries, 4);
  assert.equal(report.coverage.incomplete, true);
  assert.equal(report.coverage.crossSessionDuplicateCandidates.length, 2);
  assert.deepEqual(report.coverage.crossSessionDuplicateCandidates[0], {
    entryId: "old-result", kind: "tool", sessionIds: ["original", "fork"], projectionMatches: true,
    sourceRefs: [{ sourceId: "original-source", line: 2, entryId: "old-result", toolCallId: "call-old-result" },
      { sourceId: "fork-source", line: 2, entryId: "old-result", toolCallId: "call-old-result" }],
  });
  assert.match(report.totalsSemantics, /not-unique-executions/);
});
