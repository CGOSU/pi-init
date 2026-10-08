import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";

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
  workflowProgress,
  completeRunTiming,
  createRunTiming,
  getRunTimingDuration,
  isExternalRunSource,
  withTempDirectory,
  createExtensionHarness,
  emitExtensionEvent,
  runExternalAgent,
} = helpers;

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
  assert.equal(paused.pauseReason, "handoff-outcome-unknown");
  assert.equal(paused.tasks[0].outcomeUnknown, true);
  assert.throws(
    () => retryWorkflowTask(paused, "task"),
    { code: "WORKFLOW_UNKNOWN_OUTCOME_CONFIRMATION_REQUIRED" },
  );
  assert.equal(retryWorkflowTask(paused, "task", undefined, { confirmUnknownOutcome: true }).status, "running");
  assert.equal(WORKFLOW_MAX_NUDGES, 2);
});

test("架构角色不能作为工作流执行角色，错误包含结构化诊断", () => {
  assert.throws(
    () => validateWorkflowPlan({
      summary: "禁止 architect 执行",
      tasks: [{ id: "design", role: "architect", task: "执行实现", files: ["src"], acceptanceCriteria: ["完成"] }],
    }),
    (error) => error.code === "WORKFLOW_EXECUTION_ROLE_FORBIDDEN"
      && error.message.includes('"taskId":"design"')
      && error.message.includes('"role":"architect"'),
  );
});

test("重规划不能保留 architect 执行任务", () => {
  const state = createWorkflowState({
    summary: "旧 architect 执行任务",
    tasks: [{ id: "old-task", task: "旧任务", files: ["src"], acceptanceCriteria: ["完成"] }],
  });
  state.tasks[0].role = "architect";
  const pending = requestWorkflowReplan(state, { revisionId: "revision-role", direction: "替换不可执行任务" });
  const original = JSON.stringify(pending);
  assert.throws(
    () => applyWorkflowReplan(pending, {
      revisionId: "revision-role",
      summary: "替换计划",
      tasks: [{ id: "new-task", task: "有效任务", files: ["src"], acceptanceCriteria: ["完成"] }],
      retainTaskIds: ["old-task"],
    }),
    { code: "WORKFLOW_EXECUTION_ROLE_FORBIDDEN" },
  );
  assert.equal(JSON.stringify(pending), original);
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
  const invalidHydration = hydrateWorkflowState({
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
  });
  assert.equal(invalidHydration.code, "WORKFLOW_STATE_INVALID");
  assert.match(invalidHydration.message, /completedAt 早于 startedAt/);
});

