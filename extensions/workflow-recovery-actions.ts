import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  hydrateWorkflowState,
  recoverWorkflowState,
} from "../src/workflow.ts";
import {
  classifyWorkflowRecoveryError,
  createWorkflowRecoveryDisposition,
  parseWorkflowRecoveryCommandInput,
} from "../src/workflow-recovery-disposition.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import type { WorkflowReport } from "./workflow-report.ts";

export type WorkflowRecoveryActionDependencies = { report: WorkflowReport };

export function createWorkflowRecoveryActions(
  state: ExtensionRuntimeState,
  deps: WorkflowRecoveryActionDependencies,
) {
  function nextAction() {
    const error = state.workflowRestoreError;
    if (!error) return undefined;
    const classification = classifyWorkflowRecoveryError(error.code);
    if (!classification.ok) return `当前不能隔离：${classification.error.message}`;
    if (state.pendingWorkflowRecovery) {
      return "恢复状态尚未持久化；修复 Session 存储后重新加载，不要隔离记录。";
    }
    if (classification.value.kind === "discardable") {
      if (state.workflowState) return "当前已有可读取的工作流状态；检查后使用合法 cancel，不要隔离记录。";
      if (!error.sourceEntryId) return "缺少稳定的原 Session entry ID；当前不能安全隔离，请检查当前 branch。";
      return `仅在项目受信任且 Agent 空闲时，核对原记录及潜在外部副作用后执行 /pi-init workflow discard-recovery ${error.sourceEntryId} --confirm-unknown-outcome。隔离保留原记录，不代表任务成功或已取消。`;
    }
    if (classification.value.kind === "recoverable"
      && classification.value.action === "cancel-valid-state" && state.workflowState) {
      return "核对当前任务后，可执行 /pi-init workflow cancel。";
    }
    return classification.value.message;
  }

  function status() {
    const error = state.workflowRestoreError;
    if (!error) return undefined;
    const classification = classifyWorkflowRecoveryError(error.code);
    if (!classification.ok) {
      return {
        kind: "blocked" as const,
        code: classification.error.code,
        message: classification.error.message,
        stateAllowsAction: false,
      };
    }
    const action = nextAction();
    if (classification.value.kind === "discardable") {
      return {
        kind: "discardable" as const,
        code: classification.value.code,
        sourceEntryId: error.sourceEntryId,
        stateAllowsAction: Boolean(error.sourceEntryId) && !state.workflowState && !state.pendingWorkflowRecovery,
        requiredGuards: ["trusted-project", "agent-idle", "confirm-unknown-outcome"],
        nextAction: action,
      };
    }
    if (classification.value.kind === "recoverable") {
      return {
        kind: "recoverable" as const,
        code: classification.value.code,
        action: classification.value.action,
        stateAllowsAction: classification.value.action === "switch-session-or-plan"
          || Boolean(state.workflowState && !state.pendingWorkflowRecovery),
        nextAction: action,
      };
    }
    return {
      kind: "blocked" as const,
      code: classification.value.code,
      message: classification.value.message,
      stateAllowsAction: false,
      nextAction: action,
    };
  }

  function diagnostic() {
    const error = state.workflowRestoreError;
    const action = nextAction();
    return error
      ? `工作流恢复诊断（${error.code}）：${error.message}${action ? `\n恢复建议：${action}` : ""}`
      : undefined;
  }

  function throwActionError(code: string, message: string): never {
    throw Object.assign(new Error(message), { code });
  }

  function discard(
    sourceEntryId: string | undefined,
    confirmUnknownOutcome: boolean,
    ctx: ExtensionCommandContext,
  ) {
    if (!ctx.isProjectTrusted()) {
      throwActionError("WORKFLOW_RECOVERY_DISCARD_UNTRUSTED", "隔离工作流恢复记录仅允许在受信任项目中执行");
    }
    if (!ctx.isIdle()) {
      throwActionError("WORKFLOW_RECOVERY_DISCARD_AGENT_BUSY", "Agent 正忙；请等待空闲后再处理恢复记录");
    }
    const currentError = state.workflowRestoreError;
    if (!currentError) throwActionError("WORKFLOW_RECOVERY_ERROR_MISSING", "当前没有待处理的工作流恢复错误");
    if (state.workflowState || state.pendingWorkflowRecovery) {
      throwActionError("WORKFLOW_RECOVERY_STATE_AVAILABLE", "当前存在可恢复状态或待持久化恢复状态；请走对应恢复/取消路径，不要隔离");
    }
    const classification = classifyWorkflowRecoveryError(currentError.code);
    if (!classification.ok || classification.value.kind !== "discardable") {
      throwActionError(
        "WORKFLOW_RECOVERY_ERROR_NOT_DISCARDABLE",
        classification.ok ? classification.value.message : classification.error.message,
      );
    }
    const commandInput = parseWorkflowRecoveryCommandInput(sourceEntryId, confirmUnknownOutcome);
    if (!commandInput.ok) throwActionError(commandInput.error.code, commandInput.error.message);
    const requestedSourceEntryId = commandInput.value.sourceEntryId;
    if (!currentError.sourceEntryId || requestedSourceEntryId !== currentError.sourceEntryId) {
      throwActionError("WORKFLOW_RECOVERY_SOURCE_MISMATCH", "指定的 entry ID 与当前恢复错误的原记录不匹配");
    }
    const sessionId = ctx.sessionManager.getSessionId();
    if (typeof sessionId !== "string" || !sessionId) {
      throwActionError("WORKFLOW_SESSION_ID_UNAVAILABLE", "无法读取当前 sessionId；不得猜测隔离记录所属 session");
    }
    const branch = ctx.sessionManager.getBranch();
    const source = branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow");
    if (!source || source.id !== requestedSourceEntryId
      || branch.filter((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow" && entry.id === requestedSourceEntryId).length !== 1) {
      throwActionError("WORKFLOW_RECOVERY_SOURCE_CHANGED", "原记录已不再是当前 branch 的唯一最新工作流 entry；重新读取状态后再处理");
    }
    const sourceData = "data" in source ? source.data : undefined;
    if (sourceData !== null && typeof sourceData === "object" && !Array.isArray(sourceData)
      && Object.prototype.hasOwnProperty.call(sourceData, "sessionId")
      && (sourceData as Record<string, unknown>).sessionId !== sessionId) {
      throwActionError("WORKFLOW_SESSION_MISMATCH", "原记录声明的 sessionId 与当前 session 不一致；不能隔离或猜测其归属");
    }
    const hydrated = hydrateWorkflowState(sourceData);
    const currentErrorCode = hydrated.ok
      ? (() => {
        const recovered = recoverWorkflowState(hydrated.value, sessionId);
        return recovered.ok ? undefined : recovered.code;
      })()
      : hydrated.code;
    if (currentErrorCode !== currentError.code) {
      throwActionError("WORKFLOW_RECOVERY_SOURCE_CHANGED", "原记录恢复错误已变化；请重新读取状态，不能沿用旧确认");
    }
    const disposition = createWorkflowRecoveryDisposition({
      sessionId,
      sourceEntryId: requestedSourceEntryId,
      sourceErrorCode: currentError.code,
      confirmedUnknownOutcome: commandInput.value.confirmedUnknownOutcome,
    });
    if (!disposition.ok) throwActionError(disposition.error.code, disposition.error.message);
    deps.report.persistWorkflowRecoveryDisposition(disposition.value);
    state.workflowRestoreError = undefined;
    deps.report.updateWorkflowStatus(ctx);
    ctx.ui.notify("已隔离当前 branch 中指定的不可恢复记录；原记录及诊断仍保留。此操作不表示任务成功或已取消。", "info");
  }

  return { nextAction, status, diagnostic, discard };
}
