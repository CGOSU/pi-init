import assert from "node:assert/strict";
import test from "node:test";
import {
  COORDINATION_EVIDENCE_MESSAGE_TYPE,
  COORDINATION_REVIEW_MESSAGE_TYPE,
  coordinationHandoffIdentity,
} from "../extensions/coordination-runtime-protocol.ts";
import { compileCoordinationMessage } from "../extensions/coordination-messages.ts";
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
const evidenceReference = { findingId: "accepted-finding", sourceId: "src/input.ts", sourceVersion: "sha-v4" };

function taskContract(evidence = [evidenceReference]) {
  return {
    version: 1,
    outcome: "Implement the confirmed behavior.",
    requirementSources: ["User requirement"],
    expectedBehavior: ["Keep caller-visible failure semantics."],
    evidence,
    clarificationResolutions: [],
    fixedDecisions: ["Do not change the public error shape."],
    invariants: ["Preserve successful callers."],
    nonGoals: ["Do not broaden parsing."],
    blockingQuestions: [],
    engineeringDiscretion: ["Choose a local helper boundary."],
    verification: ["Run the focused input test."],
  };
}

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
        contract: taskContract(),
      },
      {
        id: "followup",
        task: "Continue using only required evidence.",
        dependsOn: ["current"],
        files: ["src/next.ts"],
        acceptanceCriteria: ["Keep the result traceable."],
        contract: taskContract(),
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
  state.coordinationRuntimeState = {
    runtimeVersion: 1,
    sessionId,
    recoveryGeneration: state.workflowState.recoveryGeneration,
    coordination: {
      version: 2,
      coordinationId: "coordination-context",
      sessionId,
      phase: "ready",
      workflowLink: {
        workflowId: state.workflowState.workflowId,
        planVersion: state.workflowState.planVersion,
        recoveryGeneration: state.workflowState.recoveryGeneration,
      },
      requests: [{
        requestId: "request-accepted",
        questionId: "input-contract",
        question: "What do direct callers do on parse failure?",
        rationale: "The task contract depends on the caller behavior.",
        scope: ["src/input.ts"],
        exclusions: [],
        completionCriteria: ["Report the caller behavior."],
        addressesGaps: [],
        round: 1,
        status: "accepted",
        createdAt: 1,
      }],
      reports: [{
        reportId: "report-accepted",
        requestId: "request-accepted",
        findings: [{
          findingId: evidenceReference.findingId,
          questionId: "input-contract",
          classification: "fact",
          statement: "The direct caller renders parse failures as validation errors and preserves the input.",
          sources: [{ id: evidenceReference.sourceId, location: "src/input.ts::parseInput", version: evidenceReference.sourceVersion }],
        }],
        inspectedScope: ["src/input.ts"],
        testsLocated: ["test/input.test.js"],
        testsRun: [],
        unresolved: [],
        createdAt: 1,
      }],
      reviews: [{
        reviewId: "review-accepted",
        reportId: "report-accepted",
        decision: "accept",
        acceptedEvidence: [evidenceReference],
        gaps: [],
        reviewedAt: 2,
      }],
      reviewReopenings: [],
      createdAt: 1,
      updatedAt: 2,
    },
  };
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

function coordinationRuntimeState({ role, kind, requestId = "request-current", reportId = "report-current" }) {
  const currentRequest = {
    requestId,
    questionId: "same-question",
    question: "What is the current caller-visible behavior?",
    rationale: "The handoff needs current implementation evidence.",
    scope: ["src/input.ts", "direct callers"],
    exclusions: [],
    completionCriteria: ["Report current caller behavior and source version."],
    addressesGaps: ["include caller error handling"],
    followUpOfRequestId: "request-gap",
    round: 3,
    status: kind === "evidence" ? "pending" : "reported",
    createdAt: 3,
  };
  const previousRequest = {
    requestId: "request-prior",
    questionId: "same-question",
    question: "Previous round",
    rationale: "Previous round rationale",
    scope: ["src/input.ts"],
    exclusions: [],
    completionCriteria: ["Old fact"],
    addressesGaps: [],
    round: 1,
    status: "accepted",
    createdAt: 1,
  };
  const gapRequest = {
    ...previousRequest,
    requestId: "request-gap",
    question: "Second-round investigation",
    round: 2,
    status: "follow-up-needed",
    createdAt: 2,
  };
  const unrelatedRequest = { ...previousRequest, requestId: "request-unrelated", questionId: "unrelated-question" };
  const previousReport = {
    reportId: "report-prior",
    requestId: previousRequest.requestId,
    findings: [{
      findingId: "prior-fact",
      questionId: previousRequest.questionId,
      classification: "fact",
      statement: "Prior accepted caller behavior; recheck it in the new source version.",
      sources: [{ id: "src-callers", location: "src/input.ts::caller", version: "sha-v1" }],
    }],
    inspectedScope: ["src/input.ts"],
    testsLocated: [],
    testsRun: [],
    unresolved: [],
    createdAt: 1,
  };
  const gapReport = {
    ...previousReport,
    reportId: "report-gap",
    requestId: gapRequest.requestId,
    findings: [{ ...previousReport.findings[0], findingId: "gap-inference", classification: "inference", statement: "Second-round unconfirmed inference." }],
    createdAt: 2,
  };
  const unrelatedReport = {
    ...previousReport,
    reportId: "report-unrelated",
    requestId: unrelatedRequest.requestId,
    findings: [{ ...previousReport.findings[0], findingId: "unrelated-fact", questionId: unrelatedRequest.questionId, statement: "UNRELATED FACT MUST NOT LEAK" }],
  };
  const currentReport = {
    reportId,
    requestId,
    findings: [{
      findingId: "current-fact",
      questionId: currentRequest.questionId,
      classification: "fact",
      statement: "Current implementation preserves the input on parse failure.",
      sources: [{ id: "src-callers", location: "src/input.ts::parseInput", version: "sha-v2" }],
    }],
    inspectedScope: ["src/input.ts"],
    testsLocated: ["test/input.test.js"],
    testsRun: [],
    unresolved: [],
    createdAt: 3,
  };
  const current = {
    runtimeVersion: 1,
    sessionId,
    recoveryGeneration: 0,
    coordination: {
      version: 2,
      coordinationId: "coordination-context",
      sessionId,
      phase: kind === "evidence" ? "evidence-gathering" : "evidence-review",
      requests: [previousRequest, gapRequest, unrelatedRequest, currentRequest],
      reports: [previousReport, gapReport, unrelatedReport, currentReport],
      reviews: [{
        reviewId: "review-prior",
        reportId: previousReport.reportId,
        decision: "accept",
        acceptedEvidence: [{ findingId: "prior-fact", sourceId: "src-callers", sourceVersion: "sha-v1" }],
        gaps: [],
        reviewedAt: 1,
      }, {
        reviewId: "review-gap",
        reportId: gapReport.reportId,
        decision: "more",
        acceptedEvidence: [],
        gaps: ["include caller error handling"],
        reviewedAt: 2,
      }],
      reviewReopenings: [],
      createdAt: 1,
      updatedAt: 3,
    },
    handoff: {
      role,
      kind,
      requestId,
      ...(kind === "review" ? { reportId } : {}),
      attemptId: "attempt-current",
      handoffId: "handoff-current",
      phase: "queued",
      createdAt: 3,
    },
  };
  return { current, currentRequest, currentReport, previousReport, unrelatedReport };
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

test("task and evidence handoff packages contain only relevant facts and direct dependency results", () => {
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
  assert.match(prompt, /The direct caller renders parse failures as validation errors and preserves the input/);
  assert.match(prompt, /src\/input.ts@sha-v4/);

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
  assert.match(replanPrompt, /The direct caller renders parse failures as validation errors and preserves the input/);

  const { current: docsState } = coordinationRuntimeState({ role: "docs-commit", kind: "evidence" });
  const docsMessage = compileCoordinationMessage(docsState);
  assert.match(docsMessage.content, /What is the current caller-visible behavior/);
  assert.match(docsMessage.content, /Prior accepted caller behavior/);
  assert.match(docsMessage.content, /include caller error handling/);
  assert.doesNotMatch(docsMessage.content, /UNRELATED FACT MUST NOT LEAK/);
  assert.match(docsMessage.content, /当前交接包只包含(?:本问题|本次请求)和相关历史事实/);

  const { current: architectState } = coordinationRuntimeState({ role: "architect", kind: "review" });
  const architectMessage = compileCoordinationMessage(architectState);
  assert.match(architectMessage.content, /Current implementation preserves the input/);
  assert.match(architectMessage.content, /Prior accepted caller behavior/);
  assert.doesNotMatch(architectMessage.content, /UNRELATED FACT MUST NOT LEAK/);
});

test("coordination role context uses its active request/review handoff identity and keeps the accepted-review planning window", () => {
  for (const role of ["docs-commit", "architect"]) {
    const kind = role === "docs-commit" ? "evidence" : "review";
    const { current } = coordinationRuntimeState({ role, kind });
    const state = createExtensionRuntimeState();
    state.activeRole = { role, provider, model, thinkingLevel: "max" };
    state.coordinationRuntimeState = current;
    const harness = createExtensionHarness([], { sessionId });
    const identity = coordinationHandoffIdentity(current);
    const customType = kind === "evidence" ? COORDINATION_EVIDENCE_MESSAGE_TYPE : COORDINATION_REVIEW_MESSAGE_TYPE;
    harness.branch.push({ type: "custom_message", customType, details: identity });
    const marker = { role: "custom", customType, details: identity, content: "current coordination package", timestamp: 4 };
    const result = createRoleContextView(state).context({
      type: "context",
      messages: [
        { role: "user", content: "old history", timestamp: 1 },
        { role: "user", content: "new instruction before the evidence handoff", timestamp: 2 },
        marker,
      ],
    }, harness.context);
    assert.ok(result, role);
    assert.deepEqual(result.messages.map((message) => message.content), ["new instruction before the evidence handoff", "current coordination package"], role);
  }

  const { current } = coordinationRuntimeState({ role: "architect", kind: "review" });
  const acceptedIdentity = coordinationHandoffIdentity(current);
  current.handoff = undefined;
  current.coordination.phase = "ready";
  current.coordination.reviews.push({
    reviewId: "review-current",
    reportId: "report-current",
    decision: "accept",
    acceptedEvidence: [{ findingId: "current-fact", sourceId: "src-callers", sourceVersion: "sha-v2" }],
    gaps: [],
    reviewedAt: 4,
  });
  const state = createExtensionRuntimeState();
  state.activeRole = { role: "architect", provider, model, thinkingLevel: "max" };
  state.coordinationRuntimeState = current;
  const harness = createExtensionHarness([], { sessionId });
  harness.branch.push({ type: "custom_message", customType: COORDINATION_REVIEW_MESSAGE_TYPE, details: acceptedIdentity });
  const marker = { role: "custom", customType: COORDINATION_REVIEW_MESSAGE_TYPE, details: acceptedIdentity, content: "accepted report for planning", timestamp: 5 };
  const acceptedResult = createRoleContextView(state).context({
    type: "context",
    messages: [{ role: "user", content: "latest planning instruction", timestamp: 4 }, marker],
  }, harness.context);
  assert.ok(acceptedResult);
  assert.deepEqual(acceptedResult.messages.map((message) => message.content), ["latest planning instruction", "accepted report for planning"]);
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
