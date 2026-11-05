import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSources, SOURCE_LIMITS } from "../scripts/diagnostics/sources.js";
import { collectDiagnostics, parseArguments, writeBundle } from "../scripts/diagnostics-report.js";
import { summarizeHandoff } from "../scripts/diagnostics/handoff-report.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-init-diagnostics-collection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const serialize = rows => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const runtimeIdentity = { extensionVersion: "2.0.11", sourceCommit: "a".repeat(40), sourceFingerprint: "b".repeat(64) };
function issue(count) {
  return { version: 1, kind: "issue", runtimeId: "runtime", captureId: "capture", sessionId: "session",
    id: "issue", category: "business-rejection", code: "REVISION_REQUIRED", stage: "business", toolName: "task_workflow",
    count, firstSeen: "2026-11-01T00:00:00Z", lastSeen: `2026-11-01T00:00:0${count}Z`,
    runtimeIdentity, events: [], snapshot: { secret: "PRIVATE_PAYLOAD" } };
}

test("collection discloses invalid, oversized and partial lines without copying their content", async t => {
  const directory = await fixture(t);
  const path = join(directory, "runtime.jsonl");
  const contents = '{"ok":true}\nPRIVATE_BROKEN_LINE\n' + "x".repeat(40) + '\n{"unfinished":';
  await writeFile(path, contents);
  const result = await readSources([{ kind: "runtime", path }], { ...SOURCE_LIMITS, lineBytes: 30 });
  assert.equal(result.records.runtime.length, 1);
  assert.equal(result.sources[0].invalidLines, 2);
  assert.equal(result.sources[0].oversizedLines, 1);
  assert.equal(result.sources[0].unterminatedTail, true);
  assert.equal(result.sources[0].sha256, createHash("sha256").update(contents).digest("hex"));
  assert.ok(!JSON.stringify(result).includes("PRIVATE_BROKEN_LINE"));
  assert.equal(await readFile(path, "utf8"), contents);
});

test("collection refuses oversized inputs and symlink files; record limit is explicit", async t => {
  const directory = await fixture(t);
  const path = join(directory, "source.jsonl");
  await writeFile(path, '{}\n{}\n');
  await assert.rejects(readSources([{ kind: "runtime", path }], { ...SOURCE_LIMITS, fileBytes: 1 }), /上限/);
  const limited = await readSources([{ kind: "runtime", path }], { ...SOURCE_LIMITS, records: 1 });
  assert.equal(limited.sources[0].omittedRecords, 1);
  if (process.platform !== "win32") {
    const link = join(directory, "link");
    await symlink(path, link);
    await assert.rejects(readSources([{ kind: "runtime", path: link }]), /无法读取/);
  }
});

test("local bundle deduplicates snapshots, correlates session evidence and never copies raw bodies", async t => {
  const directory = await fixture(t);
  const runtime = join(directory, "runtime.jsonl");
  const session = join(directory, "session.jsonl");
  const handoff = join(directory, "handoff.jsonl");
  await writeFile(runtime, serialize([issue(2), issue(1), issue(2)]));
  await writeFile(session, serialize([
    { type: "session", version: 3, id: "session", cwd: directory },
    { type: "message", id: "entry", message: { role: "toolResult", toolCallId: "call", toolName: "task_workflow",
      isError: true, content: [{ type: "text", text: "PRIVATE_TOOL_OUTPUT" }], details: { code: "REVISION_REQUIRED" } } },
    { type: "message", id: "user-entry", message: { role: "user", content: "PRIVATE_PROMPT" } },
  ]));
  await writeFile(handoff, serialize([
    { version: 1, runtimeId: "runtime", sessionId: "session", run: 1, sequence: 1, timestamp: "2026-11-01T00:00:00Z",
      event: "routing.tool_call", data: { toolCallId: "call", toolName: "switch_role", role: "docs-commit", secret: "PRIVATE_COMMAND" },
      snapshot: { role: "docs-commit" } },
  ]));
  const inputs = [{ kind: "runtime", path: runtime }, { kind: "session", path: session }, { kind: "handoff", path: handoff }];
  const original = await Promise.all(inputs.map(input => readFile(input.path, "utf8")));
  const bundle = await collectDiagnostics(inputs);
  assert.equal(bundle.report.runtime.issues.observations, 2);
  assert.equal(bundle.report.handoff.candidateCounts.sameRoleSwitches, 1);
  assert.ok(JSON.stringify(bundle.report.sessions).includes("task_workflow"));
  const output = join(directory, "bundle");
  await writeBundle(output, bundle);
  const json = await readFile(join(output, "report.json"), "utf8");
  const markdown = await readFile(join(output, "report.md"), "utf8");
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  assert.ok(!json.includes("PRIVATE_") && !markdown.includes("PRIVATE_"));
  assert.ok(!json.includes(directory));
  assert.equal(manifest.sources[0].path, runtime);
  assert.match(manifest.collectorSourceFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(manifest.artifacts.find(file => file.file === "report.json").sha256, createHash("sha256").update(json).digest("hex"));
  await assert.rejects(writeBundle(output, bundle), { code: "EEXIST" });
  assert.equal(await readFile(join(output, "report.json"), "utf8"), json);
  assert.deepEqual(await Promise.all(inputs.map(input => readFile(input.path, "utf8"))), original);
  if (process.platform !== "win32") {
    assert.equal((await stat(output)).mode & 0o777, 0o700);
    assert.equal((await stat(join(output, "report.json"))).mode & 0o777, 0o600);
  }
});

test("CLI requires explicit runtime and output; repeatable source flags never imply directory scanning", () => {
  assert.throws(() => parseArguments([]), /必须指定/);
  assert.throws(() => parseArguments(["--session", "session", "--output", "out"]), /必须指定/);
  assert.throws(() => parseArguments(["--runtime", "a", "--output", "b", "--output", "c"]), /只能指定/);
  assert.throws(() => parseArguments(["--upload", "yes"]), /参数无效/);
  assert.equal(parseArguments(["--runtime", "a", "--runtime", "b", "--output", "out"]).inputs.length, 2);
  assert.equal(parseArguments(["--help"]).help, true);
});

test("malformed detailed-log numeric fields cannot abort collection and duplicate evidence cites the chosen row", () => {
  const row = { version: 1, runtimeId: "runtime", sessionId: "session", run: 1, sequence: 1,
    timestamp: "2026-11-01T00:00:00Z", event: "tool.result",
    data: { toolName: "read", files: [{ path: "x", version: "v", versionKind: "stat",
      offset: { toString: null, valueOf: null }, limit: 10 }] } };
  assert.equal(summarizeHandoff([{ row, sourceId: "bad", line: 1 }]).invalidRecords, 1);
  const first = { ...row, event: "routing.tool_call", data: { toolName: "switch_role", role: "docs-commit" }, snapshot: { role: "docs-commit" } };
  const second = { ...first, data: { toolName: "read" } };
  const result = summarizeHandoff([{ row: first, sourceId: "first", line: 3 }, { row: second, sourceId: "second", line: 7 }]);
  assert.equal(result.conflictingDuplicates, 1);
  assert.deepEqual(result.candidates[0].source, { sourceId: "first", line: 3 });
});
