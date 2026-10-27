import type { ExtensionRuntimeState } from "./runtime-state.ts";

type PolicyState = Pick<ExtensionRuntimeState, "workflowState" | "roleRecoveryPending" | "roleRecoveryPersistenceFailed" | "workflowRestoreError">;
export type WorkflowNextAction = {
  action: "none" | "recover" | "finish-current-task" | "schedule-replan";
  nextAction: string;
  requiredRole?: string;
  taskId?: string;
};

/** Routing advice only: never grants identity, execution or side-effect authority. */
export function nextWorkflowAction(state: PolicyState): WorkflowNextAction {
  const workflow = state.workflowState;
  const task = workflow?.tasks.find((item) => item.id === workflow.currentTaskId);
  const taskScope = workflow?.currentTaskId ? { taskId: workflow.currentTaskId, requiredRole: task?.role } : {};
  if (state.roleRecoveryPending || state.roleRecoveryPersistenceFailed || state.workflowRestoreError
    || (workflow && !["completed", "cancelled"].includes(workflow.status)
      && (workflow.status === "paused" || task?.outcomeUnknown || (workflow.currentTaskId && !task)))) {
    return { action: "recover", ...taskScope, nextAction: '先读取 task_workflow(action="status") 并按现有恢复守卫核对当前身份和未知结果；不得自动重放副作用或沿用旧 attempt/handoff。' };
  }
  if (!workflow || ["completed", "cancelled"].includes(workflow.status)) return { action: "none", nextAction: "按当前用户目标和明确指定的任务角色继续；同一交付物内保持职责，独立交付物或必要架构决策才换角。无活动工作流任务角色绑定，不豁免其他职责与安全守卫。" };
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
