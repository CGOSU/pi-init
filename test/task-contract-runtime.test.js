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
import { workflowActionIdentity } from "../src/workflow.ts";

const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
const docs = { provider: "openai-codex", id: "gpt-5.6-docs" };
const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };

async function makeHarness(directory, options = {}) {
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
    ...options,
  });
  await emitExtensionEvent(harness, "session_start");
  return harness;
}

function restartHarness(branch, directory, options = {}) {
  return createExtensionHarness(branch, {
    cwd: directory,
    trusted: true,
    model: architect,
    availableModels: [architect, docs, developer],
    sessionId: "task-contract-session",
    isIdle: false,
    ...options,
  });
}

async function switchToArchitect(harness) {
  await harness.tools.find((tool) => tool.name === "switch_role").execute(
    "recovery-test-architect",
    { role: "architect" },
    undefined,
    undefined,
    harness.context,
  );
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

test("显式 formal plan/replan 保持契约门控；clarify 退回 architect，补证据后仅以新 revision 继续", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    const { evidence } = await prepareEvidence(harness);

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
      text: "重规划：确认只查询先前 attempt 状态，不再次提交持久化写操作。",
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
    await assert.rejects(execute(harness, {
      ...replanBase,
      confirmUnknownOutcome: true,
      tasks: [{ id: "contract-deleted", task: "不能删契约绕过未知副作用", files: ["src/input.ts"], acceptanceCriteria: ["保持澄清守卫"] }],
    }), error => error.code === "WORKFLOW_UNKNOWN_OUTCOME_CONFIRMATION_REQUIRED");
    await assert.rejects(execute(harness, {
      ...replanBase,
      tasks: [{ id: "contract-deleted-without-confirm", task: "没有自签确认也不能删除契约", files: ["src/input.ts"], acceptanceCriteria: ["保持澄清守卫"] }],
    }), error => error.code === "WORKFLOW_CLARIFICATION_UNRESOLVED");
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

test("恢复已绑定工作流时同步 evidence link 的 recoveryGeneration", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    const { evidence } = await prepareEvidence(harness);
    await execute(harness, taskParams(evidence));

    const initialWorkflow = latestWorkflow(harness);
    const previousCoordination = latestCoordination(harness).coordination;
    const previousLink = previousCoordination.workflowLink;
    assert.equal(previousLink.workflowId, initialWorkflow.workflowId);
    assert.equal(previousLink.planVersion, initialWorkflow.planVersion);
    assert.equal(previousLink.recoveryGeneration, initialWorkflow.recoveryGeneration);

    // Simulate generations persisted by the old recovery path without link synchronization.
    const workflowEntry = harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow");
    workflowEntry.data.recoveryGeneration += 3;
    const previousWorkflow = latestWorkflow(harness);
    assert.ok(previousWorkflow.recoveryGeneration > previousLink.recoveryGeneration);

    const restarted = restartHarness(harness.branch, directory);
    await emitExtensionEvent(restarted, "session_start");
    await switchToArchitect(restarted);

    const recoveredWorkflow = latestWorkflow(restarted);
    const expectedLink = {
      workflowId: recoveredWorkflow.workflowId,
      planVersion: recoveredWorkflow.planVersion,
      recoveryGeneration: recoveredWorkflow.recoveryGeneration,
    };
    assert.equal(recoveredWorkflow.recoveryGeneration, previousWorkflow.recoveryGeneration + 1);
    assert.deepEqual(latestCoordination(restarted).coordination.workflowLink, expectedLink);
    assert.deepEqual(latestCoordination(restarted).coordination.reviews, previousCoordination.reviews);
    const status = await execute(restarted, { action: "status" });
    assert.deepEqual(status.details.coordination.workflowLink, expectedLink);
    assert.ok(status.content[0].text.includes(
      `workflowLink ${expectedLink.workflowId}/${expectedLink.planVersion}/${expectedLink.recoveryGeneration}`,
    ));

    await execute(restarted, {
      action: "request-evidence",
      request: {
        questionId: "post-recovery-binding",
        question: "恢复后的工作流是否仍绑定同一证据账本？",
        rationale: "确认恢复不会把活动工作流变成无法继续取证的孤立状态。",
        scope: ["extensions/coordination-runtime.ts", "test/task-contract-runtime.test.js"],
        completionCriteria: ["证据请求被当前绑定接受"],
      },
    });
    assert.deepEqual(latestCoordination(restarted).coordination.workflowLink, expectedLink);
  });
});

test("恢复不自动改绑缺失或指向其他工作流的 evidence link", async () => {
  for (const linkMode of ["missing", "different-workflow"]) {
    await withTempDirectory(async (directory) => {
      const harness = await makeHarness(directory);
      const { evidence } = await prepareEvidence(harness);
      await execute(harness, taskParams(evidence));

      const coordinationEntry = harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === COORDINATION_ENTRY_TYPE);
      if (linkMode === "missing") {
        delete coordinationEntry.data.coordination.workflowLink;
      } else {
        coordinationEntry.data.coordination.workflowLink.workflowId = "another-workflow";
      }
      const restarted = restartHarness(harness.branch, directory);
      await emitExtensionEvent(restarted, "session_start");
      await switchToArchitect(restarted);

      const recoveredLink = latestCoordination(restarted).coordination.workflowLink;
      if (linkMode === "missing") assert.equal(recoveredLink, undefined);
      else assert.equal(recoveredLink.workflowId, "another-workflow");
      await assert.rejects(execute(restarted, {
        action: "request-evidence",
        request: {
          questionId: "must-not-rebind",
          question: "错误或缺失的 workflow link 是否可自动补齐？",
          rationale: "缺少先前绑定证明时必须保持 fail-closed。",
          scope: ["extensions/coordination-runtime.ts"],
          completionCriteria: ["错误链接被拒绝"],
        },
      }), (error) => error.code === "COORDINATION_WORKFLOW_ACTIVE");
    });
  }
});

async function coordinatedPlan(harness) {
  const { evidence } = await prepareEvidence(harness);
  const params = taskParams(evidence);
  params.tasks = ["first", "second", "third"].map((id, index, ids) => ({ ...params.tasks[0], id, dependsOn: index ? [ids[index - 1]] : [] }));
  await execute(harness, params);
  await emitExtensionEvent(harness, "agent_settled");
  return evidence;
}
function assertCurrentLink(harness) {
  const workflow = latestWorkflow(harness);
  assert.deepEqual(latestCoordination(harness).coordination.workflowLink, { workflowId: workflow.workflowId, planVersion: workflow.planVersion, recoveryGeneration: workflow.recoveryGeneration });
}
test("协调计划连续完成任务后同步证据绑定，下一项不被执行代次变化阻断", async () => {
  await withTempDirectory(async directory => {
    const harness = await makeHarness(directory);
    await coordinatedPlan(harness);
    const reviews = structuredClone(latestCoordination(harness).coordination.reviews);
    for (const taskId of ["first", "second", "third"]) {
      const identity = workflowMessageIdentity(harness, "pi-init-workflow-task");
      assert.equal(identity.taskId, taskId);
      await execute(harness, { action: "complete", ...identity, completionSummary: taskId + " 已完成", implementationRationale: "严格沿当前契约推进", verification: ["针对性检查通过"] });
      if (taskId !== "third") assertCurrentLink(harness);
      await emitExtensionEvent(harness, "agent_settled");
    }
    assert.equal(latestWorkflow(harness).status, "completed");
    assert.deepEqual(latestCoordination(harness).coordination.reviews, reviews);
    assert.equal(harness.notifications.some(entry => /协作证据未绑定当前 workflow revision/.test(entry.message)), false);
    assert.equal(harness.sentMessages.filter(entry => entry.message.customType === "pi-init-workflow-task").length, 3);
  });
});
test("协调任务 block 与 retry 同步关联但保留证据审阅和旧结果隔离", async () => {
  await withTempDirectory(async directory => {
    const harness = await makeHarness(directory);
    await coordinatedPlan(harness);
    const original = workflowMessageIdentity(harness, "pi-init-workflow-task");
    await execute(harness, { action: "block", ...original, reason: "临时缺少权限" });
    assertCurrentLink(harness);
    await execute(harness, { action: "retry", ...workflowActionIdentity(latestWorkflow(harness)), taskId: "first" });
    assertCurrentLink(harness);
    await emitExtensionEvent(harness, "agent_settled");
    const retried = workflowMessageIdentity(harness, "pi-init-workflow-task");
    assert.notEqual(retried.attemptId, original.attemptId);
    await assert.rejects(execute(harness, { action: "complete", ...original, completionSummary: "旧结果", implementationRationale: "不得接受", verification: ["旧检查"] }), error => error.code === "WORKFLOW_ACTION_IDENTITY_STALE");
  });
});

test("证据同步写入失败保留完成结果并停止派发，存储恢复后补偿而不重放", async () => {
  await withTempDirectory(async directory => {
    let failSync = false;
    const harness = await makeHarness(directory, { appendEntry: type => {
      if (failSync && type === COORDINATION_ENTRY_TYPE) throw new Error("evidence append failed");
    } });
    await coordinatedPlan(harness);
    const identity = workflowMessageIdentity(harness, "pi-init-workflow-task");
    failSync = true;
    await execute(harness, { action: "complete", ...identity, completionSummary: "第一项已完成", implementationRationale: "先保存真实结果", verification: ["已验证"] });
    assert.equal(latestWorkflow(harness).tasks[0].status, "completed");
    assert.ok(latestWorkflow(harness).recoveryGeneration > latestCoordination(harness).coordination.workflowLink.recoveryGeneration);
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.sentMessages.filter(entry => entry.message.customType === "pi-init-workflow-task").length, 1);
    failSync = false;
    await emitExtensionEvent(harness, "agent_settled");
    assertCurrentLink(harness);
    assert.equal(workflowMessageIdentity(harness, "pi-init-workflow-task").taskId, "second");
    assert.equal(harness.sentMessages.filter(entry => entry.message.customType === "pi-init-workflow-task").length, 2);
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.sentMessages.filter(entry => entry.message.customType === "pi-init-workflow-task").length, 2);
    assert.equal(latestWorkflow(harness).tasks[0].completionSummary, "第一项已完成");
  });
});
test("调度补偿不创建缺失绑定、不改绑其他计划/session，也不倒退未来代次", async () => {
  for (const mode of ["missing", "different-workflow", "different-plan", "different-session", "future-generation"]) {
    await withTempDirectory(async directory => {
      const harness = await makeHarness(directory);
      await coordinatedPlan(harness);
      const identity = workflowMessageIdentity(harness, "pi-init-workflow-task");
      await execute(harness, { action: "complete", ...identity, completionSummary: "第一项完成", implementationRationale: "保持来源身份边界", verification: ["已验证"] });
      const current = latestCoordination(harness);
      const link = current.coordination.workflowLink;
      link.recoveryGeneration -= 1;
      if (mode === "missing") delete current.coordination.workflowLink;
      if (mode === "different-workflow") link.workflowId = "unrelated-workflow";
      if (mode === "different-plan") link.planVersion += 1;
      if (mode === "different-session") current.sessionId = "other-session";
      if (mode === "future-generation") link.recoveryGeneration = latestWorkflow(harness).recoveryGeneration + 1;
      const before = structuredClone(current);
      await emitExtensionEvent(harness, "agent_settled");
      assert.deepEqual(latestCoordination(harness), before, mode);
      assert.equal(harness.sentMessages.filter(entry => entry.message.customType === "pi-init-workflow-task").length, 1, mode);
      assert.equal(latestWorkflow(harness).tasks[1].status, "pending", mode);
    });
  }
});
test("修复代次绑定不会接受来源已变化的证据或绕过契约就绪门", async () => {
  await withTempDirectory(async directory => {
    const harness = await makeHarness(directory);
    await coordinatedPlan(harness);
    const identity = workflowMessageIdentity(harness, "pi-init-workflow-task");
    await execute(harness, { action: "complete", ...identity, completionSummary: "第一项完成", implementationRationale: "证据变更仍需重查", verification: ["已验证"] });
    const coordination = latestCoordination(harness).coordination;
    coordination.reports[0].findings[0].sources[0].version = "changed-source-version";
    const reviews = structuredClone(coordination.reviews);
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.sentMessages.filter(entry => entry.message.customType === "pi-init-workflow-task").length, 1);
    assert.deepEqual(latestCoordination(harness).coordination.reviews, reviews);
    assert.equal(latestWorkflow(harness).tasks[1].status, "pending");
    assert.ok(harness.notifications.some(entry => /未通过就绪门/.test(entry.message)));
  });
});

test("工作流写入失败不先推进证据绑定；重提同一合法结果后才同步", async () => {
  await withTempDirectory(async directory => {
    let failWorkflow = false;
    const harness = await makeHarness(directory, { appendEntry: type => {
      if (failWorkflow && type === "pi-init-workflow") throw new Error("workflow append failed");
    } });
    await coordinatedPlan(harness);
    const identity = workflowMessageIdentity(harness, "pi-init-workflow-task");
    const entryIndex = harness.branch.findLastIndex(entry => entry.type === "custom_message" && entry.customType === "pi-init-workflow-task");
    const [entry] = harness.branch.splice(entryIndex, 1);
    const message = harness.sentMessages.findLast(item => item.message.customType === "pi-init-workflow-task").message;
    await emitExtensionEvent(harness, "agent_start");
    await emitExtensionEvent(harness, "message_start", { message: { ...message, role: "custom", timestamp: Date.now() } });
    harness.branch.splice(entryIndex, 0, entry);
    assert.equal(latestWorkflow(harness).handoff.phase, "executing");
    const beforeWorkflow = structuredClone(latestWorkflow(harness));
    const beforeCoordination = structuredClone(latestCoordination(harness));
    const params = { action: "complete", ...identity, completionSummary: "第一项完成", implementationRationale: "提交顺序不能倒置", verification: ["已验证"] };
    failWorkflow = true;
    await assert.rejects(execute(harness, params), /workflow append failed/);
    assert.deepEqual(latestWorkflow(harness), beforeWorkflow);
    assert.deepEqual(latestCoordination(harness), beforeCoordination);
    failWorkflow = false;
    await execute(harness, params);
    assertCurrentLink(harness);
    assert.equal(latestWorkflow(harness).tasks[0].status, "completed");
  });
});
test("同步失败后直接补充证据也可受限补偿，不再误报未关联活动工作流", async () => {
  await withTempDirectory(async directory => {
    let failSync = false;
    const harness = await makeHarness(directory, { appendEntry: type => {
      if (failSync && type === COORDINATION_ENTRY_TYPE) throw new Error("evidence append failed");
    } });
    await coordinatedPlan(harness);
    const identity = workflowMessageIdentity(harness, "pi-init-workflow-task");
    failSync = true;
    await execute(harness, { action: "block", ...identity, reason: "需要补查事实" });
    failSync = false;
    await switchToArchitect(harness);
    await execute(harness, { action: "request-evidence", request: { questionId: "additional-fact", question: "补查事实是否成立？", rationale: "任务受阻后需要额外事实", scope: ["src/input.ts"], completionCriteria: ["提供可核查证据"] } });
    assertCurrentLink(harness);
    assert.equal(latestCoordination(harness).coordination.requests.at(-1).questionId, "additional-fact");
  });
});


test("ready 旁账不将普通 auto 小计划升级为 formal，也不绑定工作流", async () => {
  await withTempDirectory(async directory => {
    const harness = await makeHarness(directory);
    const { evidence } = await prepareEvidence(harness);
    const before = structuredClone(latestCoordination(harness));
    const result = await execute(harness, taskParams(evidence, null));
    assert.equal(result.details.orchestrated, false);
    assert.equal(latestWorkflow(harness), undefined);
    assert.deepEqual(latestCoordination(harness), before);
  });
});

test("ready 旁账下普通多任务 plan/replan 可执行且不生成契约或绑定", async () => {
  await withTempDirectory(async directory => {
    const harness = await makeHarness(directory);
    const { evidence } = await prepareEvidence(harness);
    const before = structuredClone(latestCoordination(harness));
    const params = taskParams(evidence, null);
    params.tasks = ["one", "two", "three"].map(id => ({ ...params.tasks[0], id }));
    await execute(harness, params);
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(workflowMessageIdentity(harness, "pi-init-workflow-task").taskId, "one");
    await execute(harness, { action: "block", ...workflowMessageIdentity(harness, "pi-init-workflow-task"), reason: "在安全边界重规划" });
    await switchToArchitect(harness);
    await execute(harness, { action: "request-replan", ...workflowActionIdentity(latestWorkflow(harness)), summary: "调整普通任务顺序" });
    await emitExtensionEvent(harness, "agent_settled");
    await execute(harness, { ...params, action: "replan", tasks: params.tasks.map(task => ({ ...task, id: `revised-${task.id}` })), ...workflowMessageIdentity(harness, "pi-init-workflow-replan"), confirmUnknownOutcome: true });
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(latestWorkflow(harness).tasks.some(task => task.contract !== undefined), false);
    assert.deepEqual(latestCoordination(harness), before);
    assert.equal(harness.sentMessages.filter(item => item.message.customType === "pi-init-workflow-task").length, 2);
  });
});

test("显式进行中和阻塞取证不能通过无 contract 普通 plan 绕过", async () => {
  for (const phase of ["evidence-gathering", "evidence-review", "blocked"]) {
    await withTempDirectory(async directory => {
      const harness = await makeHarness(directory);
      await prepareEvidence(harness);
      latestCoordination(harness).coordination.phase = phase;
      latestCoordination(harness).coordination.requests[0].status = phase === "blocked" ? "blocked" : "pending";
      await assert.rejects(execute(harness, taskParams(undefined, null)), error => /^COORDINATION_/.test(error.code));
      assert.equal(latestWorkflow(harness), undefined);
    });
  }
});

test("显式 legacy workflow link 即使无 contract 仍 fail closed", async () => {
  await withTempDirectory(async directory => {
    const harness = await makeHarness(directory);
    await coordinatedPlan(harness);
    const identity = workflowMessageIdentity(harness, "pi-init-workflow-task");
    await execute(harness, { action: "complete", ...identity, completionSummary: "完成", implementationRationale: "保持绑定", verification: ["通过"] });
    for (const task of latestWorkflow(harness).tasks) delete task.contract;
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.sentMessages.filter(item => item.message.customType === "pi-init-workflow-task").length, 1);
    assert.ok(harness.notifications.some(item => /TASK_CONTRACT_REQUIRED/.test(item.message)));
  });
});


test("无关 coordinationRestoreError 不污染普通计划，显式 formal/取证仍阻断", async () => {
  await withTempDirectory(async directory => {
    const harness = await makeHarness(directory);
    const { evidence } = await prepareEvidence(harness);
    latestCoordination(harness).runtimeVersion = -1;
    const restarted = restartHarness(harness.branch, directory, { isIdle: true });
    await emitExtensionEvent(restarted, "session_start");
    await switchToArchitect(restarted);
    const ordinary = await execute(restarted, taskParams(evidence, null));
    assert.equal(ordinary.details.orchestrated, false);
    await assert.rejects(execute(restarted, taskParams(evidence)), error => /^COORDINATION_/.test(error.code));
    await assert.rejects(execute(restarted, { action: "request-evidence", request: {} }), error => /^COORDINATION_/.test(error.code));
    assert.equal(latestWorkflow(restarted), undefined);
    const params = taskParams(undefined, null);
    params.tasks = ["one", "two", "three"].map(id => ({ ...params.tasks[0], id }));
    await execute(restarted, params);
    await emitExtensionEvent(restarted, "agent_settled");
    assert.equal(workflowMessageIdentity(restarted, "pi-init-workflow-task").taskId, "one");
    await execute(restarted, { action: "complete", ...workflowMessageIdentity(restarted, "pi-init-workflow-task"), completionSummary: "普通结果", implementationRationale: "不依赖损坏旁账", verification: ["通过"] });
    assert.equal(latestWorkflow(restarted).tasks[0].status, "completed");
  });
});

test("formal replan 不得删除 contract 并借失配绑定降级为普通流程", async () => {
  await withTempDirectory(async directory => {
    const harness = await makeHarness(directory);
    await coordinatedPlan(harness);
    await execute(harness, { action: "block", ...workflowMessageIdentity(harness, "pi-init-workflow-task"), reason: "在安全边界重规划" });
    await switchToArchitect(harness);
    await execute(harness, { action: "request-replan", ...workflowActionIdentity(latestWorkflow(harness)), summary: "保留 formal 边界" });
    await emitExtensionEvent(harness, "agent_settled");
    latestCoordination(harness).coordination.workflowLink.planVersion += 1;
    const before = structuredClone(latestWorkflow(harness));
    const params = taskParams(undefined, null);
    await assert.rejects(execute(harness, { ...params, action: "replan", ...workflowMessageIdentity(harness, "pi-init-workflow-replan"), confirmUnknownOutcome: true }), error => /^(TASK_CONTRACT_|COORDINATION_)/.test(error.code));
    assert.deepEqual(latestWorkflow(harness), before);
  });
});


test("绑定 legacy 账本损坏且已无 contract 时恢复仍 fail closed", async () => {
  await withTempDirectory(async directory => {
    const harness = await makeHarness(directory);
    await coordinatedPlan(harness);
    for (const task of latestWorkflow(harness).tasks) delete task.contract;
    latestCoordination(harness).runtimeVersion = -1;
    const restarted = restartHarness(harness.branch, directory);
    await emitExtensionEvent(restarted, "session_start");
    await switchToArchitect(restarted);
    await assert.rejects(execute(restarted, { action: "request-replan", ...workflowActionIdentity(latestWorkflow(restarted)), summary: "不得绕过绑定的恢复错误" }), error => error.code === "COORDINATION_RUNTIME_VERSION_UNSUPPORTED");
    assert.equal(restarted.sentMessages.some(item => item.message.customType === "pi-init-workflow-task"), false);
  });
});


test("恢复错误不能掩盖同 session 显式进行中或 blocked 取证", async () => {
  for (const phase of ["evidence-gathering", "evidence-review", "blocked"]) {
    await withTempDirectory(async directory => {
      const harness = await makeHarness(directory);
      await prepareEvidence(harness);
      latestCoordination(harness).runtimeVersion = -1;
      latestCoordination(harness).coordination.phase = phase;
      const restarted = restartHarness(harness.branch, directory);
      await emitExtensionEvent(restarted, "session_start");
      await switchToArchitect(restarted);
      await assert.rejects(execute(restarted, taskParams(undefined, null)), error => error.code === "COORDINATION_RUNTIME_VERSION_UNSUPPORTED");
      assert.equal(latestWorkflow(restarted), undefined);
    });
  }
});
