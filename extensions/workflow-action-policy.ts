import type { ExtensionRuntimeState } from "./runtime-state.ts";

type PolicyState = Pick<ExtensionRuntimeState, "workflowState" | "pendingWorkflowRecovery" | "roleRecoveryPending" | "roleRecoveryPersistenceFailed" | "workflowRestoreError" | "roleModeStatus" | "userStopRequested">;
export type WorkflowNextAction = {
  action: "none" | "recover" | "finish-current-task" | "schedule-replan";
  recovery?: "role" | "workflow" | "wait" | "stop";
  nextAction: string;
  requiredRole?: string;
  taskId?: string;
};

/** Routing advice only: never grants identity, execution or side-effect authority. */
export function nextWorkflowAction(state: PolicyState): WorkflowNextAction {
  const workflow = state.workflowState;
  const task = workflow?.tasks.find((item) => item.id === workflow.currentTaskId);
  const taskScope = workflow?.currentTaskId ? { taskId: workflow.currentTaskId, requiredRole: task?.role } : {};
  if (state.userStopRequested) return { action: "recover", recovery: "stop", nextAction: "不要继续原任务、切角、重试写入或重复状态轮询。停止不等于任务完成、取消或未知副作用确认；只有用户明确继续/恢复后才重新检查原有授权。" };
  const activeWorkflow = workflow && !["completed", "cancelled"].includes(workflow.status);
  const roleAction = state.roleModeStatus === "manual"
    ? "当前为 manual 模式；若当前角色可验证，使用 switch_role，否则请用户执行 /pi-init role <role>，不要反复调用 switch_role。"
    : "先按目标调用 switch_role 并等待成功。";
  if (state.roleRecoveryPending && !activeWorkflow && !state.pendingWorkflowRecovery
    && !state.roleRecoveryPersistenceFailed && !state.workflowRestoreError) {
    return { action: "recover", recovery: "role", nextAction: `无活动工作流且无需工具或新证据的简单问答可以直接回答；不要调用 task_workflow(status)，回答不会解除恢复门。需要执行时${roleAction}` };
  }
  if (!state.roleRecoveryPending && !state.pendingWorkflowRecovery && !state.roleRecoveryPersistenceFailed && !state.workflowRestoreError && workflow?.status === "paused"
    && ["session-handoff-review", "session-transfer-pending", "session-handoff-imported"].includes(workflow.pauseReason ?? "")) {
    return { action: "recover", recovery: "wait", nextAction: workflow.taskPauseReason ?? "等待用户确认会话交接；不自行新建session、重试任务或重规划。" };
  }
  if (state.roleRecoveryPending || state.pendingWorkflowRecovery || state.roleRecoveryPersistenceFailed || state.workflowRestoreError
    || (workflow && !["completed", "cancelled"].includes(workflow.status)
      && (workflow.status === "paused" || task?.outcomeUnknown || (workflow.currentTaskId && !task)))) {
    return { action: "recover", recovery: "workflow", ...taskScope, nextAction: '先读取 task_workflow(action="status") 并按现有恢复守卫核对当前身份和未知结果；不得自动重放副作用或沿用旧 attempt/handoff。' + (state.roleRecoveryPending ? `重新确认当前任务角色；${roleAction}恢复前不要执行其他工具。` : "") };
  }
  if (!workflow || ["completed", "cancelled"].includes(workflow.status)) return { action: "none", nextAction: "按当前用户目标和明确指定的任务角色继续尚未完成的工作；没有待办就结束，不创造新任务。同一交付物内保持职责，独立交付物或必要架构决策才换角。无活动工作流任务角色绑定，不豁免其他职责与安全守卫。" };
  if (workflow.currentTaskId) {
    const boundary = workflow.pendingRevision
      ? "方向已登记；当前任务真实完成后提交 complete，确有阻塞时提交 block 记录已知成果。安全边界后由现有调度器安排 architect 重规划。"
      : "继续当前任务，真实完成且验证通过后提交 complete；只有确有阻塞才提交 block。若确需改变计划，当前真实执行角色可先用 request-replan 登记方向，再真实 complete 或 block 到达安全边界，由现有调度器交给 architect；不得用 request-replan 代替任务结果。";
    return { action: "finish-current-task", ...taskScope, nextAction: `保持或恢复当前任务显式执行角色 ${task?.role}，其优先于模型自行换角判断；使用当前真实 handoff 身份。${boundary}不要在当前任务尚未退出时切到 architect 提前重规划，不得自动标记完成或重放副作用。` };
  }
  if (workflow.pendingRevision) return { action: "schedule-replan", requiredRole: "architect", nextAction: "当前任务已退出；由现有工作流调度器安排 architect 使用当前 revision/handoff 身份规划，保留未知结果确认与证据守卫。" };
  return { action: "none", nextAction: "按现有工作流调度继续，不重复派发任务。" };
}

/** Call before switch_role configuration/model/persistence side effects. */
export function checkWorkflowRoleSwitch(state: PolicyState, targetRole: string) {
  const workflow = state.workflowState;
  const task = workflow?.tasks.find((item) => item.id === workflow.currentTaskId);
  if (!workflow || ["completed", "cancelled"].includes(workflow.status) || !workflow.currentTaskId
    || workflow.handoff?.phase !== "executing" || targetRole === task?.role) {
    return { allowed: true as const };
  }
  const step = nextWorkflowAction(state);
  return { allowed: false as const, code: "WORKFLOW_TASK_BOUNDARY_REQUIRED", message: "当前任务尚未退出，不能交接到非执行角色。", ...step };
}
