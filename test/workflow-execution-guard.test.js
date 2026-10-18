import assert from "node:assert/strict";
import test from "node:test";
import { createRoleRecovery } from "../extensions/role-recovery.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";

function fixture() {
  const state = createExtensionRuntimeState();
  state.activeRole = { role: "developer-test", provider: "test", model: "dev", thinkingLevel: "max" };
  state.workflowState = { status: "paused", pauseReason: "handoff-outcome-unknown", tasks: [{ id: "task", status: "blocked", outcomeUnknown: true }] };
  const recovery = createRoleRecovery({ on() {}, appendEntry() {} }, state);
  return { state, recovery };
}

test("确认角色不会解除暂停工作流的执行门", () => {
  const { state, recovery } = fixture();
  state.roleRecoveryPending = true;
  recovery.acknowledge("developer-test");
  assert.equal(state.roleRecoveryPending, false);
  for (const toolName of ["edit", "write", "bash", "powershell", "custom_mutation"])
    assert.equal(recovery.guardToolCall({ toolName, input: {} })?.block, true, toolName);
  for (const toolName of ["read", "grep", "find", "ls", "switch_role"])
    assert.equal(recovery.guardToolCall({ toolName, input: {} }), undefined, toolName);
  assert.equal(recovery.guardToolCall({ toolName: "task_workflow", input: { action: "status" } }), undefined);
});

test("模型自行填写确认布尔值不能授权结果未知的任务重放", () => {
  const { recovery } = fixture();
  const result = recovery.guardToolCall({ toolName: "task_workflow", input: { action: "retry", taskId: "task", confirmUnknownOutcome: true } });
  assert.equal(result?.block, true);
  assert.match(result.reason, /confirm-unknown-outcome/);
});

test("恢复失败及待持久化恢复状态阻止执行，正常运行不被暂停门干扰", () => {
  const { state, recovery } = fixture();
  state.workflowState.status = "running";
  assert.equal(recovery.guardToolCall({ toolName: "edit", input: {} }), undefined);
  state.pendingWorkflowRecovery = state.workflowState;
  assert.equal(recovery.guardToolCall({ toolName: "edit", input: {} })?.block, true);
  delete state.pendingWorkflowRecovery;
  state.workflowRestoreError = { code: "WORKFLOW_INVALID", message: "invalid" };
  assert.equal(recovery.guardToolCall({ toolName: "bash", input: {} })?.block, true);
});
test("模型不能借重规划确认布尔值重放未知副作用", () => {
  const { state, recovery } = fixture();
  state.workflowState.status = "replanning";
  assert.equal(recovery.guardToolCall({ toolName: "task_workflow", input: { action: "replan", confirmUnknownOutcome: true } })?.block, true);
  assert.equal(recovery.guardToolCall({ toolName: "task_workflow", input: { action: "replan" } }), undefined);
});
