import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  beginWorkflowDelegation,
  blockWorkflowTask,
  completeWorkflowTask,
  getNextWorkflowTask,
  getWorkflowTask,
  hydrateWorkflowState,
  isWorkflowActive,
  markWorkflowTaskStarted,
  recordWorkflowNudge,
  startWorkflowTask,
} from "../src/workflow.js";
import { parseSubtaskResult } from "../src/subtask.js";
import { textOf, type ExtensionRuntimeState } from "./runtime-state.ts";
import type { RoleRuntime } from "./role-runtime.ts";
import type { WorkflowMessages } from "./workflow-messages.ts";
import type { WorkflowReport } from "./workflow-report.ts";

export type WorkflowDispatchDependencies = {
  roleRuntime: RoleRuntime;
  getActiveTools: () => string[];
  messages: WorkflowMessages;
  report: WorkflowReport;
  setCurrentContext: (ctx: ExtensionContext) => void;
};

export function createWorkflowDispatch(
  state: ExtensionRuntimeState,
  deps: WorkflowDispatchDependencies,
) {
  function nextSubtaskRequestId(taskId: string) {
    return `pi-init-${taskId}-${Date.now()}`;
  }

  async function scheduleWorkflowReplan(ctx: ExtensionContext) {
    if (
      state.workflowDispatchInFlight ||
      state.roleCompactionInFlight ||
      state.pendingRoleCompaction ||
      !state.workflowState ||
      state.workflowState.status !== "replanning" ||
      !state.workflowState.pendingRevision
    ) return;

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

  function blockDelegatedTask(ctx: ExtensionContext, taskId: string, reason: string) {
    if (state.runtimeDisposed || !state.workflowState || state.workflowState.currentTaskId !== taskId || !isWorkflowActive(state.workflowState)) return;
    try {
      const blocked = blockWorkflowTask(state.workflowState, { taskId, reason });
      deps.report.persistWorkflowState(blocked, ctx);
      state.workflowDispatchInFlight = false;
      ctx.ui.notify(`工作流已暂停：委派任务 ${taskId}：${reason}`, "warning");
    } catch (error) {
      state.workflowDispatchInFlight = false;
      ctx.ui.notify(`无法记录委派任务 ${taskId} 的失败：${textOf(error)}`, "error");
    }
  }

  async function dispatchSubtaskTask(ctx: ExtensionContext, taskId: string) {
    if (!state.workflowState || state.workflowState.currentTaskId !== taskId || !isWorkflowActive(state.workflowState)) return;
    const task = getWorkflowTask(state.workflowState, taskId);
    if (!task) return;
    const activeTools = deps.getActiveTools();
    if (!activeTools.includes("subtask")) {
      blockDelegatedTask(ctx, taskId, "未检测到 subtask 工具；请先安装并启用 gary149/pi-subtask 扩展");
      return;
    }
    try {
      const spawning = beginWorkflowDelegation(state.workflowState, {
        taskId,
        requestId: nextSubtaskRequestId(task.id),
        type: "subtask",
      });
      const started = markWorkflowTaskStarted(spawning, taskId);
      deps.report.persistWorkflowState(started, ctx);
      deps.messages.sendSubtaskDispatchMessage(ctx, taskId);
    } catch (error) {
      blockDelegatedTask(ctx, taskId, `无法派发 subtask：${textOf(error)}`);
    }
  }

  function latestSubtaskResult(ctx: ExtensionContext) {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry.type === "custom_message" && entry.customType === "subtask-result") return entry;
    }
    return undefined;
  }

  async function consumeSubtaskResult(ctx: ExtensionContext) {
    if (!state.workflowState || state.workflowState.executor !== "subtask" || !isWorkflowActive(state.workflowState)) return;
    const taskId = state.workflowState.currentTaskId;
    if (!taskId) return;
    const task = getWorkflowTask(state.workflowState, taskId);
    const delegation = task?.delegation;
    if (!delegation || !["spawning", "running"].includes(delegation.status)) return;

    const details = latestSubtaskResult(ctx)?.details as
      | { name?: string; task?: string; status?: string; resultText?: string }
      | undefined;
    if (!details || typeof details.task !== "string" || typeof details.resultText !== "string") return;

    if (details.task !== deps.messages.workflowSubtaskPrompt(taskId)) return;

    if (details.status !== "done") {
      blockDelegatedTask(ctx, taskId, `subtask 未成功完成（${details.status ?? "未知"}）`);
      return;
    }

    try {
      const result = parseSubtaskResult(details.resultText);
      if (result.outcome === "blocked") {
        blockDelegatedTask(ctx, taskId, result.reason);
        return;
      }
      const next = completeWorkflowTask(state.workflowState, {
        taskId,
        completionSummary: result.completionSummary,
        implementationRationale: result.implementationRationale,
        verification: result.verification,
      });
      const completedTask = getWorkflowTask(next, taskId);
      const taskCompletionReport = deps.report.formatWorkflowTaskCompletion(completedTask);
      const completionReport = next.status === "completed"
        ? deps.report.formatWorkflowCompletion(next, completedTask)
        : taskCompletionReport;
      deps.report.persistWorkflowState(next, ctx);
      state.workflowDispatchInFlight = false;
      ctx.ui.notify(completionReport, "info");
    } catch (error) {
      blockDelegatedTask(ctx, taskId, `subtask 结果无效：${textOf(error)}`);
    }
  }

  async function scheduleWorkflow(ctx: ExtensionContext) {
    if (
      state.workflowDispatchInFlight ||
      state.roleCompactionInFlight ||
      state.pendingRoleCompaction ||
      !state.workflowState
    ) {
      return;
    }
    if (state.workflowState.status === "replanning") {
      await scheduleWorkflowReplan(ctx);
      return;
    }
    if (!isWorkflowActive(state.workflowState)) return;

    if (state.workflowState.currentTaskId) {
      const currentTask = getWorkflowTask(state.workflowState, state.workflowState.currentTaskId);
      if (state.workflowState.executor === "subtask") {
        if (currentTask?.delegation) {
          await consumeSubtaskResult(ctx);
          if (state.workflowState?.status === "replanning") {
            await scheduleWorkflowReplan(ctx);
            return;
          }
          if (!state.workflowState || !isWorkflowActive(state.workflowState) || state.workflowState.currentTaskId) return;
        } else {
          state.workflowDispatchInFlight = true;
          void dispatchSubtaskTask(ctx, state.workflowState.currentTaskId);
          return;
        }
      } else {
        const nudged = recordWorkflowNudge(state.workflowState);
        if (nudged === state.workflowState) return;
        deps.report.persistWorkflowState(nudged, ctx);
        if (nudged.status === "paused") {
          ctx.ui.notify(
            "工作流已暂停：任务未提交 complete/block。请检查当前任务后使用 /pi-init workflow retry 或重新规划。",
            "warning",
          );
          return;
        }
        deps.messages.sendWorkflowTaskMessage(ctx, nudged.currentTaskId!, "上一回合尚未收到任务完成或阻塞结果；请继续当前任务并在结束时调用 task_workflow。");
        return;
      }
    }

    const next = getNextWorkflowTask(state.workflowState);
    if (!next) return;

    state.workflowDispatchInFlight = true;
    const started = startWorkflowTask(state.workflowState, next.id);
    deps.report.persistWorkflowState(started, ctx);
    if (started.executor === "subtask") {
      void dispatchSubtaskTask(ctx, next.id);
      return;
    }

    try {
      const selection = await deps.roleRuntime.automaticRole(next.role, ctx);
      if (selection.result.role !== next.role) {
        const paused = blockWorkflowTask(state.workflowState, {
          taskId: next.id,
          reason: `角色模式选择了 ${selection.result.role}，而任务要求 ${next.role}`,
        });
        deps.report.persistWorkflowState(paused, ctx);
        state.workflowDispatchInFlight = false;
        ctx.ui.notify(`任务 ${next.id} 已暂停：未能应用要求的角色 ${next.role}。`, "warning");
        return;
      }

      if (selection.transition && state.pendingRoleCompaction) {
        state.pendingRoleCompaction.continuation = { kind: "workflow-task", taskId: next.id };
        deps.roleRuntime.startPendingRoleCompaction(ctx);
        return;
      }
      deps.messages.sendWorkflowTaskMessage(ctx, next.id);
    } catch (error) {
      const paused = blockWorkflowTask(state.workflowState, {
        taskId: next.id,
        reason: `无法切换到 ${next.role}：${textOf(error)}`,
      });
      deps.report.persistWorkflowState(paused, ctx);
      state.workflowDispatchInFlight = false;
      ctx.ui.notify(`工作流已暂停：${textOf(error)}`, "error");
    }
  }

  return {
    scheduleWorkflowReplan,
    restoreWorkflowState,
    blockDelegatedTask,
    dispatchSubtaskTask,
    consumeSubtaskResult,
    scheduleWorkflow,
  };
}

export type WorkflowDispatch = ReturnType<typeof createWorkflowDispatch>;
