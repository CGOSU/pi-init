import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskMemoryRuntime, TASK_MEMORY_ENTRY, TASK_MEMORY_MESSAGE, taskMemoryText } from "../extensions/task-memory-runtime.ts";
import { createRoleRecovery } from "../extensions/role-recovery.ts";
import { createRoleContextView } from "../extensions/role-context-view.ts";
import { createWorkflowToolBinding } from "../extensions/workflow-tool-binding.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowActions } from "../extensions/workflow-actions.ts";
import { createExtensionHarness, createWorkflowState, emitExtensionEvent, withTempDirectory } from "./helpers.js";
import { hydrateWorkflowState } from "../src/workflow.ts";

function fixture() {
  const handlers = new Map();
  const identity = { workflowId: "wf", planVersion: 0, sessionId: "session", recoveryGeneration: 0, taskId: "task", attemptId: "attempt", handoffId: "handoff" };
  const state = createExtensionRuntimeState();
  state.activeRole = { role: "developer-test", provider: "test", model: "model", thinkingLevel: "high" };
  state.workflowState = { version: 7, executor: "local", authority: "local", plan: { summary: "work", constraints: [] }, nudgeCount: 0, revisions: [], subworkflowHistory: [], createdAt: 0, updatedAt: 0, ...identity, status: "running", currentTaskId: "task", tasks: [{ id: "task", role: "developer-test", status: "in_progress" }], handoff: { ...identity, phase: "executing" } };
  let branch = [{ type: "custom_message", id: "anchor", customType: "pi-init-workflow-task", details: identity, content: "task", timestamp: "2026-01-01T00:00:00Z" }];
  let serial = 0, fail = false, stops = 0;
  const notices = [];
  const pi = { on(name, fn) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); }, sendMessage(message, options) {
    assert.equal(options.triggerTurn, false);
    branch.push({ type: "custom_message", id: "summary-" + (++serial), ...message });
  }, appendEntry(customType, data) {
    if (fail) throw new Error("disk failure");
    branch.push({ type: "custom", customType, data: structuredClone(data), id: "snapshot-" + (++serial), parentId: branch.at(-1)?.id });
  } };
  const ctx = { cwd: process.cwd(), isProjectTrusted: () => true, sessionManager: { getSessionId: () => "session", getBranch: () => branch, getEntry: id => branch.find(entry => entry.id === id) }, ui: { notify: (...args) => notices.push(args) } };
  const binding = createWorkflowToolBinding(pi, state);
  const runtime = createTaskMemoryRuntime(pi, state, binding, () => { stops++; });
  async function emit(name, event = {}) {
    let result;
    for (const fn of handlers.get(name) ?? []) result = await fn(event, ctx) ?? result;
    return result;
  }
  async function commit(text = "Tests 91 passed", isError = false) {
    const n = ++serial;
    const message = { role: "assistant", timestamp: n, provider: "test", model: "model", content: [{ type: "toolCall", id: "call-" + n, name: "bash", arguments: { command: "verify" } }] };
    await emit("before_provider_request"); await emit("message_start", { message });
    branch.push({ type: "message", id: "message-" + n, message });
    await emit("message_end", { message });
    const result = { role: "toolResult", toolCallId: "call-" + n, toolName: "bash", isError, content: [{ type: "text", text }], timestamp: n };
    branch.push({ type: "message", id: "result-" + n, message: result });
    const event = { type: "turn_end", outcome: "completed", message, messageEntryId: "message-" + n, toolResults: [result], toolResultEntryIds: ["result-" + n] };
    await emit("turn_end", event);
    return event;
  }
  return { pi, state, ctx, runtime, binding, identity, emit, commit, notices, get branch() { return branch; }, setBranch(value) { branch = value; }, setFail(value) { fail = value; }, get stops() { return stops; } };
}
function checkpoint(id) { return { step: "package", accomplished: [{ summary: "Historical test result", evidenceIds: [id] }], remaining: ["generate patch"], blockers: [], nextStep: "generate patch" }; }

test("real persisted results survive reload and can be read without replaying commands", async () => {
  const f = fixture(); const event = await f.commit();
  const before = f.branch.filter(entry => entry.customType === TASK_MEMORY_ENTRY).length;
  await f.emit("turn_end", event);
  assert.equal(f.branch.filter(entry => entry.customType === TASK_MEMORY_ENTRY).length, before);
  const memory = f.runtime.read(f.ctx).memory;
  assert.equal(memory.observations[0].outcome, "tool-ok");
  const restored = createTaskMemoryRuntime({ on() {}, appendEntry() { assert.fail("read must not persist or execute"); } }, f.state, f.binding);
  assert.match(restored.read(f.ctx, [memory.observations[0].id]).evidence[0].text, /91 passed/);
  assert.equal(f.state.workflowState.tasks[0].status, "in_progress");
});
test("a result persisted before the memory write can be recovered without executing it again", async () => {
  const f = fixture(); await f.commit();
  f.setBranch(f.branch.filter(entry => entry.customType !== TASK_MEMORY_ENTRY));
  const read = f.runtime.read(f.ctx);
  assert.equal(read.memory.observations.length, 1);
  assert.match(taskMemoryText(read), /91 passed/);
});
test("checkpoint rejects fake sources, stale revisions, old identities and recovery gates", async () => {
  const f = fixture(); await f.commit();
  const id = f.runtime.read(f.ctx).memory.observations[0].id;
  assert.throws(() => f.runtime.checkpoint(f.ctx, f.identity, checkpoint("fake"), 0), error => error.code === "TASK_MEMORY_SOURCE_MISSING");
  assert.throws(() => f.runtime.checkpoint(f.ctx, { ...f.identity, attemptId: "old" }, checkpoint(id), 0), error => error.code === "TASK_MEMORY_IDENTITY_INVALID");
  f.runtime.checkpoint(f.ctx, f.identity, checkpoint(id), 0);
  assert.throws(() => f.runtime.checkpoint(f.ctx, f.identity, checkpoint(id), 0), error => error.code === "TASK_MEMORY_REVISION_STALE");
  f.state.roleRecoveryPending = true;
  assert.throws(() => f.runtime.checkpoint(f.ctx, f.identity, checkpoint(id), 1), error => error.code === "TASK_MEMORY_IDENTITY_INVALID");
});
test("snapshot corruption and branch changes cannot revive unsupported evidence", async () => {
  const f = fixture(); await f.commit();
  const saved = f.branch.at(-1);
  saved.data.observations[0].summary = "fabricated success";
  assert.equal(f.runtime.read(f.ctx).status, "unavailable");
  f.setBranch([{ type: "custom", id: "other", customType: "unrelated", data: {} }]);
  assert.equal(f.runtime.read(f.ctx).memory.observations.length, 0);
  assert.throws(() => f.runtime.checkpoint(f.ctx, f.identity, checkpoint("fake"), 0), error => error.code === "TASK_MEMORY_IDENTITY_INVALID");
});
test("write failure never acknowledges progress or changes the original tool result", async () => {
  const f = fixture(); f.setFail(true); const event = await f.commit();
  assert.equal(event.toolResults[0].isError, false);
  assert.equal(f.runtime.read(f.ctx).status, "unavailable");
  assert.equal(f.stops, 1);
  assert.equal(f.branch.filter(entry => entry.customType === TASK_MEMORY_ENTRY).length, 0);
});
test("declared file hashes detect untracked changes without pretending to prove all test dependencies", async () => {
  const f = fixture(); const cwd = await mkdtemp(join(tmpdir(), "task-memory-")); f.ctx.cwd = cwd;
  try {
    await writeFile(join(cwd, "new.ts"), "first"); await f.commit();
    const id = f.runtime.read(f.ctx).memory.observations[0].id;
    f.runtime.checkpoint(f.ctx, f.identity, checkpoint(id), 0, ["new.ts"]);
    assert.equal(f.runtime.read(f.ctx).applicability, "matches-checkpoint-files");
    await writeFile(join(cwd, "new.ts"), "second");
    assert.equal(f.runtime.read(f.ctx).applicability, "changed");
    assert.match(f.runtime.read(f.ctx, [id]).evidence[0].text, /91 passed/);
    assert.throws(() => f.runtime.checkpoint(f.ctx, f.identity, checkpoint(id), 1, ["../outside"]));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
test("long success and failure summaries remain bounded and checkpoint references remain readable", async () => {
  const f = fixture(); await f.commit("old failure".repeat(3000), true); await f.commit("x".repeat(6000) + " Tests 91 passed");
  const view = f.runtime.read(f.ctx); assert.equal(view.status, "available");
  assert.ok(view.memory.observations.every(item => item.summary.length <= 1024));
  const id = view.memory.observations.at(-1).id;
  f.runtime.checkpoint(f.ctx, f.identity, checkpoint(id), 0);
  for (let i = 0; i < 20; i++) await f.commit("status unchanged");
  assert.ok(f.runtime.read(f.ctx).memory.observations.some(item => item.id === id));
  assert.match(f.runtime.read(f.ctx, [id]).evidence[0].text, /91 passed/);
});

test("task_workflow checkpoint persists progress and status reads evidence without completing or dispatching", async () => {
  const f = fixture(); await f.commit();
  const id = f.runtime.read(f.ctx).memory.observations[0].id;
  const actions = createWorkflowActions(f.state, { taskMemory: f.runtime, dispatch: {}, report: { formatWorkflowState: () => "task running" }, roleRuntime: { activeRoleFor: () => f.state.activeRole }, coordination: { status: () => undefined } });
  const result = await actions.runTaskWorkflowAction({ ...f.identity, action: "checkpoint", checkpoint: checkpoint(id), expectedMemoryRevision: 0 }, undefined, f.ctx);
  assert.equal(result.details.taskMemory.memory.revision, 1);
  assert.equal(result.terminate, undefined);
  const status = await actions.runTaskWorkflowAction({ action: "status", evidenceIds: [id] }, undefined, f.ctx);
  assert.match(status.content[0].text, /91 passed/);
  assert.match(status.content[0].text, /generate patch/);
  assert.equal(f.state.workflowState.status, "running");
  assert.equal(f.state.workflowState.tasks[0].status, "in_progress");
});
test("rephrasing a checkpoint changes its write revision but not evidence progress", async () => {
  const f = fixture(); await f.commit(); const id = f.runtime.read(f.ctx).memory.observations[0].id;
  f.runtime.checkpoint(f.ctx, f.identity, checkpoint(id), 0);
  const first = f.runtime.read(f.ctx).memory;
  f.runtime.checkpoint(f.ctx, f.identity, { ...checkpoint(id), nextStep: "generate the same patch" }, first.revision);
  const next = f.runtime.read(f.ctx).memory;
  assert.equal(next.revision, first.revision + 1);
  assert.equal(next.progressRevision, first.progressRevision);
});
test("paused recovery can read historical memory without reviving the old handoff", async () => {
  const f = fixture(); await f.commit();
  f.state.workflowState.status = "paused";
  f.state.workflowState.recoveryGeneration++;
  delete f.state.workflowState.handoff;
  f.state.roleRecoveryPending = true;
  const view = f.runtime.read(f.ctx);
  assert.equal(view.status, "available");
  assert.match(taskMemoryText(view), /91 passed/);
  assert.throws(() => f.runtime.checkpoint(f.ctx, f.identity, checkpoint(view.memory.observations[0].id), 0), error => error.code === "TASK_MEMORY_IDENTITY_INVALID");
});

test("registered extension records SDK results and binds checkpoint without injecting live memory", async () => {
  await withTempDirectory(async cwd => {
    const workflow = createWorkflowState({ sessionId: "test-session", summary: "memory integration", tasks: [{ id: "first", role: "developer-test", task: "generate patch", files: ["patches/"], acceptanceCriteria: ["patch generated"] }] });
    const h = createExtensionHarness([{ type: "custom", customType: "pi-init-workflow", data: workflow }], { cwd, trusted: true, deferSendMessagePersistence: true });
    h.context.hasPendingMessages = () => false;
    try {
      await emitExtensionEvent(h, "session_start");
      await emitExtensionEvent(h, "agent_start");
      const sent = h.sentMessages.findLast(item => item.message.customType === "pi-init-workflow-task").message;
      const anchor = { role: "custom", customType: sent.customType, content: sent.content, details: sent.details, display: false, timestamp: 1 };
      await emitExtensionEvent(h, "message_start", { message: anchor });
      h.persistSentMessage(sent);
      await emitExtensionEvent(h, "before_provider_request");
      const message = { role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "verify", name: "bash", arguments: { command: "verify" } }] };
      await emitExtensionEvent(h, "message_start", { message });
      h.branch.push({ type: "message", id: "sdk-assistant", message });
      await emitExtensionEvent(h, "message_end", { message });
      const result = { role: "toolResult", toolName: "bash", toolCallId: "verify", isError: false, content: [{ type: "text", text: "Tests 91 passed" }], timestamp: 3 };
      h.branch.push({ type: "message", id: "sdk-result", message: result });
      await emitExtensionEvent(h, "turn_end", { type: "turn_end", outcome: "completed", message, messageEntryId: "sdk-assistant", toolResults: [result], toolResultEntryIds: ["sdk-result"] });
      assert.ok(h.branch.some(entry => entry.customType === TASK_MEMORY_ENTRY));
      const tool = h.tools.find(item => item.name === "task_workflow");
      const status = await tool.execute("status", { action: "status", evidenceIds: ["sdk-result"] }, undefined, undefined, h.context);
      assert.match(status.content[0].text, /91 passed/);
      const params = { action: "checkpoint", expectedMemoryRevision: 0, checkpoint: checkpoint("sdk-result") };
      await emitExtensionEvent(h, "before_provider_request");
      const checkpointMessage = { role: "assistant", timestamp: 4, content: [{ type: "toolCall", id: "save-memory", name: "task_workflow", arguments: params }] };
      await emitExtensionEvent(h, "message_start", { message: checkpointMessage });
      await emitExtensionEvent(h, "message_end", { message: checkpointMessage });
      const saved = await tool.execute("save-memory", params, undefined, undefined, h.context);
      assert.equal(saved.details.taskMemory.memory.revision, 1);
      let messages = [{ role: "user", content: "finish patch", timestamp: 0 }, anchor, message, result];
      for (const handler of h.handlers.get("context") ?? []) {
        const projected = await handler({ type: "context", messages }, h.context);
        if (projected?.messages) messages = projected.messages;
      }
      assert.equal(messages.filter(item => item.customType === TASK_MEMORY_MESSAGE).length, 0);
      assert.match(JSON.stringify(messages), /91 passed/);
      assert.match(JSON.stringify(messages), /generate patch/);
      assert.equal(h.branch.findLast(entry => entry.customType === "pi-init-workflow").data.tasks[0].status, "in_progress");
      const complete = { action: "complete", completionSummary: "patch produced", implementationRationale: "minimal change", verification: ["historical command result checked"], evidenceIds: ["sdk-result"] };
      await emitExtensionEvent(h, "before_provider_request");
      const finishMessage = { role: "assistant", timestamp: 5, content: [{ type: "toolCall", id: "complete-memory", name: "task_workflow", arguments: complete }] };
      await emitExtensionEvent(h, "message_start", { message: finishMessage });
      await emitExtensionEvent(h, "message_end", { message: finishMessage });
      await tool.execute("complete-memory", complete, undefined, undefined, h.context);
      const completed = h.branch.findLast(entry => entry.customType === "pi-init-workflow").data;
      assert.deepEqual(completed.tasks[0].verificationEvidenceIds, ["sdk-result"]);
      const restored = hydrateWorkflowState(completed);
      assert.equal(restored.ok, true);
      assert.deepEqual(restored.value.tasks[0].verificationEvidenceIds, ["sdk-result"]);
    } finally { await emitExtensionEvent(h, "session_shutdown"); }
  });
});

test("ordinary observations and checkpoints leave the model history prefix unchanged", async () => {
  const f = fixture();
  const recovery = createRoleRecovery(f.pi, f.state, undefined, undefined, f.runtime);
  await f.emit("before_agent_start"); // The initial handoff has no observations to restore.
  await f.commit();
  const messages = [{ role: "user", content: "work", timestamp: 0 },
    ...f.branch.filter(entry => entry.type === "message").map(entry => entry.message)];
  const prefix = structuredClone(messages);
  assert.equal(recovery.context({ type: "context", messages }, f.ctx), undefined);
  const id = f.runtime.read(f.ctx).memory.observations[0].id;
  f.runtime.checkpoint(f.ctx, f.identity, checkpoint(id), 0);
  await f.commit("new observation");
  assert.equal(await f.emit("before_agent_start"), undefined);
  assert.equal(recovery.context({ type: "context", messages }, f.ctx), undefined);
  assert.deepEqual(messages, prefix);
  assert.equal(f.branch.some(entry => entry.customType === TASK_MEMORY_MESSAGE), false);
  assert.match(f.runtime.read(f.ctx, [id]).evidence[0].text, /91 passed/);
});

test("recovery summaries are captured once per boundary, not refreshed by tool results", async () => {
  const f = fixture(); await f.commit();
  const summary = (await f.emit("before_agent_start")).message;
  assert.equal(summary.customType, TASK_MEMORY_MESSAGE);
  assert.match(summary.content, /91 passed/);
  const frozen = structuredClone(summary);
  await f.commit("later observation");
  assert.equal(await f.emit("before_agent_start"), undefined);
  assert.deepEqual(summary, frozen);
  await f.emit("session_compact");
  const compacted = f.branch.findLast(entry => entry.customType === TASK_MEMORY_MESSAGE);
  assert.match(compacted.content, /later observation/);
  assert.equal(await f.emit("before_agent_start"), undefined);
  await f.emit("session_tree");
  const restored = (await f.emit("before_agent_start")).message;
  assert.match(restored.content, /later observation/);
  assert.equal(await f.emit("before_agent_start"), undefined);
});

test("compacted paused views retain the persisted summary only after validating the workflow snapshot", async () => {
  const f = fixture(); await f.commit();
  f.state.workflowState.status = "paused";
  f.state.workflowState.recoveryGeneration++;
  delete f.state.workflowState.handoff;
  f.state.roleRecoveryPending = true;
  delete f.state.workflowState.currentTaskId;
  Object.assign(f.state.workflowState.tasks[0], {
    task: "generate patch", files: ["patches/"], acceptanceCriteria: ["patch generated"],
    status: "blocked", blockReason: "paused for recovery",
  });
  const saved = hydrateWorkflowState(f.state.workflowState);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  f.pi.appendEntry("pi-init-workflow", f.state.workflowState);
  const summary = { role: "custom", ...(await f.emit("before_agent_start")).message, timestamp: 10 };
  const user = { role: "user", content: "continue safely", timestamp: 11 };
  const messages = [summary, user]; // Compaction omitted the old handoff message.
  const view = createRoleContextView(f.state);
  const projected = view.context({ type: "context", messages }, f.ctx);
  assert.ok(projected.messages.includes(summary));
  assert.ok(projected.messages.includes(user));
  assert.equal(f.state.roleRecoveryPending, true);
  assert.equal(f.state.workflowState.handoff, undefined);
  f.state.workflowState.sessionId = "another-session";
  const rejected = view.context({ type: "context", messages }, f.ctx);
  assert.equal(rejected.messages.includes(summary), false);
  assert.ok(rejected.messages.includes(user));
});

test("paused recovery snapshots remain historical and corruption still stops execution", async () => {
  const f = fixture(); await f.commit();
  f.state.workflowState.status = "paused";
  f.state.workflowState.recoveryGeneration++;
  delete f.state.workflowState.handoff;
  f.state.roleRecoveryPending = true;
  const summary = (await f.emit("before_agent_start")).message;
  assert.match(summary.content, /91 passed/);
  const id = f.runtime.read(f.ctx).memory.observations[0].id;
  assert.throws(() => f.runtime.checkpoint(f.ctx, f.identity, checkpoint(id), 0), error => error.code === "TASK_MEMORY_IDENTITY_INVALID");
  f.branch.findLast(entry => entry.customType === TASK_MEMORY_ENTRY).data.observations[0].summary = "fabricated success";
  await f.emit("session_start");
  const invalid = (await f.emit("before_agent_start")).message;
  assert.doesNotMatch(invalid.content, /91 passed/);
  assert.equal(f.stops, 1);
});

test("a not-yet-persisted dispatch anchor does not cause a false recovery failure", async () => {
  const f = fixture();
  f.setBranch([]);
  assert.equal(await f.emit("before_agent_start"), undefined);
  assert.equal(f.stops, 0);
  f.setBranch([{ type: "custom_message", id: "anchor", customType: "pi-init-workflow-task", details: f.identity }]);
  await f.commit();
  assert.equal(await f.emit("before_agent_start"), undefined);
  assert.equal(f.stops, 0);
});

test("archived source IDs remain readable and can support a later checkpoint", async () => {
  const f = fixture(); await f.commit("Tests 91 passed");
  const id = f.runtime.read(f.ctx).memory.observations[0].id;
  for (let i = 0; i < 20; i++) await f.commit("later observation " + i);
  assert.equal(f.runtime.read(f.ctx).memory.observations.some(item => item.id === id), false);
  assert.match(f.runtime.read(f.ctx, [id]).evidence[0].text, /91 passed/);
  f.runtime.checkpoint(f.ctx, f.identity, checkpoint(id), 0);
  assert.ok(f.runtime.read(f.ctx).memory.observations.some(item => item.id === id));
});

test("another task or sibling branch cannot supply evidence to this checkpoint", async () => {
  const f = fixture(); await f.commit();
  f.branch.push({ type: "custom_message", id: "other-anchor", customType: "pi-init-workflow-task", details: { ...f.identity, taskId: "other" } });
  f.branch.push({ type: "message", id: "other-message", message: { role: "assistant", content: [{ type: "toolCall", id: "other-call", name: "bash", arguments: {} }] } });
  f.branch.push({ type: "message", id: "other-result", message: { role: "toolResult", toolCallId: "other-call", toolName: "bash", isError: false, content: [{ type: "text", text: "other task passed" }] } });
  assert.equal(f.runtime.read(f.ctx, ["other-result"]).reason, "TASK_MEMORY_SOURCE_MISSING");
  assert.throws(() => f.runtime.checkpoint(f.ctx, f.identity, checkpoint("other-result"), 0), error => error.code === "TASK_MEMORY_SOURCE_MISSING");
  const memorySnapshot = f.branch.find(entry => entry.customType === TASK_MEMORY_ENTRY);
  f.setBranch([f.branch[0], memorySnapshot]);
  assert.equal(f.runtime.read(f.ctx).status, "unavailable");
});
test("failed checkpoint write cannot return an ack or advance the saved revision", async () => {
  const f = fixture(); await f.commit(); const id = f.runtime.read(f.ctx).memory.observations[0].id;
  f.setFail(true);
  assert.throws(() => f.runtime.checkpoint(f.ctx, f.identity, checkpoint(id), 0), error => error.code === "TASK_MEMORY_WRITE_FAILED");
  assert.equal(f.branch.findLast(entry => entry.customType === TASK_MEMORY_ENTRY).data.revision, 0);
  assert.equal(f.stops, 1);
});

test("missing checkpoint revision is reported accurately with a usable revision", async () => {
  const f = fixture(); await f.commit(); const id = f.runtime.read(f.ctx).memory.observations[0].id;
  assert.throws(() => f.runtime.checkpoint(f.ctx, f.identity, checkpoint(id)), error => error.code === "TASK_MEMORY_REVISION_REQUIRED" && error.message.includes("expectedMemoryRevision=0"));
  assert.equal(f.runtime.read(f.ctx).memory.revision, 0);
  assert.match(taskMemoryText(f.runtime.read(f.ctx)), /expectedMemoryRevision=0/);
  f.runtime.checkpoint(f.ctx, f.identity, checkpoint(id), 0);
  assert.throws(() => f.runtime.checkpoint(f.ctx, f.identity, checkpoint(id), 0), error => error.code === "TASK_MEMORY_REVISION_STALE");
});

test("verification sources reject missing or failed receipts without claiming test semantics", async () => {
  const f = fixture(); await f.commit("command returned successfully"); const good = f.runtime.read(f.ctx).memory.observations[0].id;
  await f.commit("failed test", true); const bad = f.runtime.read(f.ctx).memory.observations.at(-1).id;
  assert.deepEqual(f.runtime.verificationSources(f.ctx, [good, good]), [good]);
  for (const ids of [[bad], ["fake"], []]) assert.throws(() => f.runtime.verificationSources(f.ctx, ids), error => error.code === "TASK_MEMORY_VERIFICATION_INVALID");
  assert.equal(f.state.workflowState.tasks[0].status, "in_progress");
});
test("only declared successful direct-dependency sources can be reused as historical observations", async () => {
  const f = fixture(); await f.commit(); const id = f.runtime.read(f.ctx).memory.observations[0].id;
  const previous = f.state.workflowState.tasks[0]; previous.status = "completed"; previous.verificationEvidenceIds = [id];
  f.state.workflowState.planVersion = 1;
  f.state.workflowState.currentTaskId = "next";
  f.state.workflowState.tasks.push({ id: "next", role: "developer-test", status: "in_progress", dependsOn: ["task"] });
  const current = { ...f.identity, taskId: "next", planVersion: 1, handoffId: "next-handoff", attemptId: "next-attempt" };
  f.state.workflowState.handoff = { ...current, phase: "executing" };
  f.branch.push({ type: "custom_message", id: "next-anchor", customType: "pi-init-workflow-task", details: current, content: "next" });
  const observed = f.runtime.read(f.ctx, [id]);
  assert.equal(observed.evidence[0].sourceTaskId, "task");
  assert.equal(observed.evidence[0].historical, true);
  assert.match(observed.evidence[0].text, /91 passed/);
  assert.throws(() => f.runtime.verificationSources(f.ctx, [id]), error => error.code === "TASK_MEMORY_VERIFICATION_INVALID");
  f.state.workflowState.tasks[1].dependsOn = [];
  assert.equal(f.runtime.read(f.ctx, [id]).status, "unavailable");
});
