import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowDelivery } from "../extensions/workflow-delivery.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowCompletionView } from "../extensions/workflow-completion-view.ts";
import { formatWorkflowCompletionText } from "../extensions/workflow-completion-renderer.ts";
import { hasCompleteToolPairs } from "../extensions/role-context-protocol.ts";

function fixture(overrides = {}) {
  const hooks = new Map();
  const sent = [];
  const notifications = [];
  let aborted = 0;
  const ctx = { sessionManager: { getSessionId: () => "s" }, abort() { aborted++; }, ui: { notify(message) { notifications.push(message); } } };
  const state = createExtensionRuntimeState();
  state.currentContext = ctx;
  state.workflowState = {
    workflowId: "w", sessionId: "s", planVersion: 1, recoveryGeneration: 0, status: "completed",
    plan: { summary: "Whole goal", constraints: ["No unrelated edits"] },
    tasks: [1, 2].map(id => ({ id: String(id), task: `Task ${id}`, status: "completed",
      completionSummary: `Result ${id}`, implementationRationale: `Reason ${id}`,
      verification: [`pass ${id}`, `failure ${id}`, `skipped ${id}`] })),
  };
  const pi = { on(name, fn) { hooks.set(name, fn); }, sendMessage(...args) { sent.push(args); }, ...overrides };
  const controller = createWorkflowDelivery(pi, state);
  return { state, ctx, controller, sent, notifications, aborted: () => aborted,
    emit: (name, event = {}) => hooks.get(name)?.(event, ctx) };
}
const call = (...ids) => ({ role: "assistant", content: ids.map(id => ({ type: "toolCall", id, name: "workflow", arguments: {} })) });
const result = id => ({ role: "toolResult", toolCallId: id, content: [] });
const final = text => ({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });

test("root-only prepare and immutable whole-workflow evidence", () => {
  for (const condition of ["root", "running", "cancelled"]) {
    const f = fixture();
    if (condition === "running") f.state.workflowState.status = "running";
    if (condition === "cancelled") f.state.workflowState.status = "cancelled";
    const before = structuredClone(f.state.workflowState);
    f.controller.prepare("complete");
    f.emit("agent_settled");
    assert.equal(f.sent.length, condition === "root" ? 1 : 0);
    if (condition === "root") {
      const [message, options] = f.sent[0];
      assert.equal(message.display, true);
      assert.deepEqual(options, { triggerTurn: false });
      for (const text of ["Whole goal", "No unrelated edits", "Result 1", "Result 2", "Reason 1", "pass 1", "failure 1", "skipped 2"]) assert.ok(message.content.includes(text));
    }
    assert.deepEqual(f.state.workflowState, before);
  }
});

test("context preserves all users/system and whole completing call group plus suffix", () => {
  const f = fixture();
  f.controller.prepare("complete");
  const messages = [{ role: "system", content: "host" }, { role: "user", content: "goal" }, call("old"), result("old"),
    call("sibling", "complete"), result("sibling"), result("complete"), { role: "custom", content: "suffix" }];
  const before = structuredClone(messages);
  const out = f.emit("context", { messages }).messages;
  assert.deepEqual(out.slice(0, -1), [messages[0], messages[1], ...messages.slice(4)]);
  assert.ok(hasCompleteToolPairs(out.filter(m => m.role !== "system")));
  assert.match(out.at(-1).content, /Do not re-investigate/);
  assert.deepEqual(messages, before);
});

test("unsafe or missing call boundary keeps original context intact", () => {
  for (const messages of [[call("other"), result("other")], [call("complete", "missing"), result("complete")], [result("orphan"), call("complete"), result("complete")]]) {
    const f = fixture();
    f.controller.prepare("complete");
    const out = f.emit("context", { messages }).messages;
    // An orphan before a safe completing group may be removed, never introduced.
    if (messages[0].role !== "toolResult") assert.deepEqual(out.slice(0, -1), messages);
    else assert.ok(hasCompleteToolPairs(out));
  }
});

test("nonempty normal assistant stop delivers; empty/error/tool reports do not", () => {
  for (const kind of ["normal", "empty", "error", "tool"]) {
    const f = fixture();
    f.controller.prepare("complete");
    const event = final(kind === "empty" ? "  " : "Whole report");
    if (kind === "error") event.message.stopReason = "error";
    if (kind === "tool") event.message.content.push({ type: "toolCall", id: "x" });
    f.emit("message_end", event);
    f.emit("agent_settled");
    f.emit("agent_settled");
    f.controller.prepare("complete");
    f.emit("agent_settled");
    assert.equal(f.sent.length, kind === "normal" ? 0 : 1);
  }
});

test("real inputs and lifecycle clear but extension reminders/provider requests do not", () => {
  for (const event of ["input-user", "input-rpc", "input-extension", "agent_start", "session_start", "session_tree", "session_shutdown", "before_provider_request"]) {
    const f = fixture();
    f.controller.prepare("complete");
    if (event.startsWith("input-")) f.emit("input", { source: event === "input-user" ? "interactive" : event.slice(6) });
    else f.emit(event);
    f.emit("agent_settled");
    assert.equal(f.sent.length, ["input-extension", "before_provider_request"].includes(event) ? 1 : 0, event);
  }
});

test("receipt invalidates across identity and role/recovery generations", () => {
  for (const mutate of [f => f.state.workflowState.sessionId = "other", f => f.state.workflowState.workflowId = "other",
    f => f.state.workflowState.planVersion++, f => f.state.workflowState.recoveryGeneration++,
    f => f.state.roleContextGeneration++, f => f.state.roleTransitionGeneration++, f => f.state.roleRecoveryPending = true,
    f => f.state.activeRole = { role: "other" }]) {
    const f = fixture();
    f.controller.prepare("complete");
    mutate(f);
    f.emit("agent_settled");
    assert.equal(f.sent.length, 0);
  }
});

test("extra report-phase tools are blocked and aborted then fallback once without a turn", () => {
  const f = fixture();
  f.controller.prepare("complete");
  assert.equal(f.emit("tool_call", { toolName: "bash" }).block, true);
  assert.equal(f.aborted(), 1);
  f.emit("message_end", final("not accepted after abort"));
  f.emit("agent_settled");
  f.emit("agent_settled");
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0][1], { triggerTurn: false });
});

test("fallback dispatch rejection is observed once without false success or automatic retries", async () => {
  let attempts = 0;
  const f = fixture({ async sendMessage() { attempts++; throw new Error("private transport failure"); } });
  const events = [];
  f.state.traceHandoff = (_ctx, event) => events.push(event);
  f.controller.prepare("complete");
  await f.emit("agent_settled");
  await f.emit("agent_settled");
  assert.equal(attempts, 1);
  assert.ok(events.includes("workflow.delivery.fallback_failed"));
  assert.equal(events.includes("workflow.delivery.fallback_delivered"), false);
  assert.match(f.notifications[0], /Result 1/);
});

test("flat cancelled work and unknown effects remain visible without replay", async () => {
  const f = fixture();
  f.state.workflowState.tasks.push({ id: "retired", task: "Cancelled work", status: "superseded",
    blockReason: "Cancelled: Needs review", outcomeUnknown: true });
  f.controller.prepare("complete");
  await f.emit("agent_settled");
  assert.match(f.sent[0][0].content, /Cancelled/);
  assert.match(f.sent[0][0].content, /Needs review/);
  assert.match(f.sent[0][0].content, /副作用结果未知/);
});


test("model basis and fallback share the immutable completion renderer", async () => {
  const f = fixture();
  const report = formatWorkflowCompletionText(createWorkflowCompletionView(f.state.workflowState));
  f.controller.prepare("complete");
  f.state.workflowState.tasks[0].completionSummary = "Later mutation";
  const basis = f.emit("context", { messages: [] }).messages.at(-1).content;
  assert.ok(basis.endsWith(report));
  await f.emit("agent_settled");
  assert.equal(f.sent[0][0].content, report);
  assert.doesNotMatch(report, /Later mutation/);
  assert.match(report, /未记录的验证、提交及推送状态均未知/);
  assert.match(report, /不会自动续跑或重放/);
});
