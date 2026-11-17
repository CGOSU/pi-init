import assert from "node:assert/strict";
import test from "node:test";
import { createRoleRecovery } from "../extensions/role/role-recovery.ts";
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
    assert.equal(recovery.guardToolCall({ toolName, input: {} })?.code, "WORKFLOW_EXECUTION_NOT_AUTHORIZED", toolName);
  for (const toolName of ["read", "grep", "find", "ls", "switch_role"])
    assert.equal(recovery.guardToolCall({ toolName, input: {} }), undefined, toolName);
  assert.equal(recovery.guardToolCall({ toolName: "task_workflow", input: { action: "status" } }), undefined);
});

test("architect 本地只读权限不解除未知结果暂停或授予重试执行权", () => {
  const { state, recovery } = fixture();
  state.activeRole.role = "architect";
  state.roleRecoveryPending = true;
  recovery.acknowledge("architect");
  assert.equal(state.roleRecoveryPending, false);
  for (const toolName of ["read", "grep", "find", "ls"]) {
    assert.equal(recovery.guardToolCall({ toolName, input: {} }), undefined, toolName);
  }
  for (const toolName of ["ffgrep", "fffind", "graph_locate", "graph_inspect", "obs_recall", "edit", "write", "bash", "codemode"]) {
    assert.equal(recovery.guardToolCall({ toolName, input: {} })?.code, "WORKFLOW_EXECUTION_NOT_AUTHORIZED", toolName);
  }
  assert.equal(state.workflowState.status, "paused");
  assert.equal(state.workflowState.tasks[0].outcomeUnknown, true);
  for (const action of ["complete", "block", "retry", "replan"]) {
    assert.equal(recovery.guardToolCall({ toolName: "task_workflow", input: { action, confirmUnknownOutcome: true } })?.code,
      action === "retry" || action === "replan" ? "WORKFLOW_UNKNOWN_OUTCOME_CONFIRMATION_REQUIRED" : "WORKFLOW_EXECUTION_NOT_AUTHORIZED", action);
  }
  assert.equal(recovery.guardToolCall({ toolName: "task_workflow", input: { action: "status" } }), undefined);
  assert.equal(recovery.guardToolCall({ toolName: "switch_role", input: { role: "developer-test" } }), undefined);
});

test("模型自行填写确认布尔值不能授权结果未知的任务重放", () => {
  const { recovery } = fixture();
  const result = recovery.guardToolCall({ toolName: "task_workflow", input: { action: "retry", taskId: "task", confirmUnknownOutcome: true } });
  assert.equal(result?.code, "WORKFLOW_UNKNOWN_OUTCOME_CONFIRMATION_REQUIRED");
  assert.match(result.message, /confirm-unknown-outcome/);
});

test("恢复失败及待持久化恢复状态阻止执行，正常运行不被暂停门干扰", () => {
  const { state, recovery } = fixture();
  state.workflowState.status = "running";
  assert.equal(recovery.guardToolCall({ toolName: "edit", input: {} }), undefined);
  state.pendingWorkflowRecovery = state.workflowState;
  assert.equal(recovery.guardToolCall({ toolName: "edit", input: {} })?.code, "WORKFLOW_EXECUTION_NOT_AUTHORIZED");
  delete state.pendingWorkflowRecovery;
  state.workflowRestoreError = { code: "WORKFLOW_INVALID", message: "invalid" };
  assert.equal(recovery.guardToolCall({ toolName: "bash", input: {} })?.code, "WORKFLOW_EXECUTION_NOT_AUTHORIZED");
});
test("结构化拒绝保留恢复、未知结果、暂停执行的优先级并适配宿主边界", () => {
  const { state } = fixture();
  const handlers = new Map();
  const diagnostics = [], rejected = [];
  state.traceHandoff = (_ctx, _event, data) => diagnostics.push(data);
  const recovery = createRoleRecovery({ on(name, handler) { handlers.set(name, handler); } }, state,
    (_event, _ctx, code) => rejected.push(code));
  const event = { toolName: "task_workflow", toolCallId: "denied", input: { action: "retry", confirmUnknownOutcome: true } };
  state.roleRecoveryPending = true;
  for (const [code, input] of [
    ["ROLE_RECOVERY_REQUIRED", event.input],
    ["WORKFLOW_UNKNOWN_OUTCOME_CONFIRMATION_REQUIRED", event.input],
    ["WORKFLOW_EXECUTION_NOT_AUTHORIZED", { action: "complete" }],
  ]) {
    event.input = input;
    const denial = recovery.guardToolCall(event);
    assert.equal(denial.code, code);
    assert.deepEqual(handlers.get("tool_call")(event, {}), { block: true, reason: denial.message });
    assert.equal(diagnostics.at(-1).code, code);
    assert.equal(rejected.at(-1), code);
    state.roleRecoveryPending = false;
  }
  assert.equal(state.workflowState.status, "paused");
  assert.equal(state.workflowState.tasks[0].outcomeUnknown, true);
});

test("模型不能借重规划确认布尔值重放未知副作用", () => {
  const { state, recovery } = fixture();
  state.workflowState.status = "replanning";
  assert.equal(recovery.guardToolCall({ toolName: "task_workflow", input: { action: "replan", confirmUnknownOutcome: true } })?.code, "WORKFLOW_UNKNOWN_OUTCOME_CONFIRMATION_REQUIRED");
  assert.equal(recovery.guardToolCall({ toolName: "task_workflow", input: { action: "replan" } }), undefined);
});
