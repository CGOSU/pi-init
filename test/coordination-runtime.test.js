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
    workflowMode: options.workflowMode ?? "on",
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
    sessionId: options.sessionId ?? "coordination-session",
    ...options.harnessOptions,
  });
  await emitExtensionEvent(harness, "session_start");
  return harness;
}

function workflowTool(harness) {
  return harness.tools.find((tool) => tool.name === "task_workflow");
}

function execute(harness, params) {
  return workflowTool(harness).execute("coordination-test", params, undefined, undefined, harness.context);
}

function latestCoordination(harness) {
  return harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === COORDINATION_ENTRY_TYPE)?.data;
}

function actionIdentityFromHandoff(saved) {
  const { coordination, sessionId, recoveryGeneration, handoff } = saved;
  return {
    coordinationId: coordination.coordinationId,
    coordinationVersion: coordination.version,
    sessionId,
    recoveryGeneration,
    requestId: handoff.requestId,
    role: handoff.role,
    kind: handoff.kind,
    attemptId: handoff.attemptId,
    handoffId: handoff.handoffId,
    ...(handoff.reportId ? { reportId: handoff.reportId } : {}),
  };
}

function taskPlan() {
  return {
    action: "plan",
    summary: "依据已审阅证据实现边界行为",
    constraints: ["只按已接受证据中的固定事实实现"],
    tasks: [{
      id: "implementation",
      task: "实现已确认的边界行为",
      files: ["src/feature.ts"],
      acceptanceCriteria: ["针对性验证通过"],
      contract: {
        version: 1,
        outcome: "实现输入边界行为",
        requirementSources: ["用户需求", "已接受证据 caller-finding"],
        expectedBehavior: ["按已接受事实处理边界输入"],
        evidence: [{ findingId: "caller-finding", sourceId: "input-source", sourceVersion: "source-v2" }],
        clarificationResolutions: [],
        fixedDecisions: ["只按已接受事实处理"],
        invariants: ["不改变未确认的业务规则"],
        nonGoals: ["不扩展其他输入类型"],
        blockingQuestions: [],
        engineeringDiscretion: ["可自行选择局部 helper 边界"],
        verification: ["运行针对性验证"],
      },
    }],
  };
}

function reportFor(requestId, { reportId, findingId, sourceVersion, statement, questionId = "input-boundary" }) {
  return {
    ...(reportId ? { reportId } : {}),
    requestId,
    findings: [{
      findingId,
      questionId,
      classification: "fact",
      statement,
      sources: [{ id: "input-source", location: "src/input.ts:parseInput", version: sourceVersion }],
    }],
    inspectedScope: ["src/input.ts", "test/input.test.js"],
    testsLocated: ["test/input.test.js"],
    testsRun: [],
    unresolved: [],
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

test("取证请求→docs 报告→架构补查→再次报告/审阅形成可恢复闭环，未就绪不派发开发", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory, { workflowMode: "auto" });
    const request = {
      questionId: "input-boundary",
      question: "解析入口的边界输入契约和直接调用方是什么？",
      rationale: "开发契约依赖当前实现和调用方行为，不能由架构师猜测。",
      scope: ["src/input.ts::parseInput", "直接调用方", "test/input.test.js"],
      exclusions: ["不修改实现", "不运行无关全量验证"],
      completionCriteria: ["报告当前实现、直接调用方和相关测试证据", "区分事实、推断和未知项"],
    };

    const requested = await execute(harness, { action: "request-evidence", request });
    assert.equal(requested.terminate, true);
    const firstRequestId = latestCoordination(harness).coordination.requests[0].requestId;
    assert.equal(latestCoordination(harness).handoff.phase, "prepared");
    await assert.rejects(execute(harness, taskPlan()), (error) => error.code === "COORDINATION_EVIDENCE_INCOMPLETE");
    await assert.rejects(execute(harness, {
      action: "report-evidence",
      coordinationIdentity: actionIdentityFromHandoff(latestCoordination(harness)),
      report: reportFor(firstRequestId, {
        findingId: "first-finding", sourceVersion: "source-v1", statement: "未派发结果不能由 architect 伪造。",
      }),
    }), (error) => error.code === "COORDINATION_ACTION_ROLE_FORBIDDEN");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 0);

    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.context.model.id, docs.id);
    const docsIdentity = await startCurrentHandoff(harness, COORDINATION_EVIDENCE_MESSAGE_TYPE);

    const firstReport = await execute(harness, {
      action: "report-evidence",
      coordinationIdentity: docsIdentity,
      report: reportFor(firstRequestId, {
        findingId: "first-finding", sourceVersion: "source-v1", statement: "已核实输入解析函数的公开行为。",
      }),
    });
    assert.equal(firstReport.terminate, true);
    const beforeReviewRestore = latestCoordination(harness);
    const staleReviewIdentity = actionIdentityFromHandoff(beforeReviewRestore);
    assert.equal(beforeReviewRestore.handoff.kind, "review");
    await assert.rejects(execute(harness, {
      action: "report-evidence",
      coordinationIdentity: docsIdentity,
      report: reportFor(firstRequestId, {
        findingId: "duplicate-finding", sourceVersion: "source-v1", statement: "重复报告不得推进状态。",
      }),
    }), (error) => error.code === "COORDINATION_HANDOFF_IDENTITY_STALE");
    await emitExtensionEvent(harness, "session_start");
    assert.equal(harness.context.model.id, architect.id);
    assert.equal(latestCoordination(harness).handoff.phase, "queued");
    const reviewIdentity = workflowMessageIdentity(harness, COORDINATION_REVIEW_MESSAGE_TYPE);
    assert.notEqual(reviewIdentity.handoffId, staleReviewIdentity.handoffId);
    await assert.rejects(
      execute(harness, {
        action: "review-evidence",
        coordinationIdentity: staleReviewIdentity,
        review: { reportId: staleReviewIdentity.reportId, decision: "more", gaps: ["过期回调"] },
      }),
      (error) => error.code === "COORDINATION_HANDOFF_IDENTITY_STALE",
    );

    const firstReportId = latestCoordination(harness).coordination.reports[0].reportId;
    const reviewedMore = await execute(harness, {
      action: "review-evidence",
      coordinationIdentity: reviewIdentity,
      review: {
        reportId: firstReportId,
        decision: "more",
        gaps: ["需要核对直接调用方对无效输入的实际处理"],
        reason: "当前报告没有给出直接调用方证据。",
      },
    });
    assert.equal(reviewedMore.terminate, false);
    const followup = await execute(harness, {
      action: "request-evidence",
      coordinationIdentity: reviewIdentity,
      request: {
        ...request,
        question: "直接调用方如何处理解析失败？",
        scope: ["src/input.ts::parseInput", "所有直接调用方", "test/input.test.js"],
        addressesGaps: ["需要核对直接调用方对无效输入的实际处理"],
        followUpOfRequestId: firstRequestId,
      },
    });
    assert.equal(followup.terminate, true);
    assert.equal(latestCoordination(harness).coordination.requests.length, 2);

    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.context.model.id, docs.id);
    const followupId = latestCoordination(harness).coordination.requests[1].requestId;
    const followupIdentity = await startCurrentHandoff(harness, COORDINATION_EVIDENCE_MESSAGE_TYPE);
    await execute(harness, {
      action: "report-evidence",
      coordinationIdentity: followupIdentity,
      report: reportFor(followupId, {
        findingId: "caller-finding", sourceVersion: "source-v2", statement: "已核实直接调用方对失败结果的处理。",
      }),
    });
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.context.model.id, architect.id);
    const finalReviewIdentity = workflowMessageIdentity(harness, COORDINATION_REVIEW_MESSAGE_TYPE);
    const latestReport = latestCoordination(harness).coordination.reports.at(-1);
    const acceptedReview = await execute(harness, {
      action: "review-evidence",
      coordinationIdentity: finalReviewIdentity,
      review: {
        reportId: latestReport.reportId,
        decision: "accept",
        acceptedEvidence: [{ findingId: "caller-finding", sourceId: "input-source", sourceVersion: "source-v2" }],
        reason: "事实来源及版本匹配，关键缺口已解决。",
      },
    });
    assert.equal(acceptedReview.terminate, false);
    assert.equal(latestCoordination(harness).coordination.phase, "ready");
    assert.equal(latestCoordination(harness).handoff, undefined);

    await execute(harness, taskPlan());
    assert.equal(harness.branch.some((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow"), true);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 0);

    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.context.model.id, developer.id);
    const developerHandoff = harness.sentMessages.findLast(({ message }) => message.customType === "pi-init-workflow-task")?.message;
    assert.ok(developerHandoff, "only the accepted second-round evidence should open a developer handoff");
    assert.match(developerHandoff.content, /caller-finding/);
    assert.match(developerHandoff.content, /source-v2/);
  });
});

test("prepared handoff 恢复使用新身份，executing handoff 恢复则 fail-closed", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    await execute(harness, {
      action: "request-evidence",
      request: {
        questionId: "handoff-recovery",
        question: "核实取证 handoff 的恢复边界",
        rationale: "未执行派发可以重建身份，已执行结果未知时不得重放",
        scope: ["src/runtime.ts"],
        completionCriteria: ["prepared 创建新 identity；executing 进入未知结果阻塞"],
      },
    });
    const prepared = latestCoordination(harness);
    const stalePreparedIdentity = actionIdentityFromHandoff(prepared);
    assert.equal(prepared.handoff.phase, "prepared");

    await emitExtensionEvent(harness, "session_start");
    const recoveredPrepared = latestCoordination(harness);
    assert.equal(recoveredPrepared.handoff.phase, "queued");
    assert.notEqual(recoveredPrepared.handoff.attemptId, stalePreparedIdentity.attemptId);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === COORDINATION_EVIDENCE_MESSAGE_TYPE).length, 1);
    await assert.rejects(execute(harness, {
      action: "report-evidence",
      coordinationIdentity: stalePreparedIdentity,
      report: reportFor(stalePreparedIdentity.requestId, {
        findingId: "stale-prepared", sourceVersion: "v1", statement: "旧 prepared identity 被拒绝。",
      }),
    }), (error) => error.code === "COORDINATION_HANDOFF_IDENTITY_STALE");

    const docsIdentity = await startCurrentHandoff(harness, COORDINATION_EVIDENCE_MESSAGE_TYPE);
    assert.equal(latestCoordination(harness).handoff.phase, "executing");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === COORDINATION_EVIDENCE_MESSAGE_TYPE).length, 1);

    await emitExtensionEvent(harness, "session_start");
    const blocked = latestCoordination(harness);
    assert.equal(blocked.handoff.phase, "blocked");
    assert.equal(blocked.handoff.failure.code, "COORDINATION_DISPATCH_OUTCOME_UNKNOWN");
    await assert.rejects(execute(harness, {
      action: "report-evidence",
      coordinationIdentity: docsIdentity,
      report: reportFor(docsIdentity.requestId, {
        findingId: "stale-executing", sourceVersion: "v1", statement: "恢复前的 executing 结果不能提交。",
      }),
    }), (error) => error.code === "COORDINATION_HANDOFF_IDENTITY_STALE");
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === COORDINATION_EVIDENCE_MESSAGE_TYPE).length, 1);
  });
});

test("最新来源版本变化会使旧问题证据失效并阻止开发规划", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    const firstRequest = {
      questionId: "source-contract",
      question: "核实输入函数契约",
      rationale: "计划依赖当前来源版本",
      scope: ["src/input.ts"],
      completionCriteria: ["接受当前事实来源"],
    };
    await execute(harness, { action: "request-evidence", request: firstRequest });
    await emitExtensionEvent(harness, "agent_settled");
    const firstRequestId = latestCoordination(harness).coordination.requests[0].requestId;
    const firstEvidenceIdentity = workflowMessageIdentity(harness, COORDINATION_EVIDENCE_MESSAGE_TYPE);
    await execute(harness, {
      action: "report-evidence",
      coordinationIdentity: firstEvidenceIdentity,
      report: reportFor(firstRequestId, {
        findingId: "input-contract-v1", questionId: "source-contract", sourceVersion: "source-v1", statement: "已核实来源 v1。",
      }),
    });
    await emitExtensionEvent(harness, "agent_settled");
    const firstReviewIdentity = workflowMessageIdentity(harness, COORDINATION_REVIEW_MESSAGE_TYPE);
    const firstReportId = latestCoordination(harness).coordination.reports[0].reportId;
    await execute(harness, {
      action: "review-evidence",
      coordinationIdentity: firstReviewIdentity,
      review: {
        reportId: firstReportId,
        decision: "accept",
        acceptedEvidence: [{ findingId: "input-contract-v1", sourceId: "input-source", sourceVersion: "source-v1" }],
      },
    });

    await execute(harness, {
      action: "request-evidence",
      request: {
        questionId: "caller-contract",
        question: "核实调用方处理",
        rationale: "最新实现变更可能影响已接受来源",
        scope: ["src/input.ts", "直接调用方"],
        completionCriteria: ["接受来源当前版本"],
      },
    });
    await emitExtensionEvent(harness, "agent_settled");
    const secondRequestId = latestCoordination(harness).coordination.requests[1].requestId;
    const secondEvidenceIdentity = workflowMessageIdentity(harness, COORDINATION_EVIDENCE_MESSAGE_TYPE);
    await execute(harness, {
      action: "report-evidence",
      coordinationIdentity: secondEvidenceIdentity,
      report: reportFor(secondRequestId, {
        findingId: "caller-contract-v2", questionId: "caller-contract", sourceVersion: "source-v2", statement: "已核实来源 v2。",
      }),
    });
    await emitExtensionEvent(harness, "agent_settled");
    const secondReviewIdentity = workflowMessageIdentity(harness, COORDINATION_REVIEW_MESSAGE_TYPE);
    const secondReportId = latestCoordination(harness).coordination.reports.at(-1).reportId;
    await execute(harness, {
      action: "review-evidence",
      coordinationIdentity: secondReviewIdentity,
      review: {
        reportId: secondReportId,
        decision: "accept",
        acceptedEvidence: [{ findingId: "caller-contract-v2", sourceId: "input-source", sourceVersion: "source-v2" }],
      },
    });

    await assert.rejects(execute(harness, taskPlan()), (error) => error.code === "COORDINATION_EVIDENCE_VERSION_STALE");
    assert.equal(harness.branch.some((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow"), false);
  });
});

test("docs 派发恢复时结果未知则不自动重放；旧 identity 被拒绝，只允许 architect 显式新 attempt", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    await execute(harness, {
      action: "request-evidence",
      request: {
        questionId: "input-boundary",
        question: "核实输入来源",
        rationale: "开发依赖准确事实",
        scope: ["src/input.ts"],
        completionCriteria: ["找到当前来源版本"],
      },
    });
    await emitExtensionEvent(harness, "agent_settled");
    const oldIdentity = workflowMessageIdentity(harness, COORDINATION_EVIDENCE_MESSAGE_TYPE);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === COORDINATION_EVIDENCE_MESSAGE_TYPE).length, 1);

    await emitExtensionEvent(harness, "session_start");
    const recovered = latestCoordination(harness);
    assert.equal(recovered.handoff.phase, "blocked");
    assert.equal(recovered.handoff.failure.code, "COORDINATION_DISPATCH_OUTCOME_UNKNOWN");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === COORDINATION_EVIDENCE_MESSAGE_TYPE).length, 1);
    await assert.rejects(
      execute(harness, {
        action: "report-evidence",
        coordinationIdentity: oldIdentity,
        report: reportFor(oldIdentity.requestId, {
          findingId: "stale-finding", sourceVersion: "v1", statement: "过期结果不能接收。",
        }),
      }),
      (error) => error.code === "COORDINATION_HANDOFF_IDENTITY_STALE",
    );

    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    await switchRole.execute("retry-as-architect", { role: "architect" }, undefined, undefined, harness.context);
    const explicitRetry = await execute(harness, {
      action: "request-evidence",
      request: {
        requestId: oldIdentity.requestId,
        questionId: "input-boundary",
        question: "核实输入来源",
        rationale: "开发依赖准确事实",
        scope: ["src/input.ts"],
        completionCriteria: ["找到当前来源版本"],
        refreshReason: "核对上一 handoff 未知结果后，架构师明确授权创建新 attempt。",
      },
    });
    assert.equal(explicitRetry.terminate, true);
    assert.notEqual(latestCoordination(harness).handoff.handoffId, oldIdentity.handoffId);
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === COORDINATION_EVIDENCE_MESSAGE_TYPE).length, 2);
  });
});

test("取证初始持久化失败不启动派发；消息派发失败 fail-closed 且 settled 不重发", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory, {
      harnessOptions: {
        appendEntry(type) {
          if (type === COORDINATION_ENTRY_TYPE) throw new Error("协作 entry 写入失败");
        },
      },
    });
    await assert.rejects(execute(harness, {
      action: "request-evidence",
      request: {
        questionId: "persistence",
        question: "核实持久化行为",
        rationale: "验证 fail-closed",
        scope: ["src/runtime.ts"],
        completionCriteria: ["确认结果"],
      },
    }), /协作 entry 写入失败/);
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === COORDINATION_EVIDENCE_MESSAGE_TYPE).length, 0);
  });

  await withTempDirectory(async (directory) => {
    let failMessage = true;
    const harness = await makeHarness(directory, {
      harnessOptions: {
        beforeSendMessagePersist(message) {
          if (message.customType === COORDINATION_EVIDENCE_MESSAGE_TYPE && failMessage) {
            failMessage = false;
            throw new Error("模拟协作消息派发失败");
          }
        },
      },
    });
    await execute(harness, {
      action: "request-evidence",
      request: {
        questionId: "dispatch",
        question: "核实消息交接",
        rationale: "验证派发失败语义",
        scope: ["src/runtime.ts"],
        completionCriteria: ["确认报告返回"],
      },
    });
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(latestCoordination(harness).handoff.phase, "blocked");
    assert.equal(latestCoordination(harness).handoff.failure.code, "COORDINATION_DISPATCH_OUTCOME_UNKNOWN");
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === COORDINATION_EVIDENCE_MESSAGE_TYPE).length, 1);
  });
});

test("恢复状态持久化失败时保留阻塞且不重派发", async () => {
  await withTempDirectory(async (directory) => {
    let failRecoveryPersist = false;
    const harness = await makeHarness(directory, {
      harnessOptions: {
        appendEntry(type, data) {
          if (failRecoveryPersist && type === COORDINATION_ENTRY_TYPE && data.handoff?.phase === "blocked") {
            throw new Error("协作恢复状态写入失败");
          }
        },
      },
    });
    await execute(harness, {
      action: "request-evidence",
      request: {
        questionId: "restore-persist",
        question: "核实恢复写入门",
        rationale: "恢复状态必须先持久化",
        scope: ["src/runtime.ts"],
        completionCriteria: ["不重复派发未知结果"],
      },
    });
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === COORDINATION_EVIDENCE_MESSAGE_TYPE).length, 1);

    failRecoveryPersist = true;
    await emitExtensionEvent(harness, "session_start");
    const status = await execute(harness, { action: "status" });
    assert.equal(status.details.coordination.error.code, "COORDINATION_RECOVERY_PERSIST_FAILED");
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === COORDINATION_EVIDENCE_MESSAGE_TYPE).length, 1);
  });
});

test("旧 branch 中的 handoff 消息不能提交当前证据报告", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    await execute(harness, {
      action: "request-evidence",
      request: {
        questionId: "branch-check",
        question: "核实当前 branch 身份",
        rationale: "不能接受旧 branch 的回调",
        scope: ["src/runtime.ts"],
        completionCriteria: ["报告绑定当前 branch handoff"],
      },
    });
    await emitExtensionEvent(harness, "agent_settled");
    const identity = workflowMessageIdentity(harness, COORDINATION_EVIDENCE_MESSAGE_TYPE);
    const messageIndex = harness.branch.findIndex((entry) => entry.type === "custom_message"
      && entry.customType === COORDINATION_EVIDENCE_MESSAGE_TYPE);
    assert.notEqual(messageIndex, -1);
    harness.branch.splice(messageIndex, 1);

    await assert.rejects(execute(harness, {
      action: "report-evidence",
      coordinationIdentity: identity,
      report: reportFor(identity.requestId, {
        findingId: "branch-finding", sourceVersion: "v1", statement: "旧 branch 回调被拒绝。",
      }),
    }), (error) => error.code === "COORDINATION_HANDOFF_BRANCH_MISMATCH");
    assert.equal(latestCoordination(harness).coordination.reports.length, 0);
  });
});

test("跨角色取证 handoff 在自动压缩完成后只派发一次", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    harness.context.getContextUsage = () => ({ percent: 90 });
    let completeCompaction;
    harness.context.compact = ({ onComplete }) => { completeCompaction = onComplete; };
    await execute(harness, {
      action: "request-evidence",
      request: {
        questionId: "compaction",
        question: "验证压缩交接续跑",
        rationale: "任务角色切换可能需要 context 压缩",
        scope: ["src/runtime.ts"],
        completionCriteria: ["压缩后使用同一 handoff 派发"],
      },
    });

    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.context.model.id, architect.id);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === COORDINATION_EVIDENCE_MESSAGE_TYPE).length, 0);
    assert.equal(latestCoordination(harness).handoff.phase, "dispatching");
    assert.equal(typeof completeCompaction, "function");

    completeCompaction();
    const deadline = Date.now() + 2000;
    while (latestCoordination(harness).handoff.phase !== "queued" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(harness.context.model.id, docs.id);
    assert.equal(latestCoordination(harness).handoff.phase, "queued");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === COORDINATION_EVIDENCE_MESSAGE_TYPE).length, 1);
  });
});

test("不同 session 的协作记录不恢复或续跑", async () => {
  await withTempDirectory(async (directory) => {
    const first = await makeHarness(directory);
    await execute(first, {
      action: "request-evidence",
      request: {
        questionId: "session-check",
        question: "核实 session 绑定",
        rationale: "旧 session 回调必须拒绝",
        scope: ["src/runtime.ts"],
        completionCriteria: ["sessionId 一致"],
      },
    });
    const branch = [...first.branch];
    const second = await makeHarness(directory, { branch, sessionId: "different-session", model: docs });
    assert.equal(second.sentMessages.length, 0);
    const status = await execute(second, { action: "status" });
    assert.equal(status.details.coordination.error.code, "COORDINATION_SESSION_MISMATCH");
  });
});

test("证据审阅边界压缩失败停在源角色，用户恢复后才派发 architect", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    await execute(harness, { action: "request-evidence", request: { questionId: "input-boundary", question: "检查输入", rationale: "核对", scope: ["src/input.ts"], completionCriteria: ["有证据"] } });
    await emitExtensionEvent(harness, "agent_settled");
    const identity = await startCurrentHandoff(harness, COORDINATION_EVIDENCE_MESSAGE_TYPE);
    await execute(harness, { action: "report-evidence", coordinationIdentity: identity, report: reportFor(identity.requestId, { findingId: "fact-1", sourceVersion: "v1", statement: "已检查" }) });
    harness.context.getContextUsage = () => ({ percent: 90 });
    harness.context.compact = ({ onError }) => onError(new Error("review boundary failed"));
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.context.model.id, docs.id);
    assert.equal(latestCoordination(harness).handoff.phase, "blocked");
    assert.equal(latestCoordination(harness).handoff.failure.code, "COORDINATION_COMPACTION_FAILED");
    const oldHandoffId = latestCoordination(harness).handoff.handoffId;
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.sentMessages.some(({ message }) => message.customType === COORDINATION_REVIEW_MESSAGE_TYPE), false);
    harness.context.compact = ({ onComplete }) => onComplete();
    await harness.commands.get("pi-init").handler("coordination resume", harness.context);
    const deadline = Date.now() + 2000;
    while (latestCoordination(harness).handoff.phase !== "queued" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(harness.context.model.id, architect.id);
    assert.equal(latestCoordination(harness).handoff.phase, "queued");
    assert.notEqual(latestCoordination(harness).handoff.handoffId, oldHandoffId);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === COORDINATION_REVIEW_MESSAGE_TYPE).length, 1);
    await emitExtensionEvent(harness, "session_shutdown");
  });
});
