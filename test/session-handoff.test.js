import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createExtensionHarness, createWorkflowState, emitExtensionEvent, workflowMessageIdentity, withTempDirectory, mkdir, path, writeFile } from "./helpers.js";
import { buildSessionHandoff, importedWorkflow, SESSION_HANDOFF_MAX_BYTES } from "../src/session-handoff.ts";
import { readFile } from "node:fs/promises";

async function fixture(cwd, { tokens = 90000, evidence = false, threeTasks = false } = {}) {
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "role-models.json"), JSON.stringify({ schemaVersion: 2, mode: "auto", workflowMode: "on", roleModels: {} }));
  const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
  manager.appendMessage({ role: "user", content: "完成两个交付物", timestamp: Date.now() });
  const workflow = createWorkflowState({ sessionId: manager.getSessionId(), summary: "安全换会话", constraints: ["保留数据边界"], tasks: [
    { id: "first", role: "developer-test", task: "实现", files: ["src/a.ts"], acceptanceCriteria: ["测试通过"] },
    { id: "second", role: "developer-test", task: "继续", files: ["src/b.ts"], acceptanceCriteria: ["复用成果"], dependsOn: ["first"] },
    ...(threeTasks ? [{ id: "third", role: "docs-commit", task: "收尾", files: ["docs"], acceptanceCriteria: ["完成"], dependsOn: ["first", "second"] }] : []),
  ] });
  manager.appendCustomEntry("pi-init-workflow", workflow);
  const h = createExtensionHarness(manager.getBranch(), { cwd, sessionId: manager.getSessionId(), trusted: true,
    model: { provider: "test", id: "model", contextWindow: 100000, maxTokens: 1000 },
    appendEntry: (type, data) => manager.appendCustomEntry(type, data),
    beforeSendMessagePersist: message => manager.appendCustomMessageEntry(message.customType, message.content, message.display ?? false, message.details),
  });
  h.context.sessionManager.getSessionFile = () => manager.getSessionFile();
  h.context.sessionManager.getEntries = () => manager.getEntries();
  h.context.getContextUsage = () => ({ tokens, contextWindow: 100000, percent: tokens / 1000 });
  h.manager = manager;
  await emitExtensionEvent(h, "session_start");
  await emitExtensionEvent(h, "agent_start");
  let evidenceIds;
  if (evidence) {
    manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "historical-check", name: "read", arguments: { path: "src/a.ts" } }], provider: "test", model: "model", api: "test", timestamp: Date.now(), stopReason: "toolUse", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const id = manager.appendMessage({ role: "toolResult", toolCallId: "historical-check", toolName: "read", content: [{ type: "text", text: "declared verification source" }], isError: false, timestamp: Date.now() });
    evidenceIds = [id];
    h.branch.splice(0, h.branch.length, ...manager.getBranch());
  }
  h.evidenceIds = evidenceIds;
  await h.tools.find(t => t.name === "task_workflow").execute("complete-first", { action: "complete", ...workflowMessageIdentity(h), completionSummary: "第一项完成", implementationRationale: "复用既有模块", verification: ["定向测试通过"], evidenceIds }, undefined, undefined, h.context);
  await emitExtensionEvent(h, "agent_end");
  // Expose the actual completed-task boundary before the next scheduler tick.
  // Manual fresh tests act here; capacity must no longer pause the scheduler.
  return h;
}
function latest(h) { return h.branch.findLast(e => e.customType === "pi-init-workflow").data; }

test("high host usage only reminds and does not pause or replace a session at the completed-task boundary", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    h.context.newSession = () => { throw new Error("unexpected automatic replacement"); };
    assert.equal(latest(h).status, "running");
    assert.equal(latest(h).pauseReason, undefined);
    assert.equal(latest(h).tasks[0].status, "completed");
    assert.equal(latest(h).tasks[1].status, "pending");
    assert.equal(h.sentMessages.filter(e => e.message.customType === "pi-init-workflow-task").length, 1);
    const notices = h.notifications.length;
    await emitExtensionEvent(h, "agent_settled");
    assert.equal(h.notifications.length, notices + 1);
    assert.equal(latest(h).currentTaskId, "second");
    assert.equal(h.sentMessages.filter(e => e.message.customType === "pi-init-workflow-task").length, 2);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("fresh capacity pressure reminds once and exposes manual handoff only at the safe boundary without pausing", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    h.context.newSession = () => assert.fail("automatic replacement");
    const notices = h.notifications.length;
    const messages = [{ role: "system", content: "x".repeat(240000) }];
    await emitExtensionEvent(h, "context_with_system", { messages });
    await emitExtensionEvent(h, "context_with_system", { messages });
    assert.equal(h.notifications.length, notices + 1);
    assert.equal(h.statusCalls.some(s => s.name === "pi-init-capacity" && s.text?.includes("workflow fresh")), false);
    await emitExtensionEvent(h, "agent_settled");
    assert.equal(h.statusCalls.some(s => s.name === "pi-init-capacity" && s.text?.includes("workflow fresh")), true);
    assert.equal(h.notifications.length, notices + 1);
    assert.equal(latest(h).currentTaskId, "second");
    assert.equal(latest(h).status, "running");
    await emitExtensionEvent(h, "context_with_system", { messages });
    assert.equal(h.statusCalls.findLast(s => s.name === "pi-init-capacity").text?.includes("workflow fresh") ?? false, false);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("small contexts continue normally without a handoff prompt", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd, { tokens: 10000 });
    await emitExtensionEvent(h, "agent_settled");
    assert.equal(latest(h).currentTaskId, "second");
    assert.equal(h.notifications.some(n => n.message.includes("workflow fresh")), false);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

async function replaceSession(source, options, { failSetup = false, cancel = false, skipActivate = false, failWorkflowWrite = false, corruptPacket = false } = {}) {
  if (cancel) return { cancelled: true };
  const manager = SessionManager.create(source.context.cwd, path.join(source.context.cwd, "sessions"));
  await emitExtensionEvent(source, "session_shutdown");
  source.replaced = true;
  const oldNotify = source.context.ui.notify;
  source.context.ui.notify = () => { throw new Error("stale source context used after replacement"); };
  const target = createExtensionHarness(manager.getBranch(), { cwd: source.context.cwd, sessionId: manager.getSessionId(), trusted: true,
    model: source.context.model,
    appendEntry: (type, data) => manager.appendCustomEntry(type, data),
    beforeSendMessagePersist: message => manager.appendCustomMessageEntry(message.customType, message.content, message.display ?? false, message.details),
  });
  target.manager = manager;
  target.context.sessionManager.getSessionFile = () => manager.getSessionFile();
  target.context.sessionManager.getEntries = () => manager.getEntries();
  await emitExtensionEvent(target, "session_start", { reason: "new" });
  source.target = target;
  if (failSetup) throw new Error("replacement failed after source invalidation");
  if (failWorkflowWrite) {
    const append = manager.appendCustomEntry.bind(manager);
    let fail = true;
    manager.appendCustomEntry = (type, data) => { if (type === "pi-init-workflow" && fail) { fail = false; throw new Error("target workflow write failed"); } return append(type, data); };
  }
  try { await options.setup(manager); }
  finally { target.branch.splice(0, target.branch.length, ...manager.getBranch()); }
  if (corruptPacket) target.branch.find(e => e.customType === "pi-init-session-handoff" && e.data.kind === "incoming").data.packet.context.goal = "tampered";
  target.context.sendMessage = async (message, sendOptions) => {
    manager.appendCustomMessageEntry(message.customType, message.content, message.display ?? false, message.details);
    target.branch.push(manager.getLeafEntry());
    target.sentMessages.push({ message, options: sendOptions });
    await emitExtensionEvent(target, "message_end", { message: { role: "custom", ...message, timestamp: Date.now() } });
  };
  if (!skipActivate) await options.withSession(target.context);
  source.context.ui.notify = oldNotify;
  return { cancelled: false };
}

test("confirmed fresh session imports only remaining execution, preserves historical verification and never uses stale source context", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd, { evidence: true });
    let replacements = 0;
    h.context.newSession = async options => { replacements++; return replaceSession(h, options); };
    await h.commands.get("pi-init").handler("workflow fresh", h.context);
    assert.equal(replacements, 1);
    const target = h.target;
    assert.ok(target);
    assert.equal(latest(target).sessionId, target.manager.getSessionId());
    assert.notEqual(latest(target).sessionId, h.manager.getSessionId());
    assert.equal(latest(target).workflowId, latest(h).workflowId);
    assert.equal(latest(target).tasks[0].status, "completed");
    assert.match(latest(target).tasks[0].verification[0], /历史验证/);
    assert.equal(latest(target).tasks[0].verificationEvidenceIds, undefined);
    assert.equal(latest(target).currentTaskId, "second", JSON.stringify(target.notifications));
    assert.equal(target.sentMessages.filter(e => e.message.customType === "pi-init-workflow-task").length, 1);
    assert.equal(latest(h).pauseReason, "session-transfer-pending");
    const status = await target.tools.find(t => t.name === "task_workflow").execute("history", { action: "status", evidenceIds: h.evidenceIds }, undefined, undefined, target.context);
    const evidence = status.details.taskMemory.evidence[0];
    assert.equal(evidence.historical, true);
    assert.equal(evidence.sourceSessionId, h.manager.getSessionId());
    assert.match(evidence.text, /declared verification source/);
    const tools = target.tools.find(t => t.name === "task_workflow");
    await assert.rejects(tools.execute("forged-verification", { action: "complete", ...workflowMessageIdentity(target), completionSummary: "不能冒充本次验证", implementationRationale: "历史来源只读", verification: ["历史"], evidenceIds: h.evidenceIds }, undefined, undefined, target.context));
    await emitExtensionEvent(target, "session_shutdown");
  });
});

test("cancelled native switch leaves source offer resumable without creating another owner", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    h.context.newSession = options => replaceSession(h, options, { cancel: true });
    await h.commands.get("pi-init").handler("workflow fresh", h.context);
    assert.equal(latest(h).pauseReason, "session-handoff-review");
    await h.commands.get("pi-init").handler("workflow resume", h.context);
    assert.equal(latest(h).currentTaskId, "second");
    assert.equal(h.target, undefined);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("uncertain replacement freezes the old owner and repeated fresh cannot create a duplicate", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    let calls = 0;
    h.context.newSession = async () => { calls++; throw new Error("unknown switch outcome"); };
    await h.commands.get("pi-init").handler("workflow fresh", h.context);
    assert.equal(latest(h).pauseReason, "session-transfer-pending");
    await h.commands.get("pi-init").handler("workflow fresh", h.context);
    assert.equal(calls, 1);
    await h.commands.get("pi-init").handler("workflow resume", h.context);
    assert.equal(latest(h).pauseReason, "session-transfer-pending");
    await assert.rejects(h.tools.find(t => t.name === "task_workflow").execute("old-plan", { action: "plan", summary: "旧会话重排", tasks: [] }, undefined, undefined, h.context), error => error.code === "WORKFLOW_SESSION_TRANSFERRED");
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("active tools, unknown outcomes, pending messages, lost trust and missing session persistence never switch", async () => {
  for (const change of [
    h => { h.context.isIdle = () => false; },
    h => { h.context.hasPendingMessages = () => true; },
    h => { h.context.isProjectTrusted = () => false; },
    h => { h.context.sessionManager.getSessionFile = () => undefined; },
    h => { latest(h).tasks[1].outcomeUnknown = true; },
    h => emitExtensionEvent(h, "tool_execution_start", { toolCallId: "unfinished", toolName: "external", args: {} }),
  ]) {
    await withTempDirectory(async cwd => {
      const h = await fixture(cwd);
      await change(h);
      let calls = 0;
      h.context.newSession = async () => { calls++; return { cancelled: false }; };
      await h.commands.get("pi-init").handler("workflow fresh", h.context);
      assert.equal(calls, 0);
      assert.equal(latest(h).pauseReason, undefined);
      await emitExtensionEvent(h, "session_shutdown");
    });
  }
});

test("oversized capsules are rejected intact without freezing or truncating the plan", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    latest(h).plan.constraints.push("x".repeat(SESSION_HANDOFF_MAX_BYTES));
    const before = structuredClone(latest(h));
    assert.throws(() => buildSessionHandoff(before, h.branch), /32 KiB/);
    let calls = 0;
    h.context.newSession = async () => { calls++; return { cancelled: false }; };
    await h.commands.get("pi-init").handler("workflow fresh", h.context);
    assert.equal(calls, 0);
    assert.deepEqual(latest(h), before);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("target activation is idempotent and can be explicitly retried without another session creation", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    h.context.newSession = options => replaceSession(h, options, { skipActivate: true });
    await h.commands.get("pi-init").handler("workflow fresh", h.context);
    const target = h.target;
    let replacements = 0;
    target.context.newSession = async () => { replacements++; return { cancelled: false }; };
    await target.commands.get("pi-init").handler("workflow fresh", target.context);
    assert.equal(latest(target).currentTaskId, "second");
    const record = target.branch.find(e => e.customType === "pi-init-session-handoff" && e.data.kind === "incoming").data;
    await emitExtensionEvent(target, "message_end", { message: { role: "custom", customType: "pi-init-session-handoff-activate", content: "", details: { id: record.id, hash: record.packetHash } } });
    await target.commands.get("pi-init").handler("workflow fresh", target.context);
    assert.equal(replacements, 0);
    assert.equal(target.sentMessages.filter(e => e.message.customType === "pi-init-workflow-task").length, 1);
    await emitExtensionEvent(target, "session_shutdown");
  });
});

test("corrupted incoming packets never activate or create another owner", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    h.context.newSession = options => replaceSession(h, options, { corruptPacket: true });
    await h.commands.get("pi-init").handler("workflow fresh", h.context);
    const target = h.target;
    assert.equal(latest(target).pauseReason, "session-handoff-imported");
    assert.equal(target.sentMessages.filter(e => e.message.customType === "pi-init-workflow-task").length, 0);
    assert.equal(latest(h).pauseReason, "session-transfer-pending");
    await emitExtensionEvent(target, "session_shutdown");
  });
});

test("a partial target write is recoverable in that target without recreating a session or using stale APIs", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    h.context.newSession = options => replaceSession(h, options, { failWorkflowWrite: true });
    await h.commands.get("pi-init").handler("workflow fresh", h.context);
    const target = h.target;
    assert.ok(target);
    assert.equal(target.branch.some(e => e.customType === "pi-init-workflow"), false);
    await target.commands.get("pi-init").handler("workflow fresh", target.context);
    assert.equal(latest(target).currentTaskId, "second");
    assert.equal(latest(target).tasks[0].status, "completed");
    assert.equal(target.sentMessages.filter(e => e.message.customType === "pi-init-workflow-task").length, 1);
    await emitExtensionEvent(target, "session_shutdown");
  });
});

test("an old source branch remains locked by the session-wide transfer intent", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    const previous = structuredClone(latest(h));
    h.context.newSession = async () => { throw new Error("switch outcome unknown"); };
    await h.commands.get("pi-init").handler("workflow fresh", h.context);
    h.branch.splice(0, h.branch.length, { type: "custom", id: "older-branch", customType: "pi-init-workflow", data: previous });
    await emitExtensionEvent(h, "session_tree", { oldLeafId: "current", newLeafId: "older-branch" });
    assert.equal(latest(h).pauseReason, "session-transfer-pending");
    await h.commands.get("pi-init").handler("workflow resume", h.context);
    assert.equal(latest(h).pauseReason, "session-transfer-pending");
    assert.equal(h.sentMessages.filter(e => e.message.customType === "pi-init-workflow-task").length, 1);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("source preparation failure never creates a target and does not unlock uncertain ownership", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    const append = h.manager.appendCustomEntry.bind(h.manager);
    h.manager.appendCustomEntry = (type, data) => { if (type === "pi-init-workflow" && data.pauseReason === "session-transfer-pending") throw new Error("disk full"); return append(type, data); };
    let calls = 0;
    h.context.newSession = async () => { calls++; return { cancelled: false }; };
    await h.commands.get("pi-init").handler("workflow fresh", h.context);
    await h.commands.get("pi-init").handler("workflow resume", h.context);
    assert.equal(calls, 0);
    assert.equal(h.sentMessages.filter(e => e.message.customType === "pi-init-workflow-task").length, 1);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("source file identity is verified before freezing or replacing anything", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    const other = SessionManager.create(cwd, path.join(cwd, "sessions"));
    other.appendMessage({ role: "user", content: "unrelated", timestamp: Date.now() });
    h.context.sessionManager.getSessionFile = () => other.getSessionFile();
    let calls = 0;
    h.context.newSession = async () => { calls++; return { cancelled: false }; };
    await h.commands.get("pi-init").handler("workflow fresh", h.context);
    assert.equal(calls, 0);
    assert.equal(latest(h).pauseReason, undefined);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("successive handoffs keep the original declared evidence read-only without copying old conversations", async () => {
  await withTempDirectory(async cwd => {
    const original = await fixture(cwd, { evidence: true, threeTasks: true });
    original.context.newSession = options => replaceSession(original, options);
    await original.commands.get("pi-init").handler("workflow fresh", original.context);
    const middle = original.target;
    middle.context.getContextUsage = () => ({ tokens: 90000, contextWindow: 100000, percent: 90 });
    await emitExtensionEvent(middle, "agent_start");
    await middle.tools.find(t => t.name === "task_workflow").execute("complete-second", { action: "complete", ...workflowMessageIdentity(middle), completionSummary: "第二项完成", implementationRationale: "复用原历史", verification: ["第二项定向验证通过"] }, undefined, undefined, middle.context);
    await emitExtensionEvent(middle, "agent_end");
    assert.equal(latest(middle).pauseReason, undefined);
    middle.context.newSession = options => replaceSession(middle, options);
    await middle.commands.get("pi-init").handler("workflow fresh", middle.context);
    const target = middle.target;
    assert.equal(latest(target).currentTaskId, "third");
    const status = await target.tools.find(t => t.name === "task_workflow").execute("history", { action: "status", evidenceIds: original.evidenceIds }, undefined, undefined, target.context);
    assert.equal(status.details.taskMemory.evidence[0].sourceSessionId, original.manager.getSessionId());
    assert.equal(status.details.taskMemory.evidence[0].historical, true);
    assert.equal(target.branch.some(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === "historical-check"), false);
    const unknown = await target.tools.find(t => t.name === "task_workflow").execute("undeclared", { action: "status", evidenceIds: ["unrelated-source"] }, undefined, undefined, target.context);
    assert.equal(unknown.details.taskMemory.status, "unavailable");
    await emitExtensionEvent(target, "session_shutdown");
  });
});

test("missing or empty source archives are never created or rewritten by preflight", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    const empty = path.join(cwd, "empty-session.jsonl");
    await writeFile(empty, "");
    h.context.sessionManager.getSessionFile = () => empty;
    let calls = 0;
    h.context.newSession = async () => { calls++; return { cancelled: false }; };
    await h.commands.get("pi-init").handler("workflow fresh", h.context);
    assert.equal(calls, 0);
    assert.equal(await readFile(empty, "utf8"), "");
    assert.equal(latest(h).pauseReason, undefined);
    await emitExtensionEvent(h, "session_shutdown");
  });
});




