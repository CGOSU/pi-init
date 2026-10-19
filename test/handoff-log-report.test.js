import assert from "node:assert/strict";
import test from "node:test";
import { analyzeHandoffLog, parseHandoffLog } from "../scripts/handoff-report.js";

function row(sequence, event, data = {}, extra = {}) {
  return { version: 1, runtimeId: "runtime", sessionId: "session", run: 1, sequence,
    timestamp: new Date(sequence * 1000).toISOString(), event, data, snapshot: {}, ...extra };
}

function read(sequence, id, offset, limit, version = "v1", extra = {}) {
  return row(sequence, "tool.result", { toolName: "read", toolCallId: id, isError: false,
    files: [{ path: "core.rs", versionKind: "stat", version: version === "missing" ? undefined : version, offset, limit }], ...extra });
}

test("counts execution once, separates business errors and excludes user idle from runs", () => {
  const records = [row(1, "agent.before_start"), row(2, "agent.start"),
    row(3, "routing.model_proposed", { toolCallId: "a" }),
    row(4, "routing.tool_call", { toolCallId: "a", toolName: "switch_role", role: "docs-commit" }, { snapshot: { role: "docs-commit", locks: { roleRecovery: false } } }),
    row(5, "routing.tool_result", { toolCallId: "a", isError: false, businessOk: false }),
    row(6, "tool.execution_end", { toolCallId: "a", isError: false, durationMs: 7 }),
    row(7, "agent.end"), row(8, "agent.settled"), row(100, "input")];
  const result = analyzeHandoffLog(records);
  assert.equal(result.tools.calls, 1);
  assert.equal(result.tools.errors, 1);
  assert.equal(result.tools.sdkDurationMs, 7);
  assert.equal(result.runs[0].durationMs, 7000);
  assert.equal(result.sameRoleSwitches.length, 1);
});

test("overlap is interval-based, version scoped and ignores errors or unknown ranges", () => {
  const result = analyzeHandoffLog([read(1, "a", 1, 100), read(2, "b", 51, 100),
    read(3, "c", 1, 100, "v2"), read(4, "d", 1, 100, "v1", { isError: true }),
    read(5, "e", 1, undefined), read(6, "f", 1, 100, "v1", { truncated: true }),
    read(7, "g", 1, 100, "missing")]);
  assert.equal(result.repeatedReads.length, 1);
  assert.equal(result.repeatedReads[0].overlapLines, 50);
  assert.equal(result.repeatedReads[0].requestedLines, 200);
  assert.equal(result.repeatedReads[0].version, "v1");
});

test("rotated input is sorted and deduplicated, runtimes and sessions stay isolated", () => {
  const a = read(1, "a", 1, 100);
  const result = analyzeHandoffLog([read(2, "b", 51, 100), a, a,
    read(3, "c", 1, 100, "v1", { }),
    { ...read(1, "a", 1, 100), runtimeId: "other" },
    { ...read(1, "a", 1, 100), sessionId: "other" }]);
  assert.equal(result.events, 5);
  assert.equal(result.duplicateEvents, 1);
  assert.equal(result.repeatedReads[0].overlapLines, 150);
  assert.equal(result.repeatedReads.length, 1);
});

test("incomplete runs and extra SDK starts are reported, not invented as successful runs", () => {
  const result = analyzeHandoffLog([row(1, "agent.before_start"), row(2, "agent.start"),
    row(3, "agent.end"), row(4, "agent.start"), row(5, "agent.end"), row(6, "agent.settled"),
    row(7, "agent.before_start", {}, { run: 2 })]);
  assert.equal(result.runs[0].starts, 2);
  assert.equal(result.runs[0].durationMs, 5000);
  assert.equal(result.runs[1].durationMs, null);
  assert.ok(result.warnings.some(text => text.includes("agent.start")));
});

test("handoff latency requires matching identity within one runtime and session", () => {
  const coord = phase => ({ coordination: { handoff: { handoffId: "h", kind: "evidence", phase } } });
  const result = analyzeHandoffLog([row(1, "coordination.persisted", {}, { snapshot: coord("prepared") }),
    row(2, "coordination.persisted", {}, { snapshot: coord("executing"), runtimeId: "other" }),
    row(3, "coordination.persisted", {}, { snapshot: coord("executing") })]);
  assert.equal(result.handoffs.length, 1);
  assert.equal(result.handoffs[0].durationMs, 2000);
});

test("malformed and truncated JSONL lines are disclosed without hiding valid events", () => {
  const result = parseHandoffLog(JSON.stringify(row(1, "input")) + '\nnot-json\n{}\n{"event":');
  assert.equal(result.records.length, 1);
  assert.equal(result.warnings.length, 3);
});

test("batch ranges avoid per-line allocation and malformed file metadata does not crash reporting", () => {
  const files = [{ path: "large.rs", versionKind: "stat", version: "v", ranges: [{ start: 1, end: 1000000000 }] }];
  const result = analyzeHandoffLog([row(1, "tool.result", { toolName: "read", toolCallId: "a", files }),
    row(2, "tool.result", { toolName: "read", toolCallId: "b", files }),
    row(3, "tool.result", { toolName: "read", files: [null, { ...files[0], ranges: [null, {}] }] }),
    row(4, "tool.result", { toolName: "read", files: {} })]);
  assert.equal(result.repeatedReads[0].overlapLines, 1000000000);
  const invalid = parseHandoffLog(JSON.stringify(row(1, "input", [])) + "\n" + JSON.stringify(row(2, "input", {}, { snapshot: 42 })));
  assert.equal(invalid.records.length, 0);
  assert.equal(invalid.warnings.length, 2);
});

test("workflow handoffs, dropped records and incomplete tool observations stay explicit", () => {
  const snapshot = phase => ({ workflow: { handoff: { handoffId: "task-h", phase } } });
  const result = analyzeHandoffLog([row(1, "workflow.persisted", {}, { snapshot: snapshot("prepared"), dropped: 3 }),
    row(2, "workflow.persisted", {}, { snapshot: snapshot("queued") }),
    row(3, "workflow.persisted", {}, { snapshot: snapshot("executing") }),
    row(4, "tool.execution_start", { toolCallId: "unfinished" })]);
  assert.equal(result.handoffs[0].kind, "workflow");
  assert.equal(result.handoffs[0].durationMs, 2000);
  assert.equal(result.dropped, 3);
  assert.equal(result.tools.missingResults, 1);
  assert.ok(result.warnings.some(text => text.includes("丢弃")));
});

