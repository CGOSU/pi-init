import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getWorkflowTask, isWorkflowActive } from "../src/workflow.js";
import { roleLabel } from "../src/roles.js";
import type { ActiveRole, ExtensionRuntimeState } from "./runtime-state.ts";

const SECTION_KEY = "pi_init_runtime";

type RuntimeRoutingDependencies = {
  getActiveRole: (ctx: ExtensionContext) => ActiveRole | undefined;
  getThinkingLevel: () => string;
};

function workflowSummary(state: ExtensionRuntimeState) {
  const workflow = state.workflowState;
  if (!workflow || !isWorkflowActive(workflow)) return "无活动工作流";
  const task = workflow.currentTaskId ? getWorkflowTask(workflow, workflow.currentTaskId) : undefined;
  const taskSummary = task ? `${task.id}（${task.role}/${task.status}）` : "等待任务";
  return `活动工作流：${workflow.executor}/${workflow.status}，当前任务：${taskSummary}`;
}

function recoveryGuidance(state: ExtensionRuntimeState) {
  if (!state.roleRecoveryPending) {
    return "职责恢复：已确认。简单无工具问答直接回答；不要调用 task_workflow(status)，当前职责匹配时不要重复 switch_role。自动交接已确认时只继续未完成工作，不为压缩重复换角。";
  }
  const roleAction = state.roleModeStatus === "manual"
    ? "当前为 manual 模式；若当前角色可验证，使用 switch_role，否则请用户执行 /pi-init role <role>，不要反复调用 switch_role。"
    : "先按目标调用 switch_role 并等待成功。";
  if (state.workflowState && isWorkflowActive(state.workflowState)) {
    return `职责恢复：pending。先调用 task_workflow(action="status")，重新确认当前任务角色；${roleAction}恢复前不要执行其他工具。`;
  }
  return `职责恢复：pending。无活动工作流且无需工具或新证据的简单问答可以直接回答；不要调用 task_workflow(status)，回答不会解除恢复门。需要执行时${roleAction}`;
}

function buildRuntimeSection(
  state: ExtensionRuntimeState,
  ctx: ExtensionContext,
  deps: RuntimeRoutingDependencies,
) {
  const activeRole = deps.getActiveRole(ctx);
  const role = activeRole ? roleLabel(activeRole.role) : "未确认";
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "未选择";
  const thinkingLevel = deps.getThinkingLevel();
  return [
    "当前运行状态（仅用于本轮职责路由，不改变持久状态）：",
    `当前职责：${role}`,
    `当前模型：${model}，推理强度：${thinkingLevel}`,
    workflowSummary(state),
    recoveryGuidance(state),
  ].join("\n");
}

export function createRuntimeRoutingContext(
  state: ExtensionRuntimeState,
  deps: RuntimeRoutingDependencies,
) {
  function beforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext) {
    if (!event.systemPromptOptions?.sections) return;
    event.systemPromptOptions.sections[SECTION_KEY] = buildRuntimeSection(state, ctx, deps);
  }

  return { beforeAgentStart };
}
