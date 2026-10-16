import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";
import { requestWorkflowTaskClarification } from "../src/workflow.ts";

const {
  appendWorkflowReplanDirection,
  applyWorkflowReplan,
  completeWorkflowTask,
  createWorkflowState,
  createExtensionHarness,
  emitExtensionEvent,
  getNextWorkflowTask,
  hydrateWorkflowState,
  requestWorkflowReplan,
  startWorkflowTask,
  withTempDirectory,
} = helpers;

const architectModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
const developerModel = { provider: "openai-codex", id: "gpt-5.6-luna" };

function taskContract(overrides = {}) {
  return {
    version: 1,
    outcome: "Implement only confirmed behavior.",
    requirementSources: ["Confirmed user requirement"],
    expectedBehavior: ["Keep the verified boundary behavior."],
    evidence: [{ findingId: "input-fact", sourceId: "src/input.ts", sourceVersion: "sha-v2" }],
    clarificationResolutions: [],
    fixedDecisions: ["Do not replay an uncertain side effect."],
    invariants: ["Keep completed work."],
    nonGoals: [],
    blockingQuestions: [],
    engineeringDiscretion: ["Choose a local helper boundary."],
    verification: ["Run focused tests."],
    ...overrides,
  };
}

test("重规划交接携带完整身份并保留 architect 取证边界", async () => {
  await withTempDirectory(async (directory) => {
    const state = requestWorkflowReplan(
      createWorkflowState({
        workflowId: "replan-role-routing",
        sessionId: "replan-session",
        summary: "重规划身份",
        tasks: [{ id: "current", task: "继续规划", files: ["src/current.js"], acceptanceCriteria: ["完成"] }],
      }),
      { revisionId: "revision-read", direction: "补充后续工作" },
      110,
    );
    const harness = createExtensionHarness([
      { type: "custom", customType: "pi-init-workflow", data: state },
    ], {
      cwd: directory,
      sessionId: "replan-session",
      trusted: true,
      model: architectModel,
      availableModels: [architectModel, developerModel],
    });

    await emitExtensionEvent(harness, "session_start");

    const message = harness.sentMessages.find(({ message: item }) => item.customType === "pi-init-workflow-replan");
    assert.ok(message);
    const latest = harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow").data;
    assert.deepEqual(message.message.details, {
      workflowId: latest.workflowId,
      planVersion: latest.planVersion,
      sessionId: latest.sessionId,
      recoveryGeneration: latest.recoveryGeneration,
      revisionId: latest.pendingRevision.revisionId,
      handoffId: latest.continuation.handoffId,
    });
    assert.match(message.message.content, /architect 不直接取证、不执行代码、不连接 MCP/);
    assert.match(message.message.content, /request-evidence 安排 docs-commit 查证/);
  });
});

test("连续方向输入合并到同一待处理 revision，重规划前不启动旧后续任务", () => {
  const started = startWorkflowTask(
    createWorkflowState({
      summary: "合并方向",
      tasks: [
        { id: "current", task: "当前任务", files: ["src/current.js"], acceptanceCriteria: ["完成"] },
        { id: "old-next", task: "旧后续任务", files: ["src/old-next.js"], acceptanceCriteria: ["完成"] },
      ],
    }),
    "current",
    300,
  );
  const requested = requestWorkflowReplan(
    started,
    { revisionId: "revision-merge", direction: "先增加缓存层" },
    310,
  );
  assert.equal(requested.status, "running");

  const appended = appendWorkflowReplanDirection(requested, "再把报表改为异步导出", 320);
  const appendedTwice = appendWorkflowReplanDirection(appended, "  最后补充回归测试  ", 330);
  assert.equal(appendedTwice.status, "running");
  assert.equal(appendedTwice.currentTaskId, "current");
  assert.deepEqual(appendedTwice.pendingRevision, {
    revisionId: "revision-merge",
    direction: "先增加缓存层\n再把报表改为异步导出\n最后补充回归测试",
    requestedAt: 310,
    requestedFromTaskId: "current",
  });
  assert.equal(appendedTwice.revisions.length, requested.revisions.length);
  assert.equal(appendedTwice.revisions[0].direction, appendedTwice.pendingRevision.direction);
  assert.equal(getNextWorkflowTask(appendedTwice), undefined);

  const restored = hydrateWorkflowState(JSON.parse(JSON.stringify(appendedTwice))).value;
  assert.deepEqual(restored.pendingRevision, appendedTwice.pendingRevision);
  assert.deepEqual(restored.revisions, appendedTwice.revisions);

  assert.throws(
    () => appendWorkflowReplanDirection(started, "无效"),
    /没有待处理的重规划请求/,
  );

  const finished = completeWorkflowTask(
    appendedTwice,
    { taskId: "current", completionSummary: "当前任务完成", implementationRationale: "先完成当前任务再应用新的方向", verification: ["npm test：通过"] },
    340,
  );
  assert.equal(finished.status, "replanning");
  assert.equal(getNextWorkflowTask(finished), undefined);

  const waitingAppend = appendWorkflowReplanDirection(finished, "等待期间追加的新要求", 350);
  assert.equal(waitingAppend.status, "replanning");
  assert.equal(
    waitingAppend.pendingRevision.direction,
    "先增加缓存层\n再把报表改为异步导出\n最后补充回归测试\n等待期间追加的新要求",
  );

  const applied = applyWorkflowReplan(waitingAppend, {
    revisionId: "revision-merge",
    summary: "合并后的新计划",
    tasks: [{ id: "merged-new", task: "合并后的任务", files: ["src/new.js"], acceptanceCriteria: ["完成"] }],
  }, 360);
  assert.equal(applied.status, "running");
  assert.equal(applied.pendingRevision, undefined);
  assert.equal(applied.tasks.some((task) => task.id === "old-next"), false);
  assert.equal(applied.revisions[0].status, "applied");
  assert.equal(
    applied.revisions[0].direction,
    "先增加缓存层\n再把报表改为异步导出\n最后补充回归测试\n等待期间追加的新要求",
  );
  assert.equal(applied.plan.summary, "合并后的新计划");
});

test("clarify 保存部分成果并以新 revision 返回 architect；replan 必须显式解决证据和副作用", () => {
  const planned = createWorkflowState({
    summary: "澄清后继续",
    tasks: [
      { id: "finished", task: "已完成前置工作", files: ["src/finished.ts"], acceptanceCriteria: ["保留"] },
      {
        id: "blocked-implementation",
        task: "实现依赖当前事实的行为",
        files: ["src/input.ts"],
        acceptanceCriteria: ["边界行为正确"],
        contract: taskContract(),
      },
    ],
  }, 100);
  const completed = completeWorkflowTask(
    helpers.markWorkflowTaskStarted(startWorkflowTask(planned, "finished", 110), "finished", 115),
    { taskId: "finished", completionSummary: "前置成果已完成", implementationRationale: "按依赖顺序先完成稳定部分", verification: ["node --test test/finished.test.js：通过"] },
    120,
  );
  const active = helpers.markWorkflowTaskStarted(startWorkflowTask(completed, "blocked-implementation", 130), "blocked-implementation", 135);
  const result = requestWorkflowTaskClarification(active, {
    category: "missing-fact",
    question: "解析失败时直接调用方是否保留原输入？",
    impact: "没有该事实无法确定用户可观察结果。",
    checkedFacts: ["实现分支返回了结构化失败；尚未核实所有调用方。"],
    completedWork: ["完成与该问题无关的类型适配。"],
    verification: ["node --test test/input.test.js：通过"],
    sideEffects: { status: "unknown", details: ["持久化调用的结果尚未核对；不得重复触发。"] },
  }, 140);
  assert.equal(result.ok, true);
  const clarified = result.value;
  const clarification = clarified.tasks.find((task) => task.id === "blocked-implementation").clarification;
  assert.equal(clarified.status, "replanning");
  assert.equal(clarified.currentTaskId, undefined);
  assert.equal(clarified.tasks.find((task) => task.id === "blocked-implementation").status, "blocked");
  assert.equal(clarified.tasks.find((task) => task.id === "blocked-implementation").completedAt, undefined);
  assert.equal(clarification.handoff.attemptId, active.handoff.attemptId);
  assert.equal(clarification.sideEffects.status, "unknown");
  assert.equal(clarified.tasks.find((task) => task.id === "finished").completionSummary, "前置成果已完成");

  const restored = hydrateWorkflowState(JSON.parse(JSON.stringify(clarified)));
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.value.tasks.find((task) => task.id === "blocked-implementation").clarification, clarification);
  assert.throws(() => applyWorkflowReplan(clarified, {
    revisionId: clarified.pendingRevision.revisionId,
    summary: "缺少澄清处置",
    tasks: [{ id: "followup-missing-resolution", task: "继续", files: ["src/input.ts"], acceptanceCriteria: ["完成"], contract: taskContract() }],
  }), { code: "WORKFLOW_CLARIFICATION_UNRESOLVED" });

  const applied = applyWorkflowReplan(clarified, {
    revisionId: clarified.pendingRevision.revisionId,
    summary: "按新证据继续，不重复副作用",
    tasks: [{
      id: "followup-resolved",
      task: "基于重新接受的事实继续实现，不重复未知副作用。",
      files: ["src/input.ts"],
      acceptanceCriteria: ["边界行为符合确认事实"],
      contract: taskContract({
        clarificationResolutions: [{
          issueId: clarification.issueId,
          resolutionKind: "evidence",
          resolution: "architect 已基于接受的调用方证据界定行为。",
          sideEffectDisposition: "no-replay",
        }],
      }),
    }],
  }, 150);
  assert.equal(applied.planVersion, clarified.planVersion + 1);
  assert.equal(applied.status, "running");
  assert.equal(applied.tasks.find((task) => task.id === "finished").completionSummary, "前置成果已完成");
  assert.equal(applied.tasks.some((task) => task.id === "blocked-implementation"), false);
  assert.equal(applied.revisions[0].replacedTasks[0].clarification.issueId, clarification.issueId);
  assert.equal(applied.revisions[0].replacedTasks[0].status, "superseded");
});
