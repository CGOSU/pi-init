import { getNextWorkflowTask, isWorkflowActive, workflowActionIdentity } from "../src/workflow.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";

export function buildHandoffSnapshot(state: ExtensionRuntimeState, role: string) {
  const workflow = state.workflowState;
  const active = workflow && isWorkflowActive(workflow) ? workflow : undefined;
  const task = active?.tasks.find(item => item.id === active.currentTaskId) ?? (active ? getNextWorkflowTask(active) : undefined);
  return { role, workflow: active ? { ...workflowActionIdentity(active), status: active.status, taskId: task?.id, taskStatus: task?.status,
    verificationRefs: active.tasks.filter(item => item.verification?.length).slice(-4).map(item => item.id) } : undefined,
    nextAction: active ? '按当前任务继续；缺少详情时调用 task_workflow(action="status")，不重做已完成工作。' : "继续用户目标中尚未完成的工作；没有待办就结束，不创造新任务。" };
}

export function handoffSnapshotPrompt(state: ExtensionRuntimeState, role: string) {
  return [
    "系统生成的轻量交接快照（引用按需读取，不代表任务完成或证据已接受）：",
    JSON.stringify(buildHandoffSnapshot(state, role)),
  ].join("\n");
}
