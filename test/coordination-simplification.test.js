import assert from "node:assert/strict";
import test from "node:test";

import {
  createCoordinationState,
  getAcceptedEvidence,
  hydrateCoordinationState,
  reportEvidence,
  requestEvidence,
  reviewEvidence,
} from "../src/coordination.ts";
import {
  createExtensionHarness,
  emitExtensionEvent,
  mkdir,
  path,
  withTempDirectory,
  workflowMessageIdentity,
  writeFile,
} from "./helpers.js";
import {
  COORDINATION_ENTRY_TYPE,
  COORDINATION_EVIDENCE_MESSAGE_TYPE,
  COORDINATION_REVIEW_MESSAGE_TYPE,
} from "../extensions/coordination-runtime-protocol.ts";
import { taskWorkflowParameters } from "../extensions/contracts.ts";

const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
const docs = { provider: "openai-codex", id: "gpt-5.6-docs" };
const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };

const QUESTION_ID = "dedup-contract";

function ok(result) {
  assert.equal(result.ok, true, result.ok ? undefined : `${result.code}: ${result.message}`);
  return result.value;
}

function request(overrides = {}) {
  return {
    requestId: "request-dedup-1",
    questionId: QUESTION_ID,
    question: "Which normalized source identity backs the dedup contract?",
    rationale: "Dedup must not weaken conflict semantics.",
    scope: ["src/coordination-validation.ts"],
    completionCriteria: ["Report normalized source identity."],
    ...overrides,
  };
}

function finding(sources, overrides = {}) {
  return {
    findingId: "finding-dedup-1",
    questionId: QUESTION_ID,
    classification: "fact",
    statement: "Normalized source identity is id/location/version.",
    sources,
    ...overrides,
  };
}

function report(requestId, findings, overrides = {}) {
  return {
    reportId: `report-${requestId}`,
    requestId,
    findings,
    inspectedScope: ["src/coordination-validation.ts"],
    testsRun: [],
    unresolved: [],
    ...overrides,
  };
}

test("单条 finding 内规范化后完全一致的来源无损合并并保留首次出现顺序", () => {
  let state = ok(createCoordinationState({ sessionId: "dedup-session", coordinationId: "dedup-coord" }, 1));
  state = ok(requestEvidence(state, request(), 2));
  state = ok(reportEvidence(state, report("request-dedup-1", [finding([
    { id: "src/a", location: "a.ts::first", version: "v1" },
    { id: "src/b", location: "b.ts::second", version: "v1" },
    { id: " src/a ", location: " a.ts::first ", version: " v1 " },
  ])]), 3));

  assert.deepEqual(state.reports[0].findings[0].sources, [
    { id: "src/a", location: "a.ts::first", version: "v1" },
    { id: "src/b", location: "b.ts::second", version: "v1" },
  ]);
  assert.deepEqual(ok(hydrateCoordinationState(JSON.parse(JSON.stringify(state)))), state);
});

test("同 finding 同 ID 不同版本或不同位置继续分别失败并指出来源定位", () => {
  const state = ok(requestEvidence(
    ok(createCoordinationState({ sessionId: "conflict-session" }, 1)),
    request({ questionId: "conflict-question" }),
    2,
  ));
  const conflictFinding = (sources) => finding(sources, { questionId: "conflict-question", findingId: "conflict-finding" });

  const versionConflict = reportEvidence(state, {
    ...report("request-dedup-1", [conflictFinding([
      { id: "shared-source", location: "src/a.ts:one", version: "v1" },
      { id: "shared-source", location: "src/a.ts:one", version: "v2" },
    ])]),
    requestId: "request-dedup-1",
  }, 3);
  assert.equal(versionConflict.code, "COORDINATION_SOURCE_VERSION_CONFLICT");
  assert.match(versionConflict.message, /shared-source/);
  assert.match(versionConflict.field, /findings\[0\]\.sources\[1\]\.version$/);

  const locationConflict = reportEvidence(state, report("request-dedup-1", [conflictFinding([
    { id: "shared-source", location: "src/a.ts:one", version: "v1" },
    { id: "shared-source", location: "src/a.ts:two", version: "v1" },
  ])]), 3);
  assert.equal(locationConflict.code, "COORDINATION_SOURCE_LOCATION_CONFLICT");
  assert.match(locationConflict.field, /findings\[0\]\.sources\[1\]\.location$/);
  assert.match(locationConflict.message, /shared-source/);
  assert.match(locationConflict.message, /src\/a\.ts:one/);
  assert.match(locationConflict.message, /src\/a\.ts:two/);
  assert.equal(locationConflict.retryable, true, "尚未持久化的报告输入校验失败允许就地修正重提");
});

test("跨 finding 的同 ID 同版本保持合法，版本不同仍拒绝；非法事实接受仍被拒绝", () => {
  const base = ok(requestEvidence(
    ok(createCoordinationState({ sessionId: "cross-finding" }, 1)),
    request(),
    2,
  ));
  const crossFindingReport = report("request-dedup-1", [
    finding([{ id: "shared-source", location: "src/a.ts:one", version: "v1" }]),
    finding([{ id: "shared-source", location: "src/a.ts:two", version: "v1" }], { findingId: "finding-dedup-2" }),
  ]);
  const state = ok(reportEvidence(base, crossFindingReport, 3));
  assert.deepEqual(state.reports[0].findings.map((item) => item.sources[0].version), ["v1", "v1"]);

  const conflicting = reportEvidence(base, report("request-dedup-1", [
    finding([{ id: "shared-source", location: "src/a.ts:one", version: "v1" }]),
    finding([{ id: "shared-source", location: "src/a.ts:one", version: "v2" }], { findingId: "finding-dedup-2" }),
  ]), 3);
  assert.equal(conflicting.code, "COORDINATION_SOURCE_VERSION_CONFLICT");

  const inferenceReport = report("request-dedup-1", [
    finding([{ id: "shared-source", location: "src/a.ts:one", version: "v1" }]),
    finding([{ id: "shared-source", location: "src/a.ts:one", version: "v1" }], {
      findingId: "inference-finding",
      classification: "inference",
    }),
  ]);
  const reported = ok(reportEvidence(base, inferenceReport, 3));
  assert.equal(reviewEvidence(reported, {
    reportId: "report-request-dedup-1",
    decision: "accept",
    acceptedEvidence: [{ findingId: "inference-finding", sourceId: "shared-source", sourceVersion: "v1" }],
  }, 4).code, "COORDINATION_ONLY_FACTS_ACCEPTABLE");
});

test("acceptedEvidence 完全一致的三元引用只保留一份，未解决缺口仍拒绝", () => {
  const base = ok(requestEvidence(
    ok(createCoordinationState({ sessionId: "review-dedup" }, 1)),
    request(),
    2,
  ));
  const reported = ok(reportEvidence(base, report("request-dedup-1", [finding([
    { id: "shared-source", location: "src/a.ts:one", version: "v1" },
  ])]), 3));
  const reference = { findingId: "finding-dedup-1", sourceId: "shared-source", sourceVersion: "v1" };
  const reviewed = ok(reviewEvidence(reported, {
    reportId: "report-request-dedup-1",
    decision: "accept",
    acceptedEvidence: [reference, { ...reference }],
    gaps: [],
  }, 4));
  assert.deepEqual(reviewed.reviews[0].acceptedEvidence, [reference]);
  assert.deepEqual(ok(getAcceptedEvidence(reviewed)), [reference]);

  const unresolvedBase = ok(requestEvidence(
    ok(createCoordinationState({ sessionId: "review-gap" }, 1)),
    request({ requestId: "request-gap-1", questionId: "gap-question" }),
    2,
  ));
  const reportedWithGap = ok(reportEvidence(unresolvedBase, report("request-gap-1", [finding([
    { id: "shared-source", location: "src/a.ts:one", version: "v1" },
  ], { questionId: "gap-question", findingId: "gap-finding" })], {
    unresolved: ["Caller behavior is still unverified."],
  }), 3));
  assert.equal(reviewEvidence(reportedWithGap, {
    reportId: "report-request-gap-1",
    decision: "accept",
    acceptedEvidence: [{ findingId: "gap-finding", sourceId: "shared-source", sourceVersion: "v1" }],
    gaps: [],
  }, 4).code, "COORDINATION_EVIDENCE_INCOMPLETE");
  assert.equal(reviewEvidence(reportedWithGap, {
    reportId: "report-request-gap-1",
    decision: "more",
    acceptedEvidence: [{ findingId: "gap-finding", sourceId: "shared-source", sourceVersion: "v1" }],
    gaps: [],
  }, 4).code, "COORDINATION_REVIEW_GAPS_MISSING");
});

async function makeHarness(directory, options = {}) {
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  await writeFile(path.join(directory, ".pi", "role-models.json"), `${JSON.stringify({
    schemaVersion: 2,
    mode: "auto",
    workflowMode: "on",
    roleModels: {
      architect: { provider: architect.provider, model: architect.id, thinkingLevel: "max" },
      "docs-commit": { provider: docs.provider, model: docs.id, thinkingLevel: "high" },
      "developer-test": { provider: developer.provider, model: developer.id, thinkingLevel: "max" },
    },
  }, null, 2)}\n`);
  const harness = createExtensionHarness(options.branch ?? [], {
    cwd: directory,
    trusted: true,
    model: options.model ?? architect,
    availableModels: [architect, docs, developer],
    sessionId: options.sessionId ?? "coordination-simplification-session",
    ...options.harnessOptions,
  });
  await emitExtensionEvent(harness, "session_start");
  return harness;
}

function execute(harness, params) {
  return harness.tools.find((tool) => tool.name === "task_workflow")
    .execute("coordination-simplification-test", params, undefined, undefined, harness.context);
}

function latestCoordination(harness) {
  return harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === COORDINATION_ENTRY_TYPE)?.data;
}

function latestWorkflow(harness) {
  return harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow")?.data;
}

async function startEvidenceHandoff(harness, request) {
  await execute(harness, { action: "request-evidence", request });
  const requestId = latestCoordination(harness).coordination.requests.at(-1).requestId;
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(harness.context.model.id, docs.id);
  const identity = await startCurrentHandoff(harness, COORDINATION_EVIDENCE_MESSAGE_TYPE);
  return { requestId, identity };
}

/** 完成一轮 派发 docs handoff → 报告 → architect 审阅，返回该轮确认的关键身份。 */
async function completeEvidenceRound(harness, { requestId, questionId, findingId, sourceId, version, statement, decision = "accept", review }) {
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(harness.context.model.id, docs.id);
  const handoff = await startCurrentHandoff(harness, COORDINATION_EVIDENCE_MESSAGE_TYPE);
  await execute(harness, {
    action: "report-evidence",
    coordinationHandoffId: handoff.handoffId,
    report: runtimeReport(requestId, [{ id: sourceId, location: "src/input.ts:parseInput", version }], {
      findings: [{ findingId, questionId, classification: "fact", statement, sources: [{ id: sourceId, location: "src/input.ts:parseInput", version }] }],
    }),
  });
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(harness.context.model.id, architect.id);
  const reportId = latestCoordination(harness).coordination.reports.at(-1).reportId;
  const reviewResult = await execute(harness, {
    action: "review-evidence",
    coordinationHandoffId: workflowMessageIdentity(harness, COORDINATION_REVIEW_MESSAGE_TYPE).handoffId,
    review: (typeof review === "function" ? review(reportId) : review) ?? {
      reportId,
      decision,
      acceptedEvidence: [{ findingId, sourceId, sourceVersion: version }],
      reason: "来源版本及问题范围匹配。",
    },
  });
  return { result: reviewResult, reportId };
}

function plannedContract(evidence, overrides = {}) {
  return {
    version: 1,
    outcome: "实现已接受证据确认的输入边界行为",
    requirementSources: ["用户需求", "已接受证据"],
    expectedBehavior: ["按已接受事实处理边界输入"],
    evidence: [evidence],
    clarificationResolutions: [],
    fixedDecisions: ["只按已接受事实处理"],
    invariants: ["不改变未确认的业务规则"],
    nonGoals: ["不扩展其他输入类型"],
    blockingQuestions: [],
    engineeringDiscretion: ["可自行选择局部 helper 边界"],
    verification: ["运行针对性验证"],
    ...overrides,
  };
}

async function startCurrentHandoff(harness, customType) {
  const identity = workflowMessageIdentity(harness, customType);
  assert.ok(identity, `missing ${customType} message`);
  await emitExtensionEvent(harness, "agent_start");
  await emitExtensionEvent(harness, "message_start", {
    message: { role: "custom", customType, details: identity },
  });
  return identity;
}

function runtimeReport(requestId, sources, overrides = {}) {
  return {
    requestId,
    findings: [{
      findingId: "runtime-finding",
      questionId: "input-boundary",
      classification: "fact",
      statement: "已核实输入来源的规范化身份。",
      sources,
    }],
    inspectedScope: ["src/input.ts"],
    testsRun: [],
    unresolved: [],
    ...overrides,
  };
}

test("报告输入校验失败可就地修正并原身份重提，成功后旧身份不能重复消费", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    await execute(harness, {
      action: "request-evidence",
      request: {
        questionId: "input-boundary",
        question: "解析入口的来源身份和冲突语义是什么？",
        rationale: "报告去重不得放宽冲突校验。",
        scope: ["src/input.ts"],
        completionCriteria: ["报告规范化来源身份与冲突结果"],
      },
    });
    const requestId = latestCoordination(harness).coordination.requests[0].requestId;

    await assert.rejects(execute(harness, {
      action: "report-evidence",
      report: runtimeReport(requestId, [{ id: "input-source", location: "src/input.ts:parseInput", version: "v1" }]),
    }), (error) => {
      assert.equal(error.code, "COORDINATION_ACTION_ROLE_FORBIDDEN");
      assert.equal(error.details?.retryable, undefined);
      return true;
    });

    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.context.model.id, docs.id);
    const docsIdentity = await startCurrentHandoff(harness, COORDINATION_EVIDENCE_MESSAGE_TYPE);
    await assert.rejects(execute(harness, {
      action: "report-evidence",
      coordinationIdentity: docsIdentity,
      report: runtimeReport(requestId, [
        { id: "input-source", location: "src/input.ts:parseInput", version: "v1" },
        { id: "input-source", location: "src/input.ts:parseOther", version: "v1" },
      ]),
    }), (error) => {
      assert.equal(error.code, "COORDINATION_SOURCE_LOCATION_CONFLICT");
      assert.match(error.details.field, /findings\[0\]\.sources\[1\]\.location$/);
      assert.equal(error.details.retryable, true);
      assert.match(error.details.nextAction, /同一身份/);
      assert.match(error.details.nextAction, /coordinationHandoffId/);
      assert.match(error.message, /input-source/);
      return true;
    });
    assert.equal(latestCoordination(harness).coordination.reports.length, 0, "校验失败不得持久化报告");
    assert.equal(latestCoordination(harness).coordination.requests[0].status, "pending");
    assert.equal(latestCoordination(harness).handoff.phase, "executing");

    const corrected = await execute(harness, {
      action: "report-evidence",
      coordinationIdentity: docsIdentity,
      report: runtimeReport(requestId, [{ id: "input-source", location: "src/input.ts:parseInput", version: "v1" }]),
    });
    assert.equal(corrected.terminate, true);
    assert.equal(latestCoordination(harness).coordination.reports.length, 1);
    assert.equal(latestCoordination(harness).coordination.requests[0].status, "reported");
    assert.equal(latestCoordination(harness).handoff.kind, "review");

    await assert.rejects(execute(harness, {
      action: "report-evidence",
      coordinationIdentity: docsIdentity,
      report: runtimeReport(requestId, [{ id: "input-source", location: "src/input.ts:parseInput", version: "v1" }]),
    }), (error) => {
      assert.equal(error.code, "COORDINATION_HANDOFF_IDENTITY_STALE");
      assert.equal(error.details?.retryable, undefined);
      return true;
    });
    await assert.rejects(execute(harness, {
      action: "report-evidence",
      coordinationIdentity: docsIdentity,
      report: null,
    }), (error) => {
      assert.equal(error.code, "COORDINATION_HANDOFF_IDENTITY_STALE", "过期身份不会被泛化为可重提的输入错误");
      assert.equal(error.details?.retryable, undefined);
      return true;
    });
    assert.equal(latestCoordination(harness).coordination.reports.length, 1, "已消费身份不能重复提交报告");
  });
});

test("工具 schema 暴露可选 coordinationHandoffId，完整身份仍然保留", () => {
  const properties = taskWorkflowParameters.properties;
  assert.equal(properties.coordinationHandoffId.type, "string");
  assert.equal(properties.coordinationHandoffId.optional, undefined);
  assert.equal(properties.coordinationIdentity.type, "object");
  assert.deepEqual(properties.coordinationIdentity.required, [
    "coordinationId", "coordinationVersion", "sessionId", "recoveryGeneration",
    "requestId", "role", "kind", "attemptId", "handoffId",
  ]);
  assert.equal(taskWorkflowParameters.required.includes("coordinationHandoffId"), false);
});

test("短引用可完成 report/review 闭环，两种输入冲突被拒，旧引用在重建 handoff 后失败", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    const { requestId, identity } = await startEvidenceHandoff(harness, {
      questionId: "input-boundary",
      question: "短引用是否能替代完整身份回传？",
      rationale: "减少机械身份回传且不降低防重放强度。",
      scope: ["src/coordination-handoff-validation.ts"],
      completionCriteria: ["短引用与完整身份等价且冲突被拒"],
    });
    const shortReference = identity.handoffId;

    await assert.rejects(execute(harness, {
      action: "report-evidence",
      coordinationHandoffId: "",
      report: runtimeReport(requestId, [{ id: "input-source", location: "src/input.ts:parseInput", version: "v1" }]),
    }), (error) => {
      assert.equal(error.code, "COORDINATION_HANDOFF_REFERENCE_INVALID");
      assert.equal(error.details?.retryable, undefined);
      return true;
    });
    await assert.rejects(execute(harness, {
      action: "report-evidence",
      coordinationHandoffId: identity.attemptId,
      report: runtimeReport(requestId, [{ id: "input-source", location: "src/input.ts:parseInput", version: "v1" }]),
    }), (error) => {
      assert.equal(error.code, "COORDINATION_HANDOFF_IDENTITY_STALE", "只有当前签发的 handoffId 不是有效引用");
      return true;
    });
    // 缺失身份不得套用当前状态
    await assert.rejects(execute(harness, {
      action: "report-evidence",
      report: runtimeReport(requestId, [{ id: "input-source", location: "src/input.ts:parseInput", version: "v1" }]),
    }), (error) => {
      assert.equal(error.code, "COORDINATION_HANDOFF_IDENTITY_MISSING");
      assert.equal(error.details?.retryable, undefined);
      return true;
    });
    // requestId 仍须属于当前交接
    await assert.rejects(execute(harness, {
      action: "report-evidence",
      coordinationHandoffId: shortReference,
      report: runtimeReport("00000000-0000-4000-8000-000000000000", [
        { id: "input-source", location: "src/input.ts:parseInput", version: "v1" },
      ]),
    }), (error) => {
      assert.equal(error.code, "COORDINATION_REQUEST_ID_MISMATCH");
      return true;
    });
    await assert.rejects(execute(harness, {
      action: "report-evidence",
      coordinationIdentity: identity,
      coordinationHandoffId: "00000000-0000-4000-8000-000000000000",
      report: runtimeReport(requestId, [{ id: "input-source", location: "src/input.ts:parseInput", version: "v1" }]),
    }), (error) => {
      assert.equal(error.code, "COORDINATION_HANDOFF_IDENTITY_STALE", "短引用过期时不得回退为完整身份");
      return true;
    });
    await assert.rejects(execute(harness, {
      action: "report-evidence",
      coordinationIdentity: { ...identity, handoffId: "00000000-0000-4000-8000-000000000000" },
      coordinationHandoffId: shortReference,
      report: runtimeReport(requestId, [{ id: "input-source", location: "src/input.ts:parseInput", version: "v1" }]),
    }), (error) => {
      assert.equal(error.code, "COORDINATION_HANDOFF_REFERENCE_CONFLICT", "两种输入显式失配不得被忽略或静默取其一");
      return true;
    });
    assert.equal(latestCoordination(harness).coordination.reports.length, 0);
    assert.equal(latestCoordination(harness).handoff.phase, "executing");

    const reported = await execute(harness, {
      action: "report-evidence",
      coordinationHandoffId: shortReference,
      report: runtimeReport(requestId, [{ id: "input-source", location: "src/input.ts:parseInput", version: "v1" }]),
    });
    assert.equal(reported.terminate, true);
    assert.equal(latestCoordination(harness).coordination.requests[0].status, "reported");
    assert.equal(latestCoordination(harness).handoff.kind, "review");

    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.context.model.id, architect.id);
    const reviewIdentity = await startCurrentHandoff(harness, COORDINATION_REVIEW_MESSAGE_TYPE);
    assert.notEqual(reviewIdentity.handoffId, shortReference);
    await assert.rejects(execute(harness, {
      action: "review-evidence",
      coordinationHandoffId: shortReference,
      review: { reportId: latestCoordination(harness).handoff.reportId, decision: "accept", acceptedEvidence: [] },
    }), (error) => {
      assert.equal(error.code, "COORDINATION_HANDOFF_IDENTITY_STALE", "同一请求重建 handoff 后旧短引用失效");
      return true;
    });

    const reportId = latestCoordination(harness).handoff.reportId;
    const reviewed = await execute(harness, {
      action: "review-evidence",
      coordinationHandoffId: reviewIdentity.handoffId,
      review: {
        reportId,
        decision: "accept",
        acceptedEvidence: [{ findingId: "runtime-finding", sourceId: "input-source", sourceVersion: "v1" }],
        reason: "来源版本匹配。",
      },
    });
    assert.equal(reviewed.terminate, false);
    assert.equal(latestCoordination(harness).coordination.phase, "ready");
    assert.equal(latestCoordination(harness).handoff, undefined);
  });
});

test("短引用触发的 review 后可用同一引用创建补查请求并完成带契约规划", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    const { requestId } = await startEvidenceHandoff(harness, {
      questionId: "follow-up",
      question: "直接调用方目前如何处理解析失败？",
      rationale: "任务契约依赖当前调用方行为。",
      scope: ["src/input.ts"],
      completionCriteria: ["报告调用方行为及来源版本"],
    });
    await completeEvidenceRound(harness, {
      requestId,
      questionId: "follow-up",
      findingId: "caller-behavior",
      sourceId: "input-source",
      version: "v1",
      statement: "直接调用方将失败渲染为校验错误。",
      decision: "more",
      review: (reportId) => ({
        reportId,
        decision: "more",
        gaps: ["需要核对失败时的重试语义"],
        reason: "当前报告未覆盖重试路径。",
      }),
    });
    const reviewReference = workflowMessageIdentity(harness, COORDINATION_REVIEW_MESSAGE_TYPE).handoffId;
    const reviewMessage = harness.branch.findLast((entry) => entry.type === "custom_message"
      && entry.customType === COORDINATION_REVIEW_MESSAGE_TYPE);
    assert.match(reviewMessage.content, /可核对引用/);
    assert.match(reviewMessage.content, /caller-behavior · input-source · v1/);

    const followUp = await execute(harness, {
      action: "request-evidence",
      coordinationHandoffId: reviewReference,
      request: {
        question: "失败时是否会重复提交持久化写操作？",
        questionId: "follow-up",
        rationale: "重试语义影响实现契约。",
        scope: ["src/input.ts"],
        completionCriteria: ["报告重试路径及来源版本"],
        addressesGaps: ["需要核对失败时的重试语义"],
        followUpOfRequestId: requestId,
      },
    });
    assert.equal(followUp.terminate, true);
    const followUpId = latestCoordination(harness).coordination.requests.at(-1).requestId;

    const accepted = await completeEvidenceRound(harness, {
      requestId: followUpId,
      questionId: "follow-up",
      findingId: "retry-semantics",
      sourceId: "input-source",
      version: "v2",
      statement: "失败路径不会重复提交持久化写操作。",
    });
    assert.equal(accepted.result.terminate, false);
    assert.equal(latestCoordination(harness).coordination.phase, "ready");

    // 未接受的早期事实仍拒绝：契约不得引用未被接受的来源
    await assert.rejects(execute(harness, {
      action: "plan",
      summary: "引用未接受来源的计划必须被拒",
      constraints: ["只按已接受证据实现"],
      tasks: [{
        id: "stale-source-task",
        task: "实现已确认的边界行为",
        files: ["src/input.ts"],
        acceptanceCriteria: ["针对性验证通过"],
        contract: plannedContract({ findingId: "caller-behavior", sourceId: "input-source", sourceVersion: "v1" }),
      }],
    }), (error) => error.code === "TASK_CONTRACT_EVIDENCE_UNACCEPTED");
    assert.equal(latestWorkflow(harness), undefined, "来源未接受时不得保存计划");

    await execute(harness, {
      action: "plan",
      summary: "依据已接受证据实现边界行为",
      constraints: ["只按已接受证据实现"],
      tasks: [{
        id: "short-reference-task",
        task: "实现已确认的边界行为",
        files: ["src/input.ts"],
        acceptanceCriteria: ["针对性验证通过"],
        contract: plannedContract({ findingId: "retry-semantics", sourceId: "input-source", sourceVersion: "v2" }),
      }],
    });
    assert.equal(latestWorkflow(harness)?.tasks.length, 1);
    assert.equal(latestWorkflow(harness).tasks[0].contract.evidence.length, 1);
    assert.equal(latestCoordination(harness).coordination.workflowLink.planVersion, 0, "带契约计划必须绑定当前协调账本");
  });
});

test("短引用路径下来源版本过期仍阻止带契约规划", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    const first = await startEvidenceHandoff(harness, {
      questionId: "stale-question",
      question: "当前共享来源的版本是什么？",
      rationale: "开发契约必须引用未过期的来源版本。",
      scope: ["src/input.ts"],
      completionCriteria: ["报告当前来源版本"],
    });
    await completeEvidenceRound(harness, {
      requestId: first.requestId,
      questionId: "stale-question",
      findingId: "stale-fact",
      sourceId: "shared-source",
      version: "v1",
      statement: "共享来源当前版本为 v1。",
    });

    const later = await startEvidenceHandoff(harness, {
      questionId: "later-question",
      question: "共享来源是否已更新？",
      rationale: "后续取证会改变同一来源的最新版本。",
      scope: ["src/input.ts"],
      completionCriteria: ["报告最新来源版本"],
    });
    await completeEvidenceRound(harness, {
      requestId: later.requestId,
      questionId: "later-question",
      findingId: "later-fact",
      sourceId: "shared-source",
      version: "v2",
      statement: "共享来源已更新到 v2。",
    });

    await assert.rejects(execute(harness, {
      action: "plan",
      summary: "引用已过期来源版本的计划必须被拒",
      constraints: ["只按当前来源版本实现"],
      tasks: [{
        id: "stale-version-task",
        task: "实现已确认的边界行为",
        files: ["src/input.ts"],
        acceptanceCriteria: ["针对性验证通过"],
        contract: plannedContract({ findingId: "stale-fact", sourceId: "shared-source", sourceVersion: "v1" }),
      }],
    }), (error) => error.code === "COORDINATION_EVIDENCE_VERSION_STALE");
    assert.equal(latestWorkflow(harness), undefined, "来源版本过期时不得保存或派发计划");
  });
});

test("短引用仍受角色、branch 与阶段守卫约束，且不推进状态", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    const request = {
      questionId: "input-boundary",
      question: "短引用的守卫是否与完整身份一致？",
      rationale: "短引用不是新的权限凭证。",
      scope: ["src/input.ts"],
      completionCriteria: ["角色、branch 与阶段不满足时一律拒绝"],
    };
    await execute(harness, { action: "request-evidence", request });
    const requestId = latestCoordination(harness).coordination.requests[0].requestId;
    const preparedReference = latestCoordination(harness).handoff.handoffId;

    // 角色守卫：architect 不能提交 docs-commit 的报告
    await assert.rejects(execute(harness, {
      action: "report-evidence",
      coordinationHandoffId: preparedReference,
      report: runtimeReport(requestId, [{ id: "input-source", location: "src/input.ts:parseInput", version: "v1" }]),
    }), (error) => {
      assert.equal(error.code, "COORDINATION_ACTION_ROLE_FORBIDDEN");
      assert.equal(error.details?.retryable, undefined);
      return true;
    });

    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.context.model.id, docs.id);
    const queuedReference = workflowMessageIdentity(harness, COORDINATION_EVIDENCE_MESSAGE_TYPE).handoffId;
    const messageIndex = harness.branch.findIndex((entry) => entry.type === "custom_message"
      && entry.customType === COORDINATION_EVIDENCE_MESSAGE_TYPE);
    assert.notEqual(messageIndex, -1);
    harness.branch.splice(messageIndex, 1);
    await assert.rejects(execute(harness, {
      action: "report-evidence",
      coordinationHandoffId: queuedReference,
      report: runtimeReport(requestId, [{ id: "input-source", location: "src/input.ts:parseInput", version: "v1" }]),
    }), (error) => {
      assert.equal(error.code, "COORDINATION_HANDOFF_BRANCH_MISMATCH", "短引用也必须匹配当前 branch 交接消息");
      return true;
    });
    assert.equal(latestCoordination(harness).coordination.reports.length, 0);
    assert.equal(latestCoordination(harness).coordination.requests[0].status, "pending");
  });

  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory, {
      harnessOptions: {
        beforeSendMessagePersist(message) {
          if (message.customType === COORDINATION_EVIDENCE_MESSAGE_TYPE) throw new Error("模拟协作消息派发失败");
        },
      },
    });
    await execute(harness, {
      action: "request-evidence",
      request: {
        questionId: "blocked-phase",
        question: "已阻塞的 handoff 是否可提交？",
        rationale: "未知结果的 handoff 不得被消费。",
        scope: ["src/input.ts"],
        completionCriteria: ["阻塞阶段拒绝提交"],
      },
    });
    const requestId = latestCoordination(harness).coordination.requests[0].requestId;
    const preparedReference = latestCoordination(harness).handoff.handoffId;
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(latestCoordination(harness).handoff.phase, "blocked");
    await assert.rejects(execute(harness, {
      action: "report-evidence",
      coordinationHandoffId: preparedReference,
      report: runtimeReport(requestId, [{ id: "input-source", location: "src/input.ts:parseInput", version: "v1" }]),
    }), (error) => {
      assert.equal(error.code, "COORDINATION_HANDOFF_NOT_ACTIVE", "不可提交阶段必须拒绝短引用回调");
      return true;
    });
    assert.equal(latestCoordination(harness).coordination.reports.length, 0);
    assert.equal(latestCoordination(harness).handoff.phase, "blocked");

    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    await switchRole.execute("retry-as-architect", { role: "architect" }, undefined, undefined, harness.context);
    const blockedReference = latestCoordination(harness).handoff.handoffId;
    const retry = await execute(harness, {
      action: "request-evidence",
      coordinationHandoffId: blockedReference,
      request: {
        requestId,
        questionId: "blocked-phase",
        question: "已阻塞的 handoff 是否可提交？",
        rationale: "未知结果的 handoff 不得被消费。",
        scope: ["src/input.ts"],
        completionCriteria: ["阻塞阶段拒绝提交"],
        refreshReason: "核对未知结果后显式创建新 attempt。",
      },
    });
    assert.equal(retry.terminate, true);
    assert.notEqual(latestCoordination(harness).handoff.handoffId, blockedReference, "显式重试必须创建新 handoff 身份");
  });
});

test("跨 session 的短引用不会恢复协调状态或写入报告", async () => {
  await withTempDirectory(async (directory) => {
    const first = await makeHarness(directory);
    await execute(first, {
      action: "request-evidence",
      request: {
        questionId: "session-reference",
        question: "核实短引用的 session 绑定",
        rationale: "旧 session 引用必须拒绝",
        scope: ["src/input.ts"],
        completionCriteria: ["短引用不能跨 session 使用"],
      },
    });
    const shortReference = latestCoordination(first).handoff.handoffId;
    const branch = [...first.branch];
    const second = await makeHarness(directory, { branch, sessionId: "other-session", model: docs });
    await assert.rejects(execute(second, {
      action: "report-evidence",
      coordinationHandoffId: shortReference,
      report: runtimeReport(latestCoordination(second).coordination.requests[0].requestId, [
        { id: "input-source", location: "src/input.ts:parseInput", version: "v1" },
      ]),
    }), (error) => {
      assert.ok(
        ["COORDINATION_STATE_MISSING", "COORDINATION_SESSION_MISMATCH"].includes(error.code),
        `跨 session 必须拒绝短引用，实际：${error.code}`,
      );
      return true;
    });
    const secondStatus = await execute(second, { action: "status" });
    assert.equal(secondStatus.details.coordination.error.code, "COORDINATION_SESSION_MISMATCH");
    assert.equal(second.branch.filter((entry) => entry.type === "custom" && entry.customType === COORDINATION_ENTRY_TYPE).length, 1,
      "跨 session 不得写入新的协作记录");
    assert.equal(latestCoordination(second).coordination.reports.length, 0);
  });
});
