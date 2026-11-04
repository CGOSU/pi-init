import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { getNextWorkflowTask } from "../src/workflow.ts";

type PolicyState = Pick<ExtensionRuntimeState, "workflowState" | "pendingWorkflowRecovery" | "roleRecoveryPending" | "roleRecoveryPersistenceFailed" | "workflowRestoreError" | "userStopRequested"> & Partial<Pick<ExtensionRuntimeState, "roleModeStatus">>;
export type WorkflowNextAction = {
  action: "none" | "recover" | "finish-current-task" | "schedule-replan";
  recovery?: "role" | "workflow" | "wait" | "stop";
  code?: string;
  message?: string;
  nextAction: string;
  requiredRole?: string;
  taskId?: string;
};

/** Routing advice only: never grants identity, execution or side-effect authority. */
export function nextWorkflowAction(state: PolicyState): WorkflowNextAction {
  const workflow = state.workflowState;
  const task = workflow?.tasks.find((item) => item.id === workflow.currentTaskId);
  const nextTask = workflow?.pendingRevision ? undefined : getNextWorkflowTask(workflow);
  const requiredRole = task?.role ?? (!workflow?.currentTaskId && workflow?.pendingRevision ? "architect" : nextTask?.role);
  const taskId = workflow?.currentTaskId ?? nextTask?.id;
  const taskScope = { ...(taskId ? { taskId } : {}), ...(requiredRole ? { requiredRole } : {}) };
  if (state.userStopRequested) return { action: "recover", recovery: "stop", code: "WORKFLOW_USER_STOPPED", message: "自动执行已停止，等待用户明确继续或恢复。", nextAction: "不要继续原任务、切角、重试写入或重复状态轮询。停止不等于任务完成、取消或未知副作用确认；只有用户明确继续/恢复后才重新检查原有授权。" };
  const activeWorkflow = workflow && !["completed", "cancelled"].includes(workflow.status);
  const switchAction = requiredRole ? `switch_role(role="${requiredRole}")` : "switch_role";
  const roleAction = state.roleModeStatus === "manual"
    ? `当前为 manual 模式；若当前角色可验证，使用 ${switchAction}，否则请用户执行 /pi-init role ${requiredRole ?? "<role>"}，不要反复调用 switch_role。`
    : state.roleModeStatus === undefined
      ? "当前职责模式尚未确认；先核对当前模式和职责，不得猜测执行授权。"
      : `调用 ${switchAction} 并等待成功。`;
  const recoveryStatus = '当前工作流状态已提供；不要为恢复重复查询 task_workflow(action="status")。';
  if (state.roleRecoveryPersistenceFailed) return { action: "recover", recovery: "workflow", ...taskScope,
    code: "ROLE_RECOVERY_PERSIST_FAILED", message: "职责恢复记录持久化失败，执行仍被阻断。",
    nextAction: recoveryStatus + "职责恢复记录持久化失败；保持停止，先处理持久化错误，再按既有恢复流程核对职责与身份，不重复查询或自动派发任务。" };
  if (state.workflowRestoreError) return { action: "recover", recovery: "workflow", ...taskScope,
    code: state.workflowRestoreError.code, message: state.workflowRestoreError.message,
    nextAction: recoveryStatus + "工作流恢复失败；按当前错误码和既有恢复流程核对原记录及可能副作用，不自行重试、重规划或派发任务。" };
  if (state.pendingWorkflowRecovery) return { action: "recover", recovery: "workflow", ...taskScope,
    code: "WORKFLOW_RECOVERY_PENDING", message: "工作流恢复状态尚未持久化。",
    nextAction: recoveryStatus + "工作流恢复状态尚未持久化；结束当前轮询，按既有恢复流程处理持久化问题，未确认前不得派发或重放任务。" };
  if (state.roleRecoveryPending && !activeWorkflow) {
    return { action: "recover", recovery: "role", code: "ROLE_RECOVERY_PENDING", message: "职责恢复尚未确认。", nextAction: `无活动工作流且无需工具或新证据的简单问答可以直接回答；不要调用 task_workflow(status)，回答不会解除恢复门。需要执行时${roleAction}` };
  }
  if (!state.roleRecoveryPending && !state.pendingWorkflowRecovery && !state.roleRecoveryPersistenceFailed && !state.workflowRestoreError && workflow?.status === "paused"
    && ["session-handoff-review", "session-transfer-pending", "session-handoff-imported"].includes(workflow.pauseReason ?? "")) {
    return { action: "recover", recovery: "wait", nextAction: workflow.taskPauseReason ?? "等待用户确认会话交接；不自行新建session、重试任务或重规划。" };
  }
  if (state.roleRecoveryPending
    || (workflow && !["completed", "cancelled"].includes(workflow.status)
      && (workflow.status === "paused" || task?.outcomeUnknown || (workflow.currentTaskId && !task)))) {
    return { action: "recover", recovery: "workflow", ...taskScope,
      ...(state.roleRecoveryPending ? { code: "ROLE_RECOVERY_PENDING", message: "职责恢复尚未确认。" } : {}),
      nextAction: recoveryStatus + '按现有恢复守卫核对当前身份和未知结果；不得自动重放副作用或沿用旧 attempt/handoff。' + (state.roleRecoveryPending
        ? `${requiredRole ? `重新确认职责 ${requiredRole}；` : "按用户目标确认职责；"}${roleAction}恢复前不要执行其他工具。${nextTask ? "确认后结束本回合，由现有调度器派发待办；收到新的任务交接前不要执行待调度任务。" : ""}` : "") };
  }
  if (!workflow || ["completed", "cancelled"].includes(workflow.status)) return { action: "none", nextAction: "按当前用户目标和明确指定的任务角色继续尚未完成的工作；没有待办就结束，不创造新任务。同一交付物内保持职责，独立交付物或必要架构决策才换角。无活动工作流任务角色绑定，不豁免其他职责与安全守卫。" };
  if (workflow.currentTaskId) {
    const boundary = workflow.pendingRevision
      ? "方向已登记；当前任务真实完成后提交 complete，确有阻塞时提交 block 记录已知成果。安全边界后由现有调度器安排 architect 重规划。"
      : "继续当前任务，真实完成且验证通过后提交 complete；只有确有阻塞才提交 block。若确需改变计划，当前真实执行角色可先用 request-replan 登记方向，再真实 complete 或 block 到达安全边界，由现有调度器交给 architect；不得用 request-replan 代替任务结果。";
    return { action: "finish-current-task", ...taskScope, nextAction: `保持或恢复当前任务显式执行角色 ${task?.role}，其优先于模型自行换角判断；使用当前真实 handoff 身份。${boundary}不要在当前任务尚未退出时切到 architect 提前重规划，不得自动标记完成或重放副作用。` };
  }
  if (workflow.pendingRevision) return { action: "schedule-replan", requiredRole: "architect", nextAction: "当前任务已退出；由现有工作流调度器安排 architect 使用当前 revision/handoff 身份规划，保留未知结果确认与证据守卫。" };
  return { action: "none", ...taskScope, nextAction: "按现有工作流调度继续，不重复派发任务。" };
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
