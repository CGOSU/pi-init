import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeRoutingContext } from "../extensions/runtime-routing-context.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createWorkflowState } from "../src/workflow.ts";
import { createExtensionHarness } from "./helpers.js";

function routingSection(state) {
  const harness = createExtensionHarness([], { sessionId: "routing-session" });
  const event = { systemPromptOptions: { sections: {} } };
  createRuntimeRoutingContext(state, { getActiveRole: () => state.activeRole, getThinkingLevel: () => "max" }).beforeAgentStart(event, harness.context);
  return event.systemPromptOptions.sections.pi_init_runtime;
}

test("routing keeps ordinary sessions unchanged and recognizes every unfinished workflow state", () => {
  const state = createExtensionRuntimeState();
  assert.match(routingSection(state), /无活动工作流/);
  state.roleRecoveryPending = true;
  assert.match(routingSection(state), /不要调用 task_workflow\(status\)/);
  state.workflowState = createWorkflowState({ summary: "Current user goal", sessionId: "routing-session", tasks: [{ id: "task", task: "Current task", files: ["src/input.ts"], acceptanceCriteria: ["Done"] }] }, 1);
  for (const status of ["running", "paused", "replanning"]) {
    state.workflowState.status = status;
    state.workflowState.pauseReason = status === "paused" ? "task-blocked" : undefined;
    const section = routingSection(state);
    assert.match(section, new RegExp(`/${status}`));
    assert.doesNotMatch(section, /无活动工作流/);
    assert.match(section, /task_workflow\(action="status"\)/);
    if (status === "paused") {
      assert.match(section, /task-blocked/);
      assert.match(section, /不是.*执行授权/);
    }
  }
  for (const status of ["completed", "cancelled"]) {
    state.workflowState.status = status;
    assert.match(routingSection(state), /无活动工作流/);
  }
});

test("paused routing never grants execution just because role recovery was confirmed", () => {
  const state = createExtensionRuntimeState();
  state.workflowState = createWorkflowState({ summary: "Review", sessionId: "routing-session", reviewRequired: true, tasks: [{ id: "task", task: "Review task", files: ["src/input.ts"], acceptanceCriteria: ["Done"] }] }, 1);
  const section = routingSection(state);
  assert.match(section, /paused/);
  assert.match(section, /architecture-review/);
  assert.match(section, /不是.*执行授权/);
  assert.match(section, /task_workflow\(action="status"\)/);
});

test("package policy follows the active role without replacing project instructions or retaining old roles", () => {
  const state = createExtensionRuntimeState();
  const h = createExtensionHarness([], { sessionId: "routing-session" });
  const event = { systemPromptOptions: { sections: { project_owned: "Project-specific rules remain unchanged" } } };
  const runtime = createRuntimeRoutingContext(state, { getActiveRole: () => state.activeRole, getThinkingLevel: () => "high" });
  state.activeRole = { role: "developer-test", provider: "test", model: "test", thinkingLevel: "high" };
  runtime.beforeAgentStart(event, h.context);
  const sections = event.systemPromptOptions.sections;
  assert.match(sections.pi_init_policy, /规则所有权/);
  assert.match(sections.pi_init_role_policy, /开发测试工程师/);
  const common = sections.pi_init_policy;
  state.activeRole.role = "docs-commit";
  runtime.beforeAgentStart(event, h.context);
  assert.match(sections.pi_init_role_policy, /文档与提交工程师/);
  assert.doesNotMatch(sections.pi_init_role_policy, /# 开发测试工程师/);
  assert.equal(sections.pi_init_policy, common);
  assert.equal(sections.project_owned, "Project-specific rules remain unchanged");
  assert.equal(Object.keys(sections).at(-1), "pi_init_runtime");
  state.activeRole = undefined;
  runtime.beforeAgentStart(event, h.context);
  assert.equal(sections.pi_init_role_policy, undefined);
  assert.equal(sections.project_owned, "Project-specific rules remain unchanged");
});
test("unknown or invalid custom role never inherits a standard role policy", () => {
  const state = createExtensionRuntimeState();
  const h = createExtensionHarness([], { sessionId: "routing-session" });
  const runtime = createRuntimeRoutingContext(state, { getActiveRole: () => state.activeRole, getThinkingLevel: () => "high" });
  const event = { systemPromptOptions: { sections: {} } };
  for (const role of ["developer-test", "custom-project-role", "../../credentials"]) {
    state.activeRole = { role, provider: "test", model: "test", thinkingLevel: "high" };
    runtime.beforeAgentStart(event, h.context);
    if (role !== "developer-test") assert.equal(event.systemPromptOptions.sections.pi_init_role_policy, undefined);
  }
});
