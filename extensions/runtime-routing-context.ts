import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getWorkflowTask } from "../src/workflow.ts";
import { roleLabel } from "../src/roles.ts";
import type { ActiveRole, ExtensionRuntimeState } from "./runtime-state.ts";

import { nextWorkflowAction } from "./workflow-action-policy.ts";

const SECTION_KEY = "pi_init_runtime";

type RuntimeRoutingDependencies = {
  getActiveRole: (ctx: ExtensionContext) => ActiveRole | undefined;
  getThinkingLevel: () => string;
};

function workflowSummary(state: ExtensionRuntimeState) {
  const workflow = state.workflowState;
  if (!workflow || workflow.status === "completed" || workflow.status === "cancelled") return "无活动工作流";
  const task = workflow.currentTaskId ? getWorkflowTask(workflow, workflow.currentTaskId) : undefined;
  const taskSummary = task ? `${task.id}（${task.role}/${task.status}）` : "等待任务";
  const pause = workflow.status === "paused" ? `，暂停原因：${workflow.pauseReason ?? "未记录"}${workflow.taskPauseReason ? `（${workflow.taskPauseReason}）` : ""}。暂停不是当前任务执行授权，不沿用旧 attempt/handoff` : "";
  return `未结束工作流：${workflow.executor}/${workflow.status}，当前任务：${taskSummary}${pause}`;
}

function recoveryGuidance(state: ExtensionRuntimeState) {
  const workflow = state.workflowState;
  if (!state.roleRecoveryPending && workflow?.status === "paused") {
    return '职责恢复：已确认，但工作流暂停不是当前任务执行授权。先调用 task_workflow(action="status") 读取暂停原因与当前引用；通过有效的恢复/重试/重规划转换后才能执行，不沿用旧 attempt/handoff。';
  }
  if (!state.roleRecoveryPending) {
    return "职责恢复：已确认。简单无工具问答直接回答；不要调用 task_workflow(status)，当前职责匹配时不要重复 switch_role。自动交接已确认时只继续未完成工作，不为压缩重复换角。";
  }
  const roleAction = state.roleModeStatus === "manual"
    ? "当前为 manual 模式；若当前角色可验证，使用 switch_role，否则请用户执行 /pi-init role <role>，不要反复调用 switch_role。"
    : "先按目标调用 switch_role 并等待成功。";
  if (workflow && workflow.status !== "completed" && workflow.status !== "cancelled") {
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
  if (state.userStopRequested) return [
    "用户已停止自动执行，本轮只允许回答新的只读问题。",
    `当前职责：${role}；当前模型：${model}，推理强度：${thinkingLevel}`,
    workflowSummary(state),
    "不要继续原任务、切角、重试写入或重复状态轮询。停止不等于任务完成、取消或未知副作用确认；只有用户明确继续/恢复后才重新检查原有授权。",
  ].join("\n");
  return [
    "当前运行状态（仅用于本轮职责路由，不改变持久状态）：",
    `当前职责：${role}`,
    `当前模型：${model}，推理强度：${thinkingLevel}`,
    workflowSummary(state),
    recoveryGuidance(state),
    `工作流下一步：${nextWorkflowAction(state).action}。${nextWorkflowAction(state).nextAction}`,
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
