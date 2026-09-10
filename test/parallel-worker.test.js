import assert from "node:assert/strict";
import test from "node:test";
import { buildParallelWorkerPrompt, runParallelWorker, runParallelWorkers } from "../extensions/parallel-worker.ts";
import { PARALLEL_RESULT_PROTOCOL } from "../src/parallel-batch.js";

const baseCommit = "0123456789abcdef0123456789abcdef01234567";
const spec = (taskId, delay = 0) => ({
  batchId: "batch-1",
  taskId,
  attemptId: `attempt-${taskId}`,
  baseCommit,
  cwd: process.cwd(),
  task: `实现 ${taskId}`,
  files: [`src/${taskId}`],
  acceptanceCriteria: ["验证通过"],
  model: "openai-codex/gpt-5.6-luna",
  thinkingLevel: "max",
  delay,
});

function output(task) {
  return `${JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: JSON.stringify({
        protocol: PARALLEL_RESULT_PROTOCOL,
        outcome: "complete",
        batchId: task.batchId,
        taskId: task.taskId,
        attemptId: task.attemptId,
        baseCommit: task.baseCommit,
        completionSummary: "完成",
        implementationRationale: "保持 worktree 隔离",
        verification: ["node --test：通过"],
        changedFiles: [`src/${task.taskId}/index.js`],
      }) }],
    },
  })}\n`;
}

test("worker prompt 固定隔离、验证和禁止提交边界", () => {
  const prompt = buildParallelWorkerPrompt(spec("api"));
  assert.match(prompt, /当前 worktree/);
  assert.match(prompt, /不要 commit、push/);
  assert.match(prompt, /pi-init\/parallel-task@1/);
  assert.match(prompt, /src\/api/);
});

test("并行 worker 使用最多两个 Pi 进程并真实重叠等待", async () => {
  let active = 0;
  let maxActive = 0;
  const exec = async (_command, args) => {
    const taskText = args.at(-1);
    const task = taskText.includes("实现 ui") ? spec("ui") : spec("api");
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active -= 1;
    return { code: 0, stdout: output(task), stderr: "" };
  };
  const results = await runParallelWorkers(exec, [spec("api"), spec("ui")]);
  assert.equal(results.length, 2);
  assert.equal(maxActive, 2);
});

test("worker 失败不会取消仍在运行的独立 worker", async () => {
  let uiCompleted = false;
  const exec = async (_command, args, options) => {
    const taskText = args.at(-1);
    if (taskText.includes("实现 api")) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { code: 1, stdout: "", stderr: "api failed" };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    uiCompleted = !options.signal?.aborted;
    return { code: 0, stdout: output(spec("ui")), stderr: "" };
  };
  await assert.rejects(() => runParallelWorkers(exec, [spec("api"), spec("ui")]), /退出失败/);
  assert.equal(uiCompleted, true);
});

test("worker 使用固定模型、工作目录和安全参数，非零退出不回退", async () => {
  let invocation;
  const exec = async (command, args, options) => {
    invocation = { command, args, options };
    return { code: 7, stdout: "", stderr: "worker failed" };
  };
  await assert.rejects(() => runParallelWorker(exec, spec("api"), undefined, "pi-test"), /退出失败/);
  assert.equal(invocation.command, "pi-test");
  assert.equal(invocation.options.cwd, process.cwd());
  assert.ok(invocation.args.includes("--no-session"));
  assert.ok(invocation.args.includes("--approve"));
  assert.ok(invocation.args.includes("--exclude-tools"));
  assert.ok(invocation.args.includes("--append-system-prompt"));
  assert.ok(!invocation.args.includes("--offline"));
  assert.ok(!invocation.args.some((arg) => arg.includes("dangerously-bypass")));
});

test("worker 可从 agent_end 获取最终结果，并保留脱敏的退出诊断", async () => {
  const agentEnd = async (_command, args) => {
    const taskText = args.at(-1);
    const task = taskText.includes("实现 ui") ? spec("ui") : spec("api");
    const messageEnd = JSON.parse(output(task));
    return {
      code: 0,
      stdout: JSON.stringify({ type: "agent_end", messages: [messageEnd.message] }),
      stderr: "",
    };
  };
  assert.equal((await runParallelWorker(agentEnd, spec("api"))).outcome, "complete");

  const failing = async () => ({ code: 1, stdout: "", stderr: "provider token=secret" });
  await assert.rejects(() => runParallelWorker(failing, spec("api")), /stderr：provider token=\[redacted\]/);
});

test("worker 被终止时不把 code=0 的 toolUse 误报为 provider 失败", async () => {
  const killed = async () => ({
    code: 0,
    killed: true,
    stdout: `${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "read" }] } })}\n`,
    stderr: "",
  });
  await assert.rejects(() => runParallelWorker(killed, spec("api")), /被终止.*code=0/);
});

test("worker 未被终止时将 toolUse 归类为缺少最终结果", async () => {
  const toolUse = async () => ({
    code: 0,
    stdout: `${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "read" }] } })}\n`,
    stderr: "",
  });
  await assert.rejects(() => runParallelWorker(toolUse, spec("api")), (error) =>
    /最终 assistant 结果.*toolUse/.test(error.message) && !/provider/.test(error.message));
});

test("worker 缺少结构化最终结果或返回错误结果时明确失败", async () => {
  const noResult = async () => ({ code: 0, stdout: "{}\n", stderr: "" });
  await assert.rejects(() => runParallelWorker(noResult, spec("api")), /最终 assistant/);
  const badResult = async () => ({
    code: 0,
    stdout: `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "not-json" }] } })}\n`,
    stderr: "",
  });
  await assert.rejects(() => runParallelWorker(badResult, spec("api")), /JSON/);
});
