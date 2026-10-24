import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assessCodemodeRepetition, registerAbnormalToolGuard } from "../extensions/abnormal-tool-guard.ts";
import { createWorkflowState } from "../src/workflow.ts";
import { createExtensionHarness, emitExtensionEvent, withTempDirectory } from "./helpers.js";

const blankLines = (count, line = 'text(" ");', separator = "\n") => Array(count).fill(line).join(separator);

test("重复空输出同时满足连续次数和占比才拒绝，返回可解释原因", () => {
  const result = assessCodemodeRepetition('const result = 1;\n' + blankLines(256));
  assert.equal(result.ok, false);
  assert.equal(result.code, "CODEMODE_REPETITIVE_BLANK_OUTPUT");
  assert.equal(result.longestRun, 256);
  assert.equal(result.repeatedLines, 256);
  assert.equal(result.nonemptyLines, 257);
  assert.ok(result.message.length > 0);
  assert.equal(assessCodemodeRepetition(blankLines(255)).ok, true);
  const meaningful = Array(30).fill('text("result");').join("\n");
  assert.equal(assessCodemodeRepetition(blankLines(270) + "\n" + meaningful).ok, false);
  assert.equal(assessCodemodeRepetition(blankLines(270) + "\n" + meaningful + '\ntext("done");').ok, true);
  assert.equal(assessCodemodeRepetition(blankLines(128) + '\ntext("divider");\n' + blankLines(128)).ok, true);
});

test("支持缩进、单双引号、空白和换行边界，不以正常脚本长度或重复内容拒绝", () => {
  for (const line of ['text("");', "  text ( '\t ' )  ", '\ttext(" \t") ;']) {
    for (const separator of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
      assert.equal(assessCodemodeRepetition(blankLines(256, line, separator)).ok, false);
    }
  }
  for (const source of ["", "\n\n", blankLines(30), blankLines(600, 'text("status");'),
    Array.from({ length: 6000 }, (_, i) => `text({ index: ${i}, result: "real data" });`).join("\n"),
    blankLines(600, 'await tools.read({ path: "source.ts" });'),
    blankLines(256, 'text(" "); // intentional formatting'),
  ]) assert.equal(assessCodemodeRepetition(source).ok, true);
});

test("注释、多行字符串和嵌套模板中的示例不是可执行空输出", () => {
  const example = blankLines(256);
  for (const source of [
    `/*\n${example}\n*/`,
    `const example = \`\n${example}\n\`;`,
    `const example = 'start\\\n${blankLines(256, 'text(" ");\\')}\nend';`,
    `const example = \`outer \${\`nested\`}\n${example}\n\`;`,
    `const example = \`outer \${{ nested: \`inner \${1}\` }.nested}\n${example}\n\`;`,
    blankLines(256, '// text(" ");'),
    // Regex syntax is deliberately outside this conservative heuristic's scope.
    'const backtick = /`/;\nconst sample = `\n' + example + '\n`;',
    'const slash = /["/]/;\n' + example,
  ]) assert.equal(assessCodemodeRepetition(source).ok, true);
  // Closed data does not hide a subsequent pathological run.
  assert.equal(assessCodemodeRepetition('const example = `sample`;\n' + example).ok, false);
  assert.equal(assessCodemodeRepetition('/* sample */\n' + example).ok, false);
});

test("守卫只处理 codemode 的真实 code 参数，不改写或执行任何输入", async () => {
  let handler;
  let stopped = false;
  registerAbnormalToolGuard({ on: (_, fn) => { handler = fn; } }, () => { stopped = true; });
  for (const event of [
    { toolName: "write", input: { code: blankLines(256) } },
    { toolName: "codemode", input: {} },
    { toolName: "codemode", input: { code: null } },
    { toolName: "codemode", input: { code: 123 } },
    { toolName: "codemode", input: { code: 'text("real data");' } },
  ]) assert.equal(await handler(event, {}), undefined);
  assert.equal(stopped, false);
  const input = Object.freeze({ code: 'const privateSource = "do not log";\n' + blankLines(256) });
  const result = await handler({ toolName: "codemode", input }, {});
  assert.equal(result.block, true);
  assert.match(result.reason, /CODEMODE_REPETITIVE_BLANK_OUTPUT/);
  assert.ok(!result.reason.includes("privateSource"));
  assert.equal(stopped, true);
});

async function runningHarness(cwd) {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "role-models.json"), JSON.stringify({ schemaVersion: 2, mode: "auto", workflowMode: "on", roleModels: {} }));
  const initial = createWorkflowState({ sessionId: "test-session", summary: "保护异常参数", tasks: [
    { id: "owned", role: "developer-test", task: "安全拒绝", files: ["extensions"], acceptanceCriteria: ["不重放"] },
  ] });
  const h = createExtensionHarness([{ type: "custom", customType: "pi-init-workflow", data: initial }], { cwd, trusted: true, deferSendMessagePersistence: true });
  await emitExtensionEvent(h, "session_start");
  const task = h.sentMessages.findLast(({ message }) => message.customType === "pi-init-workflow-task").message;
  await emitExtensionEvent(h, "agent_start");
  await emitExtensionEvent(h, "message_start", { message: { ...task, role: "custom", timestamp: Date.now() } });
  h.persistSentMessage(task);
  return h;
}

const latestWorkflow = h => h.branch.findLast(entry => entry.customType === "pi-init-workflow").data;

test("执行前拒绝复用停止与未知结果保护，不续跑、重试或改变参数", async () => {
  await withTempDirectory(async cwd => {
    const h = await runningHarness(cwd);
    try {
      const before = structuredClone(latestWorkflow(h));
      const sent = h.sentMessages.length;
      assert.equal(await emitExtensionEvent(h, "tool_call", { toolName: "codemode", toolCallId: "normal", input: { code: 'text("result");' } }), undefined);
      const input = { code: blankLines(256) };
      const result = await emitExtensionEvent(h, "tool_call", { toolName: "codemode", toolCallId: "abnormal", input });
      assert.equal(result.block, true);
      assert.match(result.reason, /CODEMODE_REPETITIVE_BLANK_OUTPUT/);
      assert.equal(input.code, blankLines(256));
      assert.equal(latestWorkflow(h).status, "paused");
      assert.equal(latestWorkflow(h).tasks[0].outcomeUnknown, true);
      assert.equal(latestWorkflow(h).handoff, undefined);
      assert.equal(latestWorkflow(h).recoveryGeneration, before.recoveryGeneration + 1);
      assert.ok(h.aborts.length > 0);
      await emitExtensionEvent(h, "agent_end");
      await emitExtensionEvent(h, "agent_settled");
      await emitExtensionEvent(h, "input", { source: "interactive", text: "继续" });
      await emitExtensionEvent(h, "agent_settled");
      const retry = await emitExtensionEvent(h, "tool_call", { toolName: "task_workflow", input: { action: "retry", taskId: "owned", confirmUnknownOutcome: true } });
      assert.equal(retry.block, true);
      assert.equal(latestWorkflow(h).tasks[0].outcomeUnknown, true);
      assert.equal(h.sentMessages.length, sent);
      assert.equal(h.sentUserMessages.length, 0);
    } finally { await emitExtensionEvent(h, "session_shutdown"); }
  });
});

test("恢复门与 architect 边界优先，异常保护不授予权限或替代原拒绝", async () => {
  for (const role of ["architect", "developer-test"]) await withTempDirectory(async cwd => {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "role-models.json"), JSON.stringify({ schemaVersion: 2, mode: "auto", roleModels: {} }));
    const h = createExtensionHarness([], { cwd, trusted: true });
    try {
      await emitExtensionEvent(h, "session_start");
      await h.tools.find(tool => tool.name === "switch_role").execute("role", { role }, undefined, undefined, h.context);
      if (role === "developer-test") await emitExtensionEvent(h, "session_compact", { reason: "manual" });
      const result = await emitExtensionEvent(h, "tool_call", { toolName: "codemode", input: { code: blankLines(256) } });
      assert.equal(result.block, true);
      assert.ok(!result.reason.includes("CODEMODE_REPETITIVE_BLANK_OUTPUT"));
      assert.equal(h.branch.some(entry => entry.customType === "pi-init-user-control" && entry.data.reason === "abnormal-tool-arguments"), false);
    } finally { await emitExtensionEvent(h, "session_shutdown"); }
  });
});

test("停止记录持久化失败仍拒绝，普通后续请求须由用户明确恢复", async () => {
  const h = createExtensionHarness([], { trusted: true, appendEntry(type, data) {
    if (type === "pi-init-user-control" && data.stopped) throw new Error("disk full");
  } });
  try {
    await emitExtensionEvent(h, "agent_start");
    const result = await emitExtensionEvent(h, "tool_call", { toolName: "codemode", input: { code: blankLines(256) } });
    assert.equal(result.block, true);
    const stopped = await emitExtensionEvent(h, "tool_call", { toolName: "codemode", input: { code: 'text("result");' } });
    assert.equal(stopped.block, true);
    await emitExtensionEvent(h, "agent_end");
    await emitExtensionEvent(h, "agent_settled");
    await emitExtensionEvent(h, "input", { source: "interactive", text: "继续" });
    assert.equal(await emitExtensionEvent(h, "tool_call", { toolName: "codemode", input: { code: 'text("result");' } }), undefined);
    assert.equal(h.sentMessages.length, 0);
    assert.equal(h.sentUserMessages.length, 0);
  } finally { await emitExtensionEvent(h, "session_shutdown"); }
});
