import assert from "node:assert/strict";
import test from "node:test";
import {
  checkCoordinationReadiness,
  checkTaskContractAgainstCoordination,
  cloneCoordinationState,
  createCoordinationState,
  getAcceptedEvidence,
  hydrateCoordinationState,
  reportEvidence,
  requestEvidence,
  reopenEvidenceReview,
  reviewEvidence,
} from "../src/coordination.ts";

function request(overrides = {}) {
  return {
    requestId: "request-callers-1",
    questionId: "direct-callers",
    question: "Where are this workflow action's direct callers?",
    rationale: "The implementation plan depends on the actual call path.",
    scope: ["extensions/workflow-actions.ts", "src/workflow*.ts"],
    exclusions: ["unrelated UI"],
    completionCriteria: ["Identify the handler and direct callers with source locations."],
    ...overrides,
  };
}

function report(requestId, overrides = {}) {
  return {
    reportId: `report-${requestId}`,
    requestId,
    findings: [{
      findingId: `finding-${requestId}`,
      questionId: "direct-callers",
      classification: "fact",
      statement: "The workflow action is dispatched by the registered task_workflow tool.",
      sources: [{ id: "extensions/index.ts", location: "task_workflow.execute", version: "sha-index-1" }],
    }],
    inspectedScope: ["extensions/index.ts"],
    testsLocated: ["test/workflow-protocol.test.js"],
    testsRun: [],
    unresolved: [],
    ...overrides,
  };
}

function accept(reportId, findingId, version, overrides = {}) {
  return {
    reviewId: `review-${reportId}`,
    reportId,
    decision: "accept",
    acceptedEvidence: [{ findingId, sourceId: "extensions/index.ts", sourceVersion: version }],
    gaps: [],
    ...overrides,
  };
}

function ok(result) {
  assert.equal(result.ok, true, result.ok ? undefined : `${result.code}: ${result.message}`);
  return result.value;
}

test("无范围重叠的取证请求可以并发在飞，范围重叠或写范围仍串行", () => {
  let state = ok(createCoordinationState({ sessionId: "session-1", coordinationId: "coord-1" }, 10));
  state = ok(requestEvidence(state, request(), 20));

  const disjoint = ok(requestEvidence(state, request({
    requestId: "request-docs",
    questionId: "docs-coverage",
    question: "Docs coverage for the coordination协议",
    scope: ["docs/decisions.md"],
  }), 21));
  assert.deepEqual(disjoint.requests.map((item) => item.questionId).sort(), ["direct-callers", "docs-coverage"]);

  assert.equal(requestEvidence(disjoint, request({
    requestId: "request-overlap",
    questionId: "workflow-handlers",
    question: "Other handlers under the same files",
    scope: ["src/workflow-transitions.ts"],
  }), 22).code, "COORDINATION_REQUEST_IN_FLIGHT");

  assert.equal(requestEvidence(disjoint, request({
    requestId: "request-write",
    questionId: "write-scope",
    question: "Apply the write change",
    scope: ["write src/workflow-transitions.ts"],
  }), 23).code, "COORDINATION_REQUEST_IN_FLIGHT");
});

test("证据请求经历补查和第二轮审阅，只接受被架构师明确接受的来源事实", () => {
  let state = ok(createCoordinationState({ sessionId: "session-1", coordinationId: "coord-1" }, 10));
  state = ok(requestEvidence(state, request(), 20));
  assert.equal(state.phase, "evidence-gathering");
  assert.equal(requestEvidence(state, request({
    requestId: "request-parallel",
    questionId: "another-question",
    question: "A separate question",
  }), 25).code, "COORDINATION_REQUEST_IN_FLIGHT");

  const firstReport = report("request-callers-1", {
    findings: [
      ...report("request-callers-1").findings,
      {
        findingId: "inferred-test-coverage",
        questionId: "direct-callers",
        classification: "inference",
        statement: "A test may exercise the direct caller.",
        sources: [{ id: "test/workflow-protocol.test.js", location: "test name", version: "sha-test-1" }],
      },
      {
        findingId: "unknown-route",
        questionId: "direct-callers",
        classification: "unconfirmed",
        statement: "No evidence yet identifies the recovery caller.",
        sources: [],
      },
    ],
    unresolved: ["The matching recovery path test has not been identified."],
  });
  state = ok(reportEvidence(state, firstReport, 30));
  assert.equal(state.phase, "evidence-review");
  assert.equal(reviewEvidence(state, accept("report-request-callers-1", "inferred-test-coverage", "sha-test-1"), 40).code,
    "COORDINATION_ONLY_FACTS_ACCEPTABLE");
  assert.equal(reviewEvidence(state, accept("report-request-callers-1", "unknown-route", "sha-index-1"), 40).code,
    "COORDINATION_ONLY_FACTS_ACCEPTABLE");

  state = ok(reviewEvidence(state, {
    reviewId: "review-first-more",
    reportId: "report-request-callers-1",
    decision: "more",
    acceptedEvidence: [{ findingId: "finding-request-callers-1", sourceId: "extensions/index.ts", sourceVersion: "sha-index-1" }],
    gaps: ["Identify the recovery path test and verify its direct caller."],
  }, 50));
  assert.equal(state.phase, "evidence-gathering");
  assert.equal(checkCoordinationReadiness(state).code, "COORDINATION_EVIDENCE_INCOMPLETE");

  const secondRequest = request({
    requestId: "request-callers-2",
    question: "Find the recovery path test and verify its direct caller.",
    scope: ["test/workflow-recovery-disposition.test.js", "extensions/workflow-recovery-actions.ts"],
    completionCriteria: ["Name the recovery test and cite its action caller."],
    addressesGaps: ["Identify the recovery path test and verify its direct caller."],
    followUpOfRequestId: "request-callers-1",
  });
  state = ok(requestEvidence(state, secondRequest, 60));
  assert.equal(state.requests[0].status, "superseded");
  assert.equal(state.requests[1].round, 2);

  const secondReport = report("request-callers-2", {
    reportId: "report-request-callers-2",
    findings: [{
      findingId: "finding-recovery-path",
      questionId: "direct-callers",
      classification: "fact",
      statement: "The recovery disposition test covers the public action transition.",
      sources: [{ id: "extensions/index.ts", location: "workflow action event binding", version: "sha-index-2" }],
    }],
    inspectedScope: ["test/workflow-recovery-disposition.test.js", "extensions/workflow-recovery-actions.ts"],
    testsLocated: ["test/workflow-recovery-disposition.test.js"],
    testsRun: [{ command: "node --test test/workflow-recovery-disposition.test.js", result: "passed" }],
  });
  state = ok(reportEvidence(state, secondReport, 70));
  const currentAcceptedBeforeReview = ok(getAcceptedEvidence(state));
  assert.equal(currentAcceptedBeforeReview.some((item) => item.sourceVersion === "sha-index-1"), false,
    "a newly observed source version invalidates an older accepted reference");
  state = ok(reviewEvidence(state, accept("report-request-callers-2", "finding-recovery-path", "sha-index-2"), 80));
  assert.equal(state.phase, "ready");
  const readiness = ok(checkCoordinationReadiness(state));
  assert.deepEqual(readiness.acceptedEvidence, [{
    findingId: "finding-recovery-path",
    sourceId: "extensions/index.ts",
    sourceVersion: "sha-index-2",
  }]);
  const readyContract = {
    version: 1,
    outcome: "Implement against the verified handler.",
    evidence: readiness.acceptedEvidence,
    blockingQuestions: [],
  };
  assert.equal(checkTaskContractAgainstCoordination(readyContract, state).ok, true);
  assert.equal(checkTaskContractAgainstCoordination({ ...readyContract, blockingQuestions: ["Which public result code?"] }, state).code,
    "TASK_CONTRACT_BLOCKING_QUESTIONS");

  const roundTrip = ok(hydrateCoordinationState(JSON.parse(JSON.stringify(state))));
  assert.deepEqual(roundTrip, state);
  assert.deepEqual(ok(cloneCoordinationState(state)), state);

  const repeated = {
    requestId: "request-refresh-without-reason",
    questionId: secondRequest.questionId,
    question: secondRequest.question,
    rationale: "Recheck",
    scope: secondRequest.scope,
    exclusions: secondRequest.exclusions,
    completionCriteria: secondRequest.completionCriteria,
  };
  assert.equal(requestEvidence(state, repeated, 90).code, "COORDINATION_NO_PROGRESS");
  const refreshed = ok(requestEvidence(state, {
    ...repeated,
    requestId: "request-refresh-with-reason",
    refreshReason: "The source fingerprint changed since the accepted report.",
  }, 90));
  assert.equal(refreshed.requests.at(-1).round, 3);
});

test("同一问题的 follow-up 必须对应已记录缺口且改变调查范围", () => {
  let state = ok(createCoordinationState({ sessionId: "session-2" }, 1));
  state = ok(requestEvidence(state, request({ requestId: "request-no-progress" }), 2));
  state = ok(reportEvidence(state, report("request-no-progress"), 3));
  state = ok(reviewEvidence(state, {
    reportId: "report-request-no-progress",
    decision: "more",
    gaps: ["Check which test verifies recovery."],
  }, 4));

  const duplicateFollowUp = request({
    requestId: "request-no-progress-2",
    followUpOfRequestId: "request-no-progress",
    addressesGaps: ["Check which test verifies recovery."],
  });
  assert.equal(requestEvidence(state, duplicateFollowUp, 5).code, "COORDINATION_NO_PROGRESS");
  const usefulFollowUp = request({
    ...duplicateFollowUp,
    scope: ["test/workflow-recovery-disposition.test.js"],
    completionCriteria: ["Identify the recovery assertion."],
  });
  state = ok(requestEvidence(state, usefulFollowUp, 6));
  assert.equal(state.requests.at(-1).round, 2);
  assert.equal(state.phase, "evidence-gathering");
});

test("显式重开阻塞审阅保留旧证据并将复审绑定到重开记录", () => {
  let blocked = ok(createCoordinationState({ sessionId: "session-reopen", coordinationId: "coord-reopen" }, 1));
  blocked = ok(requestEvidence(blocked, request({ requestId: "request-reopen", questionId: "reopen" }), 2));
  blocked = ok(reportEvidence(blocked, report("request-reopen", { findings: [{
    findingId: "reopen-fact",
    questionId: "reopen",
    classification: "fact",
    statement: "原始来源保留。",
    sources: [{ id: "source-reopen", location: "src/reopen.ts", version: "source-v1" }],
  }] }), 3));
  blocked = ok(reviewEvidence(blocked, {
    reviewId: "review-block-original",
    reportId: "report-request-reopen",
    decision: "block",
    reason: "缺少关键证据。",
  }, 4));
  assert.equal(blocked.phase, "blocked");
  assert.equal(blocked.requests[0].status, "blocked");

  const originalReport = structuredClone(blocked.reports[0]);
  const originalBlock = structuredClone(blocked.reviews[0]);
  const reopened = ok(reopenEvidenceReview(blocked, {
    reportId: originalReport.reportId,
    reason: "补充了可复核材料，请重新评估原报告。",
  }, 5));
  assert.equal(reopened.version, 2);
  assert.equal(reopened.phase, "evidence-review");
  assert.equal(reopened.requests[0].status, "reported");
  assert.deepEqual(reopened.reports[0], originalReport);
  assert.deepEqual(reopened.reviews[0], originalBlock);
  assert.deepEqual(reopened.reviewReopenings, [{
    reopeningId: reopened.reviewReopenings[0].reopeningId,
    requestId: "request-reopen",
    reportId: originalReport.reportId,
    previousReviewId: originalBlock.reviewId,
    reason: "补充了可复核材料，请重新评估原报告。",
    createdAt: 5,
  }]);

  const migratedV1 = { ...blocked, version: 1 };
  delete migratedV1.reviewReopenings;
  const hydratedV1 = ok(hydrateCoordinationState(migratedV1));
  assert.equal(hydratedV1.version, 2);
  assert.deepEqual(hydratedV1.reviewReopenings, []);

  const accepted = ok(reviewEvidence(reopened, {
    reviewId: "review-reopened-accept",
    reportId: originalReport.reportId,
    decision: "accept",
    acceptedEvidence: [{ findingId: "reopen-fact", sourceId: "source-reopen", sourceVersion: "source-v1" }],
    reason: "显式复审后接受来源匹配的事实。",
  }, 6));
  assert.equal(accepted.phase, "ready");
  assert.equal(accepted.requests[0].status, "accepted");
  assert.deepEqual(accepted.reviews.map((review) => review.decision), ["block", "accept"]);
  assert.equal(accepted.reviews[1].reopeningId, reopened.reviewReopenings[0].reopeningId);
  assert.equal(accepted.reviewReopenings[0].previousReviewId, originalBlock.reviewId);
  assert.equal(checkCoordinationReadiness(accepted).ok, true);

  const blockedAgain = ok(reviewEvidence(reopened, {
    reviewId: "review-reopened-block",
    reportId: originalReport.reportId,
    decision: "block",
    reason: "再次审阅仍发现缺口。",
  }, 6));
  const reopenedAgain = ok(reopenEvidenceReview(blockedAgain, {
    reportId: originalReport.reportId,
    reason: "第二次明确授权复审。",
  }, 7));
  assert.equal(hydrateCoordinationState(reopenedAgain).ok, true);
  assert.equal(reopenedAgain.reviewReopenings.length, 2);
  assert.equal(reopenedAgain.reviewReopenings[1].previousReviewId, "review-reopened-block");
  const acceptedAgain = ok(reviewEvidence(reopenedAgain, {
    reviewId: "review-reopened-accept-again",
    reportId: originalReport.reportId,
    decision: "accept",
    acceptedEvidence: [{ findingId: "reopen-fact", sourceId: "source-reopen", sourceVersion: "source-v1" }],
  }, 8));
  assert.deepEqual(acceptedAgain.reviews.map((review) => review.decision), ["block", "block", "accept"]);
  assert.equal(acceptedAgain.reviews[2].reopeningId, reopenedAgain.reviewReopenings[1].reopeningId);
});

test("审阅重开只允许最新明确阻塞报告和非空原因", () => {
  let accepted = ok(createCoordinationState({ sessionId: "session-reopen-guards" }, 1));
  accepted = ok(requestEvidence(accepted, request({ requestId: "request-old" }), 2));
  accepted = ok(reportEvidence(accepted, report("request-old"), 3));
  accepted = ok(reviewEvidence(accepted, accept("report-request-old", "finding-request-old", "sha-index-1"), 4));
  assert.equal(reopenEvidenceReview(accepted, { reportId: "report-request-old", reason: "再次审阅" }, 5).code,
    "COORDINATION_REOPEN_NOT_BLOCKED");

  let blocked = ok(requestEvidence(accepted, request({ requestId: "request-new", refreshReason: "出现新的来源版本" }), 5));
  blocked = ok(reportEvidence(blocked, report("request-new"), 6));
  blocked = ok(reviewEvidence(blocked, {
    reportId: "report-request-new", decision: "block", reason: "新报告仍缺少关键证据。",
  }, 7));
  assert.equal(reopenEvidenceReview(blocked, { reportId: "report-request-old", reason: "旧报告" }, 8).code,
    "COORDINATION_REOPEN_NOT_LATEST_BLOCK");
  assert.equal(reopenEvidenceReview(blocked, { reportId: "report-request-new", reason: " " }, 8).code,
    "COORDINATION_FIELD_EMPTY");
  assert.equal(requestEvidence(blocked, request({ requestId: "request-automatic-reopen" }), 8).code,
    "COORDINATION_BLOCKED");
});

test("报告和审阅对不完整、缺失来源和错误版本返回可区分结果", () => {
  let state = ok(createCoordinationState({ sessionId: "session-3" }, 1));
  state = ok(requestEvidence(state, request(), 2));
  assert.equal(reportEvidence(state, report("request-callers-1", {
    findings: [{
      findingId: "fact-no-source",
      questionId: "direct-callers",
      classification: "fact",
      statement: "A claim without source.",
      sources: [],
    }],
  }), 3).code, "COORDINATION_EVIDENCE_SOURCE_MISSING");

  state = ok(reportEvidence(state, report("request-callers-1"), 3));
  assert.equal(reviewEvidence(state, accept("report-request-callers-1", "finding-request-callers-1", "wrong-version"), 4).code,
    "COORDINATION_EVIDENCE_VERSION_MISMATCH");
  assert.equal(reviewEvidence(state, accept("report-request-callers-1", "finding-request-callers-1", "sha-index-1", {
    gaps: ["Still open"],
  }), 4).code, "COORDINATION_EVIDENCE_INCOMPLETE");
  assert.equal(reviewEvidence(state, {
    reportId: "report-request-callers-1",
    decision: "block",
  }, 4).code, "COORDINATION_REVIEW_REASON_MISSING");
});

test("任务契约必须引用当前接受的证据且不能带关键未决问题", () => {
  const state = ok(createCoordinationState({ sessionId: "session-4" }, 1));
  const contract = {
    version: 1,
    outcome: "Expose recovery status accurately.",
    expectedBehavior: ["Return structured status."],
    evidence: [{ findingId: "f-1", sourceId: "src/role.ts", sourceVersion: "v2" }],
    fixedDecisions: ["Do not hide recovery errors."],
    invariants: [],
    nonGoals: ["Do not redesign the UI."],
    blockingQuestions: [],
    engineeringDiscretion: ["Choose a local helper shape."],
    verification: ["Run the recovery unit test."],
  };
  assert.equal(checkTaskContractAgainstCoordination(contract, state).code, "TASK_CONTRACT_EVIDENCE_UNACCEPTED");
});

test("协作状态非法类型、版本、身份和时间戳返回结构化错误", () => {
  assert.equal(createCoordinationState({}, 1).code, "COORDINATION_FIELD_MISSING");
  assert.equal(createCoordinationState({ sessionId: "s", coordinationId: 42 }, 1).code, "COORDINATION_FIELD_TYPE");
  assert.equal(createCoordinationState({ sessionId: "s" }, -1).code, "COORDINATION_TIMESTAMP_INVALID");
  assert.equal(hydrateCoordinationState(null).code, "COORDINATION_INPUT_TYPE");
  assert.equal(hydrateCoordinationState({ version: 3 }).code, "COORDINATION_VERSION_UNSUPPORTED");
  assert.equal(hydrateCoordinationState({
    version: 1,
    coordinationId: "coord",
    sessionId: "s",
    phase: "ready",
    requests: [],
    reports: [],
    reviews: [],
    createdAt: 2,
    updatedAt: 1,
  }).code, "COORDINATION_TIMESTAMP_INVALID");

  const started = ok(createCoordinationState({ sessionId: "session-time" }, 10));
  const pending = ok(requestEvidence(started, request({ requestId: "request-time" }), 20));
  assert.equal(requestEvidence(pending, request({ requestId: "request-time-2" }), 19).code,
    "COORDINATION_TIMESTAMP_REGRESSION");
  const missingId = structuredClone(pending);
  delete missingId.requests[0].requestId;
  assert.equal(hydrateCoordinationState(missingId).code, "COORDINATION_FIELD_MISSING");
  const badOrder = { ...pending, updatedAt: 19 };
  assert.equal(hydrateCoordinationState(badOrder).code, "COORDINATION_TIMESTAMP_REGRESSION");
});
