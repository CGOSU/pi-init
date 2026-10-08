import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  blockWorkflowTask,
  getNextWorkflowTask,
  getWorkflowTask,
  hydrateWorkflowState,
  isWorkflowActive,
  recordWorkflowNudge,
  startWorkflowTask,
} from "../src/workflow.js";
import { shouldCompactAfterWorkflowTask } from "../src/roles.js";
import { textOf, type ExtensionRuntimeState, type RoleCompactionContinuation, type WorkflowState } from "./runtime-state.ts";
import type { RoleRuntime } from "./role-runtime.ts";
import type { WorkflowMessages } from "./workflow-messages.ts";
import type { WorkflowReport } from "./workflow-report.ts";

export type WorkflowDispatchDependencies = {
  roleRuntime: RoleRuntime;
  messages: WorkflowMessages;
  report: WorkflowReport;
  setCurrentContext: (ctx: ExtensionContext) => void;
};

export function createWorkflowDispatch(
  state: ExtensionRuntimeState,
  deps: WorkflowDispatchDependencies,
) {
  let localScheduleInFlight = false;

  function startTaskBoundaryCompaction(
    ctx: ExtensionContext,
    continuation: RoleCompactionContinuation,
    fromRole: string | undefined,
    toRole: string,
  ) {
    if (!fromRole || fromRole === toRole) return false;
    if (!shouldCompactAfterWorkflowTask({ mode: state.roleModeStatus, contextUsage: ctx.getContextUsage() })) return false;
    state.pendingRoleCompaction ??= { fromRole, toRole };
    state.pendingRoleCompaction.continuation = continuation;
    deps.roleRuntime.startPendingRoleCompaction(ctx);
    deps.report.updateWorkflowStatus(ctx);
    return true;
  }

  async function scheduleWorkflowReplan(ctx: ExtensionContext) {
    if (
      state.workflowDispatchInFlight
      || state.roleCompactionInFlight
      || state.pendingRoleCompaction
      || !state.workflowState
      || state.workflowState.status !== "replanning"
      || !state.workflowState.pendingRevision
    ) return;

    const taskCompletionPending = state.workflowTaskCompactionPending;
    state.workflowTaskCompactionPending = false;
    state.workflowDispatchInFlight = true;
    const previousRole = deps.roleRuntime.activeRoleFor(ctx)?.role;
    try {
      const selection = await deps.roleRuntime.automaticRole("architect", ctx);
      if (selection.result.role !== "architect") {
        state.workflowDispatchInFlight = false;
        ctx.ui.notify(
          `工作流已暂停等待架构师重规划：当前角色为 ${selection.result.role}，请切换到架构设计后执行 /pi-init workflow resume。`,
          "warning",
        );
        return;
      }
      if (selection.transition && state.pendingRoleCompaction) {
        state.pendingRoleCompaction.continuation = { kind: "workflow-replan" };
        deps.roleRuntime.startPendingRoleCompaction(ctx);
        deps.report.updateWorkflowStatus(ctx);
        return;
      }
      if (taskCompletionPending && startTaskBoundaryCompaction(
        ctx,
        { kind: "workflow-replan" },
        previousRole,
        selection.result.role,
      )) return;
      deps.messages.sendWorkflowReplanMessage(ctx);
    } catch (error) {
      state.workflowDispatchInFlight = false;
      ctx.ui.notify(`工作流已暂停等待架构师重规划：${textOf(error)}`, "warning");
    }
  }

  function restoreWorkflowState(ctx: ExtensionContext) {
    deps.setCurrentContext(ctx);
    const entry = ctx.sessionManager.getBranch().findLast(
      (item) => item.type === "custom" && item.customType === "pi-init-workflow",
    );
    state.workflowState = undefined;
    state.workflowRestoreError = undefined;
    if (entry) {
      const data = "data" in entry ? entry.data : undefined;
      const restored = hydrateWorkflowState(data);
      if (restored.ok) {
        state.workflowState = restored.value;
      } else {
        state.workflowRestoreError = { code: restored.code, message: restored.message };
        ctx.ui.notify(`无法恢复工作流状态（${restored.code}）：${restored.message}`, "error");
      }
    }
    deps.report.updateWorkflowStatus(ctx);
  }

  function persistDispatchPause(ctx: ExtensionContext, workflowState: WorkflowState, taskId: string) {
    try {
      deps.report.persistWorkflowState(workflowState, ctx);
      state.workflowDispatchInFlight = false;
      return true;
    } catch (error) {
      state.workflowDispatchInFlight = false;
      ctx.ui.notify(`无法记录任务 ${taskId} 的暂停状态：${textOf(error)}`, "error");
      return false;
    }
  }

  function blockWorkflowTaskFromDispatch(ctx: ExtensionContext, taskId: string, reason: string) {
    if (state.runtimeDisposed || !state.workflowState || state.workflowState.currentTaskId !== taskId || !isWorkflowActive(state.workflowState)) return;
    try {
      const blocked = blockWorkflowTask(state.workflowState, { taskId, reason });
      deps.report.persistWorkflowState(blocked, ctx);
      state.workflowDispatchInFlight = false;
      ctx.ui.notify(
        deps.report.formatWorkflowPauseSummary(blocked),
        "warning",
      );
    } catch (error) {
      state.workflowDispatchInFlight = false;
      ctx.ui.notify(`无法记录任务 ${taskId} 的失败：${textOf(error)}`, "error");
    }
  }

  async function scheduleWorkflow(ctx: ExtensionContext) {
    if (
      state.workflowDispatchInFlight
      || state.roleCompactionInFlight
      || state.pendingRoleCompaction
      || !state.workflowState
    ) {
      return;
    }
    localScheduleInFlight = true;
    try {
      await scheduleWorkflowInternal(ctx);
    } finally {
      localScheduleInFlight = false;
    }
  }

  async function scheduleWorkflowInternal(ctx: ExtensionContext) {
    if (state.workflowState.status === "replanning") {
      await scheduleWorkflowReplan(ctx);
      return;
    }
    if (!isWorkflowActive(state.workflowState)) return;
    if (state.workflowState.currentTaskId) {
      const nudged = recordWorkflowNudge(state.workflowState);
      if (nudged === state.workflowState) return;
      deps.report.persistWorkflowState(nudged, ctx);
      if (nudged.status === "paused") {
        ctx.ui.notify(
          deps.report.formatWorkflowPauseSummary(nudged),
          "warning",
        );
        return;
      }
      deps.messages.sendWorkflowTaskMessage(
        ctx,
        nudged.currentTaskId!,
        "上一回合尚未收到任务完成或阻塞结果；请继续当前任务并在结束时调用 task_workflow。",
      );
      deps.report.updateWorkflowStatus(ctx);
      return;
    }

    const next = getNextWorkflowTask(state.workflowState);
    if (!next) {
      state.workflowTaskCompactionPending = false;
      return;
    }

    const taskCompletionPending = state.workflowTaskCompactionPending;
    state.workflowTaskCompactionPending = false;
    state.workflowDispatchInFlight = true;
    const previousRole = deps.roleRuntime.activeRoleFor(ctx)?.role;
    const started = startWorkflowTask(state.workflowState, next.id);
    try {
      deps.report.persistWorkflowState(started, ctx);
    } catch (error) {
      state.workflowTaskCompactionPending = taskCompletionPending;
      state.workflowDispatchInFlight = false;
      throw error;
    }

    try {
      const selection = await deps.roleRuntime.automaticRole(next.role, ctx);
      if (selection.result.role !== next.role) {
        const paused = blockWorkflowTask(state.workflowState, {
          taskId: next.id,
          reason: `角色模式选择了 ${selection.result.role}，而任务要求 ${next.role}`,
        });
        if (!persistDispatchPause(ctx, paused, next.id)) return;
        ctx.ui.notify(
          deps.report.formatWorkflowPauseSummary(paused),
          "warning",
        );
        return;
      }

      if (selection.transition && state.pendingRoleCompaction) {
        state.pendingRoleCompaction.continuation = { kind: "workflow-task", taskId: next.id };
        deps.roleRuntime.startPendingRoleCompaction(ctx);
        deps.report.updateWorkflowStatus(ctx);
        return;
      }
      if (taskCompletionPending && startTaskBoundaryCompaction(
        ctx,
        { kind: "workflow-task", taskId: next.id },
        previousRole,
        selection.result.role,
      )) return;
      deps.messages.sendWorkflowTaskMessage(ctx, next.id);
      deps.report.updateWorkflowStatus(ctx);
    } catch (error) {
      const paused = blockWorkflowTask(state.workflowState, {
        taskId: next.id,
        reason: `无法切换到 ${next.role}：${textOf(error)}`,
      });
      if (!persistDispatchPause(ctx, paused, next.id)) return;
      ctx.ui.notify(
        deps.report.formatWorkflowPauseSummary(paused),
        "error",
      );
    }
  }

  async function resumeLocalWorkflow(ctx: ExtensionContext) {
    const workflow = state.workflowState;
    if (!workflow || workflow.executor !== "local" || workflow.status !== "running") {
      throw new Error("只有运行中的 Local 工作流可以执行安全恢复");
    }

    const currentTask = workflow.currentTaskId
      ? workflow.tasks.find((task) => task.id === workflow.currentTaskId)
      : undefined;
    if (state.roleCompactionInFlight || state.pendingRoleCompaction) {
      const phase = state.roleCompactionPhase === "stalled"
        ? "上下文压缩等待异常"
        : "上下文压缩仍在进行";
      ctx.ui.notify(`${phase}，未重复派发任务；请等待压缩完成，或执行 /reload 后再使用 /pi-init workflow resume。`, "warning");
      return "blocked-by-compaction";
    }
    if (state.internalContinuationPending) {
      ctx.ui.notify("自动任务交接消息已排队，未重复派发任务。", "info");
      return "continuation-pending";
    }
    if (currentTask?.executionStartedAt !== undefined) {
      ctx.ui.notify(`任务 ${currentTask.id} 已真实启动，未重复派发任务。`, "info");
      return "already-started";
    }
    if (!resetStaleWorkflowDispatch()) {
      ctx.ui.notify("任务交接调度仍在进行，未重复派发任务。", "info");
      return "dispatch-in-flight";
    }

    await scheduleWorkflow(ctx);
    return "scheduled";
  }

  function resetStaleWorkflowDispatch() {
    if (localScheduleInFlight) return false;
    state.workflowDispatchInFlight = false;
    return true;
  }

  return {
    scheduleWorkflowReplan,
    restoreWorkflowState,
    scheduleWorkflow,
    resumeLocalWorkflow,
    resetStaleWorkflowDispatch,
  };
}

export type WorkflowDispatch = ReturnType<typeof createWorkflowDispatch>;
