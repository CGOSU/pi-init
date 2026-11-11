import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowDelivery } from "../extensions/workflow-delivery.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowCompletionView } from "../extensions/workflow-completion-view.ts";
import { formatWorkflowCompletionSummaryText, formatWorkflowCompletionText, formatWorkflowCompletionTimingLines } from "../extensions/workflow-completion-renderer.ts";
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
      verification: [{ check: "fixture check", status: "passed", details: `pass ${id}` }, { check: "fixture check", status: "failed", details: `failure ${id}` }, { check: "fixture check", status: "not-run", details: `skipped ${id}` }]
    })),
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
      assert.equal(message.content, formatWorkflowCompletionSummaryText(createWorkflowCompletionView(f.state.workflowState)));
      assert.match(message.content, /2项验证失败/);
      assert.match(message.content, /2项验证未执行/);
    }
    assert.deepEqual(f.state.workflowState, before);
  }
});

test("默认工作流摘要有界，展开详情保留完整目标和逐项记录", () => {
  const f = fixture();
  const longGoal = "整体目标内容".repeat(20);
  const longResult = "最终结果内容".repeat(40);
  f.state.workflowState.plan.summary = longGoal;
  f.state.workflowState.tasks[1].completionSummary = longResult;
  const view = createWorkflowCompletionView(f.state.workflowState);
  const summary = formatWorkflowCompletionSummaryText(view);
  const lines = summary.split("\n");
  assert.equal(lines.length, 4);
  assert.ok(Array.from(lines[0]).length <= 80 + "工作流完成：".length + 1);
  assert.ok(Array.from(lines[1]).length <= 160 + "结果： · 任务 2/2".length + 1);
  assert.match(summary, /需注意：2项验证失败；2项验证未执行/);
  const details = formatWorkflowCompletionText(view);
  assert.ok(details.includes(longGoal));
  assert.ok(details.includes(longResult));
});

test("context preserves all users/system and whole completing call group plus suffix", () => {
  const f = fixture();
  f.controller.prepare("complete");
  const messages = [{ role: "system", content: "host" }, { role: "user", content: "goal" }, call("old"), result("old"),
    call("sibling", "complete"), result("sibling"), result("complete"), { role: "custom", content: "suffix" }];
  const before = structuredClone(messages);
  const out = f.emit("context_with_system", { messages }).messages;
  assert.deepEqual(out.slice(0, -1), [messages[0], messages[1], ...messages.slice(4)]);
  assert.ok(hasCompleteToolPairs(out.filter(m => m.role !== "system")));
  assert.match(out.at(-1).content, /Do not re-investigate/);
  assert.deepEqual(messages, before);
});

test("unsafe or missing call boundary keeps original context intact", () => {
  for (const messages of [[call("other"), result("other")], [call("complete", "missing"), result("complete")], [result("orphan"), call("complete"), result("complete")]]) {
    const f = fixture();
    f.controller.prepare("complete");
    const out = f.emit("context_with_system", { messages }).messages;
    // An orphan before a safe completing group may be removed, never introduced.
    if (messages[0].role !== "toolResult") assert.deepEqual(out.slice(0, -1), messages);
    else assert.ok(hasCompleteToolPairs(out));
  }
});

test("completion preserves assistant reports and supplements omitted timing exactly once", () => {
  for (const kind of ["normal", "timed", "empty", "error", "tool"]) {
    const f = fixture();
    f.controller.prepare("complete");
    const event = final(kind === "empty" ? "  " : kind === "timed"
      ? formatWorkflowCompletionSummaryText(createWorkflowCompletionView(f.state.workflowState)) : "Whole report");
    if (kind === "error") event.message.stopReason = "error";
    if (kind === "tool") event.message.content.push({ type: "toolCall", id: "x" });
    f.emit("message_end", event);
    f.emit("agent_settled");
    f.emit("agent_settled");
    f.controller.prepare("complete");
    f.emit("agent_settled");
    assert.equal(f.sent.length, kind === "timed" ? 0 : 1);
    if (kind === "normal") {
      const timing = formatWorkflowCompletionTimingLines(createWorkflowCompletionView(f.state.workflowState));
      for (const line of timing) assert.ok(f.sent[0][0].content.includes(line));
      assert.deepEqual(f.sent[0][1], { triggerTurn: false });
    }
  }
});

test("timing supplement uses recorded timestamps and active duration, not model claims", async () => {
  const f = fixture();
  Object.assign(f.state.workflowState, { startedAt: 1000, completedAt: 31000, pausedMilliseconds: 10000 });
  const timing = formatWorkflowCompletionTimingLines(createWorkflowCompletionView(f.state.workflowState));
  f.controller.prepare("complete");
  f.emit("message_end", final("All done. Total time: 30 seconds."));
  await f.emit("agent_settled");
  for (const line of timing) assert.ok(f.sent[0][0].content.includes(line));
  assert.match(f.sent[0][0].content, /总耗时：20 秒（不含暂停）/);
  assert.doesNotMatch(f.sent[0][0].content, /Result 1/);
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
  assert.match(f.notifications[0], /Result 2/);
});

test("flat cancelled work and unknown effects remain visible without replay", async () => {
  const f = fixture();
  f.state.workflowState.tasks.push({ id: "retired", task: "Cancelled work", status: "superseded",
    blockReason: "Cancelled: Needs review", outcomeUnknown: true });
  f.controller.prepare("complete");
  await f.emit("agent_settled");
  assert.match(f.sent[0][0].content, /1项阻塞记录待核对/);
  assert.match(f.sent[0][0].content, /1项任务结果未知，禁止重放/);
  const details = formatWorkflowCompletionText(createWorkflowCompletionView(f.state.workflowState));
  assert.match(details, /Cancelled/);
  assert.match(details, /Needs review/);
  assert.match(details, /副作用结果未知/);
});


test("model basis preserves full immutable evidence while fallback uses its concise projection", async () => {
  const f = fixture();
  const view = createWorkflowCompletionView(f.state.workflowState);
  const report = formatWorkflowCompletionText(view);
  const summary = formatWorkflowCompletionSummaryText(view);
  f.controller.prepare("complete");
  f.state.workflowState.tasks[0].completionSummary = "Later mutation";
  const basis = f.emit("context_with_system", { messages: [] }).messages.at(-1).content;
  assert.ok(basis.endsWith(report));
  await f.emit("agent_settled");
  assert.equal(f.sent[0][0].content, summary);
  assert.doesNotMatch(report, /Later mutation/);
  assert.match(report, /未记录的验证、提交及推送状态均未知/);
  assert.match(report, /不会自动续跑或重放/);
});
