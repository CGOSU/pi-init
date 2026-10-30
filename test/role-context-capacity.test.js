import assert from "node:assert/strict";
import test from "node:test";
import { estimateContextCapacity, registerContextCapacity } from "../extensions/role-context-capacity.ts";
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
    getContextUsage() { throw new Error("old usage read"); },
    ui: { setStatus() {}, notify: (...args) => notices.push(args) } };
  registerContextCapacity({ on: (name, handler) => handlers.set(name, handler) }, state);
  const emit = (name, event = {}) => handlers.get(name)(event, ctx);
  // JSON array/string overhead is four characters: 549 and 550 input tokens.
  const request = (characters = 2196) => emit("context_with_system", { messages: ["x".repeat(characters)] });
  return { ctx, state, notices, traces, emit, request, session: value => { session = value; } };
}

for (const workflow of [false, true]) {
  test(`${workflow ? "workflow" : "ordinary"} reminder crosses 70% once without returning a request mutation`, () => {
    const h = reminderHarness(workflow);
    assert.equal(h.request(2192), undefined);
    assert.equal(h.notices.length, 0);
    assert.equal(h.traces.at(-1).status, "below-soft-threshold-estimate");
    assert.equal(h.request(), undefined);
    assert.equal(h.traces.at(-1).status, "soft-pressure");
    assert.equal(h.notices.length, 1);
    h.request(5000);
    h.request(2192);
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

test("fresh projection is evaluated against the selected window, not old usage", () => {
  const messages = [{ role: "system", content: "x".repeat(3000) }];
  const large = estimateContextCapacity(messages, model(10000));
  const small = estimateContextCapacity(messages, model(800));
  assert.equal(large.status, "below-soft-threshold-estimate");
  assert.equal(small.status, "estimated-overflow");
  assert.equal(estimateContextCapacity(messages, model(1000)).status, "soft-pressure");
  assert.equal(small.hardLimit, "unknown");
  assert.equal(small.actualOutputReserve, null);
  assert.equal(small.policyOutputReserve, 80);
  assert.equal(small.policySafetyMargin, 40);
});

test("unknown models, invalid windows, virtual routes and unavailable projections never imply fit", () => {
  for (const target of [undefined, model(0), model(NaN), model(Infinity), model(100000, "pi-virtual")]) {
    const result = estimateContextCapacity([], target);
    assert.equal(result.status, "unknown");
    assert.equal(result.contextWindow, null);
  }
  assert.equal(estimateContextCapacity(undefined, model(1000)).status, "unknown");
  const cyclic = []; cyclic.push(cyclic);
  assert.equal(estimateContextCapacity(cyclic, model(1000)).estimatedInputTokens, null);
});

test("ordinary and workflow hooks observe system projection without mutating input or reading stale usage", () => {
  const handlers = new Map();
  const traces = [];
  const state = { traceHandoff: (_ctx, _event, data) => traces.push(data) };
  const ctx = { model: model(10000), sessionManager: { getSessionId: () => "session" },
    getContextUsage: () => { throw new Error("stale usage must not determine target capacity"); }, ui: { setStatus() {} } };
  registerContextCapacity({ on: (event, handler) => handlers.set(event, handler) }, state);
  const messages = [{ role: "system", content: "rules" }, { role: "user", content: "x".repeat(3000) }];
  const original = structuredClone(messages);
  const request = () => handlers.get("context_with_system")({ messages }, ctx);
  assert.equal(request(), undefined);
  assert.equal(traces.at(-1).scope, "ordinary");
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
  request();
  assert.equal(traces.at(-1).status, "estimated-overflow");
  handlers.get("session_compact")({}, ctx);
  assert.equal(traces.at(-1).status, "unknown");
  assert.equal(traces.at(-1).estimatedInputTokens, null);
  request();
  assert.equal(traces.at(-1).status, "estimated-overflow");
  handlers.get("session_start")({}, ctx);
  assert.equal(traces.at(-1).status, "unknown");
  assert.deepEqual(messages, original);
  state.traceHandoff = () => { throw new Error("diagnostic unavailable"); };
  assert.doesNotThrow(request);
});
