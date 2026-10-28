import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionHarness, createWorkflowState, emitExtensionEvent, workflowMessageIdentity, withTempDirectory, mkdir, path, writeFile } from "./helpers.js";

let sequence = 10000;
async function fixture(cwd, { taskCount = 2, ...options } = {}) {
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "role-models.json"), JSON.stringify({ schemaVersion: 2, mode: "auto", workflowMode: "on", roleModels: {} }));
  const workflow = createWorkflowState({ summary: "请求中断续接", sessionId: "test-session", tasks: [
    { id: "work", role: "developer-test", task: "修改并验证", files: ["src"], acceptanceCriteria: ["通过"] },
    { id: "docs", role: "docs-commit", task: "收尾", files: ["docs"], acceptanceCriteria: ["完成"] },
  ].slice(0, taskCount) });
  const h = createExtensionHarness([{ type: "custom", id: "initial", customType: "pi-init-workflow", data: workflow }], { cwd, trusted: true, deferSendMessagePersistence: true, ...options });
  await emitExtensionEvent(h, "session_start");
  await emitExtensionEvent(h, "agent_start");
  const first = h.sentMessages.find(e => e.message.customType === "pi-init-workflow-task").message;
  await emitExtensionEvent(h, "message_start", { message: { ...first, role: "custom", timestamp: ++sequence } });
  h.persistSentMessage(first);
  return h;
}
function latest(h) { return h.branch.findLast(e => e.customType === "pi-init-workflow").data; }
function assistant(h, content = [], stopReason = "error", errorMessage = "fetch failed") {
  return { role: "assistant", content, stopReason, errorMessage, timestamp: ++sequence, provider: h.context.model.provider, model: h.context.model.id };
}
async function failure(h, message = assistant(h)) {
  await emitExtensionEvent(h, "before_provider_request", {});
  await emitExtensionEvent(h, "message_end", { message });
  await emitExtensionEvent(h, "agent_end");
  await emitExtensionEvent(h, "agent_settled", { aborted: message.stopReason === "aborted" });
}
async function completedTool(h, { persisted = true, nested = false, childEnds = true, isError = false } = {}) {
  const id = "write-" + ++sequence;
  const message = assistant(h, [{ type: "toolCall", id, name: "write", arguments: { path: "src/a.ts", content: "saved" } }], "toolUse", undefined);
  await emitExtensionEvent(h, "before_provider_request", {});
  await emitExtensionEvent(h, "message_end", { message });
  h.branch.push({ type: "message", id: "assistant-" + sequence, message });
  await emitExtensionEvent(h, "tool_execution_start", { toolCallId: id, toolName: "write", args: {} });
  if (nested) {
    await emitExtensionEvent(h, "tool_execution_start", { toolCallId: id + "/1", parentToolCallId: id, toolName: "external", args: {} });
    if (childEnds) await emitExtensionEvent(h, "tool_execution_end", { toolCallId: id + "/1", parentToolCallId: id, toolName: "external", result: {}, isError: false });
  }
  await emitExtensionEvent(h, "tool_execution_end", { toolCallId: id, toolName: "write", result: {}, isError });
  if (persisted) h.branch.push({ type: "message", id: "result-" + sequence, message: { role: "toolResult", toolCallId: id, toolName: "write", content: [{ type: "text", text: "saved" }], isError, timestamp: ++sequence } });
}

test("settled request-only failure preserves executing identity and one user continue resumes without task retry", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    const before = structuredClone(latest(h));
    const sent = h.sentMessages.length;
    await failure(h);
    assert.deepEqual(latest(h), before);
    assert.equal(h.sentMessages.length, sent);
    assert.equal(h.branch.findLast(e => e.customType === "pi-init-user-control").data.reason, "provider-request-failed");
    await emitExtensionEvent(h, "agent_settled", { aborted: false });
    assert.equal(h.sentMessages.length, sent);
    assert.equal((await emitExtensionEvent(h, "tool_call", { toolName: "bash", toolCallId: "held", input: {} })).block, true);
    assert.deepEqual(await emitExtensionEvent(h, "input", { source: "interactive", text: "继续" }), { action: "continue" });
    assert.deepEqual(latest(h), before);
    assert.equal(h.sentMessages.length, sent);
    await emitExtensionEvent(h, "agent_start");
    await h.tools.find(t => t.name === "task_workflow").execute("done", { action: "complete", ...workflowMessageIdentity(h), completionSummary: "完成", implementationRationale: "沿原身份完成", verification: ["通过"] }, undefined, undefined, h.context);
    assert.equal(latest(h).tasks[0].status, "completed");
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("persisted successful tools including nested calls are not replayed or marked unknown after the next request fails", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    await completedTool(h, { nested: true });
    const before = structuredClone(latest(h));
    const sources = h.branch.filter(e => e.type === "message").length;
    await failure(h);
    assert.deepEqual(latest(h), before);
    await emitExtensionEvent(h, "input", { source: "interactive", text: "继续" });
    assert.equal(h.branch.filter(e => e.type === "message").length, sources);
    assert.deepEqual(latest(h), before);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("missing persisted results, unfinished nested tools and failed tools retain unknown-outcome protection", async () => {
  for (const options of [{ persisted: false }, { nested: true, childEnds: false }, { isError: true }]) {
    await withTempDirectory(async cwd => {
      const h = await fixture(cwd);
      await completedTool(h, options);
      await failure(h);
      assert.equal(latest(h).status, "paused");
      assert.equal(latest(h).tasks[0].outcomeUnknown, true);
      await emitExtensionEvent(h, "input", { source: "interactive", text: "继续" });
      assert.equal(latest(h).tasks[0].outcomeUnknown, true);
      await emitExtensionEvent(h, "session_shutdown");
    });
  }
});

test("explicit abort never qualifies for request-only continuation", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    await failure(h, assistant(h, [], "aborted"));
    assert.equal(latest(h).tasks[0].outcomeUnknown, true);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("SDK retry success clears an intermediate failure without holding the workflow", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    await emitExtensionEvent(h, "before_provider_request", {});
    await emitExtensionEvent(h, "message_end", { message: assistant(h) });
    await emitExtensionEvent(h, "before_provider_request", {});
    await emitExtensionEvent(h, "message_end", { message: assistant(h, [], "stop", undefined) });
    await emitExtensionEvent(h, "agent_end");
    await emitExtensionEvent(h, "agent_settled", { aborted: false });
    assert.equal(latest(h).status, "running");
    assert.equal(h.branch.some(e => e.customType === "pi-init-user-control" && e.data.stopped), false);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("quota and authentication failures preserve safe task progress but never auto-request another turn", async () => {
  for (const error of ["The usage limit has been reached", "401 invalid credentials"]) {
    await withTempDirectory(async cwd => {
      const h = await fixture(cwd);
      const before = structuredClone(latest(h));
      const sent = h.sentMessages.length;
      await failure(h, assistant(h, [], "error", error));
      assert.deepEqual(latest(h), before);
      assert.equal(h.sentMessages.length, sent);
      assert.equal(h.branch.findLast(e => e.customType === "pi-init-user-control").data.stopped, true);
      await emitExtensionEvent(h, "session_shutdown");
    });
  }
});

test("quick continuation refuses changed attempt, branch, model, session and queued messages", async () => {
  for (const change of [
    h => { latest(h).handoff.attemptId = "other-attempt"; },
    h => { h.branch.splice(0, h.branch.length); },
    h => { h.context.model = { ...h.context.model, id: "other-model" }; },
    h => { h.context.sessionManager.getSessionId = () => "other-session"; },
    h => { h.context.hasPendingMessages = () => true; },
  ]) {
    await withTempDirectory(async cwd => {
      const h = await fixture(cwd);
      await failure(h);
      change(h);
      const sent = h.sentMessages.length;
      assert.deepEqual(await emitExtensionEvent(h, "input", { source: "interactive", text: "继续" }), { action: "handled" });
      assert.equal(h.sentMessages.length, sent);
      assert.equal((await emitExtensionEvent(h, "tool_call", { toolName: "bash", toolCallId: "stale-held", input: {} })).block, true);
      await emitExtensionEvent(h, "session_shutdown");
    });
  }
});

test("failed hold persistence cannot be cleared by a later successful continue write", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd, { appendEntry(type, data) { if (type === "pi-init-user-control" && data.reason === "provider-request-failed") throw new Error("disk full"); } });
    await failure(h);
    assert.deepEqual(await emitExtensionEvent(h, "input", { source: "interactive", text: "继续" }), { action: "handled" });
    await emitExtensionEvent(h, "input", { source: "interactive", text: "停止工作" });
    assert.deepEqual(await emitExtensionEvent(h, "input", { source: "interactive", text: "继续" }), { action: "handled" });
    assert.equal((await emitExtensionEvent(h, "tool_call", { toolName: "bash", toolCallId: "persist-held", input: {} })).block, true);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("failed continue persistence leaves the original hold intact until a successful explicit continue", async () => {
  await withTempDirectory(async cwd => {
    let failWrite = true;
    const h = await fixture(cwd, { appendEntry(type, data) { if (type === "pi-init-user-control" && !data.stopped && failWrite) throw new Error("disk full"); } });
    await failure(h);
    assert.deepEqual(await emitExtensionEvent(h, "input", { source: "interactive", text: "继续" }), { action: "handled" });
    failWrite = false;
    assert.deepEqual(await emitExtensionEvent(h, "input", { source: "interactive", text: "继续" }), { action: "continue" });
    assert.equal(latest(h).tasks[0].outcomeUnknown, undefined);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("reload of an interrupted executing task keeps the existing unknown-outcome gate", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    await failure(h);
    const sent = h.sentMessages.length;
    await emitExtensionEvent(h, "session_start", { reason: "reload" });
    assert.equal(latest(h).status, "paused");
    assert.equal(latest(h).tasks[0].outcomeUnknown, true);
    await emitExtensionEvent(h, "input", { source: "interactive", text: "继续" });
    assert.equal(latest(h).tasks[0].outcomeUnknown, true);
    assert.equal(h.sentMessages.length, sent);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("late bound failure cannot interrupt a replacement attempt", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    await emitExtensionEvent(h, "before_provider_request", {});
    const message = assistant(h);
    await emitExtensionEvent(h, "message_start", { message });
    latest(h).handoff.attemptId = "replacement";
    await emitExtensionEvent(h, "message_end", { message });
    await emitExtensionEvent(h, "agent_end");
    await emitExtensionEvent(h, "agent_settled", { aborted: false });
    assert.equal(latest(h).tasks[0].outcomeUnknown, undefined);
    assert.equal(h.branch.some(e => e.customType === "pi-init-user-control" && e.data.stopped), false);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("business block and explicit user stop are not converted into a provider quick continuation", async () => {
  for (const blocked of [true, false]) {
    await withTempDirectory(async cwd => {
      const h = await fixture(cwd);
      if (blocked) await h.tools.find(t => t.name === "task_workflow").execute("blocked", { action: "block", ...workflowMessageIdentity(h), reason: "required MCP unavailable" }, undefined, undefined, h.context);
      else await emitExtensionEvent(h, "input", { source: "interactive", text: "停止工作" });
      const before = structuredClone(latest(h));
      await failure(h);
      await emitExtensionEvent(h, "input", { source: "interactive", text: "继续" });
      assert.deepEqual(latest(h), before);
      assert.equal(latest(h).status, "paused");
      await emitExtensionEvent(h, "session_shutdown");
    });
  }
});

test("partial tool calls and tool activity after request capture never qualify as request-only failure", async () => {
  for (const partial of [true, false]) {
    await withTempDirectory(async cwd => {
      const h = await fixture(cwd);
      await emitExtensionEvent(h, "before_provider_request", {});
      const message = assistant(h, partial ? [{ type: "toolCall", id: "partial", name: "write", arguments: {} }] : []);
      await emitExtensionEvent(h, "message_start", { message });
      if (!partial) {
        await emitExtensionEvent(h, "tool_execution_start", { toolCallId: "late-tool", toolName: "external", args: {} });
        await emitExtensionEvent(h, "tool_execution_end", { toolCallId: "late-tool", toolName: "external", isError: false, result: {} });
      }
      await emitExtensionEvent(h, "message_end", { message });
      await emitExtensionEvent(h, "agent_end");
      await emitExtensionEvent(h, "agent_settled", { aborted: false });
      assert.equal(latest(h).tasks[0].outcomeUnknown, true);
      await emitExtensionEvent(h, "session_shutdown");
    });
  }
});

test("an incomplete nested result annotation remains unsafe even when the outer tool returned", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    await completedTool(h);
    h.branch.findLast(e => e.type === "message" && e.message.role === "toolResult").message.nestedCalls = { complete: false, calls: [] };
    await failure(h);
    assert.equal(latest(h).tasks[0].outcomeUnknown, true);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("a final report request failure never reopens or retries an already completed workflow", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd, { taskCount: 1 });
    await h.tools.find(t => t.name === "task_workflow").execute("done", { action: "complete", ...workflowMessageIdentity(h), completionSummary: "完成", implementationRationale: "已经验收", verification: ["通过"] }, undefined, undefined, h.context);
    const before = structuredClone(latest(h));
    const sent = h.sentMessages.length;
    await failure(h);
    assert.equal(latest(h).status, "completed");
    assert.deepEqual(latest(h), before);
    assert.ok(h.sentMessages.slice(sent).every(entry => entry.options.triggerTurn === false));
    await emitExtensionEvent(h, "session_shutdown");
  });
});


