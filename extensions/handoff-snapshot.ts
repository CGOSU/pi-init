import { getNextWorkflowTask, isWorkflowActive, workflowActionIdentity } from "../src/workflow.ts";
import { coordinationHandoffIdentity } from "./coordination-runtime-protocol.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";

export function buildHandoffSnapshot(state: ExtensionRuntimeState, role: string) {
  const workflow = state.workflowState;
  const activeWorkflow = workflow && isWorkflowActive(workflow) ? workflow : undefined;
  const task = activeWorkflow?.tasks.find((item) => item.id === activeWorkflow.currentTaskId)
    ?? (activeWorkflow ? getNextWorkflowTask(activeWorkflow) : undefined);
  const coordination = state.coordinationRuntimeState;
  const handoff = coordination ? coordinationHandoffIdentity(coordination) : undefined;
  return {
    role,
    workflow: activeWorkflow ? {
      ...workflowActionIdentity(activeWorkflow),
      status: activeWorkflow.status,
      taskId: task?.id,
      taskStatus: task?.status,
      contractRef: task?.contract ? task.id : undefined,
      verificationRefs: activeWorkflow.tasks.filter((item) => item.verification?.length).slice(-4).map((item) => item.id),
    } : undefined,
    coordination: handoff ? {
      ...handoff,
      status: coordination!.handoff!.phase,
      reviewRefs: coordination!.coordination.reviews.slice(-4).map((review) => review.reviewId),
    } : undefined,
    nextAction: activeWorkflow
      ? '按当前任务继续；缺少任务详情时调用 task_workflow(action="status") 按引用读取，不重做已完成工作。'
      : handoff
        ? "按当前 request/report 身份继续取证或复审；缺少详情时读取协调状态。"
        : "继续用户目标中尚未完成的工作；没有待办就结束，不创造新任务。",
  };
}

export function handoffSnapshotPrompt(state: ExtensionRuntimeState, role: string) {
  return [
    "系统生成的轻量交接快照（引用按需读取，不代表任务完成或证据已接受）：",
    JSON.stringify(buildHandoffSnapshot(state, role)),
    "补充说明可省略；引用失效或证据不足时，先读取当前状态并补查、补证或验证，不猜测旧身份，不因说明缺失请求人类。只有权限、凭据、破坏性操作或必须由用户决定的产品取舍才请求人类；持久化和身份安全检查仍须遵守。",
  ].join("\n");
}
