import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowToolBinding } from "../extensions/workflow-tool-binding.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";

function fixture() {
  const handlers = new Map();
  const state = createExtensionRuntimeState();
  state.activeRole = { role: "developer-test", provider: "test", model: "dev", thinkingLevel: "max" };
  const identity = { workflowId: "wf", planVersion: 0, sessionId: "session", recoveryGeneration: 1, taskId: "task", attemptId: "attempt", handoffId: "handoff" };
  state.workflowState = { ...identity, status: "running", currentTaskId: "task", tasks: [{ id: "task", role: "developer-test", status: "in_progress" }], handoff: { ...identity, phase: "executing" } };
  let branch = [{ id: "root" }];
  const ctx = { sessionManager: { getSessionId: () => "session", getBranch: () => branch } };
  const binding = createWorkflowToolBinding({ on(name, handler) { handlers.set(name, handler); } }, state);
  function issue(id = "call", args = { action: "complete" }) {
    handlers.get("before_provider_request")({}, ctx);
    const message = { role: "assistant", content: [{ type: "toolCall", id, name: "task_workflow", arguments: args }] };
    handlers.get("message_start")({ message }, ctx);
    handlers.get("message_end")({ message }, ctx);
  }
  return { state, ctx, identity, binding, handlers, issue, setBranch: value => { branch = value; } };
}

test("模型只提交完成结果，运行时绑定真实派发身份且不改写参数", () => {
  const f = fixture(); f.issue();
  const params = { action: "complete", completionSummary: "done" };
  const result = f.binding.bind("call", params, f.ctx);
  assert.deepEqual(result, { ...f.identity, ...params });
  assert.deepEqual(params, { action: "complete", completionSummary: "done" });
  assert.throws(() => f.binding.bind("call", params, f.ctx), error => error.code === "WORKFLOW_RUN_BINDING_MISSING");
});

for (const change of ["recovery", "attempt", "role", "context", "branch", "task"]) {
  test("旧模型回合不能套用最新身份：" + change, () => {
    const f = fixture(); f.issue();
    if (change === "recovery") f.state.workflowState.recoveryGeneration++;
    if (change === "attempt") f.state.workflowState.handoff.attemptId = "new-attempt";
    if (change === "role") f.state.roleTransitionGeneration++;
    if (change === "context") f.state.roleContextGeneration++;
    if (change === "branch") f.setBranch([{ id: "other" }]);
    if (change === "task") f.state.workflowState.currentTaskId = "other-task";
    assert.throws(() => f.binding.bind("call", { action: "complete" }, f.ctx), error => error.code === "WORKFLOW_RUN_BINDING_STALE");
  });
}

test("捕获请求时的身份而非消息结束时的最新状态", () => {
  const f = fixture();
  f.handlers.get("before_provider_request")({}, f.ctx);
  const message = { role: "assistant", content: [{ type: "toolCall", id: "late", name: "task_workflow", arguments: { action: "complete" } }] };
  f.handlers.get("message_start")({ message }, f.ctx);
  f.state.workflowState.recoveryGeneration++;
  f.handlers.get("before_provider_request")({}, f.ctx);
  f.handlers.get("message_end")({ message }, f.ctx);
  assert.throws(() => f.binding.bind("late", { action: "complete" }, f.ctx), error => error.code === "WORKFLOW_RUN_BINDING_STALE");
});

test("兼容显式身份，但不会覆盖用户提供的过期字段", () => {
  const f = fixture();
  const legacy = { action: "complete", ...f.identity, recoveryGeneration: 0 };
  assert.deepEqual(f.binding.bind("legacy", legacy, f.ctx), legacy);
  f.issue();
  assert.equal(f.binding.bind("call", { action: "complete", recoveryGeneration: 0 }, f.ctx).recoveryGeneration, 0);
});

test("状态无需绑定；缺少真实回合的隐式结果被拒绝", () => {
  const f = fixture();
  assert.deepEqual(f.binding.bind("status", { action: "status" }, f.ctx), { action: "status" });
  assert.throws(() => f.binding.bind("unknown", { action: "complete" }, f.ctx), error => error.code === "WORKFLOW_RUN_BINDING_MISSING");
});

test("嵌套调用只继承已知父工具的派发身份", () => {
  const f = fixture();
  f.handlers.get("before_provider_request")({}, f.ctx);
  const message = { role: "assistant", content: [{ type: "toolCall", id: "parent", name: "script", arguments: {} }] };
  f.handlers.get("message_start")({ message }, f.ctx);
  f.handlers.get("message_end")({ message }, f.ctx);
  f.handlers.get("tool_call")({ toolName: "task_workflow", toolCallId: "parent/1", parentToolCallId: "parent" }, f.ctx);
  assert.equal(f.binding.bind("parent/1", { action: "complete" }, f.ctx).attemptId, "attempt");
  assert.throws(() => f.binding.bind("unknown/1", { action: "complete" }, f.ctx), error => error.code === "WORKFLOW_RUN_BINDING_MISSING");
});
