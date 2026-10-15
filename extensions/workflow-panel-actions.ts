import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionRuntimeState, WorkflowState } from "./runtime-state.ts";

export type WorkflowPanelChoice = {
  value: string;
  label: string;
  description: string;
  action: "resume" | "retry" | "cancel" | "cancel-all";
  taskId?: string;
  confirmUnknownOutcome?: boolean;
  disabledReason?: string;
};
export type WorkflowPanelRequest = {
  choice: WorkflowPanelChoice;
  workflow: WorkflowState;
  contextGeneration: number;
  sessionId: string;
};

export function workflowPanelChoices(state: ExtensionRuntimeState): WorkflowPanelChoice[] {
  const workflow = state.workflowState;
  if (!workflow || ["completed", "cancelled"].includes(workflow.status)) return [];
  const choices: WorkflowPanelChoice[] = [];
  if (workflow.status === "paused" && workflow.tasks.some((task) => task.status === "blocked") && workflow.pauseReason !== "child-result-review") {
    for (const task of workflow.tasks.filter((task) => task.status === "blocked")) choices.push({ value: "retry:" + task.id, action: "retry", taskId: task.id, confirmUnknownOutcome: task.outcomeUnknown === true, label: "重试：" + task.task, description: task.outcomeUnknown ? "结果未知；必须先核对副作用并显式确认新尝试" : "解决阻塞原因后重新排队" });
  } else {
    const waiting = workflow.status === "replanning";
    const executing = workflow.handoff?.phase === "executing";
    const queued = ["dispatching", "queued", "uncertain"].includes(workflow.handoff?.phase ?? "");
    choices.push({ value: "resume", action: "resume", label: workflow.pauseReason === "child-result-review" ? "重新提交 AI 审阅" : "继续工作流", description: "沿当前计划安全恢复；不会自动验收子流程结果", disabledReason: workflow.status === "paused" && !["architecture-review", "boundary-compaction-failed", "boundary-compaction-interrupted", "child-result-review"].includes(workflow.pauseReason ?? "") ? "该暂停状态不能直接继续，请查看恢复详情" : waiting ? "正在等待 AI 规划/审阅；无需用户反复继续" : executing ? "当前任务已启动，避免重复派发" : queued ? "交接结果尚未确认，不能重发" : undefined });
  }
  const child = Boolean(workflow.parentStack?.length);
  choices.push({ value: "cancel", action: "cancel", label: child ? "取消当前子流程" : "取消当前工作流", description: child ? "保留父进度并返回结果处置；不回滚副作用" : "停止后续编排；不回滚已发生的修改" });
  if (child) choices.push({ value: "cancel-all", action: "cancel-all", label: "取消整个父子流程", description: "终止父层与子层的后续编排；不回滚副作用" });
  const unavailable = state.runtimeDisposed ? "当前运行时已退出，请重新打开面板" : state.workflowRestoreError || state.pendingWorkflowRecovery || state.coordinationRestoreError || state.roleRecoveryPending || state.roleRecoveryPersistenceFailed ? "恢复尚未确认；先检查技术详情与恢复提示" : undefined;
  return choices.map((choice) => ({ ...choice, disabledReason: unavailable ?? choice.disabledReason ?? ((choice.action === "resume" || choice.action === "retry") && (state.roleCompactionInFlight || state.pendingRoleCompaction || state.workflowDispatchInFlight || state.internalContinuationPending || (workflow.continuation?.kind !== "review" && workflow.continuation?.phase === "compacting")) ? "交接或压缩正在进行，请等待" : undefined) }));
}

export async function runWorkflowPanelRequest(
  request: WorkflowPanelRequest,
  ctx: ExtensionCommandContext,
  state: ExtensionRuntimeState,
  run: (action: string, taskId: string | undefined, confirmUnknownOutcome: boolean) => Promise<void>,
): Promise<void> {
  const current = () => state.workflowState === request.workflow && state.roleContextGeneration === request.contextGeneration
    && ctx.sessionManager.getSessionId() === request.sessionId && !state.runtimeDisposed;
  const validate = () => {
    if (!current()) { ctx.ui.notify("工作流已变化，未执行旧面板操作；请重新打开进度面板。", "warning"); return false; }
    if (!ctx.isProjectTrusted()) { ctx.ui.notify("项目尚未受信任，未执行工作流操作。", "warning"); return false; }
    const choice = workflowPanelChoices(state).find((item) => item.value === request.choice.value);
    if (!choice || choice.disabledReason) { ctx.ui.notify(choice?.disabledReason ?? "当前状态已不支持该操作。", "warning"); return false; }
    if ((choice.action === "resume" || choice.action === "retry") && !ctx.isIdle()) { ctx.ui.notify("Agent 仍在运行；空闲后再继续或重试。", "warning"); return false; }
    return true;
  };
  if (!validate()) return;
  const choice = request.choice;
  if (choice.action === "cancel" || choice.action === "cancel-all" || choice.confirmUnknownOutcome || request.workflow.pauseReason === "architecture-review") {
    const confirm = choice.confirmUnknownOutcome ? "已核对副作用，授权创建新尝试" : choice.action === "resume" ? "已完成审阅，继续原计划" : "确认" + choice.label;
    const warning = choice.confirmUnknownOutcome ? "旧执行可能已产生副作用。请先核对实际结果；确认后才创建新尝试。" : choice.action === "resume" ? "仅在已完成架构审阅后继续。" : "只停止后续编排，不回滚修改，也不保证正在运行的工具或进程停止。";
    const scope = choice.action === "cancel-all" ? [...(request.workflow.parentStack ?? []).map((frame) => frame.state.plan.summary), request.workflow.plan.summary].join(" → ") : request.workflow.plan.summary;
    const selected = await ctx.ui.select(choice.label + " · " + scope + "\n" + warning, ["返回，不执行", confirm]);
    if (selected !== confirm || !validate()) return;
  }
  await run(choice.action, choice.taskId, choice.confirmUnknownOutcome === true);
}
