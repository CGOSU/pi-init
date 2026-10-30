import assert from "node:assert/strict";
import test from "node:test";
import { evaluateContextCapacity, registerContextCapacity } from "../extensions/role-context-capacity.ts";
import { createSessionHandoff } from "../extensions/session-handoff.ts";
import { createWorkflowState } from "../src/workflow.ts";

const model = (contextWindow, api = "openai-responses") => ({ provider: "test", id: String(contextWindow), contextWindow, api });

function reminderHarness(workflow = false) {
  const handlers = new Map();
  const notices = [];
  const traces = [];
  let session = "session";
  const state = { traceHandoff: (_ctx, _event, value) => traces.push(value),
    workflowState: workflow ? { sessionId: session } : undefined };
  const ctx = { model: model(1000), sessionManager: { getSessionId: () => session },
    usage: { tokens: 700, contextWindow: 1000, percent: 70 },
    getContextUsage() { return this.usage; },
    ui: { setStatus() {}, notify: (...args) => notices.push(args) } };
  registerContextCapacity({ on: (name, handler) => handlers.set(name, handler) }, state);
  const emit = (name, event = {}) => handlers.get(name)(event, ctx);
  const request = (percent = 70) => {
    ctx.usage = { tokens: percent * 10, contextWindow: 1000, percent };
    return emit("context_with_system", { messages: ["x".repeat(2000000)] });
  };
  return { ctx, state, notices, traces, emit, request, session: value => { session = value; } };
}

for (const workflow of [false, true]) {
  test(`${workflow ? "workflow" : "ordinary"} reminder crosses 70% once without returning a request mutation`, () => {
    const h = reminderHarness(workflow);
    assert.equal(h.request(69.9), undefined);
    assert.equal(h.notices.length, 0);
    assert.equal(h.traces.at(-1).status, "below-soft-threshold-estimate");
    assert.equal(h.request(), undefined);
    assert.equal(h.traces.at(-1).status, "soft-pressure");
    assert.equal(h.notices.length, 1);
    h.request(101);
    h.request(69.9);
    h.request();
    assert.equal(h.notices.length, 1);
  });
}

test("model identity and window changes invalidate observations and rearm reminders", () => {
  const h = reminderHarness();
  h.request();
  h.emit("model_select", { model: h.ctx.model });
  h.request();
  assert.equal(h.notices.length, 1);
  h.ctx.model = { ...h.ctx.model, contextWindow: 10000 };
  h.emit("model_select", { model: h.ctx.model });
  assert.equal(h.traces.at(-1).status, "unknown");
  h.request();
  assert.equal(h.notices.length, 1);
  h.ctx.model = { ...h.ctx.model, contextWindow: 1000 };
  h.request();
  assert.equal(h.notices.length, 2);
  h.ctx.model = { ...h.ctx.model, id: "other" };
  h.request();
  assert.equal(h.notices.length, 3);
  for (const target of [undefined, model(0), model(1000, "pi-virtual")]) {
    h.ctx.model = target;
    h.request();
    assert.equal(h.traces.at(-1).status, "unknown");
    assert.equal(h.notices.length, 3);
  }
});

test("compaction and session changes require a fresh projection and rearm a single reminder", () => {
  const h = reminderHarness();
  h.request();
  for (const event of ["session_compact", "session_start"]) {
    const count = h.notices.length;
    h.ctx.usage = { tokens: null, contextWindow: 1000, percent: null };
    h.emit(event);
    assert.equal(h.traces.at(-1).status, "unknown");
    assert.equal(h.notices.length, count);
    h.request(); h.request();
    assert.equal(h.notices.length, count + 1);
  }
  h.session("another-session");
  h.request();
  assert.equal(h.notices.length, 4);
});

test("trace and UI failures never block requests; disposed runtimes never notify", () => {
  const h = reminderHarness();
  h.state.traceHandoff = () => { throw new Error("trace unavailable"); };
  h.request();
  assert.equal(h.notices.length, 1);
  h.emit("session_compact");
  h.ctx.ui.notify = () => { throw new Error("UI unavailable"); };
  assert.doesNotThrow(h.request);
  h.ctx.ui.notify = () => assert.fail("disposed runtime notified");
  h.state.runtimeDisposed = true;
  h.request();
});

test("manual entry hints retain the existing safety gate and never pause scheduling", () => {
  const cases = [
    () => {},
    h => { h.state.agentRunActive = true; },
    h => { h.state.userStopRequested = true; },
    h => { h.state.roleRecoveryPending = {}; },
    h => { h.state.workflowState.tasks[0].outcomeUnknown = true; },
    h => { h.state.workflowState.currentTaskId = "second"; },
    h => { h.ctx.isProjectTrusted = () => false; },
    h => { h.ctx.hasPendingMessages = () => true; },
    h => { h.ctx.signal = { aborted: true }; },
    h => { h.settled = false; },
    h => { h.ctx.model = model(2000); },
    h => { h.emit("session_compact"); },
  ];
  for (const [index, change] of cases.entries()) {
    const h = reminderHarness(true);
    h.state.sessionRoleConfigOverrides = {};
    h.state.workflowState = createWorkflowState({ sessionId: "session", summary: "handoff", tasks:
      ["first", "second"].map(id => ({ id, role: "developer-test", task: id, files: ["src"], acceptanceCriteria: ["verified"] })) });
    h.state.workflowState.tasks[0].status = "completed";
    h.ctx.isProjectTrusted = () => true;
    h.ctx.isIdle = () => true;
    h.ctx.hasPendingMessages = () => false;
    h.ctx.sessionManager.getSessionFile = () => "/saved-session";
    h.ctx.sessionManager.getBranch = () => [];
    h.settled = true;
    const handoff = createSessionHandoff({ on() {} }, h.state, {
      persist: () => assert.fail("capacity paused or mutated workflow"),
      restore: () => assert.fail("capacity restored workflow"),
      schedule: () => assert.fail("capacity scheduled workflow"),
      toolsSettled: () => h.settled,
    });
    h.request();
    change(h);
    let hints = 0;
    h.ctx.ui.setStatus = () => hints++;
    assert.equal(handoff.beforeDispatch(h.ctx), false);
    assert.equal(hints, index === 0 ? 1 : 0, `safety case ${index}`);
    assert.equal(h.notices.length, 1);
  }
});

test("host percentage determines thresholds without additional reserves", () => {
  for (const [percent, status] of [[0, "below-soft-threshold-estimate"], [19.1, "below-soft-threshold-estimate"], [69.99, "below-soft-threshold-estimate"], [70, "soft-pressure"], [100, "soft-pressure"], [100.1, "estimated-overflow"]]) {
    const result = evaluateContextCapacity({ tokens: percent * 5000, percent, contextWindow: 500000 }, model(500000));
    assert.equal(result.percent, percent);
    assert.equal(result.status, status);
  }
});

test("unavailable usage, invalid percentages and mismatched windows never imply fit", () => {
  for (const target of [undefined, model(0), model(NaN), model(Infinity), model(100000, "pi-virtual")]) {
    assert.equal(evaluateContextCapacity(undefined, target).status, "unknown");
  }
  for (const percent of [null, undefined, NaN, Infinity, -1]) {
    assert.equal(evaluateContextCapacity({ tokens: null, contextWindow: 1000, percent }, model(1000)).status, "unknown");
  }
  assert.equal(evaluateContextCapacity({ tokens: 900, contextWindow: 1000, percent: 90 }, model(2000)).status, "unknown");
});

test("large image/signature payloads never override 19.1% host usage; transitions clear observations", () => {
  const handlers = new Map();
  const traces = [];
  const state = { traceHandoff: (_ctx, _event, data) => traces.push(data) };
  const ctx = { model: model(10000), sessionManager: { getSessionId: () => "session" },
    getContextUsage: () => ({ tokens: 1910, contextWindow: 10000, percent: 19.1 }), ui: { setStatus() {} } };
  registerContextCapacity({ on: (event, handler) => handlers.set(event, handler) }, state);
  const messages = [{ role: "toolResult", content: [{ type: "image", data: "x".repeat(2000000) }] },
    { role: "assistant", content: [{ type: "thinking", thinkingSignature: "y".repeat(2000000) }] }];
  const original = structuredClone(messages);
  const request = () => handlers.get("context_with_system")({ messages }, ctx);
  assert.equal(request(), undefined);
  assert.equal(traces.at(-1).scope, "ordinary");
  assert.equal(traces.at(-1).percent, 19.1);
  assert.equal(traces.at(-1).status, "below-soft-threshold-estimate");
  state.workflowState = { sessionId: "session" };
  request();
  assert.equal(traces.at(-1).scope, "workflow");
  for (const status of ["completed", "cancelled"]) {
    state.workflowState.status = status;
    request();
    assert.equal(traces.at(-1).scope, "ordinary");
  }
  handlers.get("model_select")({ model: model(800) }, ctx);
  assert.equal(traces.at(-1).contextWindow, 800);
  assert.equal(traces.at(-1).status, "unknown");
  ctx.model = model(800);
  ctx.getContextUsage = () => ({ tokens: 880, contextWindow: 800, percent: 110 });
  request();
  assert.equal(traces.at(-1).status, "estimated-overflow");
  handlers.get("session_compact")({}, ctx);
  assert.equal(traces.at(-1).status, "unknown");
  assert.equal(traces.at(-1).percent, null);
  request();
  assert.equal(traces.at(-1).status, "estimated-overflow");
  ctx.getContextUsage = () => undefined;
  handlers.get("session_start")({}, ctx);
  assert.equal(traces.at(-1).status, "unknown");
  ctx.getContextUsage = () => { throw new Error("usage unavailable"); };
  assert.doesNotThrow(request);
  assert.equal(traces.at(-1).status, "unknown");
  ctx.getContextUsage = () => ({ tokens: 80, contextWindow: 800, percent: 10 });
  handlers.get("agent_settled")({}, ctx);
  assert.equal(traces.at(-1).percent, 10);
  assert.deepEqual(messages, original);
  state.traceHandoff = () => { throw new Error("diagnostic unavailable"); };
  assert.doesNotThrow(request);
});
