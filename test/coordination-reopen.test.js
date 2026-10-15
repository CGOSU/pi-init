import assert from "node:assert/strict";
import test from "node:test";

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

const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
const docs = { provider: "openai-codex", id: "gpt-5.6-docs" };
const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };

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
    model: architect,
    availableModels: [architect, docs, developer],
    sessionId: "coordination-reopen-session",
    ...options.harnessOptions,
  });
  await emitExtensionEvent(harness, "session_start");
  return harness;
}

function execute(harness, params) {
  return harness.tools.find((tool) => tool.name === "task_workflow")
    .execute("coordination-reopen-test", params, undefined, undefined, harness.context);
}

function latestCoordination(harness) {
  return harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === COORDINATION_ENTRY_TYPE)?.data;
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

async function createBlockedReview(harness) {
  const requestResult = await execute(harness, {
    action: "request-evidence",
    request: {
      questionId: "reopen-question",
      question: "核对待审报告中的事实。",
      rationale: "此事实决定后续方案是否就绪。",
      scope: ["src/reopen-target.ts", "test/reopen-target.test.js"],
      completionCriteria: ["报告可追溯事实与来源版本"],
    },
  });
  assert.equal(requestResult.terminate, true);
  const requestId = latestCoordination(harness).coordination.requests[0].requestId;
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(harness.context.model.id, docs.id);
  const evidenceIdentity = await startCurrentHandoff(harness, COORDINATION_EVIDENCE_MESSAGE_TYPE);
  const reportResult = await execute(harness, {
    action: "report-evidence",
    coordinationIdentity: evidenceIdentity,
    report: {
      reportId: "report-reopen-target",
      findings: [{
        findingId: "reopen-fact",
        questionId: "reopen-question",
        classification: "fact",
        statement: "已提供可核对的边界事实。",
        sources: [{ id: "src-reopen", location: "src/reopen-target.ts:parse", version: "source-v1" }],
      }],
      inspectedScope: ["src/reopen-target.ts"],
      testsLocated: ["test/reopen-target.test.js"],
      testsRun: [],
      unresolved: [],
    },
  });
  assert.equal(reportResult.terminate, true);
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(harness.context.model.id, architect.id);
  const reviewIdentity = await startCurrentHandoff(harness, COORDINATION_REVIEW_MESSAGE_TYPE);
  const blockResult = await execute(harness, {
    action: "review-evidence",
    coordinationIdentity: reviewIdentity,
    review: {
      reportId: "report-reopen-target",
      decision: "block",
      reason: "本轮审阅明确阻塞，等待用户确认后重开。",
    },
  });
  assert.equal(latestCoordination(harness).coordination.phase, "blocked");
  assert.equal(latestCoordination(harness).handoff, undefined);
  return { requestId, reportId: "report-reopen-target", oldIdentity: reviewIdentity };
}

async function reopenCommand(harness, reportId, reason = "用户明确要求重新审阅原报告。") {
  await harness.commands.get("pi-init").handler(`coordination reopen ${reportId} ${reason}`, harness.context);
}

test("显式重开保留 block 审计、轮换身份并只派发同报告的 architect 复审", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    const { requestId, reportId, oldIdentity } = await createBlockedReview(harness);
    const before = latestCoordination(harness);
    const originalReport = structuredClone(before.coordination.reports[0]);
    const originalBlock = structuredClone(before.coordination.reviews[0]);

    await reopenCommand(harness, reportId, "用户授权基于同一证据重新审阅");

    const current = latestCoordination(harness);
    assert.equal(current.coordination.phase, "evidence-review");
    assert.equal(current.coordination.requests[0].status, "reported");
    assert.deepEqual(current.coordination.reports[0], originalReport);
    assert.deepEqual(current.coordination.reviews[0], originalBlock);
    assert.equal(current.coordination.reviewReopenings.length, 1);
    assert.equal(current.coordination.reviewReopenings[0].requestId, requestId);
    assert.equal(current.coordination.reviewReopenings[0].reportId, reportId);
    assert.equal(current.coordination.reviewReopenings[0].previousReviewId, originalBlock.reviewId);
    assert.equal(current.coordination.reviewReopenings[0].reason, "用户授权基于同一证据重新审阅");
    assert.equal(current.handoff.role, "architect");
    assert.equal(current.handoff.kind, "review");
    assert.equal(current.handoff.requestId, requestId);
    assert.equal(current.handoff.reportId, reportId);
    assert.notEqual(current.handoff.handoffId, oldIdentity.handoffId);
    assert.notEqual(current.handoff.attemptId, oldIdentity.attemptId);
    assert.equal(current.coordination.reviews.length, 1, "重开不自动接受或新增审阅决定");
    assert.equal(current.coordination.requests[0].status, "reported", "重开后必须等待 architect 再审");

    const newMessage = harness.sentMessages.findLast(({ message }) => message.customType === COORDINATION_REVIEW_MESSAGE_TYPE)?.message;
    assert.ok(newMessage);
    const reopenEntryIndex = harness.branch.findIndex((entry) => entry.type === "custom"
      && entry.customType === COORDINATION_ENTRY_TYPE
      && entry.data.coordination.reviewReopenings.length === 1
      && entry.data.handoff?.phase === "prepared");
    const dispatchedMessageIndex = harness.branch.findIndex((entry) => entry.type === "custom_message"
      && entry.customType === COORDINATION_REVIEW_MESSAGE_TYPE
      && entry.details.handoffId === current.handoff.handoffId);
    assert.ok(reopenEntryIndex >= 0 && dispatchedMessageIndex > reopenEntryIndex, "重开记录持久化必须先于复审消息派发");
    assert.match(newMessage.content, /显式重开审阅/);
    assert.match(newMessage.content, /用户授权基于同一证据重新审阅/);
    assert.match(newMessage.content, /review-block|阻塞/);
    const newIdentity = workflowMessageIdentity(harness, COORDINATION_REVIEW_MESSAGE_TYPE);
    await assert.rejects(execute(harness, {
      action: "review-evidence",
      coordinationIdentity: oldIdentity,
      review: { reportId, decision: "accept", acceptedEvidence: [] },
    }), (error) => error.code === "COORDINATION_HANDOFF_IDENTITY_STALE");
    assert.notEqual(newIdentity.handoffId, oldIdentity.handoffId);

    const statusResult = await execute(harness, { action: "status" });
    assert.equal(statusResult.details.coordination.reviewReopenings[0].reason, "用户授权基于同一证据重新审阅");
    assert.equal(harness.sentMessages.some(({ message }) => message.customType === "pi-init-workflow-task"), false);

    const persistedBranch = [...harness.branch];
    const reloaded = await makeHarness(directory, { branch: persistedBranch });
    const restored = latestCoordination(reloaded);
    assert.equal(restored.coordination.reviewReopenings[0].reason, "用户授权基于同一证据重新审阅");
    assert.equal(restored.coordination.reports[0].reportId, reportId);
    assert.equal(restored.coordination.reviews[0].reviewId, originalBlock.reviewId);
    const restoredReviewIdentity = await startCurrentHandoff(reloaded, COORDINATION_REVIEW_MESSAGE_TYPE);
    assert.notEqual(restoredReviewIdentity.handoffId, newIdentity.handoffId);

    await execute(reloaded, {
      action: "review-evidence",
      coordinationIdentity: restoredReviewIdentity,
      review: {
        reportId,
        decision: "accept",
        acceptedEvidence: [{ findingId: "reopen-fact", sourceId: "src-reopen", sourceVersion: "source-v1" }],
        reason: "复审后明确接受来源匹配的事实。",
      },
    });
    const accepted = latestCoordination(reloaded).coordination;
    assert.equal(accepted.phase, "ready");
    assert.deepEqual(accepted.reviews.map((review) => review.decision), ["block", "accept"]);
    assert.equal(accepted.reviews[1].reopeningId, accepted.reviewReopenings[0].reopeningId);
  });
});

test("重开审阅在项目不可信、Agent 忙碌或 append 失败时不派发也不推进状态", async () => {
  await withTempDirectory(async (directory) => {
    let failAppend = false;
    const harness = await makeHarness(directory, {
      harnessOptions: { appendEntry() { if (failAppend) throw new Error("simulated append failure"); } },
    });
    const { reportId } = await createBlockedReview(harness);
    const blocked = latestCoordination(harness);
    const messageCount = harness.sentMessages.length;

    harness.context.isProjectTrusted = () => false;
    await reopenCommand(harness, reportId);
    assert.match(harness.notifications.at(-1).message, /COORDINATION_REOPEN_UNTRUSTED/);
    assert.equal(latestCoordination(harness).coordination.phase, "blocked");
    assert.equal(latestCoordination(harness).coordination.reviewReopenings.length, 0);
    assert.equal(harness.sentMessages.length, messageCount);

    harness.context.isProjectTrusted = () => true;
    harness.context.isIdle = () => false;
    await reopenCommand(harness, reportId);
    assert.match(harness.notifications.at(-1).message, /COORDINATION_REOPEN_BUSY/);
    assert.equal(latestCoordination(harness), blocked);
    assert.equal(harness.sentMessages.length, messageCount);

    harness.context.isIdle = () => true;
    failAppend = true;
    await reopenCommand(harness, reportId);
    failAppend = false;
    assert.equal(latestCoordination(harness), blocked);
    assert.equal(latestCoordination(harness).coordination.reviewReopenings.length, 0);
    assert.equal(harness.sentMessages.length, messageCount);
  });
});

test("恢复状态损坏时重开命令保持 fail-closed", async () => {
  await withTempDirectory(async (directory) => {
    const invalidStateBranch = [{
      type: "custom",
      customType: COORDINATION_ENTRY_TYPE,
      data: { runtimeVersion: 999 },
    }];
    const harness = await makeHarness(directory, { branch: invalidStateBranch });
    const beforeBranchLength = harness.branch.length;
    await reopenCommand(harness, "report-not-readable", "恢复失败时不得重开");
    assert.match(harness.notifications.at(-1).message, /COORDINATION_REOPEN_RECOVERY_REQUIRED/);
    assert.equal(harness.branch.length, beforeBranchLength);
    assert.equal(harness.sentMessages.length, 0);
    assert.match(harness.notifications.at(-1).message, /COORDINATION_REOPEN_RECOVERY_REQUIRED/);
  });
});

test("存在结果未知的活动 handoff 时不能用重开审阅重放派发", async () => {
  await withTempDirectory(async (directory) => {
    let failSend = false;
    const harness = await makeHarness(directory, {
      harnessOptions: {
        beforeSendMessagePersist() {
          if (failSend) throw new Error("simulated uncertain dispatch");
        },
      },
    });
    await execute(harness, {
      action: "request-evidence",
      request: {
        questionId: "unknown-handoff",
        question: "核对尚未执行的请求。",
        rationale: "用于验证未知派发结果隔离。",
        scope: ["src/unknown.ts"],
        completionCriteria: ["确认未知结果不能被重开命令重放"],
      },
    });
    failSend = true;
    await emitExtensionEvent(harness, "agent_settled");
    const unknown = latestCoordination(harness);
    assert.equal(unknown.handoff.phase, "blocked");
    assert.equal(unknown.handoff.failure.code, "COORDINATION_DISPATCH_OUTCOME_UNKNOWN");
    const messageCount = harness.sentMessages.length;

    await reopenCommand(harness, "report-not-present", "不能消费未知结果");

    assert.match(harness.notifications.at(-1).message, /COORDINATION_REOPEN_HANDOFF_ACTIVE/);
    assert.equal(latestCoordination(harness), unknown);
    assert.equal(latestCoordination(harness).handoff.failure.code, "COORDINATION_DISPATCH_OUTCOME_UNKNOWN");
    assert.equal(harness.sentMessages.length, messageCount);
  });
});
