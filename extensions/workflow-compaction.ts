import type {
  ExtensionAPI,
  ExtensionContext,
  SessionCompactEvent,
  SessionCompactFailedEvent,
} from "@earendil-works/pi-coding-agent";
import { roleLabel } from "../src/roles.js";
import {
  textOf,
  type ExtensionRuntimeState,
  type PendingRoleCompaction,
} from "./runtime-state.ts";

export const WORKFLOW_COMPACTION_WATCHDOG_MS = 30_000;
const COMPACTION_STATUS_KEY = "pi-init-compaction";
const ROLE_SWITCH_COMPACTION_INSTRUCTIONS = [
  "这是自动角色切换触发的上下文压缩。",
  "请保留后续角色继续工作所需的完整信息：用户目标与约束、关键决策及原因、已完成/进行中/阻塞事项、读取和修改的文件、实际执行的验证命令与结果、下一步。",
  "不要把未完成事项写成已完成；保持项目路径、错误信息和待处理问题的准确性。",
].join("\n");
const ROLE_SWITCH_CONTINUATION_TYPE = "pi-init-role-transition";

type WorkflowCompactionDependencies = {
  setWorkflowDispatchInFlight: (value: boolean) => void;
  setInternalContinuationPending: (value: boolean) => void;
  sendWorkflowTaskMessage: (ctx: ExtensionContext, taskId: string, note?: string) => void;
  scheduleWorkflow: (ctx: ExtensionContext) => Promise<void>;
  sendWorkflowReplanMessage: (ctx: ExtensionContext) => void;
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

  function notifyCompactionStalled(operation: ActiveCompaction) {
    if (!active || active.operationId !== operation.operationId || active.settled) return;
    state.roleCompactionPhase = "stalled";
    state.roleCompactionStalled = true;
    const message = `上下文压缩等待超过 ${Math.ceil(watchdogMs / 1000)} 秒（操作 ${operation.operationId}）；未自动启动下一任务。请等待 Pi 完成，或执行 /reload 后使用 /pi-init workflow resume。`;
    operation.ctx.ui.setStatus(COMPACTION_STATUS_KEY, `⚠ ${message}`);
    operation.ctx.ui.notify(message, "warning");
  }

  function sendGenericContinuation(operation: ActiveCompaction) {
    const { transition, ctx, operationId } = operation;
    try {
      deps.setInternalContinuationPending(true);
      pi.sendMessage(
        {
          customType: ROLE_SWITCH_CONTINUATION_TYPE,
          content: `已完成从${roleLabel(transition.fromRole)}到${roleLabel(transition.toRole)}的自动角色切换和上下文压缩。请继续当前任务。`,
          display: false,
          details: { ...transition, operationId },
        },
        { triggerTurn: true },
      );
    } catch (error) {
      deps.setInternalContinuationPending(false);
      ctx.ui.notify(`上下文压缩已完成，但无法自动继续：${textOf(error)}`, "warning");
    }
  }

  function continueAfterCompaction(operation: ActiveCompaction, warning?: string) {
    const { transition, ctx } = operation;
    if (!warning) deps.acknowledgeRoleRecovery(transition.toRole);
    if (warning) ctx.ui.notify(warning, "warning");

    switch (transition.continuation?.kind) {
      case "workflow-task":
        deps.sendWorkflowTaskMessage(ctx, transition.continuation.taskId, warning);
        return;
      case "workflow-schedule":
        deps.setWorkflowDispatchInFlight(false);
        void deps.scheduleWorkflow(ctx).catch((error) => ctx.ui.notify(`工作流自动续跑失败：${textOf(error)}`, "error"));
        return;
      case "workflow-review":
        deps.setWorkflowDispatchInFlight(false);
        return;
      case "workflow-replan":
        deps.setWorkflowDispatchInFlight(false);
        deps.sendWorkflowReplanMessage(ctx);
        return;
      default:
        sendGenericContinuation(operation);
    }
  }

  function settle(operationId: string, warning?: string) {
    if (!active || active.operationId !== operationId || active.settled) return false;
    const operation = active;
    operation.settled = true;
    active = undefined;
    clearWatchdog();
    operation.ctx.ui.setStatus(COMPACTION_STATUS_KEY, undefined);
    clearTransientState();
    try {
      continueAfterCompaction(operation, warning);
    } catch (error) {
      deps.setInternalContinuationPending(false);
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
    state.pendingRoleCompaction = undefined;
    const operation: ActiveCompaction = {
      operationId: `role-compaction-${Date.now().toString(36)}-${++sequence}`,
      transition,
      ctx,
      settled: false,
    };
    active = operation;
    state.roleCompactionInFlight = true;
    state.roleCompactionPhase = "compacting";
    state.roleCompactionStalled = false;
    state.roleCompactionOperationId = operation.operationId;
    state.roleCompactionStartedAt = Date.now();
    ctx.ui.setStatus(COMPACTION_STATUS_KEY, `● 正在压缩上下文（${operation.operationId}）`);
    armWatchdog(operation);

    if (branchHasOnlyCustomEntriesAfterCompaction(ctx)) {
      settle(operation.operationId);
      return true;
    }

    try {
      ctx.compact({
        customInstructions: ROLE_SWITCH_COMPACTION_INSTRUCTIONS,
        onComplete: () => settle(operation.operationId),
        onError: (error) => settle(operation.operationId, errorMessage(error, "上下文压缩失败，仍将继续当前任务")),
      });
    } catch (error) {
      settle(operation.operationId, errorMessage(error, "上下文压缩失败，仍将继续当前任务"));
    }
    return true;
  }

  function handleSessionCompact(_event: SessionCompactEvent, _ctx: ExtensionContext) {
    if (!active) return false;
    return settle(active.operationId);
  }

  function handleSessionCompactFailed(event: SessionCompactFailedEvent, _ctx: ExtensionContext) {
    if (!active) return false;
    const reason = event.aborted
      ? "上下文压缩被中止，仍将继续当前任务"
      : "上下文压缩失败，仍将继续当前任务";
    return settle(active.operationId, event.errorMessage ? `${reason}：${event.errorMessage}` : reason);
  }

  function dispose() {
    clearWatchdog();
    active = undefined;
    state.pendingRoleCompaction = undefined;
    clearTransientState();
    deps.setWorkflowDispatchInFlight(false);
  }

  return {
    start,
    settle,
    handleSessionCompact,
    handleSessionCompactFailed,
    dispose,
  };
}

export type WorkflowCompaction = ReturnType<typeof createWorkflowCompaction>;
export type { WorkflowCompactionDependencies, WorkflowCompactionOptions };
