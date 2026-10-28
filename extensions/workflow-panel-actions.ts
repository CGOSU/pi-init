import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionRuntimeState, WorkflowState } from "./runtime-state.ts";
import { transferFrozen, handoffBoundary, SESSION_HANDOFF_IMPORTED, SESSION_HANDOFF_REVIEW } from "../src/session-handoff.ts";

export type WorkflowPanelChoice = {
  value: string;
  label: string;
  description: string;
  action: "resume" | "retry" | "cancel" | "cancel-all" | "fresh";
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
  const imported = workflow.pauseReason === SESSION_HANDOFF_IMPORTED;
  const choices: WorkflowPanelChoice[] = [];
  if (workflow.status === "paused" && workflow.tasks.some(task => task.status === "blocked")) {
    for (const task of workflow.tasks.filter(task => task.status === "blocked")) choices.push({ value: "retry:" + task.id, action: "retry", taskId: task.id, confirmUnknownOutcome: task.outcomeUnknown === true, label: "重试：" + task.task, description: task.outcomeUnknown ? "结果未知；先核对副作用并显式确认新尝试" : "解决阻塞原因后重新排队" });
  } else {
    choices.push({ value: "resume", action: "resume", label: workflow.pauseReason === SESSION_HANDOFF_REVIEW ? "留在当前会话继续" : "继续工作流", description: "执行 workflow resume；沿当前计划恢复，不重放未知副作用", disabledReason: workflow.status === "paused" && !["architecture-review", SESSION_HANDOFF_REVIEW, "boundary-compaction-failed", "boundary-compaction-interrupted"].includes(workflow.pauseReason ?? "") ? "该暂停状态不能直接继续，请查看恢复详情" : workflow.status === "replanning" ? "正在等待AI规划，无需反复继续" : workflow.handoff?.phase === "executing" ? "当前任务已启动，避免重复派发" : ["dispatching", "queued", "uncertain"].includes(workflow.handoff?.phase ?? "") ? "交接结果尚未确认，不能重发" : undefined });
  }
  choices.push({ value: "cancel", action: "cancel", label: "取消当前工作流", description: "停止后续编排，不回滚已发生的修改" });
  choices.push({ value: "fresh", action: "fresh", label: imported ? "核对并继续已导入交接" : "新建会话继续",
    description: imported ? "执行 workflow fresh，仅重核当前目标导入，不再新建会话" : "执行 workflow fresh；确认后冻结旧队列，在新会话继续剩余任务",
    disabledReason: imported ? undefined : !handoffBoundary(workflow) ? "请等待当前交付物完成并到达安全任务边界"
      : state.userStopRequested ? "自动执行已暂停；先按原恢复流程核对"
      : state.sessionModeOverride !== undefined || Object.keys(state.sessionRoleConfigOverrides).length ? "会话配置尚未持久化，不能直接交接" : undefined });
  const unavailable = state.runtimeDisposed ? "当前运行时已退出，请重新打开面板" : state.workflowRestoreError || state.pendingWorkflowRecovery || state.roleRecoveryPersistenceFailed ? "恢复尚未确认；先检查技术详情与恢复提示" : undefined;
  const inflight = state.roleCompactionInFlight || state.pendingRoleCompaction || state.workflowDispatchInFlight || state.internalContinuationPending || workflow.continuation?.kind !== "review" && workflow.continuation?.phase === "compacting";
  return choices.map(choice => ({ ...choice, disabledReason: unavailable
    ?? (transferFrozen(workflow) && !(imported && choice.action === "fresh") ? "会话交接期间队列只读，请查看目标会话" : undefined)
    ?? (state.roleRecoveryPending && !(imported && choice.action === "fresh") ? "职责恢复尚未确认" : undefined)
    ?? choice.disabledReason ?? (["resume", "retry", "fresh"].includes(choice.action) && inflight ? "交接或压缩正在进行，请等待" : undefined) }));
}

export async function runWorkflowPanelRequest(
  request: WorkflowPanelRequest,
  ctx: ExtensionCommandContext,
  state: ExtensionRuntimeState,
  run: (action: string, taskId: string | undefined, confirmUnknownOutcome: boolean) => Promise<WorkflowCommandResult>,
): Promise<WorkflowCommandResult> {
  const current = () => !state.runtimeDisposed && state.workflowState === request.workflow && state.roleContextGeneration === request.contextGeneration
    && ctx.sessionManager.getSessionId() === request.sessionId;
  const validate = () => {
    if (!current()) { if (!state.runtimeDisposed) ctx.ui.notify("工作流已变化，未执行旧面板操作；请重新打开进度面板。", "warning"); return false; }
    if (!ctx.isProjectTrusted()) { ctx.ui.notify("项目尚未受信任，未执行工作流操作。", "warning"); return false; }
    const choice = workflowPanelChoices(state).find(item => item.value === request.choice.value);
    if (!choice || choice.disabledReason) { ctx.ui.notify(choice?.disabledReason ?? "当前状态已不支持该操作。", "warning"); return false; }
    if (["resume", "retry", "fresh"].includes(choice.action) && !ctx.isIdle()) { ctx.ui.notify("Agent 仍在运行；空闲后再继续或重试。", "warning"); return false; }
    if (choice.action === "fresh" && request.workflow.pauseReason !== SESSION_HANDOFF_IMPORTED && typeof ctx.newSession !== "function") { ctx.ui.notify("宿主尚未提供安全的新session接口，未执行交接。", "warning"); return false; }
    return true;
  };
  if (!validate()) return;
  const choice = request.choice;
  if (choice.action === "fresh" || choice.action === "cancel" || choice.action === "cancel-all" || choice.confirmUnknownOutcome || request.workflow.pauseReason === "architecture-review") {
    const confirm = choice.action === "fresh" ? "确认" + choice.label : choice.confirmUnknownOutcome ? "已核对副作用，授权创建新尝试" : choice.action === "resume" ? "已完成审阅，继续原计划" : "确认" + choice.label;
    const warning = choice.action === "fresh" ? request.workflow.pauseReason === SESSION_HANDOFF_IMPORTED ? "只核对当前目标会话导入，不创建另一份session或重放任务。" : "旧队列将冻结；新session只继续剩余任务，历史验证不是本次新执行。" : choice.confirmUnknownOutcome ? "旧执行可能已产生副作用。请先核对实际结果；确认后才创建新尝试。" : choice.action === "resume" ? "仅在已完成架构审阅后继续。" : "只停止后续编排，不回滚修改，也不保证正在运行的工具或进程停止。";
    const selected = await ctx.ui.select(choice.label + " · " + request.workflow.plan.summary + "\n" + warning, ["返回，不执行", confirm]);
    if (selected !== confirm || !validate()) return;
  }
  return await run(choice.action, choice.taskId, choice.confirmUnknownOutcome === true);
}
export type WorkflowCommandResult = void | "close-panel";
