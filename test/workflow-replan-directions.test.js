import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";
import { } from "../src/workflow.ts";

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
    assert.match(message.message.content, /普通 docs-commit 调查任务/);
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

test("retired clarification is rejected without losing the source state", () => {
  const state = createWorkflowState({ summary: "plain", tasks: [{ id: "task", task: "work", files: ["src"], acceptanceCriteria: ["done"] }] });
  const source = { ...state, tasks: state.tasks.map(task => ({ ...task, clarification: {} })) };
  const before = structuredClone(source);
  assert.equal(hydrateWorkflowState(source).code, "WORKFLOW_FEATURE_RETIRED");
  assert.deepEqual(source, before);
});