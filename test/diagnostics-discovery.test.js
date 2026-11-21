import "../scripts/test-bootstrap.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, readFile, realpath, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createHandoffDiagnostics } from "../extensions/diagnostics/handoff-diagnostics.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { diagnosticPath } from "./support/diagnostic-paths.js";
import { withTempDirectory } from "./support/temp-directory.js";

const script = fileURLToPath(new URL("../scripts/diagnostics-report.js", import.meta.url));
const exec = promisify(execFile);
const context = (cwd, id) => ({ cwd, isProjectTrusted: () => true, sessionManager: { getSessionId: () => id } });
const date = "2026-10-01T00:00:00Z";

function sample(sessionId, commit, count = 1) {
  return { version: 1, kind: "issue", runtimeId: `run-${commit}`, captureId: "capture", sessionId,
    id: "issue", category: "tool-failure", stage: "sdk", code: "FROZEN_FAILURE", toolName: "frozen_tool", count,
    firstSeen: date, lastSeen: date, runtimeIdentity: { extensionVersion: "2.0.11", sourceCommit: commit.repeat(40), sourceFingerprint: commit.repeat(64) } };
}

function round(sessionId, commit) {
  const { runtimeId, captureId, runtimeIdentity } = sample(sessionId, commit);
  return { version: 1, kind: "summary", runtimeId, captureId, runtimeIdentity, sessionId, run: 1, timestamp: date,
    profile: { provider: "fixture", model: "fixture", role: "developer-test", thinkingLevel: "high" },
    outcome: "normal-stop", durationMs: 100, tokens: { totalTokens: 1000 }, aborted: false, incomplete: false,
    dropped: 0, issueOccurrences: 1, overflow: 0, profileChanged: false, degraded: false };
}

const readJson = async file => JSON.parse(await readFile(file, "utf8"));
async function put(file, ...rows) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, rows.map(row => JSON.stringify(row) + "\n").join(""));
}

async function cli(root, name, args, agentOverride = join(root, "agent")) {
  const output = join(root, name);
  const env = { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentOverride };
  await exec(process.execPath, [script, ...args, "--output", output], { cwd: root, env, timeout: 15_000 });
  return {
    report: await readJson(join(output, "report.json")),
    manifest: await readJson(join(output, "manifest.json")),
    markdown: await readFile(join(output, "report.md"), "utf8"),
  };
}

test("CLI discovers one project's requested session and rotation with equivalent frozen metrics; old input can compare load identities", async () => withTempDirectory(async directory => {
  const root = await realpath(directory);
  const agent = join(root, ".pi", "agent"), cwd = join(root, "one"), secondCwd = join(root, "two");
  const sessionId = "first", ctx = context(cwd, sessionId);
  const current = diagnosticPath("project", ctx, agent), rotated = current + ".1";
  const handoff = diagnosticPath("handoff", ctx, agent), old = join(cwd, ".pi", "diagnostics", "runtime.jsonl");
  const raw = join(agent, "sessions", "raw-session.jsonl");
  const legacy = sample(sessionId, "a");
  await Promise.all([
    put(rotated, legacy), put(current, sample(sessionId, "a", 2), round(sessionId, "a")),
    put(old, legacy), put(old + ".new", sample(sessionId, "a", 2), round(sessionId, "a")),
    put(diagnosticPath("project", context(cwd, "other-session"), agent), sample("other-session", "c")),
    put(diagnosticPath("project", context(secondCwd, sessionId), agent), sample(sessionId, "d")),
    put(current + ".2", sample(sessionId, "e")), put(raw, sample(sessionId, "f")),
    put(handoff, { version: 1, runtimeId: "handoff", sessionId, run: 1, sequence: 1, timestamp: date,
      event: "routing.tool_call", data: { toolName: "switch_role", role: "docs-commit" }, snapshot: { role: "docs-commit" } }),
  ]);
  const oldTime = new Date(Date.now() - 72 * 3_600_000);
  await utimes(rotated, oldTime, oldTime);
  await utimes(old, oldTime, oldTime);
  const fresh = new Date();
  await utimes(current, fresh, fresh);
  const newest = new Date(+fresh + 1000);
  await utimes(handoff, newest, newest);
  const flags = ["--project", "./one", "--session-id", sessionId];
  const [explicit, found, recent] = await Promise.all([
    cli(root, "explicit", ["--runtime", old, "--runtime", old + ".new", "--handoff", handoff], ""),
    cli(root, "found", flags, ""),
    cli(root, "recent", [...flags, "--since", "1d", "--runtime", old], "~/.pi/agent"),
  ]);
  for (const key of ["runtime", "handoff", "sessions"]) assert.deepEqual(found.report[key], explicit.report[key]);
  assert.deepEqual(new Set(found.manifest.sources.map(source => source.path)), new Set([current, rotated, handoff]));
  assert.equal(found.report.runtime.issues.observations, 2);
  assert.deepEqual(new Set(recent.manifest.sources.map(source => source.path)), new Set([old, current, handoff]));
  assert.equal(recent.report.sourceIntegrity.discovery.streams[0].excludedByTime, 1);
  assert.equal(recent.report.runtime.issues.observations, 2, "mtime selection must not filter old event timestamps");
  const newer = join(root, "newer-load.jsonl");
  await put(newer, sample(sessionId, "b"), round(sessionId, "b"));
  const compared = await cli(root, "comparison", [...flags, "--runtime", newer], pathToFileURL(agent).href);
  assert.deepEqual(new Set(compared.report.runtime.versions.map(version => version.identity.sourceCommit)), new Set(["a".repeat(40), "b".repeat(40)]));
  assert.equal(compared.report.runtime.issues.observations, 3);
}));

test("runtime-produced sidecar is discovered and reported through the CLI without a provider", async () => withTempDirectory(async root => {
  const agent = join(root, "agent"), cwd = join(root, "project"), ctx = context(cwd, "live-test");
  const hooks = new Map();
  const monitor = createHandoffDiagnostics({ on: (name, handler) => hooks.set(name, handler) }, createExtensionRuntimeState(),
    { agentDir: () => agent, mode: "automatic" });
  await hooks.get("before_agent_start")({}, ctx);
  await hooks.get("tool_result")({ toolName: "actual_hook", toolCallId: "hook-call", isError: true, input: {}, details: { code: "FIXTURE_FAILURE" } }, ctx);
  await hooks.get("agent_settled")({}, ctx);
  await monitor.flush();
  const { report, manifest } = await cli(root, "reported", ["--project", cwd, "--session-id", "live-test"]);
  assert.equal(report.runtime.issues.observations, 1);
  assert.ok(report.runtime.issues.entries.some(issue => issue.toolName === "actual_hook" && issue.code === "FIXTURE_FAILURE"));
  assert.deepEqual(manifest.sources.map(source => source.path), [await realpath(diagnosticPath("project", ctx, agent))]);
}));

test("CLI discloses no sample, unsafe sidecars, oversized segments and project selection bounds", async () => withTempDirectory(async root => {
  const agent = join(root, "agent"), cwd = join(root, "project"), flags = ["--project", cwd];
  const empty = await cli(root, "empty", flags);
  assert.equal(empty.report.sources.length, 0);
  assert.equal(empty.report.sourceIntegrity.discovery.streams[0].directory, "missing");
  assert.match(empty.markdown, /未取得该类侧车样本/);
  const unsafe = diagnosticPath("project", context(cwd, "unsafe"), agent);
  const oversized = diagnosticPath("project", context(cwd, "oversize"), agent);
  const foreign = join(root, "foreign.jsonl");
  await put(foreign, sample("foreign", "e"));
  await put(oversized, sample("oversize", "f"));
  await truncate(oversized, 2 * 1024 * 1024 + 1);
  await link(foreign, unsafe);
  if (process.platform !== "win32") {
    const handoff = diagnosticPath("handoff", context(cwd, "unsafe"), agent);
    await mkdir(dirname(dirname(handoff)), { recursive: true });
    await symlink(dirname(unsafe), dirname(handoff));
    await symlink(foreign, unsafe + ".1");
  }
  await Promise.all(Array.from({ length: 34 }, (_, index) => put(diagnosticPath("project", context(cwd, `valid-${index}`), agent), sample(`valid-${index}`, "b"))));
  const { report } = await cli(root, "bounded", flags);
  const stream = report.sourceIntegrity.discovery.streams[0];
  assert.equal(report.sources.length, 32);
  assert.equal(stream.omittedByBudget, 2);
  assert.equal(stream.warnings.UNSAFE_DIAGNOSTIC_PATH, process.platform === "win32" ? 1 : 2);
  assert.equal(stream.warnings.DIAGNOSTIC_TOO_LARGE, 1);
  assert.equal(report.sourceIntegrity.hasReadGaps, true);
  assert.equal(report.runtime.issues.observations, 32);
  if (process.platform !== "win32") assert.equal(report.sourceIntegrity.discovery.streams[1].warnings.UNSAFE_DIAGNOSTIC_PATH, 1);
  for (let i = 0; i < 385; i += 32) {
    await Promise.all(Array.from({ length: Math.min(32, 385 - i) }, (_, j) => writeFile(join(dirname(unsafe), `foreign-${i + j}`), "ignored")));
  }
  const limited = await cli(root, "entry-limit", flags);
  assert.equal(limited.report.sources.length, 0);
  assert.equal(limited.report.sourceIntegrity.discovery.streams[0].warnings.DIAGNOSTIC_SCAN_LIMIT, 1);
  const exactFlags = [...flags, "--session-id", "valid-0"];
  const exact = await cli(root, "exact", exactFlags);
  assert.equal(exact.report.runtime.issues.observations, 1, "exact lookup must not enumerate siblings");
  await assert.rejects(cli(root, "missing-explicit", [...exactFlags, "--runtime", join(root, "missing.jsonl")]), /无法读取.*ENOENT/);
  if (process.getuid && process.getuid() !== 0) {
    const file = diagnosticPath("project", context(cwd, "valid-0"), agent);
    await chmod(file, 0o000);
    try {
      const unreadable = await cli(root, "denied", exactFlags);
      assert.equal(unreadable.report.sources.length, 0);
      assert.equal(unreadable.report.sourceIntegrity.hasReadGaps, true);
      assert.equal(unreadable.report.sourceIntegrity.unavailable[0].code, "EACCES");
    } finally { await chmod(file, 0o600); }
  }
}));
