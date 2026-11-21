import "../scripts/test-bootstrap.js";
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createDiagnosticControls } from "../extensions/diagnostics/diagnostic-controls.ts";
import { SIDECAR_LIMIT } from "../extensions/diagnostics/diagnostic-layout.ts";
import { withDiagnosticLock } from "../extensions/diagnostics/diagnostic-storage.ts";
import { createDiagnosticWriter } from "../extensions/diagnostics/diagnostic-writer.ts";
import { createHandoffDiagnostics } from "../extensions/diagnostics/handoff-diagnostics.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { diagnosticPath, diagnosticRoot, sessionKey } from "./support/diagnostic-paths.js";
import { withTempDirectory } from "./support/temp-directory.js";

const read = async path => (await fs.readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
const fixtureContext = (cwd, id) => ({
  cwd, hasUI: true, isProjectTrusted: () => true,
  sessionManager: { getSessionId: () => id, getSessionFile() { throw new Error("must not consult the raw session file"); } },
  ui: { notify() {}, confirm: async () => true },
});
const writerOptions = { maxBytes: 4096, maxPending: 8, warning: "diagnostics unavailable" };

async function put(file, text) {
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

test("extension events associate Agent sidecars with their project and session, not raw or legacy log paths", async () => withTempDirectory(async root => {
  const agent = join(root, "agent"), project = join(root, "one"), otherProject = join(root, "two");
  const oldRuntime = join(project, ".pi", "diagnostics", "runtime.jsonl");
  const oldHandoff = join(project, ".pi", "logs", "handoff.jsonl");
  const rawSession = join(agent, "sessions", "project-directory", "raw-session.jsonl");
  for (const path of [oldRuntime, oldHandoff, rawSession]) await put(path, "original\n");
  const hooks = new Map();
  const pi = { on: (name, handler) => hooks.set(name, handler) };
  const options = { agentDir: () => agent };
  const monitor = createHandoffDiagnostics(pi, createExtensionRuntimeState(), { ...options, mode: "automatic" });
  const first = fixtureContext(project, "first"), second = fixtureContext(project, "second");
  const other = fixtureContext(otherProject, "first");
  async function issue(ctx, toolName) {
    await hooks.get("before_agent_start")({}, ctx);
    await hooks.get("tool_result")({ toolName, toolCallId: "same-id", isError: true, input: {}, details: { code: "FAILURE" } }, ctx);
    await hooks.get("agent_settled")({}, ctx);
  }
  await issue(first, "first_tool");
  await issue(second, "second_tool");
  await issue(other, "other_project_tool");
  const untrusted = fixtureContext(project, "untrusted");
  untrusted.isProjectTrusted = () => false;
  await issue(untrusted, "must_not_log");
  await monitor.flush();

  for (const [ctx, tool] of [[first, "first_tool"], [second, "second_tool"], [other, "other_project_tool"]]) {
    const path = diagnosticPath("project", ctx, agent);
    assert.deepEqual([...new Set((await read(path)).filter(row => row.kind === "issue").map(row => row.toolName))], [tool]);
    await assert.rejects(fs.stat(diagnosticPath("handoff", ctx, agent)), { code: "ENOENT" });
  }
  await assert.rejects(fs.stat(diagnosticPath("project", untrusted, agent)), { code: "ENOENT" });
  const report = await monitor.report(first);
  assert.match(report, /first_tool/); assert.match(report, /second_tool/); assert.doesNotMatch(report, /other_project_tool/);
  const key = sessionKey(project, "second");
  const sessionReport = await monitor.report(first, key);
  assert.match(sessionReport, /second_tool/); assert.doesNotMatch(sessionReport, /first_tool|other_project_tool/);

  const verbose = createHandoffDiagnostics(pi, createExtensionRuntimeState(), { ...options, mode: "verbose" });
  await issue(second, "verbose_tool");
  await verbose.flush();
  assert.ok((await read(diagnosticPath("handoff", second, agent))).some(row => row.data?.toolName === "verbose_tool"));
  const controls = createDiagnosticControls({ ...verbose, ...options });
  const exportPath = join(root, "sample.json");
  const exported = await controls.exportFile(first, "project", exportPath, key);
  assert.equal(exported.ok, true);
  const sample = JSON.parse(await fs.readFile(exportPath, "utf8"));
  assert.equal(sample.selection, "session");
  assert.equal(JSON.stringify(sample).includes("second_tool"), false);
  assert.equal((await controls.clear(first, "project", key)).value.count, 1);
  await assert.rejects(fs.stat(diagnosticPath("project", second, agent)), { code: "ENOENT" });
  assert.ok((await read(diagnosticPath("project", first, agent))).length);
  assert.ok((await read(diagnosticPath("project", other, agent))).length);
  assert.ok((await read(diagnosticPath("handoff", second, agent))).length);
  for (const path of [oldRuntime, oldHandoff, rawSession]) assert.equal(await fs.readFile(path, "utf8"), "original\n");
  assert.deepEqual((await fs.readdir(join(project, ".pi"))).sort(), ["diagnostics", "logs"]);
  await assert.rejects(fs.stat(otherProject), { code: "ENOENT" });
}));

test("project status and export read only the recent window; explicit session selection can reach older files", async () => withTempDirectory(async root => {
  const agent = join(root, "agent"), cwd = join(root, "project");
  await fs.mkdir(cwd);
  const ctx = fixtureContext(cwd, "current");
  const agentDir = () => agent;
  const monitor = createHandoffDiagnostics({ on() {} }, createExtensionRuntimeState(), { agentDir, mode: "automatic" });
  const controls = createDiagnosticControls({ ...monitor, agentDir });
  const now = Date.now();
  for (let i = 0; i <= 16; i++) {
    const id = `session-${i}`;
    const file = diagnosticPath("project", fixtureContext(cwd, id), agent);
    await put(file, JSON.stringify({ version: 1, kind: "issue", count: 1, id, runtimeId: "fixture", category: "tool", code: `FIXTURE_${i}` }) + "\n");
    const time = new Date(now - (16 - i) * 1000);
    await fs.utimes(file, time, time);
  }
  const summary = await controls.status(ctx);
  assert.match(summary, /FIXTURE_16/);
  assert.doesNotMatch(summary, /FIXTURE_0/);
  assert.match(summary, /记录不完整/);
  const oldKey = sessionKey(cwd, "session-0");
  const oldSummary = await controls.status(ctx, oldKey);
  assert.match(oldSummary, /FIXTURE_0/);
  assert.doesNotMatch(oldSummary, /FIXTURE_16|记录不完整/);
  assert.equal((await controls.exportFile(ctx, "project", join(root, "recent.json"))).value.limited, true);
  const old = await controls.exportFile(ctx, "project", join(root, "old.json"), oldKey);
  assert.equal(old.value.limited, false);
  assert.equal(old.value.count, 1);
}));

test("queued writes freeze both project and session before asynchronous IO", async () => withTempDirectory(async root => {
  const agent = join(root, "agent"), old = fixtureContext(join(root, "old"), "old"), next = fixtureContext(join(root, "next"), "new");
  const ctx = { ...old };
  const writer = createDiagnosticWriter({ ...writerOptions, scope: "project", agentDir: () => agent });
  const directory = diagnosticRoot(agent);
  await fs.mkdir(directory, { recursive: true });
  await withDiagnosticLock(directory, async () => {
    assert.equal(writer.write(ctx, () => ({ marker: "old" })), true);
    await new Promise(resolve => setImmediate(resolve));
    Object.assign(ctx, next);
    assert.equal(writer.write(ctx, () => ({ marker: "new" })), true);
  }, fs, "sidecar.lock");
  await writer.flush();
  assert.deepEqual(await read(diagnosticPath("project", old, agent)), [{ marker: "old" }]);
  assert.deepEqual(await read(diagnosticPath("project", next, agent)), [{ marker: "new" }]);
}));

test("delayed verbose tool metadata does not move with a mutable session context", async () => withTempDirectory(async root => {
  const agent = join(root, "agent"), cwd = join(root, "project");
  const old = fixtureContext(cwd, "old"), next = fixtureContext(cwd, "new");
  const ctx = { ...old };
  await put(join(cwd, "fixture.txt"), "local fixture\n");
  const hooks = new Map();
  const monitor = createHandoffDiagnostics({ on: (name, handler) => hooks.set(name, handler) }, createExtensionRuntimeState(), { agentDir: () => agent, mode: "verbose" });
  const pending = hooks.get("tool_call")({ toolName: "read", toolCallId: "old-call", input: { path: "fixture.txt" } }, ctx);
  Object.assign(ctx, next);
  await pending;
  monitor.trace(ctx, "test.current");
  await monitor.flush();
  const rows = await read(diagnosticPath("handoff", next, agent));
  assert.deepEqual(rows.map(row => row.event), ["test.current"]);
}));

test("a sidecar hard link is refused without changing the linked original", async () => withTempDirectory(async root => {
  const agent = join(root, "agent"), ctx = fixtureContext(join(root, "project"), "first");
  const original = join(agent, "sessions", "fixture.jsonl");
  await put(original, "original\n");
  const file = diagnosticPath("handoff", ctx, agent);
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.link(original, file);
  const writer = createDiagnosticWriter({ ...writerOptions, scope: "handoff", agentDir: () => agent });
  writer.write(ctx, () => ({ marker: "must not append" }));
  await writer.flush();
  assert.equal(writer.failureCode, "UNSAFE_DIAGNOSTIC_PATH");
  assert.equal((await writer.resume(ctx)).causeCode, "UNSAFE_DIAGNOSTIC_PATH");
  assert.equal(await fs.readFile(original, "utf8"), "original\n");
}));

function childWrite(agent, cwd, scope, id) {
  const writerURL = new URL("../extensions/diagnostics/diagnostic-writer.ts", import.meta.url).href;
  const program = `import {createDiagnosticWriter} from ${JSON.stringify(writerURL)};
    const writer = createDiagnosticWriter({scope:${JSON.stringify(scope)},maxBytes:4096,maxPending:1,warning:'fixture'});
    writer.write({cwd:${JSON.stringify(cwd)},isProjectTrusted:()=>true,sessionManager:{getSessionId:()=>${JSON.stringify(id)}}},()=>({new:true}));
    await writer.flush(); console.log(writer.failureCode ?? 'written');`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", program], { env: { ...process.env, PI_CODING_AGENT_DIR: agent } });
    let output = "", stderr = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code ? reject(new Error(stderr)) : resolve(output.trim()));
  });
}

test("independent processes share one bounded quota across both kinds; clear and resume free a slot without replay", { timeout: 12000 }, async () => withTempDirectory(async root => {
  const agent = join(root, "agent"), cwd = join(root, "project");
  const agentDir = () => agent;
  const kept = diagnosticPath("project", fixtureContext(cwd, "seed-0"), agent);
  for (let i = 0; i < SIDECAR_LIMIT - 1; i++) await put(diagnosticPath("project", fixtureContext(cwd, `seed-${i}`), agent), "{}\n");
  await put(kept + ".1", "{}\n");
  assert.deepEqual((await Promise.all([
    childWrite(agent, cwd, "project", "contender-one"), childWrite(agent, cwd, "handoff", "contender-two"),
  ])).sort(), ["DIAGNOSTIC_QUOTA_EXCEEDED", "written"]);

  const active = createDiagnosticWriter({ ...writerOptions, scope: "project", agentDir });
  const ctx = fixtureContext(cwd, "fresh");
  active.write(fixtureContext(cwd, "seed-0"), () => ({ existing: true })); await active.flush();
  assert.equal((await read(kept)).at(-1).existing, true);
  active.write(ctx, () => ({ blocked: true })); await active.flush();
  assert.equal(active.failureCode, "DIAGNOSTIC_QUOTA_EXCEEDED");
  assert.equal((await active.resume(ctx)).causeCode, "DIAGNOSTIC_QUOTA_EXCEEDED");
  const controls = createDiagnosticControls({ agentDir, flush: active.flush, report: async () => "", resume: active.resume });
  const removed = await controls.clear(ctx, "project", basename(kept, ".jsonl"));
  assert.equal(removed.value.count, 2);
  assert.equal((await active.resume(ctx)).ok, true);
  active.write(ctx, () => ({ after: true })); await active.flush();
  assert.deepEqual(await read(diagnosticPath("project", ctx, agent)), [{ after: true }]);
}));
