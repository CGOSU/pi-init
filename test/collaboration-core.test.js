import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  createExtensionHarness,
  emitExtensionEvent,
  mkdir,
  path,
  readFile,
  rm,
  withTempDirectory,
  writeFile,
} from "./helpers.js";
import { resolveCollaborationDirs } from "../extensions/collaboration-paths.ts";
import {
  claimReservations,
  getReservationConflicts,
  getReservationPatternConflicts,
  listActiveAgents,
  pathMatchesReservation,
  reservationsOverlap,
  registerSelf,
  releaseReservations,
  updateSelf,
  updateReservations,
  unregisterSelf,
} from "../extensions/collaboration-registry.ts";
import { processInbox, readMessageLog, sendDirect } from "../extensions/collaboration-messages.ts";
import { listRuns } from "../extensions/collaboration-runs.ts";
import { formatSessionTail, lastAssistantText, readSessionTail } from "../extensions/collaboration-session-tail.ts";
import {
  abortSubagent,
  prepareCmdShimArgs,
  resolveCliInvocation,
  startSubagentBatch,
} from "../extensions/collaboration-spawn.ts";

async function withCollaborationDirectory(run) {
  return withTempDirectory(async (directory) => {
    const previous = process.env.COLLABORATING_AGENTS_DIR;
    process.env.COLLABORATING_AGENTS_DIR = path.join(directory, "collaboration");
    try {
      await run(directory);
    } finally {
      if (previous === undefined) delete process.env.COLLABORATING_AGENTS_DIR;
      else process.env.COLLABORATING_AGENTS_DIR = previous;
    }
  });
}

function registration(name, cwd, sessionId) {
  const now = new Date().toISOString();
  return { name, pid: process.pid, sessionId, cwd, model: "test/model", startedAt: now, lastSeenAt: now, role: "subagent" };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("Windows collaboration CLI invocation avoids direct cmd shim spawning", () => {
  const args = ["--mode", "json"];
  assert.deepEqual(
    resolveCliInvocation(args, {
      platform: "win32",
      command: "",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      argv1: "dist\\bundle\\cli.js",
      parentCwd: "C:\\pi-coding-agent",
      comSpec: "cmd.exe",
    }),
    { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\pi-coding-agent\\dist\\bundle\\cli.js", ...args] },
  );
  assert.deepEqual(
    resolveCliInvocation(args, { platform: "win32", command: "", argv1: "runner.js", comSpec: "cmd.exe" }),
    { command: "cmd.exe", args: ["/d", "/s", "/c", "pi.cmd", ...args] },
  );
  assert.deepEqual(
    resolveCliInvocation(args, { platform: "win32", command: "", argv1: "", comSpec: "cmd.exe" }),
    { command: "cmd.exe", args: ["/d", "/s", "/c", "pi.cmd", ...args] },
  );
  assert.deepEqual(
    resolveCliInvocation(args, { platform: "win32", command: "pi.cmd", argv1: "C:\\pi\\cli.js", comSpec: "cmd.exe" }),
    { command: "cmd.exe", args: ["/d", "/s", "/c", "pi.cmd", ...args] },
  );
  assert.deepEqual(
    resolveCliInvocation(args, { platform: "win32", command: "C:\\Program Files\\Pi\\pi.cmd", comSpec: "cmd.exe" }),
    { command: "cmd.exe", args: ["/d", "/s", "/c", "call", "C:\\Program Files\\Pi\\pi.cmd", ...args] },
  );
  assert.throws(
    () => resolveCliInvocation(args, { platform: "win32", command: "C:\\Pi&evil\\pi.cmd", comSpec: "cmd.exe" }),
    /无法安全执行/,
  );
});

test("cmd shim stores multiline prompt arguments outside the command line", async () => {
  await withTempDirectory(async (directory) => {
    const systemPrompt = "system & %PATH%\n\"quoted\"";
    const prompt = "task & %PATH%\nline two\n\"quoted\"";
    const originalArgs = ["--append-system-prompt", "raw system", "-p", "raw prompt"];
    const prepared = await prepareCmdShimArgs(originalArgs, directory, systemPrompt, prompt);
    const systemPath = path.join(directory, prepared.args[1]);
    const promptPath = path.join(directory, prepared.args.at(-1).slice(1));
    try {
      assert.equal(await readFile(systemPath, "utf8"), systemPrompt);
      assert.equal(await readFile(promptPath, "utf8"), prompt);
      assert.equal(prepared.args.at(-1).startsWith("@"), true);
      assert.equal(prepared.args.some((value) => value.includes("%PATH%")), false);
    } finally {
      await prepared.cleanup();
    }
    await assert.rejects(readFile(systemPath, "utf8"), /ENOENT/);
    await assert.rejects(readFile(promptPath, "utf8"), /ENOENT/);
  });
});

test("Windows cmd shim delivers file-backed prompt arguments", { skip: process.platform !== "win32" }, async () => {
  await withTempDirectory(async (directory) => {
    const captureScript = path.join(directory, "capture.cjs");
    const captureShim = path.join(directory, "capture.cmd");
    await writeFile(captureScript, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    await writeFile(captureShim, "@echo off\r\nnode \"%~dp0capture.cjs\" %*\r\n");
    const systemPrompt = "system & %PATH%\nline";
    const prompt = "task & %PATH%\nline two\n\"quoted\"";
    const originalArgs = ["--append-system-prompt", "raw", "-p", "raw"];
    const prepared = await prepareCmdShimArgs(originalArgs, directory, systemPrompt, prompt);
    try {
      const invocation = resolveCliInvocation(prepared.args, {
        platform: "win32",
        command: captureShim,
        argv1: "",
        comSpec: process.env.ComSpec ?? "cmd.exe",
      });
      const result = await new Promise((resolve, reject) => {
        const child = spawn(invocation.command, invocation.args, { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), prepared.args);
      assert.equal(await readFile(path.join(directory, prepared.args[1]), "utf8"), systemPrompt);
      assert.equal(await readFile(path.join(directory, prepared.args.at(-1).slice(1)), "utf8"), prompt);
    } finally {
      await prepared.cleanup();
    }
  });
});

test("collaboration registry reserves paths and detects peer conflicts", async () => {
  await withCollaborationDirectory(async (directory) => {
    const dirs = resolveCollaborationDirs();
    const owner = registration("owner", directory, "session-owner");
    const peer = registration("peer", directory, "session-peer");
    assert.equal(registerSelf(dirs, owner), true);
    assert.equal(registerSelf(dirs, peer), true);
    assert.equal(claimReservations(dirs, owner.name, directory, ["src/race.ts"]).ok, true);
    assert.equal(claimReservations(dirs, peer.name, directory, ["src/race.ts"]).ok, false);
    assert.equal(releaseReservations(dirs, owner.name).ok, true);
    const reservations = [{ pattern: "src/api/", reason: "api work", since: new Date().toISOString() }];
    assert.equal(updateReservations(dirs, peer, reservations), true);
    const conflicts = getReservationConflicts(dirs, "owner", "src/api/index.ts", directory);
    assert.equal(conflicts.length, 1);
    assert.equal(pathMatchesReservation(path.join(directory, "src/api/index.ts"), "src/api/", directory), true);
    assert.equal(pathMatchesReservation("src/api/index.ts", path.join(directory, "src/api/"), directory), true);
    assert.equal(pathMatchesReservation(path.join(directory, "SRC/API/INDEX.TS"), "src/api/", directory), process.platform === "win32");
    assert.equal(reservationsOverlap("src/", directory, "src/api/index.ts", directory), true);
    assert.equal(getReservationPatternConflicts(dirs, "owner", "src/", directory).length, 1);
    assert.equal(conflicts[0].agent, "peer");
    assert.equal(conflicts[0].reason, "api work");
    assert.deepEqual(listActiveAgents(dirs, "owner").map((agent) => agent.name), ["peer"]);
    unregisterSelf(dirs, "owner", { pid: process.pid, sessionId: owner.sessionId });
    unregisterSelf(dirs, "peer", { pid: process.pid, sessionId: peer.sessionId });
  });
});

test("reservation ownership rejects overlapping claims and failed persistence", async () => {
  await withCollaborationDirectory(async (directory) => {
    const dirs = resolveCollaborationDirs();
    const owner = registration("owner", directory, "session-owner");
    const peer = registration("peer", directory, "session-peer");
    assert.equal(registerSelf(dirs, owner), true);
    peer.reservations = [{ pattern: "src/", since: new Date().toISOString() }];
    assert.equal(registerSelf(dirs, peer), true);
    assert.equal(getReservationPatternConflicts(dirs, "owner", "src/file.ts", directory).length, 1);
    assert.equal(getReservationPatternConflicts(dirs, "owner", "src/", directory).length, 1);
    const replacement = { ...owner, sessionId: "another-session" };
    assert.equal(updateSelf(dirs, replacement), false);
    assert.equal(updateReservations(dirs, owner, [{ pattern: "src/owner.ts", since: new Date().toISOString() }]), true);
    unregisterSelf(dirs, peer.name, { pid: process.pid, sessionId: peer.sessionId });
    assert.equal(releaseReservations(dirs, peer.name).ok, false);
    unregisterSelf(dirs, owner.name, { pid: process.pid, sessionId: owner.sessionId });
  });
});

test("collaboration messages use atomic inbox files and append-only log", async () => {
  await withCollaborationDirectory(async (directory) => {
    const dirs = resolveCollaborationDirs();
    const sender = registration("sender", directory, "session-sender");
    const receiver = registration("receiver", directory, "session-receiver");
    assert.equal(registerSelf(dirs, sender), true);
    assert.equal(registerSelf(dirs, receiver), true);
    const sent = sendDirect(dirs, sender.name, receiver.name, "hello", { urgent: true });
    assert.equal(sent.ok, true);
    const received = [];
    assert.equal(processInbox(dirs, receiver.name, (message) => received.push(message)), 1);
    assert.equal(received[0].text, "hello");
    assert.equal(received[0].urgent, true);
    assert.equal(readMessageLog(dirs).length, 1);
    unregisterSelf(dirs, sender.name, { pid: process.pid, sessionId: sender.sessionId });
    unregisterSelf(dirs, receiver.name, { pid: process.pid, sessionId: receiver.sessionId });
  });
});

test("cancelled child cannot overwrite a later final result", async () => {
  await withCollaborationDirectory(async (directory) => {
    const dirs = resolveCollaborationDirs();
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const pi = { exec: async () => pending };
    const ctx = {
      cwd: directory,
      model: { provider: "provider-x", id: "model-x" },
      sessionManager: { getSessionId: () => "parent-session" },
    };
    const batch = startSubagentBatch(pi, ctx, [{ task: "cancel me" }], {}, {
      dirs,
      parentAgent: "owner",
      profile: { role: "developer-test", provider: "provider-x", model: "model-x", thinkingLevel: "high", systemPrompt: "test", allowedTools: ["read"] },
      timeoutMs: 5000,
    });
    await flush();
    assert.equal(abortSubagent(batch.records[0].recordId), true);
    finish({ code: 0, stdout: JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "late success" }] } }), stderr: "" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const record = listRuns(dirs, { parentAgent: "owner" })[0];
    assert.equal(record.status, "failed");
    assert.match(record.error, /被终止/);
  });
});

test("workflow cancellation stops shared Agent and ignores its late result", async () => {
  await withCollaborationDirectory(async (directory) => {
    const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
    const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };
    await mkdir(path.join(directory, ".pi"), { recursive: true });
    await writeFile(path.join(directory, ".pi", "role-models.json"), JSON.stringify({
      schemaVersion: 2,
      mode: "auto",
      workflowMode: "on",
      workflowExecutor: "collaboration",
      roleModels: {
        architect: { provider: architect.provider, model: architect.id, thinkingLevel: "max" },
        "developer-test": { provider: developer.provider, model: developer.id, thinkingLevel: "max" },
      },
    }));
    let started = false;
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const harness = createExtensionHarness([], {
      cwd: directory,
      trusted: true,
      model: architect,
      availableModels: [architect, developer],
      exec: async () => { started = true; return pending; },
    });
    await emitExtensionEvent(harness, "session_start");
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    await workflow.execute("plan", { action: "plan", summary: "取消测试", tasks: [{ id: "task", role: "developer-test", task: "等待取消", files: ["src/task/"], acceptanceCriteria: ["完成"] }] }, undefined, undefined, harness.context);
    await emitExtensionEvent(harness, "agent_settled");
    for (let index = 0; index < 30 && !started; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(started, true);
    await flush();
    const cancelled = await workflow.execute("cancel", { action: "cancel" }, undefined, undefined, harness.context);
    assert.equal(cancelled.details.status, "cancelled");
    finish({ code: 0, stdout: JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ protocol: "pi-init/task-result@1", outcome: "complete", completionSummary: "late", implementationRationale: "late", verification: ["late"] }) }] } }), stderr: "" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const status = await workflow.execute("status", { action: "status" }, undefined, undefined, harness.context);
    assert.equal(status.details.status, "cancelled");
    await emitExtensionEvent(harness, "session_shutdown");
  });
});

test("session tail parses assistant output and ignores toolUse as final text", async () => {
  await withTempDirectory(async (directory) => {
    const file = path.join(directory, "session.jsonl");
    await writeFile(file, [
      JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "partial" }] } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final" }] } }),
    ].join("\n"));
    const tail = readSessionTail(file, 2);
    assert.equal(formatSessionTail(tail), "assistant: partial\nassistant: final");
    assert.equal(lastAssistantText(file), "final");
  });
});

test("role adapter rejects unconfigured roles and passes exact configured model", async () => {
  await withCollaborationDirectory(async (directory) => {
    const configured = { provider: "provider-x", id: "model-x" };
    await mkdir(path.join(directory, ".pi"), { recursive: true });
    await writeFile(path.join(directory, ".pi", "role-models.json"), JSON.stringify({
      schemaVersion: 2,
      mode: "auto",
      workflowMode: "on",
      workflowExecutor: "collaboration",
      roleModels: {
        architect: { provider: configured.provider, model: "missing-model", thinkingLevel: "max" },
        "developer-test": { provider: configured.provider, model: configured.id, thinkingLevel: "high" },
      },
    }));
    let launchArgs;
    const harness = createExtensionHarness([], {
      cwd: directory,
      trusted: true,
      model: configured,
      availableModels: [configured],
      exec: async (_command, args) => {
        launchArgs = args;
        return { code: 0, stdout: JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] } }), stderr: "" };
      },
    });
    await emitExtensionEvent(harness, "session_start");
    const spawnTool = harness.tools.find((tool) => tool.name === "subagent");
    assert.ok(spawnTool);
    await assert.rejects(
      spawnTool.execute("unknown-role", { task: "missing", role: "missing-role" }, undefined, undefined, harness.context),
      /未配置模型/,
    );
    await assert.rejects(
      spawnTool.execute("missing-model", { task: "missing", role: "architect" }, undefined, undefined, harness.context),
      /配置的模型不存在/,
    );
    await spawnTool.execute("configured-role", { task: "run", role: "developer-test" }, undefined, undefined, harness.context);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(launchArgs.includes("provider-x/model-x"));
    assert.ok(launchArgs.includes("high"));
    await emitExtensionEvent(harness, "session_shutdown");
  });
});

test("extension registers collaboration tools, reservation hook, spawn and overlay command", async () => {
  await withCollaborationDirectory(async (directory) => {
    const output = JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "child done" }] } });
    let launchArgs;
    const harness = createExtensionHarness([], {
      cwd: directory,
      exec: async (command, args) => {
        launchArgs = args;
        const expectedInvocation = resolveCliInvocation([]);
        assert.equal(command, expectedInvocation.command);
        assert.deepEqual(args.slice(0, expectedInvocation.args.length), expectedInvocation.args);
        assert.ok(args.includes("--extension"));
        return { code: 0, stdout: output, stderr: "" };
      },
    });
    await emitExtensionEvent(harness, "session_start");
    const messageTool = harness.tools.find((tool) => tool.name === "agent_message");
    const spawnTool = harness.tools.find((tool) => tool.name === "subagent");
    assert.ok(messageTool);
    assert.ok(spawnTool);
    assert.ok(harness.commands.has("agents"));
    await assert.rejects(
      spawnTool.execute("missing-role", { task: "must fail without role" }, undefined, undefined, harness.context),
      /必须指定 pi-init role/,
    );
    const reserved = await messageTool.execute("reserve", { action: "reserve", paths: ["src/shared/"] }, undefined, undefined, harness.context);
    assert.equal(reserved.isError, undefined);
    const self = listActiveAgents(resolveCollaborationDirs()).find((agent) => agent.cwd === directory);
    assert.ok(self);
    const name = self.name;
    const peer = registration("peer", directory, "peer-session");
    peer.reservations = [{ pattern: "src/other.ts", since: new Date().toISOString() }];
    assert.equal(registerSelf(resolveCollaborationDirs(), peer), true);
    let blocked;
    for (const handler of harness.handlers.get("tool_call") ?? []) {
      const result = await handler({ toolName: "edit", input: { path: "src/other.ts" } }, harness.context);
      if (result?.block) {
        blocked = result;
        break;
      }
    }
    assert.equal(blocked?.block, true);
    const started = await spawnTool.execute("spawn", { task: "finish child", cwd: directory, role: "developer-test" }, undefined, undefined, harness.context);
    assert.match(started.content[0].text, /已启动 1 个/);
    for (let index = 0; index < 50 && !launchArgs; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await flush();
    assert.ok(launchArgs);
    assert.ok(launchArgs.includes("--model"));
    assert.ok(launchArgs.includes("openai-codex/gpt-5.6-luna"));
    assert.ok(launchArgs.includes("--thinking"));
    assert.ok(launchArgs.includes("max"));
    assert.ok(launchArgs.includes("--no-extensions"));
    const runs = listRuns(resolveCollaborationDirs(), { parentAgent: name });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "completed");
    await harness.commands.get("agents").handler("", harness.context);
    assert.equal(harness.customCalls.length, 1);
    await emitExtensionEvent(harness, "session_shutdown");
    assert.equal(listActiveAgents(resolveCollaborationDirs(), name).some((agent) => agent.name === name), false);
    unregisterSelf(resolveCollaborationDirs(), peer.name, { pid: process.pid, sessionId: peer.sessionId });
  });
});

test("workflow configuration menu exposes collaboration executor", async () => {
  const seen = [];
  const harness = createExtensionHarness([], {
    trusted: true,
    select: async (title, items) => {
      seen.push({ title, items });
      if (title === "工作流执行器") return "共享工作区协作 Agent";
      return items[0];
    },
  });
  await harness.commands.get("pi-init").handler("config workflow", harness.context);
  const executorMenu = seen.find((item) => item.title === "工作流执行器");
  assert.ok(executorMenu);
  assert.ok(executorMenu.items.some((item) => item.includes("共享工作区协作 Agent")));
});

test("old parallel batch session state is ignored without an old entry point", async () => {
  const harness = createExtensionHarness([
    { type: "custom", customType: "pi-init-parallel-batch", data: { batchId: "legacy", status: "running" } },
  ]);
  await emitExtensionEvent(harness, "session_start");
  assert.equal(harness.tools.some((tool) => tool.name === "parallel_batch"), false);
  assert.equal(harness.statusCalls.some((call) => call.name === "pi-init-parallel"), false);
});

test("collaboration executor preserves workflow dependencies and strict result acceptance", async () => {
  await withCollaborationDirectory(async (directory) => {
    const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
    const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };
    const output = JSON.stringify({
      protocol: "pi-init/task-result@1",
      outcome: "complete",
      completionSummary: "共享任务完成",
      implementationRationale: "使用共享 cwd 与 reservation，避免重复 worktree。",
      verification: ["node --test：通过"],
    });
    const harness = createExtensionHarness([], {
      cwd: directory,
      trusted: true,
      model: architect,
      availableModels: [architect, developer],
      exec: async () => ({ code: 0, stdout: JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: output }] } }), stderr: "" }),
    });
    await emitExtensionEvent(harness, "session_start");
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const roleModels = path.join(directory, ".pi", "role-models.json");
    await mkdir(path.dirname(roleModels), { recursive: true });
    await writeFile(roleModels, JSON.stringify({
      schemaVersion: 2,
      mode: "auto",
      workflowMode: "on",
      workflowExecutor: "collaboration",
      roleModels: {
        architect: { provider: architect.provider, model: architect.id, thinkingLevel: "max" },
        "developer-test": { provider: developer.provider, model: developer.id, thinkingLevel: "max" },
      },
    }));
    const planned = await workflow.execute("plan", {
      action: "plan",
      summary: "共享工作流",
      constraints: ["子 Agent 不得推进主工作流"],
      tasks: [{ id: "implementation", role: "developer-test", task: "实现共享任务", files: ["src/shared/"], acceptanceCriteria: ["测试通过"] }],
    }, undefined, undefined, harness.context);
    assert.equal(planned.details.executor, "collaboration");
    await emitExtensionEvent(harness, "agent_settled");
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const dispatch = harness.sentMessages.find((item) => item.message.customType === "pi-init-collaboration-result");
    assert.ok(dispatch);
    assert.equal(dispatch.message.details.status, "completed");
    assert.ok(harness.notifications.some(({ message }) => message.includes("已启动后台协作 Agent")));
    assert.ok(harness.notifications.some(({ message }) => message.includes("已返回，主会话正在校验结果")));
    harness.branch.push({ type: "custom_message", customType: "pi-init-collaboration-result", details: dispatch.message.details });
    await emitExtensionEvent(harness, "agent_settled");
    const status = await workflow.execute("status", { action: "status" }, undefined, undefined, harness.context);
    assert.equal(status.details.status, "completed");
    assert.match(status.content[0].text, /implementation/);
    await emitExtensionEvent(harness, "session_shutdown");
  });
});
