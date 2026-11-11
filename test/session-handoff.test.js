import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createExtensionHarness, emitExtensionEvent } from "./support/extension-harness.js";
import { createWorkflowState, workflowMessageIdentity } from "./support/workflow-fixtures.js";
import { withTempDirectory } from "./support/temp-directory.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { handoffBoundary, resolveHandoffSnapshot, SESSION_HANDOFF_MAX_BYTES } from "../src/session-handoff.ts";
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
  h.context.sessionManager.getLeafId = () => manager.getLeafId();
  h.context.sessionManager.getEntries = () => manager.getEntries();
  h.context.getContextUsage = () => ({ tokens, contextWindow: 100000, percent: tokens / 1000 });
  h.manager = manager;
  h.context.ui.confirm = async () => true;
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
  await h.tools.find(t => t.name === "task_workflow").execute("complete-first", { action: "complete", ...workflowMessageIdentity(h), completionSummary: "第一项完成", implementationRationale: "复用既有模块", verification: [{ check: "fixture check", status: "passed", details: "定向测试通过" }], evidenceIds }, undefined, undefined, h.context);
  await emitExtensionEvent(h, "agent_end");
  // Expose the actual completed-task boundary before the next scheduler tick.
  // Manual fresh tests act here; capacity must no longer pause the scheduler.
  return h;
}
function latest(h) { return h.branch.findLast(e => e.customType === "pi-init-workflow").data; }
function enlargeWorkflow(h) {
  latest(h).plan.constraints.push("完整约束".repeat(23000));
  h.manager.appendCustomEntry("pi-init-workflow", latest(h));
}
async function completedNestedReadFailure(h, { complete = true, name = "read" } = {}) {
  const id = "handoff-read-group";
  const calls = ["types.go", "references.go", "classical.go"].map((file, index) => ({ id: id + "/" + (index + 1), name,
    arguments: { path: "core/singbox/resources/" + file }, status: index === 2 ? "error" : "ok", durationMs: 1,
    ...(index === 2 ? { error: "ENOENT: no such file or directory" } : {}),
  }));
  const input = { code: "await Promise.all(paths.map(path => tools.read({path})))" };
  h.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name: "codemode", arguments: input }], provider: "test", model: "model", api: "test", timestamp: Date.now(), stopReason: "toolUse", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  await emitExtensionEvent(h, "tool_execution_start", { toolCallId: id, toolName: "codemode", args: input });
  for (const call of calls) {
    await emitExtensionEvent(h, "tool_execution_start", { toolCallId: call.id, parentToolCallId: id, toolName: name, args: call.arguments });
    await emitExtensionEvent(h, "tool_result", { toolCallId: call.id, parentToolCallId: id, toolName: name, input: call.arguments, content: [], isError: call.status === "error" });
    await emitExtensionEvent(h, "tool_execution_end", { toolCallId: call.id, parentToolCallId: id, toolName: name, result: { content: [] }, isError: call.status === "error" });
  }
  const details = { calls: calls.map(({ arguments: args, ...call }) => ({ ...call, args: JSON.stringify(args) })) };
  const result = { role: "toolResult", toolCallId: id, toolName: "codemode", content: [{ type: "text", text: "ENOENT: no such file or directory" }], details, isError: true, timestamp: Date.now(), nestedCalls: { calls, complete } };
  await emitExtensionEvent(h, "tool_result", { ...result, input });
  await emitExtensionEvent(h, "tool_execution_end", { toolCallId: id, toolName: "codemode", result, isError: true });
  h.manager.appendMessage(result);
  h.branch.splice(0, h.branch.length, ...h.manager.getBranch());
}

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
  target.context.ui.confirm = async () => true;
  target.context.sessionManager.getSessionFile = () => manager.getSessionFile();
  target.context.sessionManager.getLeafId = () => manager.getLeafId();
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
    await h.commands.get("pi-init").handler("fresh", h.context);
    assert.equal(replacements, 1, JSON.stringify(h.notifications));
    const target = h.target;
    assert.ok(target);
    assert.equal(latest(target).sessionId, target.manager.getSessionId());
    assert.notEqual(latest(target).sessionId, h.manager.getSessionId());
    assert.equal(latest(target).workflowId, latest(h).workflowId);
    assert.equal(latest(target).tasks[0].status, "completed");
    assert.equal(latest(target).tasks[0].verification[0].sourceSessionId, h.manager.getSessionId());
    assert.equal(latest(target).tasks[0].verification[0].status, "passed");
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
    await assert.rejects(tools.execute("forged-verification", { action: "complete", ...workflowMessageIdentity(target), completionSummary: "不能冒充本次验证", implementationRationale: "历史来源只读", verification: [{ check: "fixture check", status: "passed", details: "历史" }], evidenceIds: h.evidenceIds }, undefined, undefined, target.context));
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
    enlargeWorkflow(h);
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
  for (const [change, reason] of [
    [h => { h.context.isIdle = () => false; }, /AGENT_BUSY/],
    [h => { h.context.hasPendingMessages = () => true; }, /MESSAGES_PENDING/],
    [h => { h.context.isProjectTrusted = () => false; }, /PROJECT_UNTRUSTED/],
    [h => { h.context.sessionManager.getSessionFile = () => undefined; }, /session未持久化/],
    [h => { latest(h).tasks[1].outcomeUnknown = true; }, /OUTCOME_UNKNOWN/],
    [h => emitExtensionEvent(h, "tool_execution_start", { toolCallId: "unfinished", toolName: "external", args: {} }), /TOOLS_UNSETTLED/],
  ]) {
    await withTempDirectory(async cwd => {
      const h = await fixture(cwd);
      await change(h);
      let calls = 0;
      h.context.newSession = async () => { calls++; return { cancelled: false }; };
      await h.commands.get("pi-init").handler("workflow fresh", h.context);
      assert.equal(calls, 0);
      assert.equal(latest(h).pauseReason, undefined);
      assert.match(h.notifications.at(-1).message, reason);
      await emitExtensionEvent(h, "session_shutdown");
    });
  }
});

test("large workflows transfer through a bounded manifest without truncating constraints or history", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    enlargeWorkflow(h);
    const before = structuredClone(latest(h));
    assert.ok(Buffer.byteLength(JSON.stringify(before)) >= 259576);
    h.context.newSession = options => replaceSession(h, options);
    await h.commands.get("pi-init").handler("workflow fresh", h.context);
    const target = h.target;
    assert.ok(target, JSON.stringify(h.notifications));
    assert.deepEqual(latest(target).plan, before.plan);
    assert.deepEqual(latest(target).revisions, before.revisions);
    const packet = target.branch.find(e => e.customType === "pi-init-session-handoff" && e.data.kind === "incoming").data.packet;
    assert.equal(packet.version, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= SESSION_HANDOFF_MAX_BYTES);
    assert.equal(packet.workflow, undefined);
    assert.equal(latest(target).currentTaskId, "second");
    assert.ok(target.sentMessages.find(e => e.message.customType === "pi-init-workflow-task").message.content.includes(before.plan.constraints[1]), "worker receives the full constraint");
    const seed = target.branch.find(e => e.type === "message" && e.message.role === "user").message.content;
    assert.ok(Buffer.byteLength(seed) <= SESSION_HANDOFF_MAX_BYTES);
    assert.match(seed, /完整.*快照/);
    await emitExtensionEvent(target, "session_shutdown");
  });
});

test("a settled known block can transfer without resuming or losing the original reason", async () => {
  for (const cancel of [false, true]) await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    await emitExtensionEvent(h, "agent_settled");
    await emitExtensionEvent(h, "agent_start");
    await h.tools.find(t => t.name === "task_workflow").execute("handoff-block", { action: "block", ...workflowMessageIdentity(h), reason: "用户要求停在这里交接；没有在途操作" }, undefined, undefined, h.context);
    await emitExtensionEvent(h, "agent_end");
    const before = structuredClone(latest(h));
    h.context.newSession = options => replaceSession(h, options, { cancel });
    await h.commands.get("pi-init").handler("fresh", h.context);
    const owner = cancel ? h : h.target;
    assert.ok(owner, JSON.stringify(h.notifications));
    assert.equal(latest(owner).status, "paused");
    assert.equal(latest(owner).pauseReason, "task-blocked");
    assert.equal(latest(owner).tasks[1].status, "blocked");
    assert.equal(latest(owner).tasks[1].blockReason, before.tasks[1].blockReason);
    if (!cancel) {
      assert.equal(owner.sentMessages.filter(e => e.message.customType === "pi-init-workflow-task").length, 0);
      let replacements = 0;
      owner.context.newSession = async () => { replacements++; return { cancelled: true }; };
      await owner.commands.get("pi-init").handler("fresh", owner.context);
      assert.equal(replacements, 0);
      assert.equal(latest(owner).tasks[1].status, "blocked");
    }
    await emitExtensionEvent(owner, "session_shutdown");
  });
});

test("handoff preparation distinguishes an active checkpoint from a blocked workflow needing role confirmation", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    await emitExtensionEvent(h, "agent_settled");
    await emitExtensionEvent(h, "agent_start");
    const sent = h.sentMessages.findLast(e => e.message.customType === "pi-init-workflow-task").message;
    const [anchor] = h.branch.splice(h.branch.findLastIndex(e => e.customType === "pi-init-workflow-task"), 1);
    await emitExtensionEvent(h, "message_start", { message: { role: "custom", ...sent, timestamp: Date.now() } });
    h.branch.push(anchor);
    const workflow = h.tools.find(t => t.name === "task_workflow");
    const checkpoint = { step: "保存未完成任务", accomplished: [], remaining: ["继续第二项"], blockers: [], nextStep: "确认交接后继续" };
    await workflow.execute("save-progress", { action: "checkpoint", ...workflowMessageIdentity(h), expectedMemoryRevision: 0, checkpoint }, undefined, undefined, h.context);
    await emitExtensionEvent(h, "agent_end");
    h.context.newSession = options => replaceSession(h, options);
    await h.commands.get("pi-init").handler("fresh", h.context);
    assert.equal(h.target, undefined);
    assert.match(h.notifications.at(-1).message, /ACTIVE_TASK.*checkpoint.*block/);
    assert.equal(latest(h).tasks[1].status, "in_progress");

    await emitExtensionEvent(h, "agent_start");
    await workflow.execute("handoff-block", { action: "block", ...workflowMessageIdentity(h), reason: "用户要求暂停未完成任务以准备交接" }, undefined, undefined, h.context);
    await emitExtensionEvent(h, "agent_end");
    await emitExtensionEvent(h, "session_start", { reason: "reload" });
    const blocked = structuredClone(latest(h));
    await h.commands.get("pi-init").handler("fresh", h.context);
    assert.equal(h.target, undefined);
    assert.match(h.notifications.at(-1).message, /ROLE_RECOVERY_PENDING.*switch_role.*不.*retry/);
    assert.deepEqual(latest(h), blocked, "a rejected handoff must preserve the business pause");

    const dispatched = h.sentMessages.filter(e => e.message.customType === "pi-init-workflow-task").length;
    await h.tools.find(t => t.name === "switch_role").execute("confirm-role", { role: "developer-test" }, undefined, undefined, h.context);
    await h.commands.get("pi-init").handler("fresh", h.context);
    assert.ok(h.target, JSON.stringify(h.notifications));
    assert.equal(h.sentMessages.filter(e => e.message.customType === "pi-init-workflow-task").length, dispatched);
    assert.equal(latest(h.target).pauseReason, "task-blocked");
    assert.equal(latest(h.target).tasks[1].status, "blocked");
    assert.deepEqual(latest(h.target).tasks[1], blocked.tasks[1]);
    assert.equal(h.target.sentMessages.filter(e => e.message.customType === "pi-init-workflow-task").length, 0);
    await emitExtensionEvent(h.target, "session_shutdown");
  });
});

test("large handoffs deliver unfinished checkpoints or an exact retrievable source without forging current memory", async () => {
  for (const oversized of [false, true]) await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    enlargeWorkflow(h);
    await emitExtensionEvent(h, "agent_settled");
    await emitExtensionEvent(h, "agent_start");
    const sent = h.sentMessages.findLast(e => e.message.customType === "pi-init-workflow-task").message;
    const anchorIndex = h.branch.findLastIndex(e => e.customType === "pi-init-workflow-task");
    const [anchor] = h.branch.splice(anchorIndex, 1);
    await emitExtensionEvent(h, "message_start", { message: { role: "custom", ...sent, timestamp: Date.now() } });
    h.branch.push(anchor);
    const checkpoint = { step: "移交前已定位下一项", accomplished: [], blockers: [],
      remaining: oversized ? Array(32).fill("边界约束".repeat(100)) : ["完成仍待处理的定向修改"],
      nextStep: "从 resources/references.go 的真实缺口继续，不重跑此前调查" };
    await h.tools.find(t => t.name === "task_workflow").execute("save-progress", { action: "checkpoint", ...workflowMessageIdentity(h), expectedMemoryRevision: 0, checkpoint }, undefined, undefined, h.context);
    await h.tools.find(t => t.name === "task_workflow").execute("handoff-block", { action: "block", ...workflowMessageIdentity(h), reason: "用户要求在已保存进度处交接" }, undefined, undefined, h.context);
    await emitExtensionEvent(h, "agent_end");
    h.context.newSession = options => replaceSession(h, options);
    await h.commands.get("pi-init").handler("fresh", h.context);
    const target = h.target;
    assert.ok(target, JSON.stringify(h.notifications));
    const seed = target.branch.find(e => e.type === "message" && e.message.role === "user").message.content;
    const context = JSON.parse(seed.split("\n")[1]).context;
    assert.ok(Buffer.byteLength(seed) <= SESSION_HANDOFF_MAX_BYTES);
    assert.equal(target.branch.some(e => e.customType === "pi-init-task-memory"), false, "historical checkpoint must not acquire current attempt identity");
    assert.equal(latest(target).tasks[1].status, "blocked");
    const incoming = target.branch.find(e => e.customType === "pi-init-session-handoff" && e.data.kind === "incoming").data;
    const full = resolveHandoffSnapshot(incoming.packet, h.manager.getEntries());
    if (!oversized) {
      assert.deepEqual(context.checkpoints[0].checkpoint, checkpoint);
      assert.equal(context.checkpoints[0].sourceSessionId, h.manager.getSessionId());
      assert.equal(context.checkpoints[0].sourceFile, h.manager.getSessionFile());
      assert.equal(context.checkpoints[0].historical, true);
      assert.equal(context.deferredCheckpointCount, 0);
    } else {
      assert.equal(context.checkpoints.length, 0);
      assert.equal(context.deferredCheckpoints[0].nextStep, checkpoint.nextStep);
      assert.equal(context.deferredCheckpointCount, 1);
      assert.equal(context.snapshotSource.sourceFile, h.manager.getSessionFile());
      assert.equal(context.snapshotSource.id, incoming.packet.snapshot.id);
      assert.equal(context.snapshotSource.hash, incoming.packet.snapshot.hash);
      assert.deepEqual(full.context.checkpoints[context.deferredCheckpoints[0].index].checkpoint, checkpoint);
      assert.match(context.checkpointNotice, /正文未注入/);
    }
    // A later explicitly resumed attempt can be blocked again without losing old progress.
    await target.tools.find(t => t.name === "switch_role").execute("confirm", { role: "developer-test" }, undefined, undefined, target.context);
    await target.commands.get("pi-init").handler("workflow retry second", target.context);
    await emitExtensionEvent(target, "agent_start");
    await target.tools.find(t => t.name === "task_workflow").execute("block-again", { action: "block", ...workflowMessageIdentity(target), reason: "新的交接暂停" }, undefined, undefined, target.context);
    await emitExtensionEvent(target, "agent_end");
    target.context.newSession = options => replaceSession(target, options);
    await target.commands.get("pi-init").handler("fresh", target.context);
    assert.ok(target.target, JSON.stringify(target.notifications));
    const second = target.target.branch.find(e => e.customType === "pi-init-session-handoff" && e.data.kind === "incoming").data;
    assert.deepEqual(resolveHandoffSnapshot(second.packet, target.manager.getEntries()).context.checkpoints[0].checkpoint, checkpoint);
    await emitExtensionEvent(target.target, "session_shutdown");
  });
});

test("blocked fresh accepts a complete read-only codemode failure but keeps incomplete or effectful results frozen", async () => {
  for (const options of [{}, { complete: false }, { name: "write" }]) await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    await emitExtensionEvent(h, "agent_settled");
    await emitExtensionEvent(h, "agent_start");
    await completedNestedReadFailure(h, options);
    await h.tools.find(t => t.name === "task_workflow").execute("handoff-block", { action: "block", ...workflowMessageIdentity(h), reason: "用户要求停在这里交接" }, undefined, undefined, h.context);
    await emitExtensionEvent(h, "agent_end");
    h.context.newSession = args => replaceSession(h, args);
    await h.commands.get("pi-init").handler("fresh", h.context);
    const safe = !Object.keys(options).length;
    assert.equal(Boolean(h.target), safe, JSON.stringify(h.notifications));
    assert.equal(latest(h.target ?? h).tasks[1].status, "blocked");
    assert.equal(latest(h.target ?? h).tasks[1].outcomeUnknown, undefined);
    await emitExtensionEvent(h.target ?? h, "session_shutdown");
  });
});

test("known block handoff still rejects unknown outcomes and active delegated work", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    const state = structuredClone(latest(h));
    state.status = "paused"; state.pauseReason = "task-blocked";
    state.tasks[1].status = "blocked"; state.tasks[1].blockReason = "handoff";
    delete state.continuation;
    assert.equal(handoffBoundary(state), true);
    state.tasks[1].outcomeUnknown = true;
    assert.equal(handoffBoundary(state), false);
    delete state.tasks[1].outcomeUnknown;
    state.tasks[1].delegation = { status: "running" };
    assert.equal(handoffBoundary(state), false);
    await emitExtensionEvent(h, "session_shutdown");
  });
});

test("missing, tampered and duplicate large snapshots prevent activation and never create a second target", async () => {
  for (const corrupt of ["missing", "tampered", "duplicate"]) await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    enlargeWorkflow(h);
    h.context.newSession = options => replaceSession(h, options, { skipActivate: true });
    await h.commands.get("pi-init").handler("fresh", h.context);
    const target = h.target;
    assert.ok(target);
    const sourceFile = h.manager.getSessionFile();
    const original = await readFile(sourceFile, "utf8");
    let entries = original.trim().split("\n").map(line => JSON.parse(line));
    const snapshot = entries.find(e => e.customType === "pi-init-session-handoff" && e.data.kind === "snapshot");
    assert.ok(snapshot);
    if (corrupt === "missing") entries = entries.filter(e => e !== snapshot);
    if (corrupt === "tampered") snapshot.data.packet.workflow.plan.constraints[0] = "tampered";
    if (corrupt === "duplicate") entries.push({ ...snapshot, id: "duplicate-snapshot-entry" });
    await writeFile(sourceFile, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
    let replacements = 0;
    target.context.newSession = async () => { replacements++; return { cancelled: false }; };
    await target.commands.get("pi-init").handler("fresh", target.context);
    assert.equal(replacements, 0);
    assert.equal(latest(target).pauseReason, "session-handoff-imported");
    assert.equal(latest(h).pauseReason, "session-transfer-pending");
    assert.equal(target.sentMessages.filter(e => e.message.customType === "pi-init-workflow-task").length, 0);
    await writeFile(sourceFile, original);
    await target.commands.get("pi-init").handler("fresh", target.context);
    assert.equal(replacements, 0);
    assert.equal(latest(target).currentTaskId, "second");
    await emitExtensionEvent(target, "session_shutdown");
  });
});

test("a failed large snapshot write never creates a target or changes the source workflow", async () => {
  await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    enlargeWorkflow(h);
    const before = structuredClone(latest(h));
    const append = h.manager.appendCustomEntry.bind(h.manager);
    h.manager.appendCustomEntry = (type, data) => {
      if (type === "pi-init-session-handoff" && data.kind === "snapshot") throw new Error("snapshot disk full");
      return append(type, data);
    };
    h.context.newSession = () => assert.fail("snapshot was not saved");
    await h.commands.get("pi-init").handler("fresh", h.context);
    assert.deepEqual(latest(h), before);
    assert.equal(h.manager.getEntries().some(e => e.customType === "pi-init-session-handoff" && e.data.kind === "outgoing"), false);
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
    enlargeWorkflow(h);
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
    enlargeWorkflow(h);
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
    enlargeWorkflow(original);
    original.context.newSession = options => replaceSession(original, options);
    await original.commands.get("pi-init").handler("workflow fresh", original.context);
    const middle = original.target;
    middle.context.getContextUsage = () => ({ tokens: 90000, contextWindow: 100000, percent: 90 });
    await emitExtensionEvent(middle, "agent_start");
    await middle.tools.find(t => t.name === "task_workflow").execute("complete-second", { action: "complete", ...workflowMessageIdentity(middle), completionSummary: "第二项完成", implementationRationale: "复用原历史", verification: [{ check: "fixture check", status: "passed", details: "第二项定向验证通过" }] }, undefined, undefined, middle.context);
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

test("workflow preview cancellation or changing source state cannot freeze or replace the session", async () => {
  for (const mode of ["cancel", "stop", "branch"]) await withTempDirectory(async cwd => {
    const h = await fixture(cwd);
    h.context.ui.confirm = async () => {
      if (mode === "branch") h.manager.appendMessage({ role: "user", content: "new requirement", timestamp: Date.now() });
      if (mode === "stop") h.context.isProjectTrusted = () => false;
      return mode !== "cancel";
    };
    h.context.newSession = () => { throw new Error("must not replace changed source"); };
    await h.commands.get("pi-init").handler("fresh", h.context);
    assert.equal(latest(h).pauseReason, undefined);
    assert.equal(h.manager.getEntries().some(e => e.customType === "pi-init-session-handoff"), false);
    await emitExtensionEvent(h, "session_shutdown");
  });
});




