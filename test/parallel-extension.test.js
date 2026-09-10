import assert from "node:assert/strict";
import test from "node:test";
import {
  createExtensionHarness,
  emitExtensionEvent,
  mkdir,
  readFile,
  writeFile,
  withTempDirectory,
  path,
} from "./helpers.js";
import {
  attachParallelIntegrationWorktree,
  attachParallelWorkerWorktree,
  createParallelBatch,
  startParallelBatch,
  startParallelWorker,
} from "../src/parallel-batch.js";
import { PARALLEL_RESULT_PROTOCOL } from "../src/parallel-batch.js";

const baseCommit = "0123456789abcdef0123456789abcdef01234567";

function roleConfig() {
  return {
    schemaVersion: 2,
    mode: "auto",
    workflowMode: "on",
    workflowExecutor: "local",
    roleModels: {
      architect: { provider: "openai-codex", model: "gpt-5.6-sol", thinkingLevel: "max" },
      "developer-test": { provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "max" },
    },
  };
}

function worktree(name, worktreePath) {
  return { name, path: worktreePath, branch: name, commit: baseCommit, status: "clean" };
}

function runningState() {
  const parent = process.platform === "win32" ? "C:\\repo" : "/repo";
  const external = (name) => process.platform === "win32" ? `C:\\work\\${name}` : `/work/${name}`;
  let state = createParallelBatch({
    batchId: "batch-restore",
    parentPath: parent,
    baseCommit,
    tasks: [
      { id: "api", task: "API", files: ["src/api"], acceptanceCriteria: ["完成"] },
      { id: "ui", task: "UI", files: ["src/ui"], acceptanceCriteria: ["完成"] },
    ],
  });
  state = attachParallelWorkerWorktree(state, { taskId: "api", worktree: worktree("api", external("api")) });
  state = attachParallelWorkerWorktree(state, { taskId: "ui", worktree: worktree("ui", external("ui")) });
  state = attachParallelIntegrationWorktree(state, { worktree: worktree("integration", external("integration")) });
  state = startParallelBatch(state);
  return startParallelWorker(state, { taskId: "api", attemptId: "attempt-api" });
}

function workerOutput(prompt) {
  const match = prompt.match(/批次：([^；]+)；任务：([^；]+)；attempt：([^；]+)；固定基线：([^\n]+)/);
  assert.ok(match, "worker prompt should include identity");
  const [, batchId, taskId, attemptId, commit] = match;
  const result = {
    protocol: PARALLEL_RESULT_PROTOCOL,
    outcome: "complete",
    batchId,
    taskId,
    attemptId,
    baseCommit: commit,
    completionSummary: `${taskId} 完成`,
    implementationRationale: "在独立 worktree 中保持范围隔离",
    verification: ["node --test：通过"],
    changedFiles: [`src/${taskId}/index.js`],
  };
  return `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(result) }] } })}\n`;
}

async function makeHarness(directory, exec, model = { provider: "openai-codex", id: "gpt-5.6-luna" }) {
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  await writeFile(path.join(directory, ".pi", "role-models.json"), `${JSON.stringify(roleConfig(), null, 2)}\n`, "utf8");
  const harness = createExtensionHarness([], {
    cwd: directory,
    trusted: true,
    model,
    availableModels: [model, { provider: "openai-codex", id: "gpt-5.6-sol" }],
    exec,
  });
  await emitExtensionEvent(harness, "session_start");
  return { harness, directory };
}

test("parallel_batch status 无批次时不会渲染 undefined", async () => {
  const harness = createExtensionHarness([], { trusted: true });
  const tool = harness.tools.find((item) => item.name === "parallel_batch");
  assert.ok(tool);

  const result = await tool.execute("parallel-status", { action: "status" }, undefined, undefined, harness.context);
  assert.equal(result.details, undefined);
  const rendered = tool.renderResult(result, {}, harness.context.ui.theme).render(240).join("\n").trimEnd();
  assert.equal(rendered, "✓ 当前没有并行批次。");
});

test("parallel_batch 接入 Pi、gmc 和独立 integration worktree，且不完成 task_workflow", async () => {
  await withTempDirectory(async (fixture) => {
    const parent = fixture;
    const base = worktree("repo", parent);
    const worktrees = [base];
    const calls = [];
    const exec = async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: `${baseCommit}\n`, stderr: "" };
      if (command === "git" && args[0] === "diff") return { code: 0, stdout: "src/api/index.js\nsrc/ui/index.js\n", stderr: "" };
      if (command === "gmc.exe" && args.includes("version")) return { code: 0, stdout: "gmc version 0.10.1\n", stderr: "" };
      if (command === "gmc.exe" && args.includes("hook")) return { code: 0, stdout: "[]", stderr: "" };
      if (command === "gmc.exe" && args.includes("share")) return { code: 0, stdout: "[]", stderr: "" };
      if (command === "gmc.exe" && args.includes("add")) {
        const name = args[args.indexOf("add") + 1];
        const item = worktree(name, path.join(path.dirname(fixture), `${path.basename(fixture)}--${name}-worktree`));
        worktrees.push(item);
        return { code: 0, stdout: "created", stderr: "" };
      }
      if (command === "gmc.exe" && args.includes("list")) return { code: 0, stdout: JSON.stringify(worktrees), stderr: "" };
      if (command === "gmc.exe" && args.includes("promote")) return { code: 0, stdout: "promoted", stderr: "" };
      if (args.includes("--mode") && args.includes("json") && args.includes("-p")) return { code: 0, stdout: workerOutput(args.at(-1)), stderr: "" };
      throw new Error(`unexpected ${command} ${args.join(" ")}`);
    };
    const { harness } = await makeHarness(fixture, exec);
    const tool = harness.tools.find((item) => item.name === "parallel_batch");
    assert.ok(tool);

    const started = await tool.execute("parallel-start", {
      action: "start",
      batchId: "batch-extension",
      baseRef: "HEAD",
      tasks: [
        { id: "api", task: "API", files: ["src/api"], acceptanceCriteria: ["完成"] },
        { id: "ui", task: "UI", files: ["src/ui"], acceptanceCriteria: ["完成"] },
      ],
    }, undefined, undefined, harness.context);
    assert.equal(started.details.status, "awaiting-integration");
    assert.equal(harness.branch.filter((entry) => entry.customType === "pi-init-workflow").length, 0);
    assert.equal(harness.branch.filter((entry) => entry.customType === "pi-init-parallel-batch").length > 0, true);
    assert.equal(calls.filter((call) => call.args.some((arg) => arg.includes("parallel_batch"))).length, 2);

    const integrated = await tool.execute("parallel-integrate", { action: "integrate", batchId: "batch-extension" }, undefined, undefined, harness.context);
    assert.equal(integrated.details.status, "integrating");
    const completed = await tool.execute("parallel-complete", {
      action: "complete",
      batchId: "batch-extension",
      verification: ["npm test：通过"],
      changedFiles: ["src/api/index.js", "src/ui/index.js"],
    }, undefined, undefined, harness.context);
    assert.equal(completed.details.status, "completed");
  });
});

test("parallel_batch 保留成功 worker 并显示失败原因", async () => {
  await withTempDirectory(async (fixture) => {
    const base = worktree("repo", fixture);
    const worktrees = [base];
    const exec = async (command, args) => {
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: `${baseCommit}\n`, stderr: "" };
      if (command === "gmc.exe" && args.includes("version")) return { code: 0, stdout: "gmc version 0.10.1\n", stderr: "" };
      if (command === "gmc.exe" && args.includes("hook")) return { code: 0, stdout: "[]", stderr: "" };
      if (command === "gmc.exe" && args.includes("share")) return { code: 0, stdout: "[]", stderr: "" };
      if (command === "gmc.exe" && args.includes("add")) {
        const name = args[args.indexOf("add") + 1];
        const item = worktree(name, path.join(path.dirname(fixture), `${path.basename(fixture)}--${name}-worktree`));
        worktrees.push(item);
        return { code: 0, stdout: "created", stderr: "" };
      }
      if (command === "gmc.exe" && args.includes("list")) return { code: 0, stdout: JSON.stringify(worktrees), stderr: "" };
      if (args.includes("--mode") && args.includes("json") && args.includes("-p")) {
        const prompt = args.at(-1);
        if (prompt.includes("任务：api")) return { code: 1, stdout: "", stderr: "provider token=secret" };
        return { code: 0, stdout: workerOutput(prompt), stderr: "" };
      }
      throw new Error(`unexpected ${command} ${args.join(" ")}`);
    };
    const { harness } = await makeHarness(fixture, exec);
    const tool = harness.tools.find((item) => item.name === "parallel_batch");
    assert.ok(tool);

    const started = await tool.execute("parallel-start", {
      action: "start",
      batchId: "batch-failure-diagnostic",
      baseRef: "HEAD",
      tasks: [
        { id: "api", task: "API", files: ["src/api"], acceptanceCriteria: ["完成"] },
        { id: "ui", task: "UI", files: ["src/ui"], acceptanceCriteria: ["完成"] },
      ],
    }, undefined, undefined, harness.context);
    assert.equal(started.details.status, "blocked");
    assert.equal(started.details.tasks.find((task) => task.id === "ui").status, "completed");
    assert.match(started.content[0].text, /worker api 失败/);
    assert.match(tool.renderResult(started, {}, harness.context.ui.theme).render(240).join("\\n"), /worker api 失败/);
  });
});

test("parallel_batch 在不受信任项目或错误角色下拒绝启动", async () => {
  const untrusted = createExtensionHarness([], { trusted: false });
  const untrustedTool = untrusted.tools.find((item) => item.name === "parallel_batch");
  await assert.rejects(() => untrustedTool.execute("start", { action: "start", tasks: [] }, undefined, undefined, untrusted.context), /受信任/);

  await withTempDirectory(async (fixture) => {
    const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
    const { harness } = await makeHarness(fixture, async () => ({ code: 1, stdout: "", stderr: "" }), architect);
    const tool = harness.tools.find((item) => item.name === "parallel_batch");
    await assert.rejects(() => tool.execute("start", { action: "start", tasks: [] }, undefined, undefined, harness.context), /developer-test/);
  });
});

test("session_start 和 session_shutdown 不会自动重派未终态批次", async () => {
  const state = runningState();
  const branch = [{ type: "custom", customType: "pi-init-parallel-batch", data: state }];
  let workerCalls = 0;
  const harness = createExtensionHarness(branch, {
    trusted: true,
    exec: async (command) => {
      if (command === "pi.cmd") workerCalls += 1;
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await emitExtensionEvent(harness, "session_start");
  assert.equal(workerCalls, 0);
  assert.match(harness.notifications.at(-1)?.message ?? "", /不会自动重新派发/);
  await emitExtensionEvent(harness, "session_shutdown");
  assert.equal(workerCalls, 0);
  assert.equal(harness.branch.at(-1)?.data.status, "blocked");
});
