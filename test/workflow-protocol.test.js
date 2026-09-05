import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";
import { createWorkflowReport } from "../extensions/workflow-report.ts";

const {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  os,
  path,
  initProjectExtension,
  installLaunchers,
  dateRange,
  formatReport,
  PI_USAGE_VERSION,
  queryUsage,
  shouldRefreshUsage,
  summarizeUsage,
  createScaffold,
  formatEnvironmentInstructions,
  DEFAULT_ROLE_CONFIG,
  DEFAULT_ROLE_MODELS,
  DEFAULT_WORKFLOW_EXECUTOR,
  DEFAULT_WORKFLOW_MODE,
  ROLE_LABELS,
  ROLE_MODE_LABELS,
  ROLE_SWITCH_COMPACTION_THRESHOLD,
  THINKING_LEVELS,
  filterRoleModels,
  findMatchingRole,
  normalizeModelReference,
  resolveRoleConfig,
  resolveRoleMode,
  resolveWorkflowExecutor,
  resolveWorkflowMode,
  resolveRoleModel,
  shouldOrchestrateWorkflow,
  shouldCompactOnRoleSwitch,
  WORKFLOW_MAX_NUDGES,
  WORKFLOW_MAX_TASKS,
  blockWorkflowTask,
  beginWorkflowDelegation,
  cancelWorkflow,
  completeWorkflowTask,
  createWorkflowState,
  getNextWorkflowTask,
  getWorkflowTask,
  getWorkflowTaskDuration,
  getWorkflowExecutionBounds,
  getWorkflowExecutionDuration,
  hydrateWorkflowState,
  markWorkflowTaskStarted,
  recordWorkflowNudge,
  requestWorkflowReplan,
  applyWorkflowReplan,
  resumeWorkflow,
  retryWorkflowTask,
  startWorkflowTask,
  validateWorkflowPlan,
  requestWorkflowDelegationStop,
  workflowProgress,
  SUBTASK_RESULT_MAX_BYTES,
  SUBTASK_RESULT_PROTOCOL,
  extractSubtaskResultJson,
  parseSubtaskResult,
  completeRunTiming,
  createRunTiming,
  getRunTimingDuration,
  isExternalRunSource,
  withTempDirectory,
  createExtensionHarness,
  emitExtensionEvent,
  runExternalAgent,
} = helpers;

test("subtask 结果协议严格验证完成、阻塞和异常结果", () => {
  const complete = parseSubtaskResult(JSON.stringify({
    protocol: SUBTASK_RESULT_PROTOCOL,
    outcome: "complete",
    completionSummary: "实现完成",
    implementationRationale: "复用现有边界以降低改动风险",
    verification: ["npm test：通过", "npm test：通过"],
  }));
  assert.deepEqual(complete, {
    outcome: "complete",
    completionSummary: "实现完成",
    implementationRationale: "复用现有边界以降低改动风险",
    verification: ["npm test：通过"],
  });
  assert.throws(
    () => parseSubtaskResult(JSON.stringify({
      protocol: SUBTASK_RESULT_PROTOCOL,
      outcome: "complete",
      completionSummary: "完成",
      verification: ["通过"],
    })),
    /缺少字段：implementationRationale/,
  );
  assert.deepEqual(parseSubtaskResult(JSON.stringify({
    protocol: SUBTASK_RESULT_PROTOCOL,
    outcome: "blocked",
    reason: "缺少凭据",
  })), { outcome: "blocked", reason: "缺少凭据" });
  assert.throws(
    () => parseSubtaskResult(JSON.stringify({
      protocol: SUBTASK_RESULT_PROTOCOL,
      outcome: "complete",
      completionSummary: "完成",
      implementationRationale: "保持验证要求明确",
      verification: [],
    })),
    /verification 必须是非空数组/,
  );
  assert.throws(
    () => parseSubtaskResult(JSON.stringify({
      protocol: SUBTASK_RESULT_PROTOCOL,
      outcome: "complete",
      completionSummary: "完成",
      implementationRationale: "保持协议字段受控",
      verification: ["通过"],
      extra: true,
    })),
    /不支持的字段/,
  );
  assert.throws(
    () => parseSubtaskResult("x".repeat(SUBTASK_RESULT_MAX_BYTES + 1)),
    /结果过大/,
  );
  assert.deepEqual(
    extractSubtaskResultJson("```json\n" + JSON.stringify({ protocol: SUBTASK_RESULT_PROTOCOL, outcome: "blocked", reason: "卡住" }) + "\n```"),
    JSON.stringify({ protocol: SUBTASK_RESULT_PROTOCOL, outcome: "blocked", reason: "卡住" }),
  );
  assert.throws(
    () => parseSubtaskResult("不是 JSON"),
    /JSON/,
  );
});

test("阻塞工作流状态显示原因和建议解决方法", () => {
  const planned = createWorkflowState({
    summary: "阻塞提示测试",
    tasks: [{ id: "implementation", task: "执行实现", files: ["src/feature.js"], acceptanceCriteria: ["测试通过"] }],
  }, 100);
  const blocked = blockWorkflowTask(
    startWorkflowTask(planned, "implementation", 110),
    { taskId: "implementation", reason: "缺少产品决策" },
    120,
  );
  const report = createWorkflowReport({}, { pi: {}, roleRuntime: {} });
  const stateText = report.formatWorkflowState(blocked);
  const notice = report.formatWorkflowBlockNotice(blocked);

  assert.match(stateText, /阻塞原因：任务 implementation · 缺少产品决策/);
  assert.match(stateText, /建议解决方法：.*retry implementation/);
  assert.match(stateText, /task_workflow\(action="replan"\)/);
  assert.equal(notice, stateText.split("\n").slice(-3, -1).join("\n"));
});

test("架构工作流只有明确审阅要求时才暂停，并支持阻塞重试", () => {
  const review = createWorkflowState(
    {
      summary: "先审阅架构",
      reviewRequired: true,
      tasks: [{ id: "implementation", task: "实现方案", files: ["src"], acceptanceCriteria: ["测试通过"] }],
    },
    200,
  );
  assert.equal(review.status, "paused");
  assert.equal(review.pauseReason, "architecture-review");
  const running = resumeWorkflow(review, 210);
  const started = startWorkflowTask(running, "implementation", 220);
  const blocked = blockWorkflowTask(started, { taskId: "implementation", reason: "缺少产品决策" }, 230);
  assert.equal(blocked.status, "paused");
  assert.equal(blocked.tasks[0].status, "blocked");
  assert.throws(() => resumeWorkflow(blocked), /retry/);
  const retried = retryWorkflowTask(blocked, "implementation", 240);
  assert.equal(retried.status, "running");
  assert.equal(retried.tasks[0].status, "pending");
});

test("架构工作流未提交完成时有限次提醒后暂停", () => {
  const state = startWorkflowTask(
    createWorkflowState({
      summary: "提醒测试",
      tasks: [{ id: "task", task: "执行任务", files: ["src"], acceptanceCriteria: ["完成"] }],
    }),
    "task",
  );
  const nudged = recordWorkflowNudge(state);
  assert.equal(nudged.status, "running");
  assert.equal(nudged.nudgeCount, 1);
  const paused = recordWorkflowNudge(nudged);
  assert.equal(paused.status, "paused");
  assert.equal(paused.tasks[0].status, "blocked");
  assert.equal(paused.pauseReason, "task-not-completed");
  assert.equal(WORKFLOW_MAX_NUDGES, 2);
});

test("架构工作流拒绝重复任务、未知依赖和循环依赖", () => {
  assert.throws(
    () => validateWorkflowPlan({
      summary: "重复",
      tasks: [
        { id: "same", task: "a", files: ["a"], acceptanceCriteria: ["a"] },
        { id: "same", task: "b", files: ["b"], acceptanceCriteria: ["b"] },
      ],
    }),
    /id 重复/,
  );
  assert.throws(
    () => validateWorkflowPlan({
      summary: "未知依赖",
      tasks: [{ id: "a", task: "a", files: ["a"], acceptanceCriteria: ["a"], dependsOn: ["missing"] }],
    }),
    /不存在的任务/,
  );
  assert.throws(
    () => validateWorkflowPlan({
      summary: "循环",
      tasks: [
        { id: "a", task: "a", files: ["a"], acceptanceCriteria: ["a"], dependsOn: ["b"] },
        { id: "b", task: "b", files: ["b"], acceptanceCriteria: ["b"], dependsOn: ["a"] },
      ],
    }),
    /循环/,
  );
  assert.equal(WORKFLOW_MAX_TASKS, 12);
  assert.throws(
    () => cancelWorkflow({ status: "completed" }),
    /已经结束/,
  );
  assert.equal(
    getWorkflowTaskDuration({ startedAt: 20, completedAt: 10 }),
    undefined,
  );
  assert.throws(
    () => hydrateWorkflowState({
      version: 2,
      status: "completed",
      plan: { summary: "无效时间", constraints: [] },
      tasks: [{
        id: "task",
        task: "任务",
        role: "developer-test",
        files: ["src"],
        acceptanceCriteria: ["完成"],
        dependsOn: [],
        status: "completed",
        startedAt: 20,
        completedAt: 10,
      }],
    }),
    /completedAt 早于 startedAt/,
  );
});

