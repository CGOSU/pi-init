import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createRoleRecovery, ROLE_RECOVERY_MESSAGE_TYPE } from "../extensions/role-recovery.ts";
import { createWorkflowDelivery } from "../extensions/workflow-delivery.ts";

function fixture() {
  const handlers = new Map();
  const errors = [];
  const state = createExtensionRuntimeState();
  const ctx = {
    model: { provider: "test", id: "test", contextWindow: 1000000 },
    sessionManager: { getSessionId: () => "system-history", getBranch: () => [] },
    ui: { notify() {} },
  };
  state.currentContext = ctx;
  const pi = {
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    appendEntry() { assert.fail("request projections must not persist session entries"); },
    sendMessage() { assert.fail("request projections must not dispatch messages"); },
  };
  const runner = new ExtensionRunner([{ path: "context-system-preservation", handlers }], {}, process.cwd(), ctx.sessionManager, {});
  runner.createContext = () => ctx;
  runner.onError(error => errors.push(error));
  return { state, ctx, pi, runner, errors };
}

const tool = (name, description = name) => ({ name, description, parameters: { type: "object", properties: {} } });
const assistant = text => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 1 });
function transcript() {
  return [
    { role: "system", content: "Stable host instructions", sections: { runtime: "recovering", stable: "unchanged", temporary: "remove later" },
      toolsAdded: [tool("read"), tool("write")], timestamp: 0 },
    { role: "user", content: "Original goal", timestamp: 1 },
    assistant("obsolete discussion"),
    { role: "system", content: "", sections: { runtime: "confirmed", temporary: null }, toolsRemoved: [{ name: "write" }], toolsAdded: [tool("inspect")], timestamp: 2 },
    { role: "user", content: "Current constraint", timestamp: 3 },
    assistant("current observation"),
    { role: "system", content: "", sections: { role: "developer-test" }, toolsRemoved: [{ name: "inspect" }], toolsAdded: [tool("read", "updated declaration")], timestamp: 4 },
    { role: "user", content: "Continue", timestamp: 5 },
  ];
}

function assertSystemHistory(before, after) {
  assert.deepEqual(after[0], before[0], "the initial instructions and declarations must remain the cached leading prefix");
  assert.deepEqual(after.filter(message => message.role === "system"), before.filter(message => message.role === "system"),
    "system deltas must retain their content, order, additions, removals and section deletions");
  assert.deepEqual(getCurrentSystemMessage(after), getCurrentSystemMessage(before), "the effective prompt and tool state must be unchanged");
  assert.deepEqual(getCurrentTools(after), [tool("read", "updated declaration")]);
  assert.equal(getCurrentSystemMessage(after).sections.temporary, undefined);
}

test("SDK recovery annotation preserves the existing system-history prefix", async () => {
  const f = fixture();
  f.state.roleRecoveryPending = true;
  createRoleRecovery(f.pi, f.state);
  const messages = transcript();
  messages.push({ role: "system", content: "", sections: { latest: "keep before the recovery notice" }, timestamp: 6 });
  const before = structuredClone(messages);
  const output = await f.runner.emitContext(messages);
  assertSystemHistory(before, output);
  assert.deepEqual(output.slice(0, -1), before);
  assert.equal(output.at(-1).customType, ROLE_RECOVERY_MESSAGE_TYPE);
  assert.deepEqual(messages, before, "the persisted source transcript must not be rewritten");
  assert.deepEqual(f.errors, []);
});

test("SDK ordered conversation projection preserves system-delta boundaries around surviving messages", async () => {
  const f = fixture();
  const summary = { role: "custom", customType: "test-summary", content: "Prior observations", timestamp: 0 };
  createRoleRecovery(f.pi, f.state, event => ({ messages: [summary, ...event.messages.filter(message =>
    !(message.role === "assistant" && message.content[0].text === "obsolete discussion"))] }));
  const messages = transcript();
  const before = structuredClone(messages);
  const output = await f.runner.emitContext(messages);
  assertSystemHistory(before, output);
  assert.deepEqual(output, [before[0], summary, before[1], ...before.slice(3)]);
  assert.deepEqual(messages, before);
  assert.deepEqual(f.errors, []);
});

test("SDK ordinary no-op context retains every system and conversation message", async () => {
  const f = fixture();
  createRoleRecovery(f.pi, f.state);
  const messages = transcript();
  const before = structuredClone(messages);
  const output = await f.runner.emitContext(messages);
  assert.deepEqual(output, before);
  assertSystemHistory(before, output);
  assert.deepEqual(messages, before);
  assert.deepEqual(f.errors, []);
});

test("SDK completion-report projection preserves tool declarations and system changes", async () => {
  const f = fixture();
  f.state.workflowState = {
    workflowId: "completed-workflow", sessionId: "system-history", planVersion: 1, recoveryGeneration: 0, status: "completed",
    plan: { summary: "Deliver the whole result", constraints: ["Keep the original instructions"] },
    tasks: [{ id: "task", task: "Implement the result", status: "completed", completionSummary: "Result ready",
      implementationRationale: "Local change", verification: [{ check: "fixture check", status: "passed", details: "Targeted check passed" }]
    }],
  };
  const delivery = createWorkflowDelivery(f.pi, f.state);
  delivery.prepare("complete");
  const messages = transcript();
  messages.splice(5, 1,
    { role: "assistant", content: [{ type: "toolCall", id: "complete", name: "task_workflow", arguments: { action: "complete" } }], timestamp: 3 },
    { role: "toolResult", toolCallId: "complete", toolName: "task_workflow", content: [{ type: "text", text: "Completed" }], isError: false, timestamp: 3 });
  const before = structuredClone(messages);
  const output = await f.runner.emitContext(messages);
  assertSystemHistory(before, output);
  assert.deepEqual(output.slice(0, -1), [before[0], before[1], ...before.slice(3)]);
  assert.equal(output.at(-1).customType, "pi-init-workflow-delivery-basis");
  assert.match(output.at(-1).content, /Result ready/);
  assert.deepEqual(messages, before);
  assert.deepEqual(f.errors, []);
});
