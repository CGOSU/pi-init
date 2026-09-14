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
import { textOf, type ExtensionRuntimeState, type RoleCompactionContinuation } from "./runtime-state.ts";
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
  function formatBlockedWorkflowMessage(message: string, workflowState: NonNullable<ExtensionRuntimeState["workflowState"]>) {
    const guidance = deps.report.formatWorkflowBlockNotice(workflowState);
    return guidance ? `${message}\n${guidance}` : message;
  }

  function startTaskBoundaryCompaction(ctx: ExtensionContext, continuation: RoleCompactionContinuation) {
    if (!shouldCompactAfterWorkflowTask({ mode: state.roleModeStatus, contextUsage: ctx.getContextUsage() })) return false;
    const role = state.activeRole?.role ?? "workflow";
    state.pendingRoleCompaction ??= { fromRole: role, toRole: role };
    state.pendingRoleCompaction.continuation = continuation;
    deps.roleRuntime.startPendingRoleCompaction(ctx);
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
        return;
      }
      if (taskCompletionPending && startTaskBoundaryCompaction(ctx, { kind: "workflow-replan" })) return;
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
    const data = entry && "data" in entry ? entry.data : undefined;
    try {
      state.workflowState = data && typeof data === "object" && Array.isArray((data as { tasks?: unknown }).tasks)
        ? hydrateWorkflowState(data)
        : undefined;
      if (state.workflowState) state.workflowExecutorStatus = state.workflowState.executor;
    } catch (error) {
      state.workflowState = undefined;
      ctx.ui.notify(`无法恢复工作流状态：${textOf(error)}`, "error");
    }
    deps.report.updateWorkflowStatus(ctx);
  }

  function blockWorkflowTaskFromDispatch(ctx: ExtensionContext, taskId: string, reason: string) {
    if (state.runtimeDisposed || !state.workflowState || state.workflowState.currentTaskId !== taskId || !isWorkflowActive(state.workflowState)) return;
    try {
      const blocked = blockWorkflowTask(state.workflowState, { taskId, reason });
      deps.report.persistWorkflowState(blocked, ctx);
      state.workflowDispatchInFlight = false;
      ctx.ui.notify(
        formatBlockedWorkflowMessage(`工作流任务 ${taskId} 已暂停：${reason}`, blocked),
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
    if (state.workflowState.status === "replanning") {
      await scheduleWorkflowReplan(ctx);
      return;
    }
    if (!isWorkflowActive(state.workflowState)) return;
    if (state.workflowState.executor === "runtime") {
      if (!state.runtimeBackend) {
        ctx.ui.notify("Runtime workflow backend 未初始化；不会回退到本地调度。", "error");
        return;
      }
      await state.runtimeBackend.schedule(ctx);
      return;
    }

    if (state.workflowState.currentTaskId) {
      const nudged = recordWorkflowNudge(state.workflowState);
      if (nudged === state.workflowState) return;
      deps.report.persistWorkflowState(nudged, ctx);
      if (nudged.status === "paused") {
        ctx.ui.notify(
          formatBlockedWorkflowMessage("工作流已暂停：任务未提交 complete/block。", nudged),
          "warning",
        );
        return;
      }
      deps.messages.sendWorkflowTaskMessage(
        ctx,
        nudged.currentTaskId!,
        "上一回合尚未收到任务完成或阻塞结果；请继续当前任务并在结束时调用 task_workflow。",
      );
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
    const started = startWorkflowTask(state.workflowState, next.id);
    deps.report.persistWorkflowState(started, ctx);

    try {
      const selection = await deps.roleRuntime.automaticRole(next.role, ctx);
      if (selection.result.role !== next.role) {
        const paused = blockWorkflowTask(state.workflowState, {
          taskId: next.id,
          reason: `角色模式选择了 ${selection.result.role}，而任务要求 ${next.role}`,
        });
        deps.report.persistWorkflowState(paused, ctx);
        state.workflowDispatchInFlight = false;
        ctx.ui.notify(
          formatBlockedWorkflowMessage(`任务 ${next.id} 已暂停：未能应用要求的角色 ${next.role}。`, paused),
          "warning",
        );
        return;
      }

      if (selection.transition && state.pendingRoleCompaction) {
        state.pendingRoleCompaction.continuation = { kind: "workflow-task", taskId: next.id };
        deps.roleRuntime.startPendingRoleCompaction(ctx);
        return;
      }
      if (taskCompletionPending && startTaskBoundaryCompaction(ctx, { kind: "workflow-task", taskId: next.id })) return;
      deps.messages.sendWorkflowTaskMessage(ctx, next.id);
    } catch (error) {
      const paused = blockWorkflowTask(state.workflowState, {
        taskId: next.id,
        reason: `无法切换到 ${next.role}：${textOf(error)}`,
      });
      deps.report.persistWorkflowState(paused, ctx);
      state.workflowDispatchInFlight = false;
      ctx.ui.notify(
        formatBlockedWorkflowMessage(`工作流已暂停：${textOf(error)}`, paused),
        "error",
      );
    }
  }

  return {
    scheduleWorkflowReplan,
    restoreWorkflowState,
    scheduleWorkflow,
  };
}

export type WorkflowDispatch = ReturnType<typeof createWorkflowDispatch>;
