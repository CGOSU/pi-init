import { isCoreReadOnlyTool } from "../../src/tool-classification.ts";
import { textOf } from "../../src/error-utils.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  matchPolicy,
  type RuntimeStateAccess,
} from "../runtime-state.ts";
import { nextWorkflowAction } from "../workflow/workflow-action-policy.ts";

export const ROLE_RECOVERY_ENTRY_TYPE = "pi-init-role-recovery";
export const ROLE_RECOVERY_MESSAGE_TYPE = "pi-init-role-recovery";

const ROLE_RECOVERY_REASON = "上下文刚完成压缩，职责尚未重新确认；请先成功调用 switch_role(role=...)。优先按当前任务声明的角色确认；同一实现交付的代码、测试、必要说明及已授权整项 Git 收尾沿用 developer-test，独立文档/版本或显式统一收尾用 docs-commit。恢复门解除前不要先读取Skill或仓库；缺少凭据应停止，不自动更换模型。";
const SESSION_REARM_REASONS = new Set(["startup", "reload", "resume", "fork"]);

type RecoveryGuardRejection = {
  code: "ROLE_RECOVERY_REQUIRED" | "WORKFLOW_UNKNOWN_OUTCOME_CONFIRMATION_REQUIRED" | "WORKFLOW_EXECUTION_NOT_AUTHORIZED";
  message: string;
};

function isPendingEntry(entry: unknown) {
  if (!entry || typeof entry !== "object" || !("data" in entry)) return false;
  const data = (entry as { data?: unknown }).data;
  return data !== null && typeof data === "object" && (data as { status?: unknown }).status === "pending";
}

export function createRoleRecovery(
  pi: ExtensionAPI,
  state: RuntimeStateAccess<"roleRecoveryPending" | "roleRecoveryPersistenceFailed">,
  onRejected?: RecoveryRejectionHandler,
) {
  function enterPending(reason: string) {
    state.roleRecoveryPending = true;
    try {
      pi.appendEntry(ROLE_RECOVERY_ENTRY_TYPE, { status: "pending", reason });
      state.roleRecoveryPersistenceFailed = false;
    } catch (error) {
      state.roleRecoveryPersistenceFailed = true;
      throw Object.assign(new Error(`无法持久化职责恢复门，执行工具仍保持阻断：${textOf(error)}`), {
        code: "ROLE_RECOVERY_PERSIST_FAILED",
      });
    }
  }

  function restore(ctx: ExtensionContext, reason?: string) {
    const branch = ctx.sessionManager.getBranch();
    const entry = branch.findLast(
      (item) => item.type === "custom" && item.customType === ROLE_RECOVERY_ENTRY_TYPE,
    );
    if (state.roleRecoveryPersistenceFailed) {
      state.roleRecoveryPending = true;
      return;
    }
    if (branch.length > 0 && SESSION_REARM_REASONS.has(reason ?? "") && !isPendingEntry(entry)) {
      enterPending(reason ?? "startup");
      return;
    }
    state.roleRecoveryPending = isPendingEntry(entry);
  }

  function requireConfirmation(ctx: ExtensionContext, reason: string) {
    try {
      enterPending(reason);
    } catch (error) {
      ctx.ui.notify(textOf(error), "error");
    }
  }

  function reset() {
    state.roleRecoveryPending = false;
    state.roleRecoveryPersistenceFailed = false;
  }

  function afterCompact(event: { reason?: string }, ctx: ExtensionContext) {
    requireConfirmation(ctx, event.reason ?? "unknown");
  }

  function acknowledge(role: string) {
    if (!state.roleRecoveryPending) return;
    try {
      pi.appendEntry(ROLE_RECOVERY_ENTRY_TYPE, { status: "acknowledged", role });
      state.roleRecoveryPending = false;
      state.roleRecoveryPersistenceFailed = false;
    } catch (error) {
      state.roleRecoveryPending = true;
      state.roleRecoveryPersistenceFailed = true;
      throw Object.assign(new Error(`无法持久化职责确认，恢复门仍保持阻断：${textOf(error)}`), {
        code: "ROLE_RECOVERY_PERSIST_FAILED",
      });
    }
  }

  function unknownOutcomeTask(workflow: typeof state.workflowState, workflowAction: unknown, input?: Record<string, unknown>) {
    if (workflowAction !== "retry" && !(workflowAction === "replan" && input?.confirmUnknownOutcome === true)) return undefined;
    const taskId = input?.taskId;
    const task = workflowAction === "replan"
      ? workflow?.tasks.find(item => item.outcomeUnknown)
      : workflow?.tasks.find(item => taskId === undefined ? item.status === "blocked" : item.id === taskId);
    return task?.outcomeUnknown ? task : undefined;
  }

  function guardToolCall(event: { toolName: string; input?: Record<string, unknown> }) {
    if (event.toolName === "switch_role") return undefined;
    const readOnly = isCoreReadOnlyTool(event.toolName);
    const workflowAction = event.toolName === "task_workflow" ? event.input?.action : undefined;
    const workflow = state.workflowState;
    const recoveryAllowed = workflowAction === "status" || Boolean(state.activeRole?.role && state.activeRole.role !== "architect" && readOnly);
    const unavailable = Boolean(state.workflowRestoreError || state.pendingWorkflowRecovery || workflow?.status === "paused" || workflow?.status === "replanning");
    const executionBlocked = unavailable && !readOnly && (!workflowAction || ["complete", "block", "clarify"].includes(String(workflowAction)));
    return matchPolicy<RecoveryGuardRejection>([
      [() => (state.roleRecoveryPending || state.roleRecoveryPersistenceFailed) && !recoveryAllowed,
        { code: "ROLE_RECOVERY_REQUIRED", message: "[pi-init-role-recovery] " + ROLE_RECOVERY_REASON }],
      [() => Boolean(unknownOutcomeTask(workflow, workflowAction, event.input)),
        () => ({
          code: "WORKFLOW_UNKNOWN_OUTCOME_CONFIRMATION_REQUIRED",
          message: "[pi-init-workflow-authorization] 旧执行结果未知；模型布尔值不构成用户授权。" + nextWorkflowAction(state).nextAction
        })],
      [() => executionBlocked,
        () => ({
          code: "WORKFLOW_EXECUTION_NOT_AUTHORIZED",
          message: "[pi-init-workflow-execution] 工作流暂停、重规划或恢复未完成；职责确认不授权继续执行。" + nextWorkflowAction(state).nextAction + "codemode/bash 包装不属于暂停时允许的只读入口。"
        })],
    ]);
  }

  pi.on("session_compact", (event, ctx) => afterCompact(event, ctx));
  pi.on("tool_call", (event, ctx) => {
    const rejection = guardToolCall(event);
    if (!rejection) return;
    const { code, message } = rejection;
    state.traceHandoff?.(ctx, "workflow.action_rejected", { toolCallId: event.toolCallId, toolName: event.toolName, action: event.input && "action" in event.input ? event.input.action : undefined, code });
    onRejected?.(event, ctx, code);
    return { block: true, reason: message };
  });

  return {
    restore,
    reset,
    requireConfirmation,
    afterCompact,
    acknowledge,
    guardToolCall,
  };
}

export type RoleRecovery = ReturnType<typeof createRoleRecovery>;
type RecoveryRejectionHandler = (event: { toolName: string; toolCallId: string; input?: Record<string, unknown> }, ctx: ExtensionContext, code: string) => void;
