import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionRuntimeState } from "./runtime-state.ts";

type ReviewDispatchState = Pick<ExtensionRuntimeState,
  "roleRecoveryPersistenceFailed" | "workflowRestoreError" | "pendingWorkflowRecovery"
  | "workflowState" | "workflowDispatchInFlight"
>;

type ReviewDispatchDecision =
  | { allowed: true }
  | {
    allowed: false;
    code: "ROLE_RECOVERY_PERSIST_FAILED" | "WORKFLOW_RESTORE_FAILED" | "WORKFLOW_RECOVERY_PENDING"
    | "WORKFLOW_ACTIVE" | "WORKFLOW_DISPATCH_IN_FLIGHT" | "AGENT_BUSY";
    message: string;
  };

export function evaluateFileReviewDispatch(
  state: ReviewDispatchState,
  ctx: Pick<ExtensionContext, "isIdle">,
): ReviewDispatchDecision {
  if (state.roleRecoveryPersistenceFailed) {
    return { allowed: false, code: "ROLE_RECOVERY_PERSIST_FAILED", message: "职责恢复记录持久化失败；扫描结果已保留，未启动 AI 审阅。" };
  }
  if (state.workflowRestoreError) {
    return { allowed: false, code: "WORKFLOW_RESTORE_FAILED", message: `工作流恢复失败（${state.workflowRestoreError.code}）；未启动 AI 审阅。` };
  }
  if (state.pendingWorkflowRecovery) {
    return { allowed: false, code: "WORKFLOW_RECOVERY_PENDING", message: "有待处理的工作流恢复；未启动 AI 审阅。" };
  }
  if (state.workflowState && !["completed", "cancelled"].includes(state.workflowState.status)) {
    return { allowed: false, code: "WORKFLOW_ACTIVE", message: "当前有未结束的工作流；未启动 AI 审阅。" };
  }
  if (state.workflowDispatchInFlight) {
    return { allowed: false, code: "WORKFLOW_DISPATCH_IN_FLIGHT", message: "工作流正在派发；未启动 AI 审阅。" };
  }
  if (!ctx.isIdle()) {
    return { allowed: false, code: "AGENT_BUSY", message: "Agent 正忙；未启动或排队 AI 审阅。" };
  }
  return { allowed: true };
}
