import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowState, startWorkflowTask, setWorkflowHandoffPhase, markWorkflowTaskStarted } from "../src/workflow.ts";
import { createRoleHandoff } from "../extensions/role-handoff.ts";
import { createContextBudgetChecker } from "../extensions/context-budget-monitor.ts";
import { createWorkflowCompaction } from "../extensions/workflow-compaction.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";

function fixture() {
  const state = createExtensionRuntimeState();
  const plan = createWorkflowState({ sessionId: "session", summary: "未完成工作", tasks: [
    { id: "task", role: "developer-test", task: "实现", files: ["src"], acceptanceCriteria: ["通过"] },
  ] });
  state.workflowState = markWorkflowTaskStarted(setWorkflowHandoffPhase(startWorkflowTask(plan), "queued"), "task");
  state.agentRunActive = true;
  state.activeRole = { role: "docs-commit", provider: "test", model: "model", thinkingLevel: "high" };
  const branch = [{ id: "initial", type: "message" }];
  const sent = [];
  let callbacks;
  const ctx = {
    model: { provider: "test", id: "model", contextWindow: 100000, maxTokens: 1000 },
    sessionManager: { getSessionId: () => "session", getBranch: () => branch },
    getContextUsage: () => ({ tokens: 90000, contextWindow: 100000, percent: 90 }),
    isIdle: () => true, hasPendingMessages: () => false,
    compact: options => { callbacks = options; }, ui: { notify() {} },
  };
  const pi = {
    getThinkingLevel: () => "high",
    appendEntry: (customType, data) => branch.push({ id: `entry-${branch.length}`, type: "custom", customType, data }),
    sendMessage: async (message, options) => { sent.push({ message, options }); },
  };
  const roleHandoff = createRoleHandoff(pi, state, { getActiveRole: () => state.activeRole, requireRecovery: () => { state.roleRecoveryPending = true; } });
  const source = roleHandoff.capture(ctx);
  state.activeRole = { ...state.activeRole, role: "developer-test" };
  state.roleTransitionGeneration++;
  roleHandoff.finishSwitch(ctx, source, state.activeRole);
  const manager = createWorkflowCompaction(pi, state, {
    roleHandoff, getActiveRole: () => state.activeRole,
    setWorkflowDispatchInFlight: value => { state.workflowDispatchInFlight = value; },
    requireRoleRecovery: () => { state.roleRecoveryPending = true; },
    scheduleWorkflow: async () => assert.fail("must not dispatch a different workflow continuation"),
    sendWorkflowTaskMessage: () => assert.fail("must not replay a task"),
    sendWorkflowReplanMessage: () => assert.fail("must not replan"),
    acknowledgeRoleRecovery: () => assert.fail("compaction must not acknowledge recovery"),
  });
  const check = createContextBudgetChecker(pi, state, {
    mode: async () => "auto", activeRole: () => state.activeRole, start: manager.start, roleHandoff,
  });
  const result = { summary: "preserved task", firstKeptEntryId: "initial", tokensBefore: 90000 };
  let compacted = false;
  const complete = () => {
    if (!compacted) branch.push({ id: "compact", type: "compaction", ...result });
    compacted = true;
    callbacks.onComplete(result);
  };
  return { state, ctx, sent, roleHandoff, manager, check, complete };
}

const guards = {
  "role recovery pending": state => { state.roleRecoveryPending = true; },
  "recovery persistence failed": state => { state.roleRecoveryPersistenceFailed = true; },
  "workflow restore error": state => { state.workflowRestoreError = { code: "READ_FAILED", message: "unavailable" }; },
  "workflow recovery pending": state => { state.pendingWorkflowRecovery = state.workflowState; },
  "task completed": state => { state.workflowState.tasks[0].status = "completed"; },
  "task outcome unknown": state => { state.workflowState.tasks[0].outcomeUnknown = true; },
  "task delegated": state => { state.workflowState.tasks[0].delegation = { status: "running" }; },
  "workflow completed": state => { state.workflowState.status = "completed"; },
  "attempt changed": state => { state.workflowState.handoff.attemptId = "another-attempt"; },
  "handoff phase uncertain": state => { state.workflowState.handoff.phase = "uncertain"; },
  "role generation changed": state => { state.roleTransitionGeneration++; },
};

for (const [name, invalidate] of Object.entries(guards)) {
  test(`预算压缩期间 ${name}：迟到成功不能恢复已失效交接`, async () => {
    const f = fixture();
    assert.equal(await f.check(f.ctx), true);
    invalidate(f.state);
    f.state.agentRunActive = false;
    f.complete();
    assert.equal(await f.roleHandoff.schedule(f.ctx), true, "retired boundary must suppress fallback workflow dispatch");
    assert.equal(f.sent.filter(({ options }) => options.triggerTurn).length, 0);
    // Clearing the recovery flag later must not resurrect the old handoff.
    f.state.roleRecoveryPending = false;
    f.state.roleRecoveryPersistenceFailed = false;
    f.state.workflowRestoreError = undefined;
    f.state.pendingWorkflowRecovery = undefined;
    assert.equal(await f.roleHandoff.schedule(f.ctx), true);
    assert.equal(f.sent.filter(({ options }) => options.triggerTurn).length, 0);
    f.manager.dispose();
  });
}

test("压缩失败回调先到，后续成功回调与 settled 不重放；新交接不受旧回调影响", async () => {
  const f = fixture();
  assert.equal(await f.check(f.ctx), true);
  f.manager.settle(f.state.roleCompactionOperationId, "compaction failed");
  f.state.agentRunActive = false;
  f.complete();
  await f.roleHandoff.schedule(f.ctx);
  assert.equal(f.sent.filter(({ options }) => options.triggerTurn).length, 0);
  f.state.agentRunActive = true;
  const source = f.roleHandoff.capture(f.ctx);
  f.state.activeRole = { ...f.state.activeRole, role: "docs-commit" };
  f.state.roleTransitionGeneration++;
  f.roleHandoff.finishSwitch(f.ctx, source, f.state.activeRole);
  f.complete();
  f.state.agentRunActive = false;
  await f.roleHandoff.schedule(f.ctx);
  assert.equal(f.sent.filter(({ options }) => options.triggerTurn).length, 1);
  f.manager.dispose();
});
