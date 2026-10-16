import assert from "node:assert/strict";
import test from "node:test";
import {
  checkWorkflowTaskContractReadiness,
  cloneState,
  createWorkflowState,
  hydrateWorkflowState,
  parseWorkflowTaskClarificationInput,
  validateWorkflowTaskContract,
} from "../src/workflow.ts";

const acceptedEvidence = [{ findingId: "fact-1", sourceId: "src/workflow.ts", sourceVersion: "sha-v2" }];

function contract(overrides = {}) {
  return {
    version: 1,
    outcome: "Expose an accurate workflow recovery state.",
    requirementSources: ["Confirmed user requirement"],
    expectedBehavior: ["Return the recovery error instead of empty data."],
    evidence: [...acceptedEvidence],
    clarificationResolutions: [],
    fixedDecisions: ["Do not report recovery failure as success."],
    invariants: ["Preserve the original session record."],
    nonGoals: ["Do not redesign the command UI."],
    blockingQuestions: [],
    engineeringDiscretion: ["Choose an internal helper boundary."],
    verification: ["Run the focused recovery test."],
    ...overrides,
  };
}

test("澄清输入结构化区分缺失字段、类型错误和副作用冲突", () => {
  const input = {
    category: "missing-fact",
    question: "调用方是否会重复执行写操作？",
    impact: "可能造成无法逆转的副作用。",
    checkedFacts: [],
    completedWork: [],
    verification: [],
    sideEffects: { status: "unknown", details: ["结果未核对"] },
  };
  assert.equal(parseWorkflowTaskClarificationInput({ ...input, question: undefined }).code,
    "WORKFLOW_CLARIFICATION_FIELD_MISSING");
  assert.equal(parseWorkflowTaskClarificationInput({ ...input, completedWork: "not-an-array" }).code,
    "WORKFLOW_CLARIFICATION_FIELD_TYPE");
  assert.equal(parseWorkflowTaskClarificationInput({ ...input, sideEffects: { status: "none", details: ["冲突"] } }).code,
    "WORKFLOW_CLARIFICATION_SIDE_EFFECT_CONFLICT");
  assert.equal(parseWorkflowTaskClarificationInput(input).ok, true);
});

test("任务契约解析区分缺失、类型错误和不支持版本", () => {
  assert.equal(validateWorkflowTaskContract({ version: 1 }).code, "TASK_CONTRACT_OUTCOME_MISSING");
  assert.equal(validateWorkflowTaskContract({ ...contract(), outcome: 12 }).code, "TASK_CONTRACT_OUTCOME_INVALID");
  assert.equal(validateWorkflowTaskContract({ ...contract(), fixedDecisions: "not-an-array" }).code,
    "TASK_CONTRACT_FIELD_TYPE");
  assert.equal(validateWorkflowTaskContract({ ...contract(), requirementSources: 12 }).code,
    "TASK_CONTRACT_FIELD_TYPE");
  assert.equal(validateWorkflowTaskContract({ ...contract(), clarificationResolutions: [{ issueId: "bad id" }] }).code,
    "TASK_CONTRACT_CLARIFICATION_INVALID");
  assert.equal(validateWorkflowTaskContract({ ...contract(), version: 2 }).code,
    "TASK_CONTRACT_VERSION_UNSUPPORTED");
  assert.equal(validateWorkflowTaskContract({ ...contract(), evidence: [{ findingId: "f" }] }).code,
    "TASK_CONTRACT_EVIDENCE_INVALID");
  assert.throws(() => createWorkflowState({
    summary: "invalid external task contract",
    sessionId: "invalid-contract-session",
    tasks: [{
      id: "bad-contract",
      task: "Reject the malformed contract",
      files: ["src/bad.ts"],
      acceptanceCriteria: ["Return a stable contract code"],
      contract: contract({ blockingQuestions: "not-an-array" }),
    }],
  }), { code: "TASK_CONTRACT_FIELD_TYPE" });
});

test("未决问题、未接受证据和过期来源分别阻止任务就绪", () => {
  assert.equal(checkWorkflowTaskContractReadiness(contract({
    blockingQuestions: ["Which public error code is required?"],
  }), acceptedEvidence).code, "TASK_CONTRACT_BLOCKING_QUESTIONS");
  assert.equal(checkWorkflowTaskContractReadiness(contract(), "invalid").code,
    "TASK_CONTRACT_FIELD_TYPE");
  assert.equal(checkWorkflowTaskContractReadiness(contract(), []).code,
    "TASK_CONTRACT_EVIDENCE_UNACCEPTED");
  assert.equal(checkWorkflowTaskContractReadiness(contract(), [
    { findingId: "fact-1", sourceId: "src/workflow.ts", sourceVersion: "sha-v3" },
  ]).code, "TASK_CONTRACT_EVIDENCE_STALE");
  assert.deepEqual(checkWorkflowTaskContractReadiness(contract(), acceptedEvidence), {
    ok: true,
    value: { ready: true },
  });
  assert.deepEqual(checkWorkflowTaskContractReadiness(undefined, []), {
    ok: true,
    value: { ready: true },
  }, "legacy local tasks without a contract remain ready");
});

test("工作流创建、clone、hydration 和 JSON 恢复保留任务契约且深拷贝数组", () => {
  const state = createWorkflowState({
    summary: "契约持久化",
    sessionId: "contract-session",
    tasks: [{
      id: "implementation",
      task: "恢复 workflow 错误",
      role: "developer-test",
      files: ["src/workflow.ts"],
      acceptanceCriteria: ["错误可区分"],
      contract: contract(),
    }],
  }, 10);
  const originalContract = state.tasks[0].contract;
  assert.ok(originalContract);

  const cloned = cloneState(state, 20);
  cloned.tasks[0].contract.fixedDecisions.push("new decision");
  assert.equal(originalContract.fixedDecisions.includes("new decision"), false);

  const restored = hydrateWorkflowState(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.ok, true);
  assert.equal(restored.value.version, 7);
  assert.deepEqual(restored.value.tasks[0].contract, originalContract);
});

test("version 4 有身份 workflow 升级到当前版本但不伪造旧任务契约", () => {
  const current = createWorkflowState({
    summary: "version 4 migration",
    sessionId: "version-session",
    tasks: [{
      id: "old-task",
      task: "Existing local task",
      files: ["src/old.ts"],
      acceptanceCriteria: ["Keep working"],
    }],
  }, 10);
  const version4 = { ...current, version: 4 };
  delete version4.tasks[0].contract;

  const restored = hydrateWorkflowState(version4);
  assert.equal(restored.ok, true);
  assert.equal(restored.value.version, 7);
  assert.equal(restored.value.workflowId, current.workflowId);
  assert.equal(restored.value.sessionId, current.sessionId);
  assert.equal(restored.value.legacySourceVersion, undefined);
  assert.equal(restored.value.tasks[0].contract, undefined);
});

test("损坏的持久化任务契约不会被静默忽略", () => {
  const valid = createWorkflowState({
    summary: "坏契约 fail closed",
    sessionId: "broken-contract-session",
    tasks: [{
      id: "bad-task",
      task: "Persist a valid contract first",
      files: ["src/bad.ts"],
      acceptanceCriteria: ["Then reject corruption"],
      contract: contract(),
    }],
  }, 10);
  const corrupted = structuredClone(valid);
  corrupted.tasks[0].contract.blockingQuestions = "not-an-array";
  const restored = hydrateWorkflowState(corrupted);
  assert.equal(restored.ok, false);
  assert.equal(restored.code, "TASK_CONTRACT_FIELD_TYPE");
});
