import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { ROLE_RECOVERY_MESSAGE_TYPE } from "../extensions/role/role-recovery.ts";
import { createRoleContextPipeline } from "../extensions/role/role-context-pipeline.ts";
import { createRuntimeRoutingContext } from "../extensions/role/runtime-routing-context.ts";
import { createWorkflowDelivery } from "../extensions/workflow/workflow-delivery.ts";

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
  createRoleContextPipeline(f.pi, f.state);
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
  createRoleContextPipeline(f.pi, f.state, {
    contextView: event => ({ messages: [summary, ...event.messages.filter(message =>
      !(message.role === "assistant" && message.content[0].text === "obsolete discussion"))] }),
  });
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
  createRoleContextPipeline(f.pi, f.state);
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

function wrapSections(sections) {
  return Object.fromEntries(Object.entries(sections).filter(([, value]) => Boolean(value)).map(([name, value]) => [name, `<${name}>\n${value}\n</${name}>`]));
}

function diffSections(previous, current) {
  const patch = {};
  for (const [name, value] of Object.entries(current)) if (previous[name] !== value) patch[name] = value;
  for (const name of Object.keys(previous)) if (current[name] === undefined) patch[name] = null;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

test("SDK runtime routing preserves leading and historical system prefix across same-model role handoffs", async () => {
  const f = fixture();
  let thinking = "high";
  f.state.activeRole = { role: "developer-test", provider: f.ctx.model.provider, model: f.ctx.model.id, thinkingLevel: "high" };
  const routing = createRuntimeRoutingContext(f.state, {
    getActiveRole: () => f.state.activeRole,
    getThinkingLevel: () => thinking,
  });
  f.pi.on("context_with_system", routing.contextWithSystem);

  const event1 = { type: "before_agent_start", systemPromptOptions: { sections: {} } };
  routing.beforeAgentStart(event1, f.ctx);
  const messages = [
    { role: "system", content: "Stable host instructions", sections: wrapSections(event1.systemPromptOptions.sections), toolsAdded: [tool("read"), tool("edit")], timestamp: 0 },
    { role: "user", content: "Inspect bug", timestamp: 1 },
  ];
  const req1 = await f.runner.emitContext(messages);
  assert.deepEqual(req1, messages);

  // Switch role on the same model with a different thinking level (developer-test/high -> architect/max)
  messages.push(assistant("Switching to architect"));
  thinking = "max";
  f.state.activeRole = { role: "architect", provider: f.ctx.model.provider, model: f.ctx.model.id, thinkingLevel: "max" };
  const event2 = { type: "before_agent_start", systemPromptOptions: { sections: {} } };
  routing.beforeAgentStart(event2, f.ctx);
  const patch2 = diffSections(getCurrentSystemMessage(messages).sections, wrapSections(event2.systemPromptOptions.sections));
  assert.ok(patch2?.pi_init_runtime);
  messages.push(
    { role: "system", content: "", sections: patch2, timestamp: 2 },
    { role: "custom", customType: "pi-init-role-handoff", content: "handoff", display: false, timestamp: 3 },
  );
  const beforeReq2 = structuredClone(messages);
  const req2 = await f.runner.emitContext(messages);
  assert.deepEqual(req2, beforeReq2, "role handoff must not rewrite leading or historical system messages");
  assert.deepEqual(req2.slice(0, req1.length), req1, "all prior cached prefix messages must stay byte-identical");
  assert.match(getCurrentSystemMessage(req2).sections.pi_init_runtime, /当前职责：架构设计/);

  // Switch back (architect/max -> developer-test/high)
  messages.push(assistant("Back to implementation"));
  thinking = "high";
  f.state.activeRole = { role: "developer-test", provider: f.ctx.model.provider, model: f.ctx.model.id, thinkingLevel: "high" };
  const event3 = { type: "before_agent_start", systemPromptOptions: { sections: {} } };
  routing.beforeAgentStart(event3, f.ctx);
  const patch3 = diffSections(getCurrentSystemMessage(messages).sections, wrapSections(event3.systemPromptOptions.sections));
  messages.push(
    { role: "system", content: "", sections: patch3, timestamp: 4 },
    { role: "custom", customType: "pi-init-role-handoff", content: "handoff back", display: false, timestamp: 5 },
  );
  const req3 = await f.runner.emitContext(messages);
  assert.deepEqual(req3.slice(0, req2.length), req2, "switching back must keep the entire architect prefix intact");
  assert.match(getCurrentSystemMessage(req3).sections.pi_init_runtime, /当前职责：开发测试/);
  assert.deepEqual(f.errors, []);
});

test("SDK in-run runtime updates stay anchored without mutating messages[0] across follow-up turns", async () => {
  const f = fixture();
  f.state.roleRecoveryPending = true;
  f.state.activeRole = { role: "developer-test", provider: f.ctx.model.provider, model: f.ctx.model.id, thinkingLevel: "high" };
  const routing = createRuntimeRoutingContext(f.state, {
    getActiveRole: () => f.state.activeRole,
    getThinkingLevel: () => "high",
  });
  f.pi.on("context_with_system", routing.contextWithSystem);
  const event1 = { type: "before_agent_start", systemPromptOptions: { sections: {} } };
  routing.beforeAgentStart(event1, f.ctx);

  const messages = [
    { role: "system", content: "Stable host instructions", sections: wrapSections(event1.systemPromptOptions.sections), toolsAdded: [tool("read")], timestamp: 0 },
    { role: "user", content: "Continue", timestamp: 1 },
  ];
  const req1 = await f.runner.emitContext(messages);
  assert.deepEqual(req1, messages);

  // Same-run recovery confirmation (no before_agent_start)
  f.state.roleRecoveryPending = false;
  messages.push(
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "switch_role", arguments: { role: "developer-test" } }], timestamp: 2 },
    { role: "toolResult", toolCallId: "c1", toolName: "switch_role", content: [{ type: "text", text: "confirmed" }], isError: false, timestamp: 3 },
  );
  const req2 = await f.runner.emitContext(messages);
  assert.deepEqual(req2[0], req1[0], "leading system message must remain untouched");
  assert.deepEqual(req2.slice(0, messages.length), messages);
  assert.equal(req2.length, messages.length + 1);
  assert.equal(req2.at(-1).role, "system");
  assert.match(getCurrentSystemMessage(req2).sections.pi_init_runtime, /职责恢复：已确认/);

  // Follow-up turn in the same run keeps the delta anchored at index 4
  messages.push(
    { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "read", arguments: {} }], timestamp: 4 },
    { role: "toolResult", toolCallId: "c2", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 5 },
  );
  const req3 = await f.runner.emitContext(messages);
  assert.deepEqual(req3.slice(0, req2.length), req2, "in-run delta must stay anchored so follow-up turns preserve cache");
  assert.deepEqual(req3.slice(req2.length), messages.slice(4));

  // Second in-run state change appends a second anchored delta without moving the first
  f.state.userStopRequested = true;
  const req4 = await f.runner.emitContext(messages);
  assert.deepEqual(req4.slice(0, req3.length), req3);
  assert.equal(req4.length, req3.length + 1);
  assert.match(getCurrentSystemMessage(req4).sections.pi_init_runtime, /自动执行已暂停/);

  // Reverting the second state change before any new message pops the redundant tail delta
  f.state.userStopRequested = false;
  const req5 = await f.runner.emitContext(messages);
  assert.deepEqual(req5, req3);

  // Respect explicit removal of pi_init_runtime
  const removed = [...messages, { role: "system", content: "", sections: { pi_init_runtime: null }, timestamp: 6 }];
  assert.deepEqual(await f.runner.emitContext(removed), removed);
  assert.deepEqual(f.errors, []);
});
