import type { ExtensionRuntimeState } from "./runtime-state.ts";
import type { TaskMemoryView } from "./task-memory-runtime.ts";
import { createCurrentWorkflowStatusView } from "./workflow-status-view.ts";
import { formatWorkflowStatusText, workflowIdentityLines, workflowStatusActivityLabel } from "./workflow-status-renderer.ts";
import { nextWorkflowAction } from "./workflow-action-policy.ts";

function excerpt(text: string | undefined, limit = 400) {
  if (text === undefined) return "未记录";
  return text.length <= limit ? text : text.slice(0, limit) + "…（摘要省略，完整内容见 detail=full）";
}

/** Model-facing observation: full histories stay in the explicit detail response and UI. */
export function workflowStatusToolSummary(state: ExtensionRuntimeState, memory?: TaskMemoryView) {
  const view = createCurrentWorkflowStatusView(state);
  const fullHint = '完整规划、任务历史与身份：task_workflow(action="status", detail="full")；真实来源可用 evidenceIds 定向读取。';
  if (view.kind !== "workflow") return formatWorkflowStatusText(view);
  const workflow = state.workflowState!;
  const step = nextWorkflowAction(state);
  const current = workflow.tasks.find(task => task.id === workflow.currentTaskId);
  const blocked = workflow.tasks.filter(task => task.status === "blocked");
  const unknown = workflow.tasks.filter(task => task.outcomeUnknown);
  const lines = [
    `状态：${workflow.status} · 阶段：${workflowStatusActivityLabel(view.activity)} · 已完成 ${view.progress.completed}/${view.progress.total}`,
    `目标：${excerpt(workflow.plan.summary)}`,
    ...workflowIdentityLines(view),
    ...(current ? [`当前任务：${current.id} · ${current.role} · ${excerpt(current.task)}`] : []),
    ...(view.recovery ? [`执行阻断：${view.recovery.code} · ${excerpt(view.recovery.message)}`] : []),
    ...(workflow.pauseReason ? [`暂停类别：${workflow.pauseReason}`] : []),
    ...(workflow.taskPauseReason ? [`暂停原因：${excerpt(workflow.taskPauseReason)}`] : []),
    ...blocked.slice(0, 3).map(task => `阻塞任务：${task.id} · ${excerpt(task.blockReason ?? "原因未记录", 240)}`),
    ...(blocked.length > 3 ? [`另有 ${blocked.length - 3} 个阻塞任务，完整原因见 detail=full。`] : []),
    ...(unknown.length ? [`结果未知：${unknown.length} 项（${unknown.slice(0, 4).map(task => task.id).join("、")}${unknown.length > 4 ? "等" : ""}）；必须核对副作用，不得自动重放。`] : []),
    ...(workflow.pendingRevision ? [`待重规划：${workflow.pendingRevision.revisionId} · ${excerpt(workflow.pendingRevision.direction)}`] : []),
    `下一步：${step.nextAction}`,
  ];
  if (memory?.status === "unavailable") lines.push("任务记忆不可用：" + excerpt(memory.reason ?? "来源不可确认") + "；不得据此重跑副作用。");
  else if (memory?.memory) {
    lines.push(`任务记忆：${memory.memory.identity.taskId} · expectedMemoryRevision=${memory.memory.revision} · 历史观察不是当前验证或执行授权。`);
    if (memory.memory.checkpoint) {
      lines.push("检查点：" + excerpt(memory.memory.checkpoint.step), "记忆中的下一步：" + excerpt(memory.memory.checkpoint.nextStep));
    }
  }
  lines.push(fullHint);
  return lines.join("\n");
}
