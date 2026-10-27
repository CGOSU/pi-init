import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionHarness, createWorkflowState, emitExtensionEvent, workflowMessageIdentity, withTempDirectory, mkdir, path, writeFile } from "./helpers.js";

async function fixture(directory, secondRole = "docs-commit", deferSendMessagePersistence = false) {
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  const model = { provider: "test", id: "model", contextWindow: 100000, maxTokens: 1000 };
  await writeFile(path.join(directory, ".pi", "role-models.json"), JSON.stringify({ schemaVersion: 2, mode: "auto", workflowMode: "on", roleModels: {} }));
  const workflow = createWorkflowState({ summary: "原生压缩所有权", tasks: [
    { id: "first", role: "developer-test", task: "实现", files: ["src"], acceptanceCriteria: ["通过"] },
    { id: "second", role: secondRole, task: "继续", files: ["src"], acceptanceCriteria: ["通过"] },
  ] });
  const h = createExtensionHarness([{ type: "custom", customType: "pi-init-workflow", data: workflow }], { cwd: directory, trusted: true, model, thinkingLevel: "high", deferSendMessagePersistence });
  h.context.getContextUsage = () => ({ tokens: 99000, contextWindow: 100000, percent: 99 });
  h.compactions = [];
  h.context.compact = options => h.compactions.push(options);
  await emitExtensionEvent(h, "session_start");
  return h;
}

function latest(h) { return h.entries.filter(e => e.type === "pi-init-workflow").at(-1).data; }
function taskMessages(h) { return h.sentMessages.filter(e => e.message.customType === "pi-init-workflow-task"); }

test("completed tool turns never request extension compaction even near capacity", async () => {
  await withTempDirectory(async directory => {
    const h = await fixture(directory);
    await emitExtensionEvent(h, "turn_end", { outcome: "completed", message: { role: "assistant", content: [] }, toolResults: [], toolResultEntryIds: [] });
    assert.equal(h.compactions.length, 0);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("same-role and cross-role task boundaries dispatch without summary generation", async () => {
  for (const role of ["developer-test", "docs-commit"]) {
    await withTempDirectory(async directory => {
      const h = await fixture(directory, role);
      await emitExtensionEvent(h, "agent_start");
      const tool = h.tools.find(t => t.name === "task_workflow");
      await tool.execute("complete", { ...workflowMessageIdentity(h), action: "complete", taskId: "first", completionSummary: "完成", implementationRationale: "保留原生压缩", verification: ["通过"] }, undefined, undefined, h.context);
      await emitExtensionEvent(h, "agent_settled");
      assert.equal(h.compactions.length, 0);
      assert.equal(latest(h).tasks[0].status, "completed");
      assert.equal(latest(h).currentTaskId, "second");
      assert.equal(taskMessages(h).length, 2);
      await emitExtensionEvent(h, "session_shutdown");
    });
  }
});

test("native and manual compaction retain task state and rearm role recovery without dispatch", async () => {
  for (const reason of ["manual", "threshold", "overflow"]) {
    await withTempDirectory(async directory => {
      const h = await fixture(directory);
      const before = structuredClone(latest(h));
      const messages = h.sentMessages.length;
      await h.completeCompaction({ reason });
      assert.deepEqual(latest(h), before);
      assert.equal(h.sentMessages.length, messages);
      assert.equal(h.compactions.length, 0);
      const blocked = await emitExtensionEvent(h, "tool_call", { toolName: "bash", toolCallId: "blocked", input: { command: "true" } });
      assert.equal(blocked.block, true);
      assert.match(blocked.reason, /pi-init-role-recovery/);
      await emitExtensionEvent(h, "session_shutdown");
    });
  }
});

test("replanning never generates a boundary summary", async () => {
  await withTempDirectory(async directory => {
    const h = await fixture(directory, "docs-commit", true);
    await emitExtensionEvent(h, "agent_start");
    const tool = h.tools.find(t => t.name === "task_workflow");
    await emitExtensionEvent(h, "message_start", { message: { role: "custom", ...taskMessages(h)[0].message } });
    h.persistSentMessage(taskMessages(h)[0].message);
    await tool.execute("direction", { ...workflowMessageIdentity(h), action: "request-replan", summary: "调整后续任务" }, undefined, undefined, h.context);
    await tool.execute("complete", { ...workflowMessageIdentity(h), action: "complete", taskId: "first", completionSummary: "完成", implementationRationale: "后续重规划", verification: ["通过"] }, undefined, undefined, h.context);
    await emitExtensionEvent(h, "agent_settled");
    assert.equal(h.compactions.length, 0);
    assert.equal(latest(h).status, "replanning");
    assert.equal(latest(h).tasks[0].status, "completed");
    assert.equal(h.sentMessages.filter(e => e.message.customType === "pi-init-workflow-replan").length, 1);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("legacy interrupted boundary resumes explicitly without recompressing or replaying completed work", async () => {
  await withTempDirectory(async directory => {
    const h = await fixture(directory);
    await emitExtensionEvent(h, "agent_start");
    await h.tools.find(t => t.name === "task_workflow").execute("complete", { ...workflowMessageIdentity(h), action: "complete", taskId: "first", completionSummary: "完成", implementationRationale: "旧边界", verification: ["通过"] }, undefined, undefined, h.context);
    const saved = structuredClone(latest(h));
    saved.continuation = { kind: "schedule", phase: "compacting", reason: "task-completed" };
    await emitExtensionEvent(h, "session_shutdown");
    const recovered = createExtensionHarness([{ type: "custom", customType: "pi-init-workflow", data: saved }], { cwd: directory, trusted: true });
    let compactions = 0;
    recovered.context.compact = () => { compactions++; };
    await emitExtensionEvent(recovered, "session_start");
    assert.equal(latest(recovered).status, "paused");
    assert.equal(latest(recovered).pauseReason, "boundary-compaction-interrupted");
    assert.equal(taskMessages(recovered).length, 0);
    await recovered.commands.get("pi-init").handler("workflow resume", recovered.context);
    assert.equal(compactions, 0);
    assert.equal(latest(recovered).tasks[0].status, "completed");
    assert.equal(latest(recovered).currentTaskId, "second");
    assert.equal(taskMessages(recovered).length, 1);
    await emitExtensionEvent(recovered, "session_shutdown");
  });
});

