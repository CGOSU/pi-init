import assert from "node:assert/strict";
import { access, chmod, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import test from "node:test";

import { RuntimeClient } from "../extensions/runtime-client.ts";
import {
  createExtensionHarness,
  emitExtensionEvent,
  mkdir,
  path,
  withTempDirectory,
  writeFile as writeFixture,
} from "./helpers.js";

const architect = { provider: "fixture-provider", id: "fixture-architect" };
const developer = { provider: "fixture-provider", id: "fixture-developer" };
const RUNTIME_ROOT = process.env.AGENT_RUNTIME_ROOT
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../Rust/agent-runtime");
const DEBUG_SUFFIX = process.platform === "win32" ? ".exe" : "";
function cargoTargetDirectory() {
  try {
    return JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
      cwd: RUNTIME_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })).target_directory;
  } catch {
    return path.join(RUNTIME_ROOT, "target");
  }
}
const TARGET_ROOT = process.env.AGENT_RUNTIME_TARGET_DIR ?? cargoTargetDirectory();
const DAEMON_BINARY = process.env.AGENT_RUNTIME_DAEMON
  ?? path.join(TARGET_ROOT, "debug", `runtime-daemon${DEBUG_SUFFIX}`);

function workflowEntry(branch) {
  return [...branch].reverse().find((entry) => entry.customType === "pi-init-workflow");
}

function runtimePlan(summary) {
  return {
    action: "plan",
    summary,
    constraints: ["fixture integration owns execution authority"],
    tasks: [{
      id: "fixture-task",
      role: "developer-test",
      task: "run the model-free fixture agent",
      files: ["fixture.js"],
      acceptanceCriteria: ["the fixture result is non-empty"],
    }],
  };
}

async function writeRuntimeConfig(directory, endpoint, executor = "runtime") {
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  await writeFixture(path.join(directory, ".pi", "role-models.json"), `${JSON.stringify({
    schemaVersion: 2,
    mode: "auto",
    workflowMode: "on",
    workflowExecutor: executor,
    runtime: {
      endpoint,
      agentBackend: "pi-rpc",
      permissionProfile: "fixture",
      timeoutMs: 1500,
      retries: 1,
    },
    roleModels: {
      architect: { provider: architect.provider, model: architect.id, thinkingLevel: "max" },
      "developer-test": { provider: developer.provider, model: developer.id, thinkingLevel: "max" },
    },
  }, null, 2)}\n`);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(250, () => done(false));
  });
}

function spawnProcess(binary, args, options = {}) {
  const child = spawn(binary, args, {
    cwd: options.cwd ?? RUNTIME_ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });
  child.runtimeStderr = () => stderr;
  return child;
}

async function waitForPort(child, port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`runtime daemon exited before listening: ${child.runtimeStderr()}`);
    }
    if (await canConnect(port)) return;
    await wait(40);
  }
  throw new Error(`runtime daemon did not listen on ${port}: ${child.runtimeStderr()}`);
}

async function startDaemon(database, config, port) {
  const child = spawnProcess(DAEMON_BINARY, [
    "--listen", `127.0.0.1:${port}`,
    "--pi-rpc-config", config,
    database,
  ]);
  await waitForPort(child, port);
  return child;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise((resolve) => killer.once("exit", resolve));
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    wait(5000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitForWorkflow(harness, expected, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 15000);
  while (Date.now() < deadline) {
    const data = workflowEntry(harness.branch)?.data;
    if (data?.status === expected && (!options.when || options.when(data))) return data;
    if (typeof options.beforePoll === "function") await options.beforePoll(data);
    await emitExtensionEvent(harness, "agent_settled");
    await wait(60);
  }
  throw new Error(`workflow did not reach ${expected}: ${JSON.stringify(workflowEntry(harness.branch)?.data)}`);
}

async function createFixtureAgent(workspace, holdFile, failFile) {
  const script = `const fs = require("fs");
const holdFile = ${JSON.stringify(holdFile)};
const failFile = ${JSON.stringify(failFile)};
let input = "";
let settled = false;
let cancelled = false;
let shouldFail = false;
function frame(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function settleWhenReleased() {
  if (settled || cancelled) return;
  if (fs.existsSync(holdFile)) return setTimeout(settleWhenReleased, 25);
  settled = true;
  frame({ type: "agent_settled" });
}
function handle(line) {
  let command;
  try { command = JSON.parse(line); } catch { process.exitCode = 2; return; }
  if (command.type === "prompt") {
    shouldFail = fs.existsSync(failFile);
    frame({ type: "response", id: command.id, command: "prompt", success: true });
    setTimeout(settleWhenReleased, 10);
  } else if (command.type === "abort") {
    cancelled = true;
    frame({ type: "response", id: command.id, command: "abort", success: true });
    setImmediate(settleWhenReleased);
  } else if (command.type === "get_last_assistant_text") {
    const result = { version: 1, outcome: shouldFail ? "failed" : "succeeded", output: shouldFail ? "fixture failed" : "fixture succeeded" };
    frame({ type: "response", id: command.id, command: "get_last_assistant_text", success: true, data: { text: JSON.stringify(result) } });
  }
}
process.stdin.on("data", (chunk) => {
  input += chunk.toString();
  let newline;
  while ((newline = input.indexOf("\\n")) >= 0) {
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (line) handle(line);
  }
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 30));
`;
  const scriptPath = path.join(workspace, "fixture.js");
  await writeFile(scriptPath, script);
  const launcherPath = process.platform === "win32"
    ? path.join(workspace, "fixture-launcher.cmd")
    : path.join(workspace, "fixture-launcher");
  const launcher = process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "%~dp0fixture.js" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fixture.js" "$@"\n`;
  await writeFile(launcherPath, launcher);
  if (process.platform !== "win32") await chmod(launcherPath, 0o755);
  return { scriptPath, launcherPath };
}

async function writeDaemonConfig(workspace, launcherPath) {
  const configPath = path.join(workspace, "pi-rpc.json");
  await writeFile(configPath, `${JSON.stringify({
    version: 1,
    executable: launcherPath,
    profiles: { fixture: { working_directory: workspace, args: [] } },
  }, null, 2)}\n`);
  return configPath;
}

const integrationSkip = !(await exists(DAEMON_BINARY));

test("the same plan preserves local authority while Runtime drives the model-free full chain", async (t) => {
  if (integrationSkip) {
    t.skip(`build runtime-daemon first, or set AGENT_RUNTIME_DAEMON`);
    return;
  }
  await withTempDirectory(async (directory) => {
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace, { recursive: true });
    const holdFile = path.join(workspace, "hold");
    const failFile = path.join(workspace, "fail");
    const { launcherPath } = await createFixtureAgent(workspace, holdFile, failFile);
    const daemonConfig = await writeDaemonConfig(workspace, launcherPath);
    const database = path.join(directory, "runtime.sqlite");
    let daemon;
    try {
      const daemonPort = await freePort();
      daemon = await startDaemon(database, daemonConfig, daemonPort);
      const endpoint = `127.0.0.1:${daemonPort}`;

      await writeRuntimeConfig(directory, endpoint, "local");
      const localBranch = [];
      const localHarness = createExtensionHarness(localBranch, {
        cwd: directory,
        trusted: true,
        model: architect,
        availableModels: [architect, developer],
      });
      await emitExtensionEvent(localHarness, "session_start");
      const localWorkflow = localHarness.tools.find((tool) => tool.name === "task_workflow");
      const localResult = await localWorkflow.execute("same-plan-local", runtimePlan("same plan"), undefined, undefined, localHarness.context);
      assert.equal(localResult.details.executor, "local");
      assert.equal(localResult.details.authority, "local");
      assert.equal(localResult.details.status, "running");
      assert.equal(localHarness.sentMessages.some(({ message }) => message?.customType === "pi-init-workflow-task"), false);

      await writeRuntimeConfig(directory, endpoint, "runtime");
      const branch = [];
      const harness = createExtensionHarness(branch, {
        cwd: directory,
        trusted: true,
        model: architect,
        availableModels: [architect, developer],
      });
      await emitExtensionEvent(harness, "session_start");
      const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
      const planned = await workflow.execute("same-plan-runtime", runtimePlan("same plan"), undefined, undefined, harness.context);
      assert.equal(planned.details.executor, "runtime");
      assert.equal(planned.details.authority, "runtime");
      const completed = await waitForWorkflow(harness, "completed");
      assert.equal(completed.tasks[0].status, "completed");
      assert.equal(completed.runtimeAuthority.eventCursor > 0, true);
      assert.equal(harness.sentMessages.some(({ message }) => message?.customType === "pi-init-workflow-task"), false);
      await emitExtensionEvent(harness, "session_shutdown");
      await emitExtensionEvent(localHarness, "session_shutdown");
    } finally {
      await stopProcess(daemon);
    }
  });
});

test("Runtime authority survives client disconnect and daemon restart", async (t) => {
  if (integrationSkip) {
    t.skip(`build runtime-daemon first, or set AGENT_RUNTIME_DAEMON`);
    return;
  }
  await withTempDirectory(async (directory) => {
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace, { recursive: true });
    const holdFile = path.join(workspace, "hold");
    const failFile = path.join(workspace, "fail");
    const { launcherPath } = await createFixtureAgent(workspace, holdFile, failFile);
    await writeFile(holdFile, "hold\n");
    const daemonConfig = await writeDaemonConfig(workspace, launcherPath);
    const database = path.join(directory, "runtime.sqlite");
    let daemon;
    let reloadedHarness;
    try {
      const daemonPort = await freePort();
      daemon = await startDaemon(database, daemonConfig, daemonPort);
      const endpoint = `127.0.0.1:${daemonPort}`;
      await writeRuntimeConfig(directory, endpoint);
      const branch = [];
      const harness = createExtensionHarness(branch, {
        cwd: directory,
        trusted: true,
        model: architect,
        availableModels: [architect, developer],
      });
      await emitExtensionEvent(harness, "session_start");
      const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
      await workflow.execute("restart-plan", runtimePlan("restart and reconnect"), undefined, undefined, harness.context);
      const running = await waitForWorkflow(harness, "running", { when: (data) => data.tasks[0].status === "in_progress" });
      assert.equal(running.tasks[0].status, "in_progress");
      await rm(holdFile, { force: true });
      await harness.completeCompaction();
      const compacted = workflowEntry(branch).data;
      assert.equal(compacted.runtimeAuthority.graphRevision.graphId, running.runtimeAuthority.graphRevision.graphId);
      const completedBeforeRestart = await waitForWorkflow(harness, "completed");
      const authority = completedBeforeRestart.runtimeAuthority;
      const duplicate = await new RuntimeClient({ endpoint, timeoutMs: 1500, retries: 0 }).request({
        command: "submit_graph",
        payload: { protocol_version: 2, graph: authority.graph },
      }, { requestId: authority.submitRequestId });
      assert.equal(duplicate.response, "graph_submitted");

      await emitExtensionEvent(harness, "session_shutdown");
      await stopProcess(daemon);
      daemon = undefined;
      const restartedPort = await freePort();
      daemon = await startDaemon(database, daemonConfig, restartedPort);
      const restartedEndpoint = `127.0.0.1:${restartedPort}`;
      await writeRuntimeConfig(directory, restartedEndpoint);
      reloadedHarness = createExtensionHarness(branch, {
        cwd: directory,
        trusted: true,
        model: architect,
        availableModels: [architect, developer],
      });
      await emitExtensionEvent(reloadedHarness, "session_start", { reason: "reload-after-daemon-restart" });
      const reloaded = workflowEntry(branch).data;
      assert.equal(reloaded.executor, "runtime");
      assert.equal(reloaded.authority, "runtime");
      assert.equal(reloaded.runtimeAuthority.graphRevision.graphId, authority.graphRevision.graphId);
      assert.equal(reloaded.runtimeAuthority.eventCursor, authority.eventCursor);
      const reconnectedClient = new RuntimeClient({ endpoint: restartedEndpoint, timeoutMs: 1500, retries: 0 });
      const queried = await reconnectedClient.queryGraph({
        graphId: authority.graphRevision.graphId,
        revision: authority.graphRevision.revision,
      });
      assert.equal(queried.tasks[0].state, "succeeded");
      const lateEvents = await reconnectedClient.readEvents({
        graphId: authority.graphRevision.graphId,
        afterEventId: authority.eventCursor,
        limit: 100,
      });
      assert.equal(lateEvents.length, 0);
      assert.equal(reloadedHarness.sentMessages.some(({ message }) => message?.customType === "pi-init-workflow-task"), false);
      await emitExtensionEvent(reloadedHarness, "session_shutdown");
    } finally {
      await emitExtensionEvent(reloadedHarness, "session_shutdown").catch(() => {});
      await stopProcess(daemon);
    }
  });
});

test("Runtime cancel and retry remain command-driven on the real daemon", async (t) => {
  if (integrationSkip) {
    t.skip(`build runtime-daemon first, or set AGENT_RUNTIME_DAEMON`);
    return;
  }
  await withTempDirectory(async (directory) => {
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace, { recursive: true });
    const holdFile = path.join(workspace, "hold");
    const failFile = path.join(workspace, "fail");
    const { launcherPath } = await createFixtureAgent(workspace, holdFile, failFile);
    const daemonConfig = await writeDaemonConfig(workspace, launcherPath);
    const database = path.join(directory, "runtime.sqlite");
    let daemon;
    try {
      const daemonPort = await freePort();
      daemon = await startDaemon(database, daemonConfig, daemonPort);
      const endpoint = `127.0.0.1:${daemonPort}`;
      await writeRuntimeConfig(directory, endpoint);
      const branch = [];
      const harness = createExtensionHarness(branch, {
        cwd: directory,
        trusted: true,
        model: architect,
        availableModels: [architect, developer],
      });
      await emitExtensionEvent(harness, "session_start");
      const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
      await writeFile(holdFile, "hold\n");
      await workflow.execute("cancel-plan", runtimePlan("cancel fixture"), undefined, undefined, harness.context);
      await waitForWorkflow(harness, "running", { when: (data) => data.tasks[0].status === "in_progress" });
      const cancelled = await workflow.execute("cancel", { action: "cancel" }, undefined, undefined, harness.context);
      assert.equal(cancelled.details.status, "cancelled");
      assert.equal(cancelled.details.tasks[0].status, "blocked");
      await rm(holdFile, { force: true });

      await writeFile(failFile, "fail\n");
      const failed = await workflow.execute("retry-plan", runtimePlan("retry fixture"), undefined, undefined, harness.context);
      assert.equal(failed.details.status, "running");
      const paused = await waitForWorkflow(harness, "paused");
      assert.equal(paused.tasks[0].status, "blocked");
      await (await import("node:fs/promises")).rm(failFile, { force: true });
      const retried = await workflow.execute("retry", { action: "retry", taskId: "fixture-task" }, undefined, undefined, harness.context);
      assert.equal(retried.details.executor, "runtime");
      const completed = await waitForWorkflow(harness, "completed");
      assert.equal(completed.tasks[0].status, "completed");
      assert.equal(completed.runtimeAuthority.eventCursor > paused.runtimeAuthority.eventCursor, true);
      assert.equal(harness.sentMessages.some(({ message }) => message?.customType === "pi-init-workflow-task"), false);
      await emitExtensionEvent(harness, "session_shutdown");
    } finally {
      await stopProcess(daemon);
    }
  });
});
