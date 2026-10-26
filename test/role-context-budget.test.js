import assert from "node:assert/strict";
import test from "node:test";
import { boundContextWindow } from "../extensions/role-context-budget.ts";
import { createRoleRecovery } from "../extensions/role-recovery.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createTaskMemory, recordTaskObservations, checkpointTaskMemory } from "../src/task-memory.ts";
import { TASK_MEMORY_MESSAGE, taskMemoryText } from "../extensions/task-memory-runtime.ts";

function pair(index, text = "x".repeat(2000), isError = false) {
  return [{ role: "assistant", content: [{ type: "toolCall", id: "call-" + index, name: "bash", arguments: { command: "verify-" + index } }], timestamp: index },
    { role: "toolResult", toolCallId: "call-" + index, toolName: "bash", isError, content: [{ type: "text", text }], timestamp: index }];
}

test("long live task checkpoints old complete groups without changing user intent, current anchor or failure pairs", () => {
  const user = { role: "user", content: "Keep the confirmed contract", timestamp: 0 };
  const anchor = { role: "custom", customType: "pi-init-workflow-task", content: "task identity", details: { handoffId: "current" }, timestamp: 1 };
  const failed = pair(0, "failure", true);
  const messages = [user, anchor, ...failed, ...Array.from({ length: 30 }, (_, i) => pair(i + 1)).flat()];
  const original = structuredClone(messages);
  const result = boundContextWindow(messages, 18000);
  assert.equal(result.checkpointed, true);
  assert.ok(result.outputBytes <= 18000);
  for (const pinned of [user, anchor, ...failed, ...messages.slice(-2)]) assert.ok(result.messages.includes(pinned));
  const calls = result.messages.flatMap(message => message.role === "assistant" ? message.content.filter(part => part.type === "toolCall").map(part => part.id) : []);
  const results = result.messages.filter(message => message.role === "toolResult").map(message => message.toolCallId);
  assert.deepEqual([...calls].sort(), [...results].sort());
  const checkpoint = result.messages.find(message => message.customType === "pi-init-context-checkpoint");
  assert.match(checkpoint.content, /不.*重放/);
  assert.match(checkpoint.content, /verify-/);
  assert.deepEqual(messages, original);
});

test("unsafe pairing never masquerades as a successful bounded checkpoint", () => {
  const messages = [pair(1)[0], ...pair(2)];
  const result = boundContextWindow(messages, 100);
  assert.equal(result.checkpointed, false);
  assert.equal(result.overBudget, true);
  assert.equal(result.reason, "unsafe-tool-pairs");
  assert.equal(result.messages, messages);
});

test("oversized user requirements and latest output stay explicit, with byte rather than character accounting", () => {
  const user = { role: "user", content: "约束".repeat(1000), timestamp: 0 };
  const messages = [user, ...pair(1, "latest")];
  const result = boundContextWindow(messages, 1000);
  assert.equal(result.overBudget, true);
  assert.ok(result.messages.includes(user));
  assert.ok(result.outputBytes > 1000);
});

test("public recovery context applies budget and records degradation metadata, not source contents", () => {
  const state = createExtensionRuntimeState();
  const trace = [];
  state.traceHandoff = (_ctx, event, data) => trace.push({ event, data });
  const messages = [{ role: "user", content: "private-goal", timestamp: 0 }, ...Array.from({ length: 120 }, (_, i) => pair(i)).flat()];
  const recovery = createRoleRecovery({ on() {} }, state, event => ({ messages: event.messages }));
  const original = { roleRecoveryPending: state.roleRecoveryPending };
  const result = recovery.context({ type: "context", messages }, { model: { contextWindow: 16000 } });
  assert.ok(Buffer.byteLength(JSON.stringify(result.messages)) <= 24000);
  assert.equal(trace[0].event, "context.projected");
  assert.equal(trace[0].data.checkpointed, true);
  assert.ok(trace[0].data.inputBytes > trace[0].data.outputBytes);
  assert.equal(JSON.stringify(trace).includes("private-goal"), false);
  assert.equal(state.roleRecoveryPending, original.roleRecoveryPending);
});

test("oversized protected failures never starve successful work from a live task", () => {
  const user = { role: "user", content: "Generate patch after native tests", timestamp: 0 };
  const failed = pair(0, "old failure ".repeat(3000), true);
  const verified = pair(1, "Test Files 8 passed; Tests 91 passed; exit 0");
  const latest = pair(2, "Current checkout remains at the verified baseline");
  const messages = [user, ...failed, ...verified, ...latest];
  const result = boundContextWindow(messages, 18000);
  assert.equal(result.overBudget, true);
  assert.equal(result.reason, "protected-content-over-budget");
  for (const message of verified) assert.ok(result.messages.includes(message), "successful verification must not disappear behind oversized failure evidence");
  assert.equal(result.messages, messages);
  assert.equal(result.checkpointed, false);
});

test("public live-task context keeps successful results when protected evidence exceeds the soft budget", () => {
  const state = createExtensionRuntimeState();
  const observations = [];
  state.traceHandoff = (_ctx, event, data) => observations.push({ event, data });
  const verified = pair(1, "Tests 91 passed; exit 0");
  const messages = [{ role: "user", content: "finish patch", timestamp: 0 }, ...pair(0, "old error".repeat(30000), true), ...verified, ...pair(2, "latest read")];
  const recovery = createRoleRecovery({ on() {} }, state, event => ({ messages: event.messages }));
  const result = recovery.context({ type: "context", messages }, { model: { contextWindow: 500000 } });
  assert.equal(result.messages, messages);
  for (const message of verified) assert.ok(result.messages.includes(message));
  assert.equal(observations[0].data.overBudget, true);
  assert.equal(observations[0].data.checkpointed, false);
  assert.equal(observations[0].data.omittedMessages, 0);
  assert.equal(state.roleRecoveryPending, false);
});

function memoryFixture() {
  const identity = { workflowId: "workflow", planVersion: 0, sessionId: "session", recoveryGeneration: 0, taskId: "task", attemptId: "attempt", handoffId: "handoff" };
  let memory = recordTaskObservations(createTaskMemory(identity), [
    { id: "source-0", messageEntryId: "msg-0", toolCallId: "call-0", toolName: "bash", inputHash: "input-0", outputHash: "out-0", outcome: "tool-error", summary: "old failure", truncated: true },
    { id: "source-1", messageEntryId: "msg-1", toolCallId: "call-1", toolName: "bash", inputHash: "input-1", outputHash: "out-1", outcome: "tool-ok", summary: "Tests 91 passed", truncated: false },
  ], "source-1");
  memory = checkpointTaskMemory(memory, { step: "package", accomplished: [{ summary: "Historical verification: Tests 91 passed", evidenceIds: ["source-1"] }], remaining: ["generate patch"], blockers: [], nextStep: "generate patch" });
  return { read: () => ({ status: "available", memory, applicability: "historical" }), suspend() { assert.fail("bounded memory should not pause"); } };
}
function boundaryMessage() {
  const view = memoryFixture().read();
  return { role: "custom", customType: TASK_MEMORY_MESSAGE, content: taskMemoryText(view), display: false,
    details: { summarizedToolCallIds: view.memory.observations.map(item => item.toolCallId) }, timestamp: 1 };
}
test("one hundred projections retain the immutable recovery summary while archiving covered failure bodies", () => {
  const state = createExtensionRuntimeState();
  const memory = { read() { assert.fail("context must not refresh task memory"); }, suspend() { assert.fail("bounded memory should not pause"); } };
  const recovery = createRoleRecovery({ on() {} }, state, event => ({ messages: event.messages }), undefined, memory);
  const summary = boundaryMessage();
  let messages = [{ role: "user", content: "finish the patch", timestamp: 0 }, summary, ...pair(0, "old failure".repeat(6000), true), ...pair(1, "Tests 91 passed"), ...pair(2, "latest read")];
  for (let i = 0; i < 100; i++) {
    messages = recovery.context({ type: "context", messages }, { model: { contextWindow: 16000 } }).messages;
    assert.deepEqual(messages.filter(message => message.customType === TASK_MEMORY_MESSAGE), [summary]);
    assert.ok(messages.includes(summary), "the persisted boundary message is not regenerated");
    assert.match(JSON.stringify(messages), /Tests 91 passed/);
    assert.match(JSON.stringify(messages), /generate patch/);
    assert.ok(Buffer.byteLength(JSON.stringify(messages)) <= 24000);
    const calls = messages.flatMap(message => message.role === "assistant" ? message.content.filter(part => part.type === "toolCall").map(part => part.id) : []);
    assert.deepEqual(calls.sort(), messages.filter(message => message.role === "toolResult").map(message => message.toolCallId).sort());
  }
});
test("oversized persisted recovery memory pauses without dropping instructions or rereading history", () => {
  const state = createExtensionRuntimeState(); let pauses = 0;
  const memory = { read() { assert.fail("context must not refresh task memory"); }, suspend() { pauses++; } };
  const recovery = createRoleRecovery({ on() {} }, state, event => ({ messages: event.messages }), undefined, memory);
  const user = { role: "user", content: "user constraints".repeat(4000), timestamp: 0 };
  const summary = boundaryMessage();
  const result = recovery.context({ type: "context", messages: [user, summary, ...pair(2)] }, { model: { contextWindow: 16000 } });
  assert.equal(pauses, 1);
  assert.ok(result.messages.includes(user));
  assert.ok(result.messages.includes(summary));
});

test("live executing task uses SDK token budget instead of repeatedly discarding its own history", () => {
  const state = createExtensionRuntimeState();
  const fixture = memoryFixture();
  const stored = fixture.read().memory;
  const memory = { read: () => ({ status: "available", memory: { ...stored, checkpoint: undefined, revision: 0, progressRevision: 0 } }), suspend() { assert.fail("byte size is not token pressure"); } };
  const identity = stored.identity;
  const anchor = { type: "custom_message", id: "anchor", customType: "pi-init-workflow-task", details: identity, content: "current task" };
  state.activeRole = { role: "developer-test", provider: "test", model: "model", thinkingLevel: "high" };
  state.workflowState = { ...identity, status: "running", currentTaskId: identity.taskId, tasks: [{ id: identity.taskId, role: "developer-test", status: "in_progress" }], handoff: { ...identity, phase: "executing" } };
  const observations = [];
  state.traceHandoff = (_ctx, event, data) => observations.push({ event, data });
  let branch = [anchor];
  const ctx = { model: { contextWindow: 500000, maxTokens: 32000 }, getContextUsage: () => ({ tokens: 47386, contextWindow: 500000, percent: 9.4772 }), sessionManager: { getSessionId: () => identity.sessionId, getBranch: () => branch } };
  const recovery = createRoleRecovery({ on() {} }, state, event => ({ messages: event.messages }), undefined, memory);
  const source = [{ role: "user", content: "finish patch" }, ...Array.from({ length: 30 }, (_, i) => pair(i, "document content".repeat(1000))).flat()];
  source[1].content.unshift({ type: "thinking", thinking: "", thinkingSignature: "opaque".repeat(40000) });
  let messages = source;
  for (let i = 0; i < 100; i++) {
    messages = recovery.context({ type: "context", messages }, ctx).messages;
    for (const message of source) assert.ok(messages.includes(message), "successful work must survive without a voluntary checkpoint");
    assert.equal(messages.some(message => message.customType === "pi-init-context-checkpoint"), false);
  }
  assert.equal(observations.at(-1).data.reason, "sdk-token-budget");
  assert.equal(observations.at(-1).data.budgetBytes, null);
  assert.equal(observations.at(-1).data.omittedMessages, 0);
  ctx.getContextUsage = () => ({ tokens: 450000, contextWindow: 500000, percent: 90 });
  assert.equal(recovery.context({ type: "context", messages: source }, ctx).messages.includes(source[2]), true);
  branch = [];
  recovery.context({ type: "context", messages: source }, ctx);
  assert.notEqual(observations.at(-1).data.reason, "sdk-token-budget");
});
