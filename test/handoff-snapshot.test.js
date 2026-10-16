import assert from "node:assert/strict";
import test from "node:test";
import { buildHandoffSnapshot } from "../extensions/handoff-snapshot.ts";
import { shouldCompactAfterWorkflowTask } from "../src/roles.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowState } from "../src/workflow.ts";

test("轻量交接自动引用任务，缺少说明不阻塞且不复制契约全文", () => {
  const state = createExtensionRuntimeState();
  state.workflowState = createWorkflowState({ sessionId: "test-session", summary: "交接目标", tasks: [{ id: "next", role: "developer-test", task: "继续实现", files: ["src"], acceptanceCriteria: ["通过"] }] });
  const snapshot = buildHandoffSnapshot(state, "developer-test");
  assert.equal(snapshot.role, "developer-test");
  assert.equal(snapshot.workflow.taskId, "next");
  assert.equal(snapshot.workflow.status, "running");
  assert.match(snapshot.nextAction, /task_workflow/);
  assert.equal(snapshot.contract, undefined);
  assert.equal(snapshot.verification, undefined);
});

test("无活动任务交接不创造任务，完成工作流不提供旧任务引用", () => {
  const state = createExtensionRuntimeState();
  assert.match(buildHandoffSnapshot(state, "architect").nextAction, /未完成/);
  state.workflowState = createWorkflowState({ sessionId: "test-session", summary: "已结束", tasks: [{ id: "old", role: "developer-test", task: "旧任务", files: ["src"], acceptanceCriteria: ["通过"] }] });
  state.workflowState.status = "completed";
  assert.equal(buildHandoffSnapshot(state, "architect").workflow, undefined);
});

test("目标模型预算识别低于 50% 的大窗口到小窗口交接", () => {
  assert.equal(shouldCompactAfterWorkflowTask({ mode: "auto", contextUsage: { percent: 20, tokens: 40000 }, targetModel: { contextWindow: 32000, maxTokens: 8000 } }), true);
  assert.equal(shouldCompactAfterWorkflowTask({ mode: "auto", contextUsage: { percent: 20, tokens: 40000 }, targetModel: { contextWindow: 200000, maxTokens: 8000 } }), false);
  assert.equal(shouldCompactAfterWorkflowTask({ mode: "manual", contextUsage: { percent: 20, tokens: 40000 }, targetModel: { contextWindow: 32000, maxTokens: 8000 } }), false);
});

test("预算不可用时沿用 50% 兜底，不增加恢复门槛", () => {
  assert.equal(shouldCompactAfterWorkflowTask({ mode: "auto", contextUsage: { percent: 50 } }), true);
  assert.equal(shouldCompactAfterWorkflowTask({ mode: "auto", contextUsage: { percent: 49, tokens: null }, targetModel: { contextWindow: 32000, maxTokens: 8000 } }), false);
});
