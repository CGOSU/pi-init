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
  "这是自动角色切换触发的上下文压缩。",
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
  scheduleWorkflow: (ctx: ExtensionContext, identity?: import("./runtime-state.ts").WorkflowActionIdentity) => Promise<void>;
  sendWorkflowReplanMessage: (ctx: ExtensionContext, identity?: import("./runtime-state.ts").WorkflowReplanIdentity) => void;
  acknowledgeRoleRecovery: (role: string) => void;
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

  function clearTransientState() {
    state.roleCompactionInFlight = false;
    state.roleCompactionPhase = "idle";
    state.roleCompactionStalled = false;
    state.roleCompactionOperationId = undefined;
    state.roleCompactionStartedAt = undefined;
  }

  function watchdogNextStep(operation: ActiveCompaction) {
    const continuation = operation.transition.continuation;
    if (!continuation) return "当前压缩只负责角色切换，不会派发工作流任务；等待 Pi 完成后检查角色恢复状态。";
    if (!continuationIsCurrent(operation.transition)) {
      return "关联的工作流身份已变化，不会继续旧交接；请查看当前工作流状态。";
    }
    if (continuation.kind === "workflow-review") {
      return "工作流仍等待用户审阅；压缩完成不会自动恢复，审阅后再显式继续。";
    }
    return "请先查看当前工作流状态；只有身份仍匹配时才显式恢复，不要重放旧交接。";
  }

  function notifyCompactionStalled(operation: ActiveCompaction) {
    if (!active || active.operationId !== operation.operationId || active.settled) return;
    state.roleCompactionPhase = "stalled";
    state.roleCompactionStalled = true;
    const message = `上下文压缩等待超过 ${Math.ceil(watchdogMs / 1000)} 秒（操作 ${operation.operationId}）；未自动启动下一任务。${watchdogNextStep(operation)}`;
    deps.activityStatus?.setCompaction(operation.ctx, "stalled");
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
    const current = state.workflowState;
    const continuation = transition.continuation;
    if (!continuation) return true;
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
    return transition.sessionId === identity.sessionId
      && transition.contextGeneration === state.roleContextGeneration
      && Boolean(transition.continuation && sameWorkflowIdentity(transition.continuation.identity, identity));
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
    if (!contextIsCurrent(operation)
      || state.roleTransitionGeneration !== transition.roleTransitionGeneration
      || !sameRole(deps.getActiveRole(ctx), transition.targetRole)
      || !continuationIsCurrent(transition)) return false;
    return !state.pendingRoleCompaction
      || state.pendingRoleCompaction.roleTransitionGeneration === transition.roleTransitionGeneration;
  }

  function sendFailureDiagnostic(operation: ActiveCompaction) {
    const diagnostic = {
      code: "ROLE_COMPACTION_FAILED",
      message: "自动角色切换后的上下文压缩失败或被中止；不会伪报成功，也不会自动继续或派发工作流任务。",
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
      sendFailureDiagnostic(operation);
      return;
    }
    deps.acknowledgeRoleRecovery(transition.toRole);

    switch (transition.continuation?.kind) {
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
        ctx.ui.notify("角色切换和上下文压缩已完成；普通任务不会因此额外自动启动新回合。", "info");
    }
  }

  function settle(operationId: string, warning?: string) {
    if (!active || active.operationId !== operationId || active.settled) return false;
    const operation = active;
    operation.settled = true;
    active = undefined;
    clearWatchdog();
    deps.activityStatus?.setCompaction(operation.ctx, undefined);
    clearTransientState();
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
    watchdogTimer = setTimeout(() => notifyCompactionStalled(operation), watchdogMs);
    watchdogTimer.unref?.();
  }

  function start(ctx: ExtensionContext) {
    if (state.runtimeDisposed || state.roleCompactionInFlight || active || !state.pendingRoleCompaction) return false;

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
    state.roleCompactionInFlight = true;
    state.roleCompactionPhase = "compacting";
    state.roleCompactionStalled = false;
    state.roleCompactionOperationId = operation.operationId;
    state.roleCompactionStartedAt = Date.now();
    deps.activityStatus?.setCompaction(ctx, "compacting");
    armWatchdog(operation);

    if (branchHasOnlyCustomEntriesAfterCompaction(ctx)) {
      settle(operation.operationId);
      return true;
    }

    try {
      ctx.compact({
        customInstructions: ROLE_SWITCH_COMPACTION_INSTRUCTIONS,
        onComplete: () => settle(operation.operationId),
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
    clearTransientState();
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
