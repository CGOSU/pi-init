import { getNextWorkflowTask, isWorkflowActive, workflowActionIdentity } from "../src/workflow.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { nextWorkflowAction } from "./workflow-action-policy.ts";

export function buildHandoffSnapshot(state: ExtensionRuntimeState, role: string) {
  const workflow = state.workflowState;
  const active = workflow && isWorkflowActive(workflow) ? workflow : undefined;
  const task = active?.tasks.find(item => item.id === active.currentTaskId) ?? (active ? getNextWorkflowTask(active) : undefined);
  return { role, workflow: active ? { ...workflowActionIdentity(active), status: active.status, taskId: task?.id, taskStatus: task?.status,
    verificationRefs: active.tasks.filter(item => item.verification?.length).slice(-4).map(item => item.id) } : undefined,
    nextAction: nextWorkflowAction(state).nextAction };
}

export function handoffSnapshotPrompt(state: ExtensionRuntimeState, role: string) {
  return [
    "系统生成的轻量交接快照（引用按需读取，不代表任务完成或证据已接受）：",
    JSON.stringify(buildHandoffSnapshot(state, role)),
    "承接上一回合已说明的本角色交付物；目标与当前职责匹配时直接推进，不为重新确认已明确的分工往返切角。职责确实不匹配或遇到必要决策边界时仍按职责路由；上述下一步及安全、恢复守卫优先。",
    "复用当前上下文中可见且来源版本、适用范围仍有效的规则与结果；切角本身不要求整批预读。只对缺失、截断、版本变化或关键事实缺口定向补读，历史验证不自动代表当前通过。",
  ].join("\n");
}
