import assert from "node:assert/strict";
import test from "node:test";
import { boundContextWindow } from "../extensions/role-context-budget.ts";
import { createRoleRecovery } from "../extensions/role-recovery.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";

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
