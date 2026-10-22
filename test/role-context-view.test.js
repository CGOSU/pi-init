import assert from "node:assert/strict";
import test from "node:test";
import { createRoleContextView, ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE } from "../extensions/role-context-view.ts";
import { createRoleRecovery } from "../extensions/role-recovery.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowMessages } from "../extensions/workflow-messages.ts";
import {
  completeWorkflowTask,
  createWorkflowState,
  startWorkflowTask,
  workflowHandoffIdentity,
  workflowReplanIdentity,
  requestWorkflowReplan,
  ensureWorkflowReplanHandoff,
} from "../src/workflow.ts";
import { createExtensionHarness } from "./helpers.js";
import { blockWorkflowTask } from "../src/workflow.ts";
import { groupToolMessages, hasCompleteToolPairs } from "../extensions/role-context-protocol.ts";

test("paused recovery keeps the trusted task window and user goal without reviving the old authorization", () => {
  const { state, harness, handoffMessage } = makeWorkflowContextFixture();
  state.workflowState = blockWorkflowTask(state.workflowState, { taskId: "current", reason: "Need confirmed input behavior" }, 20);
  harness.branch.push({ type: "custom", id: "paused-source", customType: "pi-init-workflow", data: structuredClone(state.workflowState) });
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "unrelated ancient history" }], timestamp: 0 },
    { role: "user", content: "Original user goal: preserve caller errors", timestamp: 1 },
    ...Array.from({ length: 40 }, (_, index) => ({ role: "user", content: `Additional constraint ${index}`, timestamp: 2 + index })),
    handoffMessage,
    { role: "assistant", content: [{ type: "toolCall", id: "read-current-fact", name: "read", arguments: {} }], stopReason: "toolUse", timestamp: 43 },
    { role: "toolResult", toolCallId: "read-current-fact", toolName: "read", content: [{ type: "text", text: "Current verified caller fact" }], isError: false, timestamp: 44 },
    { role: "user", content: "Resume only after clarifying the blocker", timestamp: 45 },
  ];
  const original = structuredClone({ messages, branch: harness.branch, workflow: state.workflowState });
  state.roleRecoveryPending = true;
  const roleRecovery = createRoleRecovery({ on() {}, appendEntry() {} }, state, createRoleContextView(state).context);
  const result = roleRecovery.context({ type: "context", messages }, harness.context);
  assert.ok(result, "paused workflows still require a bounded recovery view while role recovery is pending");
  assert.equal(result.messages.some(message => message.content?.[0]?.text === "unrelated ancient history"), false);
  assert.ok(result.messages.some(message => message.content === "Original user goal: preserve caller errors"));
  assert.equal(result.messages.filter(message => typeof message.content === "string" && message.content.startsWith("Additional constraint")).length, 40);
  assert.ok(result.messages.some(message => message.role === "toolResult" && message.content[0].text === "Current verified caller fact"));
  assert.ok(result.messages.some(message => message.role === "assistant" && message.content[0].id === "read-current-fact"));
  assert.equal(result.messages.some(message => message.customType === "pi-init-workflow-task"), false);
  const recovery = result.messages.find(message => message.customType === "pi-init-workflow-paused-context");
  assert.ok(recovery);
  assert.match(recovery.content, /paused/);
  assert.match(recovery.content, /Need confirmed input behavior/);
  assert.match(recovery.content, /不是.*执行授权/);
  assert.equal(recovery.details.recoveryGeneration, state.workflowState.recoveryGeneration);
  assert.equal(recovery.details.attemptId, undefined);
  assert.equal(state.roleRecoveryPending, true);
  assert.deepEqual({ messages, branch: harness.branch, workflow: state.workflowState }, original);
});

test("paused recovery rejects stale snapshot identities and broken pairs with bounded diagnostics and an execution gate", () => {
  for (const failure of ["generation", "session", "snapshot-status", "snapshot-missing", "broken-pair"]) {
    const { state, harness, handoffMessage } = makeWorkflowContextFixture();
    state.workflowState = blockWorkflowTask(state.workflowState, { taskId: "current", reason: "Needs confirmation" }, 20);
    const source = structuredClone(state.workflowState);
    if (failure === "generation") source.recoveryGeneration -= 1;
    if (failure === "session") source.sessionId = "other-session";
    if (failure === "snapshot-status") source.status = "running";
    if (failure !== "snapshot-missing") harness.branch.push({ type: "custom", id: "paused-source", customType: "pi-init-workflow", data: source });
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "untrusted ancient history" }], timestamp: 0 },
      handoffMessage,
      ...(failure === "broken-pair" ? [{ role: "toolResult", toolCallId: "absent", toolName: "read", content: [], isError: true, timestamp: 21 }] : []),
      { role: "user", content: "Recover safely", timestamp: 22 },
    ];
    const branch = structuredClone(harness.branch);
    const result = createRoleContextView(state).context({ type: "context", messages }, harness.context);
    assert.ok(result, failure);
    assert.ok(result.messages.some(message => message.customType === ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE), failure);
    assert.equal(result.messages.some(message => message.customType === "pi-init-workflow-task"), false, failure);
    assert.equal(result.messages.some(message => message.content?.[0]?.text === "untrusted ancient history"), false, failure);
    assert.equal(state.roleRecoveryPending, false, "a context projection must not mutate role confirmation");
    assert.equal(state.workflowState.status, "paused", "workflow execution protection stays in force");
    assert.deepEqual(harness.branch, branch, failure);
  }
});

test("a first architecture-review pause can recover from its persisted snapshot without a historical task handoff", () => {
  const state = createExtensionRuntimeState();
  state.workflowState = createWorkflowState({ summary: "Review before execution", sessionId, reviewRequired: true, tasks: [{ id: "first", task: "First task", files: ["src/input.ts"], acceptanceCriteria: ["Reviewed"] }] }, 10);
  const harness = createExtensionHarness([], { sessionId });
  harness.branch.push({ type: "custom", id: "initial-review", customType: "pi-init-workflow", data: structuredClone(state.workflowState) });
  const result = createRoleContextView(state).context({ type: "context", messages: [{ role: "user", content: "Original review goal", timestamp: 1 }] }, harness.context);
  assert.ok(result);
  assert.match(result.messages.find(message => message.customType === "pi-init-workflow-paused-context").content, /architecture-review/);
  assert.equal(result.messages.some(message => message.customType === ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE), false);
});

const sessionId = "role-context-session";
const provider = "test-provider";
const model = "developer-model";

function makeWorkflow() {
  let workflow = createWorkflowState({
    summary: "Apply the confirmed input contract.",
    sessionId,
    constraints: ["Do not guess missing business rules."],
    tasks: [
      { id: "unrelated-a", task: "Unrelated completed work A", files: ["src/a.ts"], acceptanceCriteria: ["done"] },
      { id: "dependency", task: "Direct dependency", files: ["src/dependency.ts"], acceptanceCriteria: ["done"] },
      { id: "unrelated-b", task: "Unrelated completed work B", files: ["src/b.ts"], acceptanceCriteria: ["done"] },
      {
        id: "current",
        task: "Implement the current task.",
        dependsOn: ["dependency"],
        role: "developer-test",
        files: ["src/input.ts", "test/input.test.js"],
        acceptanceCriteria: ["Keep the confirmed error semantics."],
      },
      {
        id: "followup",
        task: "Continue using only required evidence.",
        dependsOn: ["current"],
        files: ["src/next.ts"],
        acceptanceCriteria: ["Keep the result traceable."],
      },
    ],
  }, 10);
  for (const taskId of ["unrelated-a", "dependency", "unrelated-b"]) {
    workflow = startWorkflowTask(workflow, taskId, 11);
    workflow = completeWorkflowTask(workflow, {
      taskId,
      completionSummary: `${taskId} completed result`,
      implementationRationale: `rationale for ${taskId}`,
      verification: [`node --test test/${taskId}.test.js → passed`],
    }, 12);
  }
  workflow = startWorkflowTask(workflow, "current", 13);
  workflow.handoff = { ...workflow.handoff, phase: "executing" };
  return workflow;
}

function makeWorkflowContextFixture() {
  const state = createExtensionRuntimeState();
  state.activeRole = { role: "developer-test", provider, model, thinkingLevel: "max" };
  state.workflowState = makeWorkflow();
  const harness = createExtensionHarness([], { sessionId });
  const identity = workflowHandoffIdentity(state.workflowState);
  harness.branch.push({ type: "custom_message", customType: "pi-init-workflow-task", details: identity });
  const handoffMessage = {
    role: "custom",
    customType: "pi-init-workflow-task",
    content: "current handoff package",
    details: identity,
    timestamp: 14,
  };
  return { state, harness, identity, handoffMessage };
}

function callContextHandler(state, harness, messages) {
  const handlers = new Map();
  const pi = { on(name, handler) { handlers.set(name, handler); } };
  const roleContextView = createRoleContextView(state);
  createRoleRecovery(pi, state, roleContextView.context);
  return handlers.get("context")({ type: "context", messages }, harness.context);
}

test("public context callback isolates the current role window while retaining new instructions, failures, and tool pairs", () => {
  const { state, harness, handoffMessage } = makeWorkflowContextFixture();
  const previousIdentity = {
    workflowId: "previous-workflow",
    planVersion: 0,
    sessionId,
    recoveryGeneration: 0,
    revisionId: "previous-revision",
    handoffId: "previous-handoff",
  };
  const previousMarker = {
    role: "custom",
    customType: "pi-init-workflow-replan",
    content: "previous handoff",
    details: previousIdentity,
    timestamp: 1,
  };
  harness.branch.unshift({ type: "custom_message", customType: previousMarker.customType, details: previousIdentity });
  const messages = [
    { role: "user", content: "old unrelated request", timestamp: 0 },
    previousMarker,
    { role: "user", content: "new instruction before handoff: preserve the caller error", timestamp: 2 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "previous-failed-call", name: "read", arguments: { path: "src/old.ts" } }],
      stopReason: "toolUse",
      timestamp: 3,
    },
    { role: "toolResult", toolCallId: "previous-failed-call", toolName: "read", content: [{ type: "text", text: "previous failure" }], isError: true, timestamp: 4 },
    handoffMessage,
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "current-call", name: "read", arguments: { path: "src/input.ts" } }],
      stopReason: "toolUse",
      timestamp: 15,
    },
    { role: "toolResult", toolCallId: "current-call", toolName: "read", content: [{ type: "text", text: "large current output" }], isError: true, timestamp: 16 },
    { role: "assistant", content: [{ type: "text", text: "Provider returned a real error." }], stopReason: "error", errorMessage: "provider failure", timestamp: 17 },
    { role: "user", content: "new instruction during current execution", timestamp: 18 },
  ];
  const originalMessages = structuredClone(messages);
  const originalBranch = structuredClone(harness.branch);
  const handlers = new Map();
  const pi = { on(name, handler) { handlers.set(name, handler); } };
  createRoleRecovery(pi, state, createRoleContextView(state).context);
  const result = handlers.get("context")({ type: "context", messages }, harness.context);

  assert.ok(result);
  assert.equal(result.messages.some((message) => message.content === "old unrelated request"), false);
  assert.ok(result.messages.some((message) => message.content === "new instruction before handoff: preserve the caller error"));
  assert.ok(result.messages.some((message) => message.content === "new instruction during current execution"));
  assert.ok(result.messages.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.id === "previous-failed-call")));
  assert.equal(result.messages.find((message) => message.role === "toolResult" && message.toolCallId === "previous-failed-call")?.content[0]?.text, "previous failure");
  assert.ok(result.messages.some((message) => message.role === "toolResult" && message.toolCallId === "previous-failed-call" && message.isError));
  assert.equal(result.messages.find((message) => message.role === "toolResult" && message.toolCallId === "current-call")?.content[0]?.text, "large current output");
  assert.ok(result.messages.some((message) => message.role === "toolResult" && message.toolCallId === "current-call" && message.isError));
  assert.ok(result.messages.some((message) => message.role === "assistant" && message.errorMessage === "provider failure"));
  assert.deepEqual(result.messages.find((message) => message.role === "assistant"
    && message.content.some((part) => part.type === "toolCall" && part.id === "current-call"))?.content[0],
  { type: "toolCall", id: "current-call", name: "read", arguments: { path: "src/input.ts" } });
  assert.deepEqual(messages, originalMessages, "the context hook must not mutate Pi's input array or session messages");
  assert.deepEqual(harness.branch, originalBranch, "context filtering must not rewrite branch entries");
  assert.equal(result.messages.some((message) => message.role === "system"), false,
    "Pi owns system/tool state; context receives only conversation messages");
});

test("unknown boundaries, damaged tool pairs, and system messages fail open with explicit diagnostics", () => {
  const { state, harness, handoffMessage } = makeWorkflowContextFixture();
  const ordinaryPrefix = [{ role: "user", content: "keep all input", timestamp: 1 }];
  const absentAnchor = callContextHandler(state, harness, ordinaryPrefix);
  assert.deepEqual(absentAnchor.messages.slice(0, ordinaryPrefix.length), ordinaryPrefix);
  assert.equal(absentAnchor.messages.at(-1).customType, ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE);
  assert.equal(absentAnchor.messages.at(-1).details.code, "ROLE_CONTEXT_VIEW_MESSAGE_BOUNDARY_UNAVAILABLE");

  const danglingTool = [handoffMessage, {
    role: "toolResult", toolCallId: "missing-call", toolName: "read", content: [], isError: false, timestamp: 1,
  }];
  const damagedPair = callContextHandler(state, harness, danglingTool);
  assert.deepEqual(damagedPair.messages.slice(0, danglingTool.length), danglingTool);
  assert.equal(damagedPair.messages.at(-1).details.code, "ROLE_CONTEXT_VIEW_TOOL_PAIR_UNSAFE");

  const systemInput = [{ role: "system", content: "Pi-managed prompt", timestamp: 0 }, handoffMessage];
  const systemResult = callContextHandler(state, harness, systemInput);
  assert.deepEqual(systemResult.messages.slice(0, systemInput.length), systemInput);
  assert.ok(systemResult.messages.some((message) => message.role === "system"));
  assert.equal(systemResult.messages.at(-1).details.code, "ROLE_CONTEXT_VIEW_SYSTEM_MESSAGE_PRESENT");

  const compactState = structuredClone(state);
  compactState.roleCompactionInFlight = true;
  const compactMessages = [handoffMessage];
  const compactResult = callContextHandler(compactState, harness, compactMessages);
  assert.deepEqual(compactResult.messages[0], handoffMessage);
  assert.equal(compactResult.messages.at(-1).details.code, "ROLE_CONTEXT_VIEW_COMPACTION_UNCERTAIN");

  const mismatchedSessionState = structuredClone(state);
  mismatchedSessionState.workflowState.sessionId = "other-session";
  const mismatchMessages = [{ role: "user", content: "keep the full forked history", timestamp: 1 }, handoffMessage];
  const mismatchResult = callContextHandler(mismatchedSessionState, harness, mismatchMessages);
  assert.deepEqual(mismatchResult.messages.slice(0, mismatchMessages.length), mismatchMessages);
  assert.equal(mismatchResult.messages.at(-1).details.code, "ROLE_CONTEXT_VIEW_SESSION_MISMATCH");
});

test("ordinary conversations and role-recovery requests keep their existing full context behavior", () => {
  const state = createExtensionRuntimeState();
  const harness = createExtensionHarness([], { sessionId });
  const messages = [{ role: "user", content: "ordinary microtask", timestamp: 1 }];
  assert.equal(createRoleContextView(state).context({ type: "context", messages }, harness.context), undefined);

  const { state: activeState, handoffMessage } = makeWorkflowContextFixture();
  activeState.roleRecoveryPending = true;
  assert.equal(createRoleContextView(activeState).context({ type: "context", messages: [handoffMessage] }, harness.context), undefined);
});

test("task handoff packages retain only direct dependency results", () => {
  const { state } = makeWorkflowContextFixture();
  const messages = createWorkflowMessages(state, {
    pi: { sendMessage() {} },
    setInternalContinuationPending() {},
    persistWorkflowState(next) { return next; },
  });
  const prompt = messages.workflowTaskPrompt("current");
  assert.match(prompt, /Apply the confirmed input contract/);
  assert.match(prompt, /dependency completed result/);
  assert.doesNotMatch(prompt, /Unrelated completed work A/);
  assert.doesNotMatch(prompt, /Unrelated completed work B/);

  let replanState = requestWorkflowReplan(state.workflowState, { direction: "continue only with traceable evidence" }, 14);
  replanState = completeWorkflowTask(replanState, {
    taskId: "current",
    completionSummary: "current completed result",
    implementationRationale: "finished before applying the new direction",
    verification: ["node --test test/current.test.js → passed"],
  }, 15);
  replanState = ensureWorkflowReplanHandoff(replanState);
  state.workflowState = replanState;
  const replanPrompt = messages.workflowReplanPrompt(workflowReplanIdentity(replanState));
  assert.match(replanPrompt, /current completed result/);
  assert.doesNotMatch(replanPrompt, /Unrelated completed work A/);
  assert.doesNotMatch(replanPrompt, /Unrelated completed work B/);

});
test("retired evidence actions are absent while task memory remains available", () => {
  const tool = createExtensionHarness().tools.find(tool => tool.name === "task_workflow");
  const schema = JSON.stringify(tool.parameters.properties.action);
  for (const action of ["request-evidence", "report-evidence", "review-evidence", "clarify", "review-child"]) assert.equal(schema.includes(action), false);
  assert.ok(tool.parameters.properties.checkpoint);
  assert.equal(tool.parameters.properties.coordinationIdentity, undefined);
});
test("first verified handoff retains successful investigation and validation as complete pairs", () => {
  const { state, harness, handoffMessage } = makeWorkflowContextFixture();
  const call = { role: "assistant", content: [
    { type: "toolCall", id: "read-success", name: "read", arguments: { path: "src/input.ts" } },
    { type: "toolCall", id: "test-success", name: "bash", arguments: { command: "node --test" } },
  ], timestamp: 2 };
  const results = [
    { role: "toolResult", toolCallId: "read-success", toolName: "read", content: [{ type: "text", text: "verified source" }], isError: false, timestamp: 3 },
    { role: "toolResult", toolCallId: "test-success", toolName: "bash", content: [{ type: "text", text: "tests passed" }], isError: false, timestamp: 4 },
  ];
  const messages = [{ role: "user", content: "current goal", timestamp: 1 }, call, ...results, handoffMessage];
  const result = callContextHandler(state, harness, messages);
  for (const message of [call, ...results]) assert.ok(result.messages.includes(message));
  assert.equal(result.messages.some(message => message.customType === ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE), false);
});

test("reuse keeps newest complete groups within count/size budgets and excludes old routing identities", () => {
  const { state, harness, handoffMessage } = makeWorkflowContextFixture();
  const messages = [{ role: "user", content: "current goal", timestamp: 1 }];
  for (let index = 0; index < 11; index++) {
    const id = "read-" + index;
    messages.push({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "source.ts" } }], timestamp: 2 });
    messages.push({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: index === 10 ? "x".repeat(40000) : "source" }], isError: false, timestamp: 3 });
  }
  messages.push({ role: "assistant", content: [{ type: "toolCall", id: "old-status", name: "task_workflow", arguments: { action: "status" } }], timestamp: 4 });
  messages.push({ role: "toolResult", toolCallId: "old-status", toolName: "task_workflow", content: [{ type: "text", text: "old identity" }], isError: false, timestamp: 5 });
  messages.push(handoffMessage);
  const trace = [];
  state.traceHandoff = (_ctx, event, data) => trace.push({ event, data });
  const result = callContextHandler(state, harness, messages);
  const kept = result.messages.filter(message => message.role === "toolResult");
  assert.deepEqual(kept.map(message => message.toolCallId), Array.from({ length: 8 }, (_, i) => "read-" + (i + 2)));
  assert.equal(trace[0].data.retainedGroups, 8);
  assert.equal(trace[0].data.omittedGroups, 3);
  assert.ok(result.messages.some(message => message.customType === "pi-init-prior-tool-observations"));
});

test("reuse does not cross prior branch boundary and never crops a partially paired parallel group", () => {
  const { state, harness, handoffMessage } = makeWorkflowContextFixture();
  const call = { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", arguments: {} },
    { type: "toolCall", id: "b", name: "read", arguments: {} }], timestamp: 1 };
  const partial = { role: "toolResult", toolCallId: "a", toolName: "read", content: [], isError: false, timestamp: 2 };
  const result = callContextHandler(state, harness, [{ role: "user", content: "goal", timestamp: 0 }, call, partial, handoffMessage]);
  assert.ok(result.messages.includes(call));
  assert.ok(result.messages.some(message => message.customType === ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE));
  const foreign = { role: "custom", customType: "pi-init-workflow-task", details: { sessionId: "foreign" }, content: "foreign", timestamp: 0 };
  const mismatch = callContextHandler(state, harness, [foreign, call, partial, handoffMessage]);
  assert.ok(mismatch.messages.some(message => message.customType === ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE));
});

function pausedStatusObservation() {
  return [
    { role: "assistant", content: [{ type: "toolCall", id: "paused-status", name: "task_workflow", arguments: { action: "status" } }], timestamp: 30 },
    { role: "toolResult", toolCallId: "paused-status", toolName: "task_workflow", content: [{ type: "text", text: "current persisted paused status" }], isError: false, timestamp: 31 },
  ];
}

test("paused status survives missing ancient handoffs and repeated projections", () => {
  const { state, harness, handoffMessage, identity } = makeWorkflowContextFixture();
  harness.branch.unshift({ type: "custom_message", customType: "pi-init-workflow-task", details: { ...identity, taskId: "dependency", attemptId: "older-attempt", handoffId: "older-handoff" } });
  state.workflowState = blockWorkflowTask(state.workflowState, { taskId: "current", reason: "Needs confirmation" }, 20);
  harness.branch.push({ type: "custom", id: "paused-source", customType: "pi-init-workflow", data: structuredClone(state.workflowState) });
  const observations = pausedStatusObservation();
  let messages = [{ role: "user", content: "Original goal", timestamp: 1 }, handoffMessage, ...observations];
  for (let projection = 0; projection < 3; projection++) {
    messages = createRoleContextView(state).context({ type: "context", messages }, harness.context).messages;
    for (const observation of observations) assert.ok(messages.includes(observation), `projection ${projection} retains status`);
    assert.equal(messages.some(message => message.customType === ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE), false);
    assert.equal(messages.some(message => message.customType === "pi-init-workflow-task"), false);
    assert.equal(messages.filter(message => message.customType === "pi-init-workflow-paused-context").length, 1);
    assert.equal(messages.at(-1).details.attemptId, undefined);
  }
});

test("architecture-review without handoff history retains complete read-only status observations", () => {
  const state = createExtensionRuntimeState();
  state.workflowState = createWorkflowState({ summary: "Review before execution", sessionId, reviewRequired: true, tasks: [{ id: "first", task: "First task", files: ["src/input.ts"], acceptanceCriteria: ["Reviewed"] }] }, 10);
  const harness = createExtensionHarness([], { sessionId });
  harness.branch.push({ type: "custom", id: "initial-review", customType: "pi-init-workflow", data: structuredClone(state.workflowState) });
  const observations = pausedStatusObservation();
  const result = createRoleContextView(state).context({ type: "context", messages: [{ role: "user", content: "Review goal", timestamp: 1 }, ...observations] }, harness.context);
  for (const observation of observations) assert.ok(result.messages.includes(observation));
});

test("markerless paused status remains fail closed for corrupt snapshots and incomplete or mutating groups", () => {
  for (const failure of ["foreign-snapshot", "malformed-snapshot", "missing-result", "mixed-execution", "foreign-marker"]) {
    const { state, harness } = makeWorkflowContextFixture();
    state.workflowState = blockWorkflowTask(state.workflowState, { taskId: "current", reason: "Needs confirmation" }, 20);
    const snapshot = structuredClone(state.workflowState);
    if (failure === "foreign-snapshot") snapshot.sessionId = "foreign";
    if (failure === "malformed-snapshot") snapshot.tasks = null;
    harness.branch.push({ type: "custom", id: "paused-source", customType: "pi-init-workflow", data: snapshot });
    const observations = pausedStatusObservation();
    if (failure === "missing-result") observations.pop();
    if (failure === "mixed-execution") {
      observations[0].content.push({ type: "toolCall", id: "old-start", name: "task_workflow", arguments: { action: "start", taskId: "current" } });
      observations.push({ role: "toolResult", toolCallId: "old-start", toolName: "task_workflow", content: [], timestamp: 32 });
    }
    const messages = [{ role: "user", content: "Recover safely", timestamp: 1 }, ...observations];
    if (failure === "foreign-marker") messages.unshift({ role: "custom", customType: "pi-init-workflow-task", details: { sessionId: "foreign" }, content: "foreign", timestamp: 0 });
    const result = createRoleContextView(state).context({ type: "context", messages }, harness.context);
    assert.equal(result.messages.some(message => message.role === "toolResult"), false, failure);
    assert.equal(result.messages.some(message => message.role === "assistant"), false, failure);
    if (failure !== "mixed-execution") assert.ok(result.messages.some(message => message.customType === ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE), failure);
    assert.equal(state.workflowState.status, "paused", failure);
  }
});

test("unconfirmed paused snapshots report a completed status observation instead of requesting endless polling", () => {
  const { state, harness } = makeWorkflowContextFixture();
  state.workflowState = blockWorkflowTask(state.workflowState, { taskId: "current", reason: "Needs confirmation" }, 20);
  const messages = [{ role: "user", content: "Recover safely", timestamp: 1 }, ...pausedStatusObservation()];
  const result = createRoleContextView(state).context({ type: "context", messages }, harness.context);
  const diagnostic = result.messages.find(message => message.customType === ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE);
  assert.equal(diagnostic.details.statusObserved, true);
  assert.match(diagnostic.content, /不要反复查询/);
  assert.equal(result.messages.some(message => message.role === "toolResult"), false);
  assert.equal(state.workflowState.status, "paused");
});

test("identical historical handoff deliveries do not erase paused observations or grant execution identity", () => {
  const { state, harness, handoffMessage } = makeWorkflowContextFixture();
  harness.branch.push({ type: "custom_message", id: "redelivered", customType: handoffMessage.customType, details: structuredClone(handoffMessage.details) });
  state.workflowState = blockWorkflowTask(state.workflowState, { taskId: "current", reason: "Needs confirmation" }, 20);
  harness.branch.push({ type: "custom", id: "paused-source", customType: "pi-init-workflow", data: structuredClone(state.workflowState) });
  const observations = pausedStatusObservation();
  const messages = [{ role: "user", content: "Recover safely", timestamp: 1 }, handoffMessage, { ...handoffMessage, timestamp: 25 }, ...observations];
  const result = createRoleContextView(state).context({ type: "context", messages }, harness.context);
  for (const observation of observations) assert.ok(result.messages.includes(observation));
  assert.equal(result.messages.some(message => message.customType === ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE), false);
  assert.equal(result.messages.at(-1).details.attemptId, undefined);
  assert.equal(state.workflowState.status, "paused");
  const active = makeWorkflowContextFixture();
  active.harness.branch.push({ type: "custom_message", customType: active.handoffMessage.customType, details: structuredClone(active.handoffMessage.details) });
  const rejected = createRoleContextView(active.state).context({ type: "context", messages: [active.handoffMessage] }, active.harness.context);
  assert.ok(rejected.messages.some(message => message.customType === ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE));
});

test("unchanged current status remains observed across later non-mutating user reminders", () => {
  const { state, harness } = makeWorkflowContextFixture();
  state.workflowState = blockWorkflowTask(state.workflowState, { taskId: "current", reason: "Needs confirmation" }, 20);
  const observations = pausedStatusObservation();
  observations[1].details = structuredClone(state.workflowState);
  const result = createRoleContextView(state).context({ type: "context", messages: [{ role: "user", content: "Recover safely", timestamp: 1 }, ...observations,
    { role: "user", content: "Task list reference only", timestamp: 32 }] }, harness.context);
  const diagnostic = result.messages.find(message => message.customType === ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE);
  assert.equal(diagnostic.details.statusObserved, true);
});

test("host system messages survive paused projection without being mistaken for broken tool pairs", () => {
  const { state, harness, handoffMessage } = makeWorkflowContextFixture();
  state.workflowState = blockWorkflowTask(state.workflowState, { taskId: "current", reason: "Needs confirmation" }, 20);
  harness.branch.push({ type: "custom", id: "paused-source", customType: "pi-init-workflow", data: structuredClone(state.workflowState) });
  const system = { role: "system", content: "Host-managed role prompt", sections: { host: "untouched" }, timestamp: 29 };
  const observations = pausedStatusObservation();
  const messages = [{ role: "user", content: "Recover safely", timestamp: 1 }, handoffMessage, system, ...observations];
  const result = createRoleContextView(state).context({ type: "context", messages }, harness.context);
  assert.ok(result.messages.includes(system));
  for (const observation of observations) assert.ok(result.messages.includes(observation));
  assert.equal(result.messages.some(message => message.customType === ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE), false);
  harness.branch.pop();
  const failed = createRoleContextView(state).context({ type: "context", messages }, harness.context);
  assert.ok(failed.messages.includes(system));
  assert.equal(state.workflowState.status, "paused");
});

test("shared tool grouping preserves interleaved parallel results and absolute window indices", () => {
  const call = (id) => ({ type: "toolCall", id, name: "read", arguments: {} });
  const result = (id, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: "read", isError, content: [] });
  const messages = [{ role: "user", content: "goal" }, { role: "assistant", content: [call("a"), call("b")] }, result("b", true), { role: "assistant", content: [call("c")] }, result("a"), result("c")];
  const groups = groupToolMessages(messages);
  assert.deepEqual(groups.map(group => group.indices), [[0], [1, 2, 4], [3, 5]]);
  assert.equal(groups[1].failed, true);
  assert.deepEqual(groupToolMessages(messages, 1, messages.length).map(group => group.indices), [[1, 2, 4], [3, 5]]);
  assert.equal(groupToolMessages(messages, 1, 3), undefined);
  assert.equal(hasCompleteToolPairs(messages), true);
  for (const broken of [messages.slice(0, -1), [result("orphan")], [{ role: "assistant", content: [call("a"), call("a")] }, result("a")], [{ role: "assistant", content: [call("")] }, result("")], [...messages, result("a")], [{ role: "system", content: "host" }]]) {
    assert.equal(groupToolMessages(broken), undefined);
    assert.equal(hasCompleteToolPairs(broken), false);
  }
});
