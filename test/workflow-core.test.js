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
  appendWorkflowReplanDirection,
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

test("架构工作流按依赖顺序推进并在完成后选择下一任务", () => {
  const planned = createWorkflowState(
    {
      summary: "完成用户认证改造",
      constraints: ["保留现有登录接口"],
      tasks: [
        {
          id: "schema",
          task: "更新认证数据结构",
          files: ["src/auth/schema.js"],
          acceptanceCriteria: ["迁移可重复执行", "新增回归测试"],
        },
        {
          id: "service",
          task: "实现认证服务",
          files: ["src/auth/service.js"],
          acceptanceCriteria: ["服务使用新结构"],
          dependsOn: ["schema"],
        },
        {
          id: "docs",
          task: "更新认证文档",
          role: "docs-commit",
          files: ["README.md"],
          acceptanceCriteria: ["文档与实际行为一致"],
          dependsOn: ["service"],
        },
      ],
    },
    100,
  );

  assert.equal(planned.status, "running");
  assert.equal(getNextWorkflowTask(planned).id, "schema");
  const first = startWorkflowTask(planned, "schema", 110);
  assert.equal(first.currentTaskId, "schema");
  assert.equal(first.tasks[0].startedAt, undefined);
  const firstStarted = markWorkflowTaskStarted(first, "schema", 115);
  assert.equal(firstStarted.tasks[0].startedAt, 115);
  assert.equal(firstStarted.tasks[0].executionStartedAt, 115);
  assert.equal(firstStarted.startedAt, 115);
  assert.equal(getWorkflowExecutionBounds(firstStarted).startedAt, 115);
  assert.equal(markWorkflowTaskStarted(firstStarted, "schema", 119), firstStarted);
  assert.throws(
    () => completeWorkflowTask(
      firstStarted,
      { taskId: "schema", completionSummary: "结构和迁移已完成", verification: ["npm test：通过"] },
      120,
    ),
    /实现原因不能为空/,
  );
  const second = completeWorkflowTask(
    firstStarted,
    { taskId: "schema", completionSummary: "结构和迁移已完成", implementationRationale: "保留兼容边界并覆盖迁移路径", verification: ["npm test：通过"] },
    120,
  );
  assert.equal(second.currentTaskId, undefined);
  assert.equal(second.tasks[0].completedAt, 120);
  assert.equal(getWorkflowTaskDuration(second.tasks[0]), 5);
  assert.equal(second.completedAt, undefined);
  assert.equal(getWorkflowExecutionDuration(second), 5);
  assert.equal(getNextWorkflowTask(second).id, "service");
  const secondStarted = markWorkflowTaskStarted(startWorkflowTask(second, "service", 130), "service", 135);
  const third = completeWorkflowTask(
    secondStarted,
    { taskId: "service", completionSummary: "服务已切换", implementationRationale: "沿用现有服务接口以降低改动范围", verification: ["npm test：通过"] },
    140,
  );
  assert.equal(getNextWorkflowTask(third).id, "docs");
  const finishedStarted = markWorkflowTaskStarted(startWorkflowTask(third, "docs", 150), "docs", 155);
  const finished = completeWorkflowTask(
    finishedStarted,
    { taskId: "docs", completionSummary: "文档已同步", implementationRationale: "让文档与已验证行为保持一致", verification: ["git diff --check：通过"] },
    160,
  );
  assert.equal(finished.status, "completed");
  assert.equal(finished.startedAt, 115);
  assert.equal(finished.completedAt, 160);
  assert.deepEqual(getWorkflowExecutionBounds(finished), { startedAt: 115, completedAt: 160 });
  assert.equal(getWorkflowExecutionDuration(finished), 45);
  assert.deepEqual(workflowProgress(finished), { completed: 3, total: 3, blocked: 0, currentTaskId: undefined });
});

test("工作流任务支持合法的动态角色 ID并保留默认开发角色", () => {
  const state = createWorkflowState({
    summary: "动态角色工作流",
    tasks: [
      { id: "review", role: "qa-review", task: "执行评审", files: ["src/review.js"], acceptanceCriteria: ["评审完成"] },
      { id: "implementation", task: "执行实现", files: ["src/feature.js"], acceptanceCriteria: ["测试通过"] },
    ],
  });
  assert.deepEqual(state.tasks.map((task) => task.role), ["qa-review", "developer-test"]);
  assert.throws(
    () => createWorkflowState({
      summary: "非法角色",
      tasks: [{ id: "task", role: "qa_review", task: "执行", files: ["src"], acceptanceCriteria: ["完成"] }],
    }),
    /role 无效/,
  );
});

test("工作流重规划保留已完成任务、支持新增并审计被替换任务", () => {
  const planned = createWorkflowState({
    summary: "原始计划",
    constraints: ["保持兼容"],
    tasks: [
      { id: "schema", task: "完成结构", files: ["src/schema.js"], acceptanceCriteria: ["结构完成"] },
      { id: "keep", task: "保留任务", files: ["src/keep.js"], acceptanceCriteria: ["保留"] },
      { id: "obsolete", task: "旧任务", files: ["src/obsolete.js"], acceptanceCriteria: ["旧任务完成"] },
    ],
  }, 100);
  const completed = completeWorkflowTask(
    markWorkflowTaskStarted(startWorkflowTask(planned, "schema", 110), "schema", 115),
    { taskId: "schema", completionSummary: "结构已完成", implementationRationale: "先固定数据结构再推进后续变更", verification: ["npm test：通过"] },
    120,
  );
  const completedSnapshot = JSON.parse(JSON.stringify(getWorkflowTask(completed, "schema")));
  const requested = requestWorkflowReplan(
    completed,
    { revisionId: "revision-1", direction: "新增缓存任务并保留仍有效的 keep" },
    130,
  );
  assert.equal(requested.status, "replanning");
  assert.deepEqual(requested.pendingRevision, {
    revisionId: "revision-1",
    direction: "新增缓存任务并保留仍有效的 keep",
    requestedAt: 130,
  });
  assert.equal(requested.revisions[0].status, "requested");
  const restoredRequest = hydrateWorkflowState(JSON.parse(JSON.stringify(requested)));
  assert.equal(restoredRequest.status, "replanning");
  assert.deepEqual(restoredRequest.pendingRevision, requested.pendingRevision);
  assert.deepEqual(restoredRequest.revisions, requested.revisions);

  const applied = applyWorkflowReplan(
    requested,
    {
      revisionId: "revision-1",
      summary: "扩展后的计划",
      constraints: ["保持兼容", "缓存可回滚"],
      retainTaskIds: ["keep"],
      tasks: [{
        id: "cache",
        task: "新增缓存",
        files: ["src/cache.js"],
        acceptanceCriteria: ["缓存有测试"],
        dependsOn: ["schema"],
      }],
    },
    140,
  );
  assert.equal(applied.status, "running");
  assert.equal(applied.pendingRevision, undefined);
  assert.deepEqual(getWorkflowTask(applied, "schema"), completedSnapshot);
  assert.deepEqual(
    applied.tasks.map((task) => task.id),
    ["schema", "keep", "cache"],
  );
  assert.equal(getWorkflowTask(applied, "obsolete"), undefined);
  assert.equal(getNextWorkflowTask(applied).id, "keep");
  assert.deepEqual(applied.revisions[0], {
    revisionId: "revision-1",
    direction: "新增缓存任务并保留仍有效的 keep",
    status: "applied",
    requestedAt: 130,
    appliedAt: 140,
    previousPlan: { summary: "原始计划", constraints: ["保持兼容"] },
    previousTasks: requested.tasks,
    replacedTaskIds: ["obsolete"],
    replacedTasks: [{
      ...getWorkflowTask(requested, "obsolete"),
      status: "superseded",
      supersededAt: 140,
      supersededBy: "revision-1",
    }],
    retainedTaskIds: ["keep"],
    addedTaskIds: ["cache"],
    newPlan: {
      summary: "扩展后的计划",
      constraints: ["保持兼容", "缓存可回滚"],
      tasks: [getWorkflowTask(applied, "cache")],
    },
  });

  const restored = hydrateWorkflowState(JSON.parse(JSON.stringify(applied)));
  assert.equal(restored.version, 3);
  assert.deepEqual(restored.tasks, applied.tasks);
  assert.deepEqual(restored.revisions, applied.revisions);
});

test("工作流重规划在当前任务结束后才切换状态并拒绝过期计划", () => {
  const started = startWorkflowTask(
    createWorkflowState({
      summary: "边界测试",
      tasks: [
        { id: "current", task: "当前任务", files: ["src/current.js"], acceptanceCriteria: ["完成"] },
        { id: "future", task: "未来任务", files: ["src/future.js"], acceptanceCriteria: ["完成"] },
      ],
    }),
    "current",
    200,
  );
  const requested = requestWorkflowReplan(
    started,
    { revisionId: "revision-boundary", direction: "改为新的后续任务" },
    210,
  );
  assert.equal(requested.status, "running");
  assert.equal(requested.currentTaskId, "current");
  assert.throws(
    () => applyWorkflowReplan(requested, {
      revisionId: "revision-boundary",
      summary: "过早应用",
      tasks: [{ id: "new", task: "新任务", files: ["src/new.js"], acceptanceCriteria: ["完成"] }],
    }),
    /等待重规划状态/,
  );
  const finished = completeWorkflowTask(
    requested,
    { taskId: "current", completionSummary: "当前任务完成", implementationRationale: "先完成当前边界再等待架构重规划", verification: ["npm test：通过"] },
    220,
  );
  assert.equal(finished.status, "replanning");
  const applied = applyWorkflowReplan(
    finished,
    {
      revisionId: "revision-boundary",
      summary: "新的后续任务",
      tasks: [{ id: "new", task: "新任务", files: ["src/new.js"], acceptanceCriteria: ["完成"] }],
    },
    230,
  );
  assert.equal(applied.status, "running");
  assert.equal(getWorkflowTask(applied, "future"), undefined);
  assert.throws(
    () => applyWorkflowReplan(applied, {
      revisionId: "revision-boundary",
      summary: "重复应用",
      tasks: [{ id: "other", task: "其他", files: ["src/other.js"], acceptanceCriteria: ["完成"] }],
    }),
    /等待重规划状态/,
  );
});

test("工作流重规划拒绝复用任务 ID、悬空依赖、循环和超出数量限制", () => {
  const base = createWorkflowState({
    summary: "校验重规划",
    tasks: [
      { id: "done", task: "已完成", files: ["src/done.js"], acceptanceCriteria: ["完成"] },
      { id: "old", task: "旧任务", files: ["src/old.js"], acceptanceCriteria: ["完成"] },
    ],
  });
  const completed = completeWorkflowTask(
    markWorkflowTaskStarted(startWorkflowTask(base, "done"), "done"),
    { taskId: "done", completionSummary: "完成", implementationRationale: "保持完成任务与后续重规划边界清晰", verification: ["通过"] },
  );
  const requested = requestWorkflowReplan(completed, { revisionId: "revision-validation", direction: "验证" });
  const apply = (tasks, extra = {}) => applyWorkflowReplan(requested, {
    revisionId: "revision-validation",
    summary: "新计划",
    tasks,
    ...extra,
  });

  assert.throws(
    () => apply([{ id: "old", task: "复用旧 ID", files: ["src/new.js"], acceptanceCriteria: ["完成"] }]),
    /不能复用历史任务 ID/,
  );
  assert.throws(
    () => apply([{ id: "new", task: "依赖被替换任务", files: ["src/new.js"], acceptanceCriteria: ["完成"], dependsOn: ["old"] }]),
    /不存在的任务/,
  );
  assert.throws(
    () => apply([
      { id: "cycle-a", task: "循环 A", files: ["src/a.js"], acceptanceCriteria: ["完成"], dependsOn: ["cycle-b"] },
      { id: "cycle-b", task: "循环 B", files: ["src/b.js"], acceptanceCriteria: ["完成"], dependsOn: ["cycle-a"] },
    ]),
    /循环/,
  );

  const manyTasks = Array.from({ length: 12 }, (_, index) => ({
    id: `task-${index}`,
    task: `任务 ${index}`,
    files: [`src/task-${index}.js`],
    acceptanceCriteria: ["完成"],
  }));
  const manyState = createWorkflowState({ summary: "数量", tasks: manyTasks });
  const manyCompleted = completeWorkflowTask(
    markWorkflowTaskStarted(startWorkflowTask(manyState, "task-0"), "task-0"),
    { taskId: "task-0", completionSummary: "完成", implementationRationale: "先完成首个任务以验证数量边界", verification: ["通过"] },
  );
  const manyRequested = requestWorkflowReplan(manyCompleted, { revisionId: "revision-count", direction: "增加任务" });
  assert.throws(
    () => applyWorkflowReplan(manyRequested, {
      revisionId: "revision-count",
      summary: "超出数量",
      retainTaskIds: manyTasks.slice(1).map((task) => task.id),
      tasks: [
        { id: "extra-a", task: "额外 A", files: ["src/extra-a.js"], acceptanceCriteria: ["完成"] },
        { id: "extra-b", task: "额外 B", files: ["src/extra-b.js"], acceptanceCriteria: ["完成"] },
      ],
    }),
    /最多支持 12 个活动任务/,
  );
});

test("工作流状态从 version 1 迁移到本地执行器并保留任务进度", () => {
  const legacy = {
    version: 1,
    status: "running",
    plan: { summary: "旧工作流", constraints: [] },
    tasks: [{
      id: "legacy-task",
      task: "继续旧任务",
      role: "developer-test",
      files: ["src/legacy.js"],
      acceptanceCriteria: ["测试通过"],
      dependsOn: [],
      status: "in_progress",
    }],
    currentTaskId: "legacy-task",
    nudgeCount: 1,
    createdAt: 10,
    updatedAt: 20,
  };
  const restored = hydrateWorkflowState(legacy);
  assert.equal(restored.version, 3);
  assert.deepEqual(restored.revisions, []);
  assert.equal(restored.executor, "local");
  assert.equal(restored.currentTaskId, "legacy-task");
  const restoredV2 = hydrateWorkflowState({ ...legacy, version: 2, executor: "local" });
  assert.equal(restoredV2.version, 3);
  assert.deepEqual(restoredV2.revisions, []);
  assert.equal(restored.tasks[0].status, "in_progress");
  assert.equal(restored.tasks[0].startedAt, undefined);
  assert.equal(getWorkflowTaskDuration(restored.tasks[0]), undefined);
  const staleStarted = hydrateWorkflowState({
    ...legacy,
    tasks: [{ ...legacy.tasks[0], startedAt: 5 }],
  });
  const refreshedStart = markWorkflowTaskStarted(staleStarted, "legacy-task", 30);
  assert.equal(refreshedStart.tasks[0].startedAt, 30);
  assert.equal(refreshedStart.tasks[0].executionStartedAt, 30);
  assert.equal(restored.tasks[0].delegation, undefined);

  const legacyCompleted = hydrateWorkflowState({
    ...legacy,
    status: "completed",
    currentTaskId: undefined,
    tasks: [{ ...legacy.tasks[0], status: "completed", startedAt: 40, completedAt: 70 }],
  });
  assert.deepEqual(getWorkflowExecutionBounds(legacyCompleted), { startedAt: 40, completedAt: 70 });
  assert.equal(getWorkflowExecutionDuration(legacyCompleted), 30);
  assert.equal(getWorkflowExecutionDuration({ startedAt: 80, completedAt: 70, tasks: [] }), undefined);
  assert.throws(
    () => hydrateWorkflowState({ ...legacy, startedAt: 80, completedAt: 70 }),
    /completedAt 早于 startedAt/,
  );
});

test("subtask 工作流保存委派、失败和取消状态", () => {
  const planned = createWorkflowState({
    executor: "subtask",
    summary: "委派实现任务",
    tasks: [{
      id: "implementation",
      task: "执行实现",
      files: ["src/feature.js"],
      acceptanceCriteria: ["测试通过"],
    }],
  }, 100);
  const started = startWorkflowTask(planned, "implementation", 110);
  const spawning = beginWorkflowDelegation(
    started,
    { taskId: "implementation", requestId: "request-1", type: "workflow-developer" },
    120,
  );
  assert.deepEqual(spawning.tasks[0].delegation, {
    requestId: "request-1",
    type: "workflow-developer",
    status: "spawning",
    createdAt: 120,
  });
  assert.throws(
    () => beginWorkflowDelegation(createWorkflowState({ executor: "local", summary: "本地", tasks: [{ id: "implementation", task: "本地执行", files: ["src"], acceptanceCriteria: ["完成"] }] }, 90), {
      taskId: "implementation",
      requestId: "request",
      type: "workflow-developer",
    }),
    /subtask 执行器/,
  );
  const blocked = blockWorkflowTask(spawning, { taskId: "implementation", reason: "结果协议无效" }, 150);
  assert.equal(blocked.status, "paused");
  assert.equal(blocked.tasks[0].delegation.status, "failed");
  assert.equal(blocked.tasks[0].delegation.reason, "结果协议无效");

  const retried = retryWorkflowTask(blocked, "implementation", 160);
  assert.equal(retried.tasks[0].startedAt, undefined);
  assert.equal(retried.tasks[0].executionStartedAt, undefined);
  assert.equal(retried.tasks[0].completedAt, undefined);
  assert.equal(retried.tasks[0].delegation, undefined);
  const redelegated = beginWorkflowDelegation(
    startWorkflowTask(retried, "implementation", 170),
    { taskId: "implementation", requestId: "request-2", type: "workflow-developer" },
    180,
  );
  const cancelled = cancelWorkflow(redelegated, 200);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.tasks[0].delegation.status, "stop-requested");
  assert.equal(requestWorkflowDelegationStop(cancelled), cancelled);
});

