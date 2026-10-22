import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { workflowActionIdentity, workflowHandoffIdentity, workflowReplanIdentity } from "../src/workflow.ts";
import {
  textOf,
  type ActiveRole,
  type ExtensionRuntimeState,
  type PendingRoleCompaction,
  type WorkflowActionIdentity,
} from "./runtime-state.ts";
import type { ActivityStatusReporter } from "./activity-status.ts";

export const WORKFLOW_COMPACTION_WATCHDOG_MS = 30_000;
const ROLE_SWITCH_COMPACTION_INSTRUCTIONS = [
  "这是任务交接边界触发的上下文压缩。",
  "请保留后续角色继续工作所需的完整信息：用户目标与约束、关键决策及原因、已完成/进行中/阻塞事项、读取和修改的文件、实际执行的验证命令与结果、下一步。",
  "不要把未完成事项写成已完成；保持项目路径、错误信息和待处理问题的准确性。",
].join("\n");
const ROLE_SWITCH_DIAGNOSTIC_TYPE = "pi-init-role-transition";

type WorkflowCompactionDependencies = {
  activityStatus?: ActivityStatusReporter;
  setWorkflowDispatchInFlight: (value: boolean) => void;
  getActiveRole: (ctx: ExtensionContext) => ActiveRole | undefined;
  requireRoleRecovery: (ctx: ExtensionContext, reason: string) => void;
  sendWorkflowTaskMessage: (ctx: ExtensionContext, taskId: string, note?: string, identity?: import("./runtime-state.ts").WorkflowHandoffIdentity) => void;
  scheduleWorkflow: (ctx: ExtensionContext, identity?: import("./runtime-state.ts").WorkflowActionIdentity, reason?: "context-budget") => Promise<void>;
  sendWorkflowReplanMessage: (ctx: ExtensionContext, identity?: import("./runtime-state.ts").WorkflowReplanIdentity) => void;
  acknowledgeRoleRecovery: (role: string) => void;
  finishWorkflowBoundary?: (ctx: ExtensionContext, identity: WorkflowActionIdentity, failed?: boolean) => Promise<void>;
};

type ActiveCompaction = {
  operationId: string;
  transition: PendingRoleCompaction;
  ctx: ExtensionContext;
  settled: boolean;
};

type WorkflowCompactionOptions = {
  watchdogMs?: number;
};

function branchHasOnlyCustomEntriesAfterCompaction(ctx: ExtensionContext) {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index].type !== "custom") return branch[index].type === "compaction";
  }
  return false;
}

function validWatchdogMs(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : WORKFLOW_COMPACTION_WATCHDOG_MS;
}

function errorMessage(error: unknown, prefix: string) {
  return `${prefix}：${textOf(error)}`;
}

export function createWorkflowCompaction(
  pi: ExtensionAPI,
  state: ExtensionRuntimeState,
  deps: WorkflowCompactionDependencies,
  options: WorkflowCompactionOptions = {},
) {
  const watchdogMs = validWatchdogMs(options.watchdogMs);
  let sequence = 0;
  let active: ActiveCompaction | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;

  function clearWatchdog() {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = undefined;
  }

  function clearTransientState(operationId?: string) {
    if (state.activeRoleCompaction && state.activeRoleCompaction.operationId !== operationId) return;
    state.roleCompactionInFlight = false;
    state.activeRoleCompaction = undefined;
    state.roleCompactionPhase = "idle";
    state.roleCompactionOperationId = undefined;
    state.roleCompactionStartedAt = undefined;
  }

  function watchdogNextStep(operation: ActiveCompaction) {
    const continuation = operation.transition.continuation;
    if (!continuation) return "当前压缩没有可执行续跑，不会派发工作流任务；等待Pi完成后检查职责恢复状态。";
    if (!continuationIsCurrent(operation.transition)) return "关联的工作流身份已变化，不继续旧交接。";
    return continuation.kind === "workflow-review" ? "仍等待用户审阅，压缩完成不自动恢复。" : "检查当前工作流，仅以仍匹配的身份显式恢复。";
  }

  function compactionElapsed(startedAt: number | undefined, now = Date.now()) {
    if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || !Number.isFinite(now) || now < startedAt) {
      return undefined;
    }
    const elapsedMilliseconds = Math.floor(now - startedAt);
    return elapsedMilliseconds < 1000
      ? `${elapsedMilliseconds}ms`
      : `${Math.floor(elapsedMilliseconds / 1000)}s`;
  }

  function reminderThreshold() {
    return watchdogMs < 1000 ? `${watchdogMs}ms` : `${Math.ceil(watchdogMs / 1000)} 秒`;
  }

  function notifyCompactionLongWait(operation: ActiveCompaction) {
    if (!active || active.operationId !== operation.operationId || operation.settled
      || !state.roleCompactionInFlight
      || state.roleCompactionOperationId !== operation.operationId
      || state.activeRoleCompaction?.operationId !== operation.operationId
      || state.roleTransitionGeneration !== operation.transition.roleTransitionGeneration
      || !sameRole(deps.getActiveRole(operation.ctx), operation.transition.targetRole)
      || !contextIsCurrent(operation)) return;
    state.traceHandoff?.(operation.ctx, "compaction.long_wait", { operationId: operation.operationId });
    const elapsed = compactionElapsed(state.roleCompactionStartedAt);
    const wait = elapsed ? `（已等待 ${elapsed}）` : "（实际等待时长不可用）";
    const message = `上下文压缩仍在进行${wait}；已达到 ${reminderThreshold()} 软提醒阈值，仅表示等待较长，不代表失败。不会停止压缩或自动重派发。${watchdogNextStep(operation)}`;
    deps.activityStatus?.setCompaction(operation.ctx, "long-wait", state.roleCompactionStartedAt);
    operation.ctx.ui.notify(message, "warning");
  }

  function sameRole(left: ActiveRole | undefined, right: ActiveRole) {
    if (!left) return false;
    return left.role === right.role
      && left.provider === right.provider
      && left.model === right.model
      && left.thinkingLevel === right.thinkingLevel;
  }

  function continuationIsCurrent(transition: PendingRoleCompaction) {
    if (transition.budget) {
      const workflow = state.workflowState;
      const expected = transition.budget.identity;
      if (!expected) return transition.budget.inactiveWorkflowKey
        ? Boolean(workflow && ["completed", "cancelled"].includes(workflow.status)
          && JSON.stringify([workflowActionIdentity(workflow), workflow.status]) === transition.budget.inactiveWorkflowKey)
        : !workflow;
      const current = workflow && workflowHandoffIdentity(workflow);
      const task = workflow?.tasks.find(item => item.id === expected.taskId);
      return Boolean(current && workflow?.status === "running" && !workflow.pendingRevision && !workflow.continuation
        && workflow.handoff?.phase === "executing" && workflow.currentTaskId === expected.taskId
        && task?.status === "in_progress" && !task.outcomeUnknown && !task.delegation
        && task.role === transition.targetRole.role
        && Object.keys(expected).every(key => current[key as keyof typeof current] === expected[key as keyof typeof expected]));
    }
    const continuation = transition.continuation;
    if (!continuation) return true;
    const current = state.workflowState;
    if (!current) return false;
    if (continuation.kind === "workflow-task") {
      const identity = workflowHandoffIdentity(current);
      return identity !== undefined
        && Object.keys(continuation.identity).every((key) => identity[key as keyof typeof identity] === continuation.identity[key as keyof typeof continuation.identity]);
    }
    if (continuation.kind === "workflow-replan") {
      const identity = workflowReplanIdentity(current);
      return identity !== undefined
        && Object.keys(continuation.identity).every((key) => identity[key as keyof typeof identity] === continuation.identity[key as keyof typeof continuation.identity]);
    }
    const identity = workflowActionIdentity(current);
    return identity !== undefined
      && Object.keys(continuation.identity).every((key) => identity[key as keyof typeof identity] === continuation.identity[key as keyof typeof continuation.identity]);
  }

  function contextIsCurrent(operation: ActiveCompaction) {
    const { transition, ctx } = operation;
    return !state.runtimeDisposed
      && state.roleContextGeneration === transition.contextGeneration
      && ctx.sessionManager.getSessionId() === transition.sessionId;
  }

  function sameWorkflowIdentity(left: WorkflowActionIdentity, right: WorkflowActionIdentity) {
    return left.workflowId === right.workflowId
      && left.planVersion === right.planVersion
      && left.sessionId === right.sessionId
      && left.recoveryGeneration === right.recoveryGeneration;
  }

  function continuationBelongsTo(transition: PendingRoleCompaction, identity: WorkflowActionIdentity) {
    const continuation = transition.continuation;
    return transition.sessionId === identity.sessionId
      && transition.contextGeneration === state.roleContextGeneration
      && Boolean(continuation && sameWorkflowIdentity(continuation.identity, identity));
  }

  function retireWorkflowContinuation(identity: WorkflowActionIdentity) {
    let retired = false;
    for (const transition of [state.pendingRoleCompaction, active?.transition]) {
      if (!transition || !continuationBelongsTo(transition, identity)) continue;
      transition.continuation = undefined;
      retired = true;
    }
    return retired;
  }

  function operationIsCurrent(operation: ActiveCompaction) {
    const { transition, ctx } = operation;
    const budget = transition.budget;
    const currentRole = deps.getActiveRole(ctx);
    const roleMatches = budget && !budget.explicitRole
      ? !state.activeRole && !currentRole && ctx.model?.provider === transition.targetRole.provider
        && ctx.model.id === transition.targetRole.model && pi.getThinkingLevel() === transition.targetRole.thinkingLevel
      : sameRole(currentRole, transition.targetRole);
    const branch = budget ? ctx.sessionManager.getBranch() : [];
    const branchMatches = !budget || (branch.length >= budget.branchEntryIds.length
      && budget.branchEntryIds.every((id, index) => branch[index]?.id === id)
      && branch.slice(budget.branchEntryIds.length).every(entry => entry.type === "custom" || entry.type === "compaction"));
    if (!contextIsCurrent(operation) || state.userStopRequested || !branchMatches
      || (budget && (state.roleRecoveryPending || state.roleRecoveryPersistenceFailed || state.workflowRestoreError
        || state.pendingWorkflowRecovery))
      || state.roleTransitionGeneration !== transition.roleTransitionGeneration
      || !roleMatches
      || !continuationIsCurrent(transition)) return false;
    return !state.pendingRoleCompaction
      || state.pendingRoleCompaction.roleTransitionGeneration === transition.roleTransitionGeneration;
  }

  function sendFailureDiagnostic(operation: ActiveCompaction) {
    const diagnostic = {
      code: "ROLE_COMPACTION_FAILED",
      message: "任务交接边界的上下文压缩失败或被中止；不会伪报成功，也不会自动继续或派发工作流任务。",
      operationId: operation.operationId,
      nextAction: operation.transition.continuation?.kind === "workflow-review"
        ? "查看工作流状态并等待用户明确完成架构审阅；不得自动 resume。"
        : operation.transition.continuation
            ? "检查当前工作流身份与状态；确认仍是同一交接后，再显式执行 /pi-init workflow resume。"
            : "后续仅在用户继续请求且任务仍未完成时恢复工作；不要重复已经完成的工作。",
    };
    try {
      pi.sendMessage(
        {
          customType: ROLE_SWITCH_DIAGNOSTIC_TYPE,
          content: `[PI-INIT_ROLE_COMPACTION_ERROR] ${JSON.stringify(diagnostic)}`,
          display: false,
          details: diagnostic,
        },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
    } catch (error) {
      operation.ctx.ui.notify(`无法记录模型可见的压缩失败诊断：${textOf(error)}`, "error");
    }
  }

  function continueAfterCompaction(operation: ActiveCompaction, warning?: string) {
    const { transition, ctx } = operation;
    state.traceHandoff?.(ctx, "compaction.settled", { operationId: operation.operationId, failed: Boolean(warning), current: operationIsCurrent(operation) });
    if (!operationIsCurrent(operation)) {
      deps.setWorkflowDispatchInFlight(false);
      if (contextIsCurrent(operation)
        && state.roleTransitionGeneration === transition.roleTransitionGeneration
        && !sameRole(deps.getActiveRole(ctx), transition.targetRole)) {
        deps.requireRoleRecovery(ctx, "role-changed-during-compaction");
      }
      ctx.ui.notify("角色压缩交接已过期；未确认旧身份、未自动派发或继续任务。请检查当前职责与工作流状态。", "warning");
      return;
    }
    if (warning) {
      ctx.ui.notify(warning, "warning");
      deps.setWorkflowDispatchInFlight(false);
      if (transition.continuation?.kind === "workflow-boundary") {
        void deps.finishWorkflowBoundary?.(ctx, transition.continuation.identity, true).catch((error) => ctx.ui.notify(`无法记录任务边界压缩暂停：${textOf(error)}`, "error"));
      }
      sendFailureDiagnostic(operation);
      return;
    }
    if (transition.budget) {
      if (transition.budget.identity && !state.agentRunActive && ctx.isIdle()) {
        void deps.scheduleWorkflow(ctx, workflowActionIdentity(state.workflowState!), "context-budget")
          .catch(error => ctx.ui.notify(`预算压缩后的可信续做未完成：${textOf(error)}`, "warning"));
      } else if (!transition.budget.identity) {
        ctx.ui.notify("上下文预算压缩已完成；普通任务未重新派发。若宿主已结束当前回合，可明确继续未完成部分，不重放已完成操作。", "info");
      }
      return;
    }
    deps.acknowledgeRoleRecovery(transition.targetRole.role);

    switch (transition.continuation?.kind) {
      case "workflow-boundary":
        deps.setWorkflowDispatchInFlight(false);
        void deps.finishWorkflowBoundary?.(ctx, transition.continuation.identity).catch((error) => ctx.ui.notify(`任务边界压缩续跑失败：${textOf(error)}`, "error"));
        return;
      case "workflow-task":
        deps.sendWorkflowTaskMessage(ctx, transition.continuation.taskId, undefined, transition.continuation.identity);
        return;
      case "workflow-schedule":
        deps.setWorkflowDispatchInFlight(false);
        void deps.scheduleWorkflow(ctx, transition.continuation.identity).catch((error) => ctx.ui.notify(`工作流自动续跑失败：${textOf(error)}`, "error"));
        return;
      case "workflow-review":
        deps.setWorkflowDispatchInFlight(false);
        return;
      case "workflow-replan":
        deps.setWorkflowDispatchInFlight(false);
        deps.sendWorkflowReplanMessage(ctx, transition.continuation.identity);
        return;
      default:
        ctx.ui.notify("上下文压缩已完成；普通任务不会因此额外自动启动新回合。", "info");
    }
  }

  function settle(operationId: string, warning?: string) {
    if (!active || active.operationId !== operationId || active.settled) return false;
    const operation = active;
    operation.settled = true;
    active = undefined;
    clearWatchdog();
    deps.activityStatus?.setCompaction(operation.ctx, undefined);
    clearTransientState(operation.operationId);
    try {
      continueAfterCompaction(operation, warning);
    } catch (error) {
      deps.setWorkflowDispatchInFlight(false);
      operation.ctx.ui.notify(`上下文压缩交接失败：${textOf(error)}`, "error");
    }
    return true;
  }

  function armWatchdog(operation: ActiveCompaction) {
    clearWatchdog();
    watchdogTimer = setTimeout(() => notifyCompactionLongWait(operation), watchdogMs);
    watchdogTimer.unref?.();
  }

  function start(ctx: ExtensionContext) {
    if (state.runtimeDisposed || state.userStopRequested || state.roleCompactionInFlight || active || !state.pendingRoleCompaction) return false;

    const transition = state.pendingRoleCompaction;
    const operation: ActiveCompaction = {
      operationId: `role-compaction-${Date.now().toString(36)}-${++sequence}`,
      transition,
      ctx,
      settled: false,
    };
    if (!operationIsCurrent(operation)) {
      state.pendingRoleCompaction = undefined;
      deps.setWorkflowDispatchInFlight(false);
      if (contextIsCurrent(operation)
        && state.roleTransitionGeneration === transition.roleTransitionGeneration
        && !sameRole(deps.getActiveRole(ctx), transition.targetRole)) {
        deps.requireRoleRecovery(ctx, "role-changed-before-compaction");
      }
      ctx.ui.notify("角色压缩交接的职责、session、branch 或工作流身份已过期；未执行压缩续跑。", "warning");
      return false;
    }
    state.pendingRoleCompaction = undefined;
    active = operation;
    state.activeRoleCompaction = { operationId: operation.operationId, transition };
    state.roleCompactionInFlight = true;
    state.roleCompactionPhase = "compacting";
    state.roleCompactionOperationId = operation.operationId;
    const startedAt = Date.now();
    state.roleCompactionStartedAt = startedAt;
    deps.activityStatus?.setCompaction(ctx, "compacting", startedAt);
    state.traceHandoff?.(ctx, "compaction.started", { operationId: operation.operationId, fromRole: transition.fromRole, toRole: transition.toRole, continuationKind: transition.continuation?.kind });
    armWatchdog(operation);

    if (!transition.budget && branchHasOnlyCustomEntriesAfterCompaction(ctx)) {
      settle(operation.operationId);
      return true;
    }

    try {
      ctx.compact({
        customInstructions: transition.budget
          ? `System-derived current task snapshot (not a handoff):\n${transition.budget.snapshot}`
          : ROLE_SWITCH_COMPACTION_INSTRUCTIONS,
        onComplete: (result) => {
          const verified = !transition.budget || (result && typeof result.summary === "string" && result.summary.trim()
            && typeof result.firstKeptEntryId === "string" && Number.isFinite(result.tokensBefore)
            && ctx.sessionManager.getBranch().slice(transition.budget.branchEntryIds.length)
              .some(entry => entry.type === "compaction" && entry.summary === result.summary));
          settle(operation.operationId, verified ? undefined : "上下文压缩结果未知；未自动继续任务。");
        },
        onError: (error) => settle(operation.operationId, errorMessage(error, "上下文压缩失败或被中止")),
      });
    } catch (error) {
      settle(operation.operationId, errorMessage(error, "上下文压缩失败或被中止"));
    }
    return true;
  }

  function dispose() {
    const operation = active;
    clearWatchdog();
    active = undefined;
    if (operation) deps.activityStatus?.setCompaction(operation.ctx, undefined);
    state.pendingRoleCompaction = undefined;
    clearTransientState(operation?.operationId);
    deps.setWorkflowDispatchInFlight(false);
  }

  return {
    start,
    settle,
    retireWorkflowContinuation,
    dispose,
  };
}

export type WorkflowCompaction = ReturnType<typeof createWorkflowCompaction>;
export type { WorkflowCompactionDependencies, WorkflowCompactionOptions };
