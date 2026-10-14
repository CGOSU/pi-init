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

async function makeHarness(directory) {
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  await writeFile(path.join(directory, ".pi", "role-models.json"), `${JSON.stringify({
    schemaVersion: 2,
    mode: "auto",
    workflowMode: "auto",
    roleModels: {
      architect: { provider: architect.provider, model: architect.id, thinkingLevel: "max" },
      "docs-commit": { provider: docs.provider, model: docs.id, thinkingLevel: "high" },
      "developer-test": { provider: developer.provider, model: developer.id, thinkingLevel: "max" },
    },
  }, null, 2)}\n`);
  const harness = createExtensionHarness([], {
    cwd: directory,
    trusted: true,
    model: architect,
    availableModels: [architect, docs, developer],
    sessionId: "task-contract-session",
  });
  await emitExtensionEvent(harness, "session_start");
  return harness;
}

function execute(harness, params) {
  const tool = harness.tools.find((item) => item.name === "task_workflow");
  return tool.execute("task-contract-runtime-test", params, undefined, undefined, harness.context);
}

function latestCoordination(harness) {
  return harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === COORDINATION_ENTRY_TYPE)?.data;
}

function latestWorkflow(harness) {
  return harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow")?.data;
}

function contract(evidence, overrides = {}) {
  return {
    version: 1,
    outcome: "Implement only the confirmed input boundary behavior.",
    requirementSources: ["Confirmed user requirement", "Accepted evidence finding"],
    expectedBehavior: ["Preserve the verified caller-visible result."],
    evidence: [evidence],
    clarificationResolutions: [],
    fixedDecisions: ["Do not infer an unresolved business rule."],
    invariants: ["Keep already completed work."],
    nonGoals: ["Do not broaden unrelated parsing behavior."],
    blockingQuestions: [],
    engineeringDiscretion: ["Choose a local helper boundary and ordinary naming."],
    verification: ["Run the targeted input test."],
    ...overrides,
  };
}

function taskParams(evidence, taskContract) {
  return {
    action: "plan",
    summary: "按当前证据实现输入边界行为",
    constraints: ["不得超出已接受事实"],
    tasks: [{
      id: "input-implementation",
      task: "按已确认契约实现输入边界",
      files: ["src/input.ts", "test/input.test.js"],
      acceptanceCriteria: ["边界行为通过针对性验证"],
      ...(taskContract === null ? {} : { contract: taskContract ?? contract(evidence) }),
    }],
  };
}

async function prepareEvidence(harness) {
  await execute(harness, {
    action: "request-evidence",
    request: {
      questionId: "input-callers",
      question: "当前解析失败语义及直接调用方如何处理？",
      rationale: "开发契约依赖最新调用方行为，不能从函数名推断。",
      scope: ["src/input.ts", "直接调用方", "test/input.test.js"],
      completionCriteria: ["报告当前实现、直接调用方和相关测试证据"],
    },
  });
  await emitExtensionEvent(harness, "agent_settled");
  const requestId = latestCoordination(harness).coordination.requests[0].requestId;
  const evidenceIdentity = workflowMessageIdentity(harness, COORDINATION_EVIDENCE_MESSAGE_TYPE);
  await execute(harness, {
    action: "report-evidence",
    coordinationIdentity: evidenceIdentity,
    report: {
      requestId,
      findings: [{
        findingId: "caller-behavior-v2",
        questionId: "input-callers",
        classification: "fact",
        statement: "直接调用方将解析失败显示为校验错误，并保留原始输入。",
        sources: [{ id: "src-input-callers", location: "src/input.ts::parseInput callers", version: "sha-v2" }],
      }],
      inspectedScope: ["src/input.ts", "test/input.test.js"],
      testsLocated: ["test/input.test.js"],
      testsRun: [],
      unresolved: [],
    },
  });
  await emitExtensionEvent(harness, "agent_settled");
  const report = latestCoordination(harness).coordination.reports[0];
  const reviewIdentity = workflowMessageIdentity(harness, COORDINATION_REVIEW_MESSAGE_TYPE);
  await execute(harness, {
    action: "review-evidence",
    coordinationIdentity: reviewIdentity,
    review: {
      reportId: report.reportId,
      decision: "accept",
      acceptedEvidence: [{ findingId: "caller-behavior-v2", sourceId: "src-input-callers", sourceVersion: "sha-v2" }],
      reason: "来源版本和问题范围匹配。",
    },
  });
  return { evidence: { findingId: "caller-behavior-v2", sourceId: "src-input-callers", sourceVersion: "sha-v2" } };
}

test("无协调证据的普通计划携带契约时返回双向门控诊断", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    const evidence = { findingId: "caller-behavior-v2", sourceId: "src-input-callers", sourceVersion: "sha-v2" };
    await assert.rejects(execute(harness, taskParams(evidence)), (error) => {
      assert.equal(error.code, "TASK_CONTRACT_REQUIRES_COORDINATION");
      assert.equal(error.details.taskId, "input-implementation");
      assert.match(error.details.precondition, /协调证据/);
      assert.match(error.details.nextAction, /取证链路/);
      assert.doesNotMatch(error.details.nextAction, /删除契约|环境权限/);
      return true;
    });
    assert.equal(latestWorkflow(harness), undefined);
    assert.equal(harness.branch.some((entry) => entry.type === "custom" && entry.customType === COORDINATION_ENTRY_TYPE), false);
  });
});

test("协调 plan/replan 强制任务契约；clarify 退回 architect，补证据后仅以新 revision 继续", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    const { evidence } = await prepareEvidence(harness);

    await assert.rejects(execute(harness, taskParams(evidence, null)), (error) => {
      assert.equal(error.code, "TASK_CONTRACT_REQUIRED");
      assert.equal(error.details.taskId, "input-implementation");
      assert.match(error.details.precondition, /结构化任务契约/);
      assert.match(error.details.nextAction, /重新提交 plan\/replan/);
      assert.doesNotMatch(error.details.nextAction, /删除契约|环境权限/);
      return true;
    });
    await assert.rejects(execute(harness, taskParams(evidence, contract(evidence, {
      blockingQuestions: ["尚未确认失败后是否回滚副作用"],
    }))), (error) => {
      assert.equal(error.code, "TASK_CONTRACT_BLOCKING_QUESTIONS");
      assert.equal(error.details.taskId, "input-implementation");
      assert.equal(error.details.field, "blockingQuestions");
      assert.match(error.details.precondition, /未决问题/);
      return true;
    });
    assert.equal(latestWorkflow(harness), undefined, "缺契约或存在关键未决问题时不得保存/派发计划");

    await execute(harness, taskParams(evidence));
    assert.ok(latestWorkflow(harness));
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 0);
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.context.model.id, developer.id);
    const oldTaskIdentity = workflowMessageIdentity(harness, "pi-init-workflow-task");
    const oldTaskMessage = harness.branch.findLast((entry) => entry.type === "custom_message"
      && entry.customType === "pi-init-workflow-task");
    assert.match(oldTaskMessage.content, /开发任务契约/);
    assert.match(oldTaskMessage.content, /需求来源/);
    assert.match(oldTaskMessage.content, /已接受证据/);
    assert.match(oldTaskMessage.content, /工程自由度/);
    assert.match(oldTaskMessage.content, /普通可逆 helper/);

    await emitExtensionEvent(harness, "agent_start");
    await emitExtensionEvent(harness, "message_start", {
      message: { role: "custom", customType: "pi-init-workflow-task", details: oldTaskIdentity },
    });
    const clarified = await execute(harness, {
      action: "clarify",
      ...oldTaskIdentity,
      clarification: {
        category: "missing-fact",
        question: "调用方在失败时是否会重复提交持久化写操作？",
        impact: "如果未核实，重复执行可能造成外部副作用。",
        checkedFacts: ["当前任务工具报告结果未知，尚未核对外部状态。"],
        completedWork: ["已完成不触发写操作的局部类型适配。"],
        verification: ["node --test test/input.test.js：通过"],
        sideEffects: { status: "unknown", details: ["写操作可能已发生，结果尚未核实。"] },
      },
    });
    assert.equal(clarified.terminate, true);
    assert.equal(latestWorkflow(harness).status, "replanning");
    assert.equal(latestWorkflow(harness).currentTaskId, undefined);
    const issue = latestWorkflow(harness).tasks[0].clarification;
    assert.equal(latestWorkflow(harness).tasks[0].status, "blocked");
    assert.equal(latestWorkflow(harness).tasks[0].completedAt, undefined);
    assert.deepEqual(issue.completedWork, ["已完成不触发写操作的局部类型适配。"]);
    assert.equal(issue.sideEffects.status, "unknown");
    assert.equal(latestWorkflow(harness).pendingRevision.requestedFromTaskId, "input-implementation");

    await assert.rejects(execute(harness, {
      action: "complete",
      ...oldTaskIdentity,
      completionSummary: "过期回报不应完成任务",
      implementationRationale: "旧 handoff 已失效",
      verification: [],
    }), (error) => error.code === "WORKFLOW_ACTION_IDENTITY_STALE");

    await emitExtensionEvent(harness, "agent_settled");
    const firstReplanIdentity = workflowMessageIdentity(harness, "pi-init-workflow-replan");
    const firstReplan = harness.branch.findLast((entry) => entry.type === "custom_message"
      && entry.customType === "pi-init-workflow-replan");
    assert.equal(harness.context.model.id, architect.id);
    assert.match(firstReplan.content, /开发者正式退回的澄清/);
    assert.match(firstReplan.content, /业务决策缺失必须向用户确认/);
    assert.match(firstReplan.content, /不得自动重放/);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1,
      "clarify only returns to architect; old code/side effects are not automatically rerun");

    await emitExtensionEvent(harness, "input", {
      source: "interactive",
      text: "确认只查询先前 attempt 状态，不再次提交持久化写操作。",
    });
    const updatedWorkflow = latestWorkflow(harness);
    const updatedCoordination = latestCoordination(harness).coordination;
    assert.equal(updatedCoordination.workflowLink.recoveryGeneration, updatedWorkflow.recoveryGeneration,
      "新增用户指令同步更新协调账本的 workflow link");
    const currentReplanIdentity = workflowMessageIdentity(harness, "pi-init-workflow-replan");
    assert.notEqual(currentReplanIdentity.handoffId, firstReplanIdentity.handoffId);
    const currentReplan = harness.branch.findLast((entry) => entry.type === "custom_message"
      && entry.customType === "pi-init-workflow-replan");
    assert.match(currentReplan.content, /确认只查询先前 attempt 状态/);
    await assert.rejects(execute(harness, {
      action: "replan",
      ...firstReplanIdentity,
      revisionId: latestWorkflow(harness).pendingRevision.revisionId,
      summary: "过期 architect handoff 不得推进",
      constraints: [],
      tasks: [{
        id: "stale-replan-task",
        task: "该计划必须在身份检查前被拒绝",
        files: ["src/input.ts"],
        acceptanceCriteria: ["过期身份不能生效"],
        contract: contract(evidence),
      }],
    }), (error) => error.code === "WORKFLOW_ACTION_IDENTITY_STALE");

    await execute(harness, {
      action: "request-evidence",
      request: {
        questionId: "input-callers",
        question: "当前持久化写操作是否幂等，如何核对先前 attempt 的结果？",
        rationale: "澄清记录声明副作用结果未知，重规划前必须核对当前来源版本。",
        scope: ["src/input.ts", "直接调用方", "test/input.test.js"],
        completionCriteria: ["明确幂等契约和安全核对方式"],
        refreshReason: "开发澄清要求重新核实可能已发生的写操作及来源变化。",
      },
    });
    await emitExtensionEvent(harness, "agent_settled");
    const followupRequestId = latestCoordination(harness).coordination.requests.at(-1).requestId;
    await execute(harness, {
      action: "report-evidence",
      coordinationIdentity: workflowMessageIdentity(harness, COORDINATION_EVIDENCE_MESSAGE_TYPE),
      report: {
        requestId: followupRequestId,
        findings: [{
          findingId: "write-idempotency-v3",
          questionId: "input-callers",
          classification: "fact",
          statement: "同一 request key 的写入具幂等性；可通过状态查询核对先前结果。",
          sources: [{ id: "src-input-callers", location: "src/input.ts::persistInput", version: "sha-v3" }],
        }],
        inspectedScope: ["src/input.ts", "test/input.test.js"],
        testsLocated: ["test/input.test.js"],
        testsRun: [],
        unresolved: [],
      },
    });
    await emitExtensionEvent(harness, "agent_settled");
    const newReport = latestCoordination(harness).coordination.reports.at(-1);
    await execute(harness, {
      action: "review-evidence",
      coordinationIdentity: workflowMessageIdentity(harness, COORDINATION_REVIEW_MESSAGE_TYPE),
      review: {
        reportId: newReport.reportId,
        decision: "accept",
        acceptedEvidence: [{ findingId: "write-idempotency-v3", sourceId: "src-input-callers", sourceVersion: "sha-v3" }],
        reason: "最新版本已明确 idempotency 和结果核对方式。",
      },
    });

    const latestEvidence = { findingId: "write-idempotency-v3", sourceId: "src-input-callers", sourceVersion: "sha-v3" };
    const replanBase = {
      action: "replan",
      ...currentReplanIdentity,
      revisionId: latestWorkflow(harness).pendingRevision.revisionId,
      summary: "依据已接受事实继续且不重放写操作",
      constraints: ["未知副作用必须先核对，不能重复提交"],
    };
    const unresolvedContract = contract(latestEvidence);
    await assert.rejects(execute(harness, {
      ...replanBase,
      tasks: [{ id: "continued-implementation", task: "继续", files: ["src/input.ts"], acceptanceCriteria: ["完成"], contract: unresolvedContract }],
    }), (error) => error.code === "WORKFLOW_CLARIFICATION_UNRESOLVED");
    const unresolvedDecision = contract(latestEvidence, {
      clarificationResolutions: [{
        issueId: issue.issueId,
        resolutionKind: "evidence",
        resolution: "已核对幂等行为。",
        sideEffectDisposition: "no-replay",
      }],
      blockingQuestions: ["业务副作用仍未完成核对"],
    });
    await assert.rejects(execute(harness, {
      ...replanBase,
      tasks: [{ id: "continued-implementation", task: "继续", files: ["src/input.ts"], acceptanceCriteria: ["完成"], contract: unresolvedDecision }],
    }), (error) => error.code === "TASK_CONTRACT_BLOCKING_QUESTIONS");
    assert.equal(latestWorkflow(harness).status, "replanning");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1);

    const applied = await execute(harness, {
      ...replanBase,
      tasks: [{
        id: "continued-implementation",
        task: "通过状态查询核对先前 attempt，并继续实现；不得再次提交原写操作。",
        files: ["src/input.ts", "test/input.test.js"],
        acceptanceCriteria: ["结果核对完成且不重复写入"],
        contract: contract(latestEvidence, {
          invariants: ["对未知 attempt 只执行状态核对，不重复副作用写入。"],
          clarificationResolutions: [{
            issueId: issue.issueId,
            resolutionKind: "evidence",
            resolution: "已接受幂等及状态核对证据；新任务仅核对已有 attempt 后继续。",
            sideEffectDisposition: "no-replay",
          }],
        }),
      }],
    });
    assert.equal(applied.terminate, true);
    const revised = latestWorkflow(harness);
    assert.equal(revised.planVersion, 1);
    assert.equal(revised.revisions[0].replacedTasks[0].clarification.issueId, issue.issueId);
    assert.equal(revised.revisions[0].replacedTasks[0].status, "superseded");
    await assert.rejects(execute(harness, {
      action: "complete",
      ...oldTaskIdentity,
      completionSummary: "旧任务不能推进新版本",
      implementationRationale: "身份已过期",
      verification: [],
    }), (error) => error.code === "WORKFLOW_ACTION_IDENTITY_STALE");
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.context.model.id, developer.id);
    const newTaskIdentity = workflowMessageIdentity(harness, "pi-init-workflow-task");
    assert.notEqual(newTaskIdentity.handoffId, oldTaskIdentity.handoffId);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 2);
  });
});
