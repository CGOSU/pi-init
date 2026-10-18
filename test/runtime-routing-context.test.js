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
