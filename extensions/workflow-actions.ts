import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import {
  applyWorkflowReplan,
  blockWorkflowTask,
  cancelWorkflow,
  completeWorkflowTask,
  createWorkflowState,
  resumeWorkflow,
  retryWorkflowTask,
  validateWorkflowHandoffIdentity,
  validateWorkflowMutationIdentity,
  validateWorkflowReplanIdentity,
  validateWorkflowPlan,
} from "../src/workflow.ts";
import { resolveRoleModel, shouldOrchestrateWorkflow } from "../src/roles.ts";
import type { WorkflowMode } from "../src/role-types.ts";
import type { WorkflowHandoffIdentity, WorkflowResult } from "../src/workflow-types.ts";
import { textOf, type ExtensionRuntimeState, type WorkflowActionIdentity } from "./runtime-state.ts";
import type { RoleRuntime } from "./role-runtime.ts";
import type { WorkflowDispatch } from "./workflow-dispatch.ts";
import type { WorkflowReport } from "./workflow-report.ts";
import { taskWorkflowParameters } from "./contracts.ts";
import {
  createWorkflowCompletionView,
  createWorkflowTaskCompletionView,
} from "./workflow-completion-view.ts";
import {
  formatWorkflowCompletionText,
  formatWorkflowTaskCompletionText,
} from "./workflow-completion-renderer.ts";
import { createCurrentWorkflowStatusView } from "./workflow-status-view.ts";
import { attachWorkflowPresentation } from "./workflow-presentation.ts";

export type WorkflowActionDependencies = {
  roleRuntime: RoleRuntime;
  dispatch: WorkflowDispatch;
  report: WorkflowReport;
};

type WorkflowActionResult = {
  content: { type: "text"; text: string }[];
  details: unknown;
  terminate?: boolean;
};

export function createWorkflowActions(
  state: ExtensionRuntimeState,
  deps: WorkflowActionDependencies,
) {
  function missingWorkflowError() {
    const restoreError = state.workflowRestoreError;
    if (restoreError) {
      return Object.assign(
        new Error(`无法恢复已保存的工作流（${restoreError.code}）：${restoreError.message}`),
        { code: restoreError.code },
      );
    }
    return new Error("当前没有活动工作流");
  }

  function statusDetails(details: object, workflowState = state.workflowState) {
    return attachWorkflowPresentation(details, {
      kind: "workflow-status",
      view: createCurrentWorkflowStatusView(state, workflowState),
    });
  }

  function requireIdentity<T>(result: WorkflowResult<T>): T {
    if (!result.ok) {
      const diagnostic = Object.fromEntries(Object.entries(result).filter(([key]) => key !== "ok"));
      const code = typeof result.code === "string" ? result.code : "WORKFLOW_ACTION_IDENTITY_INVALID";
      throw Object.assign(new Error(`[PI-INIT_WORKFLOW_ERROR] ${JSON.stringify(diagnostic)}`), {
        code,
        details: diagnostic,
      });
    }
    return result.value;
  }

  function shouldOrchestrateConfiguredWorkflow(mode: WorkflowMode, taskCount: number) {
    if (typeof shouldOrchestrateWorkflow !== "function") {
      throw new Error(
        "检测到 pi-init 运行时版本不一致：扩展与 src/roles.ts 不是同一版本，缺少 shouldOrchestrateWorkflow。请先执行 pi update --extensions，然后在 Pi 中执行 /reload；本地开发请重启 Pi，并确保使用同一份扩展和 src/roles.ts。",
      );
    }
    return shouldOrchestrateWorkflow({ mode, taskCount });
  }
  function assertConfiguredTaskRoles(
    config: { roleModels: Record<string, unknown> },
    tasks: Array<{ id: string; role: string }>,
    sessionDefault: ReturnType<RoleRuntime["currentRole"]>,
  ) {
    for (const task of tasks) {
      const resolved = resolveRoleModel(config, task.role, sessionDefault);
      if (!resolved.ok) {
        throw Object.assign(
          new Error(`工作流任务 ${task.id} 无法解析角色 ${task.role} 的模型：${resolved.message}`),
          { code: resolved.code },
        );
      }
    }
  }

  function requireTaskHandoffIdentity(params: unknown, ctx: ExtensionContext): WorkflowHandoffIdentity {
    return requireIdentity(validateWorkflowHandoffIdentity(state.workflowState, params, ctx, { allowQueued: true }));
  }

  function markQueuedTaskStarted(params: unknown, ctx: ExtensionContext) {
    const current = state.workflowState;
    if (current?.handoff?.phase !== "queued") return;
    const task = current.currentTaskId
      ? current.tasks.find((item) => item.id === current.currentTaskId)
      : undefined;
    if (!task) throw new Error("queued handoff 找不到当前任务，拒绝补记任务开始");
    if (deps.roleRuntime.activeRoleFor(ctx)?.role !== task.role) {
      throw new Error(`queued handoff 要求角色 ${task.role}，当前角色不匹配；拒绝补记任务开始`);
    }
    deps.dispatch.markCurrentTaskStarted(ctx);
    requireIdentity(validateWorkflowHandoffIdentity(state.workflowState, params, ctx));
  }

  async function workflowCommand(
    action: string | undefined,
    taskId: string | undefined,
    ctx: ExtensionCommandContext,
    confirmUnknownOutcome = false,
  ) {
    if (action === undefined || action === "status") {
      await deps.report.showWorkflowProgress(ctx);
      if (state.workflowRestoreError) {
        ctx.ui.notify(
          `工作流恢复诊断（${state.workflowRestoreError.code}）：${state.workflowRestoreError.message}`,
          "error",
        );
      }
      return;
    }
    if (!state.workflowState) {
      const restoreError = state.workflowRestoreError;
      ctx.ui.notify(
        restoreError
          ? `无法恢复工作流（${restoreError.code}）：${restoreError.message}`
          : "当前没有工作流。请先让架构角色调用 task_workflow(action=plan)。",
        restoreError ? "error" : "warning",
      );
      return;
    }

    try {
      if (action === "resume") {
        if (state.workflowState.status === "replanning") {
          await deps.dispatch.scheduleWorkflow(ctx);
          return;
        }
        if (state.workflowState.status === "running") {
          await deps.dispatch.resumeLocalWorkflow(ctx);
          return;
        }
        deps.report.persistWorkflowState(resumeWorkflow(state.workflowState), ctx);
        await deps.dispatch.scheduleWorkflow(ctx);
        return;
      }
      if (action === "retry") {
        deps.report.persistWorkflowState(retryWorkflowTask(state.workflowState, taskId, undefined, { confirmUnknownOutcome }), ctx);
        await deps.dispatch.scheduleWorkflow(ctx);
        return;
      }
      if (action === "cancel") {
        const cancelled = cancelWorkflow(state.workflowState);
        deps.report.persistWorkflowState(cancelled, ctx);
        state.workflowDispatchInFlight = false;
        state.workflowRestoreError = undefined;
        ctx.ui.notify("工作流已取消。", "info");
        return;
      }
      ctx.ui.notify("用法：/pi-init workflow [status|resume|retry <taskId> [--confirm-unknown-outcome]|cancel]", "error");
    } catch (error) {
      ctx.ui.notify(textOf(error), "error");
    }
  }

  async function runTaskWorkflowAction(
    params: Static<typeof taskWorkflowParameters>,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<WorkflowActionResult> {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "工作流操作已取消。" }], details: {} };
    }
    if (params.action !== "status" && !ctx.isProjectTrusted()) {
      throw new Error("task_workflow 仅允许在受信任项目中运行；请先信任当前项目");
    }
    const mayStartFreshSessionWorkflow = params.action === "plan"
      && state.workflowRestoreError?.code === "WORKFLOW_SESSION_MISMATCH";
    const mayCancelInvalidExecutionRole = params.action === "cancel"
      && ["WORKFLOW_EXECUTION_ROLE_FORBIDDEN", "WORKFLOW_TASK_ROLE_INVALID"].includes(state.workflowRestoreError?.code ?? "")
      && Boolean(state.workflowState);
    if (params.action !== "status" && state.workflowRestoreError
      && !mayStartFreshSessionWorkflow && !mayCancelInvalidExecutionRole) {
      throw missingWorkflowError();
    }

    switch (params.action) {
      case "plan": {
        if (deps.roleRuntime.activeRoleFor(ctx)?.role !== "architect") {
          throw new Error("只有架构角色可以创建工作流；请先调用 switch_role(role=architect)");
        }
        if (state.workflowState && ["running", "paused", "replanning"].includes(state.workflowState.status)) {
          throw new Error("当前已有未结束的工作流，请先完成、取消或处理它");
        }

        const config = await deps.roleRuntime.readSessionRoleConfig(ctx);
        state.workflowModeStatus = config.workflowMode;
        const plan = validateWorkflowPlan({
          summary: params.summary,
          constraints: params.constraints,
          tasks: params.tasks,
          reviewRequired: params.reviewRequired,
        });
        assertConfiguredTaskRoles(config, plan.tasks, deps.roleRuntime.currentRole("architect", ctx));
        if (config.workflowMode === "off") {
          throw new Error(
            "task_workflow 当前策略为 off；请先执行 /pi-init config workflow 选择 on 或 auto，或在 .pi/role-models.json 中将 workflowMode 设为 on/auto",
          );
        }
        if (!shouldOrchestrateConfiguredWorkflow(config.workflowMode, plan.tasks.length)) {
          return {
            content: [{
              type: "text",
              text: `当前工作流策略为 auto，规划包含 ${plan.tasks.length} 个任务（不超过 2 个），已跳过工作流编排；请按各任务指定的角色切换后顺序执行这些任务，架构角色只负责规划，不直接实现。`,
            }],
            details: { workflowMode: config.workflowMode, taskCount: plan.tasks.length, orchestrated: false },
          };
        }

        const next = createWorkflowState({
          ...plan,
          executor: "local",
          sessionId: ctx.sessionManager.getSessionId(),
        });
        deps.report.persistWorkflowState(next, ctx);
        state.workflowRestoreError = undefined;
        const identity: WorkflowActionIdentity = {
          workflowId: next.workflowId,
          planVersion: next.planVersion,
          sessionId: next.sessionId,
          recoveryGeneration: next.recoveryGeneration,
        };
        if (next.status === "paused") {
          ctx.ui.notify("架构规划已保存，等待用户审阅。审阅后执行 /pi-init workflow resume。", "info");
          if (state.pendingRoleCompaction) state.pendingRoleCompaction.continuation = { kind: "workflow-review", identity };
        } else if (state.pendingRoleCompaction) {
          state.pendingRoleCompaction.continuation = { kind: "workflow-schedule", identity };
        }
        return {
          content: [{ type: "text", text: `已保存架构规划。\n${deps.report.formatWorkflowState(next)}${next.status === "paused" ? "\n\n当前按用户要求暂停，审阅后再执行。" : "\n\n将自动切换到第一个任务。"}` }],
          details: statusDetails(next),
          terminate: true,
        };
      }
      case "status": {
        const restoreDiagnostic = state.workflowRestoreError
          ? `\n\n工作流恢复错误：${JSON.stringify(state.workflowRestoreError)}；不会改写原记录或派发任务。可显式取消该工作流后另建计划。`
          : "";
        return {
          content: [{ type: "text", text: `${deps.report.formatWorkflowState()}${restoreDiagnostic}` }],
          details: state.workflowRestoreError
            ? { ...(state.workflowState ?? {}), error: state.workflowRestoreError }
            : state.workflowState
              ? statusDetails(state.workflowState)
              : statusDetails({}),
        };
      }
      case "replan": {
        if (!state.workflowState) throw missingWorkflowError();
        if (deps.roleRuntime.activeRoleFor(ctx)?.role !== "architect") {
          throw new Error("只有架构角色可以应用工作流重规划；请先调用 switch_role(role=architect)");
        }
        if (state.workflowState.status !== "replanning") {
          throw new Error("当前没有等待应用的工作流重规划");
        }
        const config = await deps.roleRuntime.readSessionRoleConfig(ctx);
        const plan = validateWorkflowPlan({
          summary: params.summary,
          constraints: params.constraints,
          tasks: params.tasks,
        });
        assertConfiguredTaskRoles(config, plan.tasks, deps.roleRuntime.currentRole("architect", ctx));
        requireIdentity(validateWorkflowReplanIdentity(state.workflowState, params, ctx));
        const next = applyWorkflowReplan(state.workflowState, {
          revisionId: params.revisionId,
          summary: params.summary,
          constraints: params.constraints,
          tasks: params.tasks,
          retainTaskIds: params.retainTaskIds,
        });
        deps.report.persistWorkflowState(next, ctx);
        state.workflowDispatchInFlight = false;
        return {
          content: [{ type: "text", text: `已应用工作流重规划。\n${deps.report.formatWorkflowState(next)}\n\n新计划将自动开始。` }],
          details: statusDetails(next),
          terminate: true,
        };
      }
      case "complete": {
        if (!state.workflowState) throw missingWorkflowError();
        const { taskId } = requireTaskHandoffIdentity(params, ctx);
        const task = taskId ? state.workflowState.tasks.find((item) => item.id === taskId) : undefined;
        if (!task) throw new Error(`工作流任务不存在：${taskId ?? "（未指定）"}`);
        if (deps.roleRuntime.activeRoleFor(ctx)?.role !== task.role) {
          throw new Error(`任务 ${task.id} 要求角色 ${task.role}，当前角色不匹配；请先调用 switch_role`);
        }
        markQueuedTaskStarted(params, ctx);
        const next = completeWorkflowTask(state.workflowState, {
          taskId,
          completionSummary: params.completionSummary,
          implementationRationale: params.implementationRationale,
          verification: params.verification,
        });
        const completedTask = next.tasks.find((item) => item.id === task.id);
        const taskCompletionView = createWorkflowTaskCompletionView(completedTask);
        const workflowCompletionView = next.status === "completed"
          ? createWorkflowCompletionView(next, completedTask)
          : undefined;
        const completionReport = workflowCompletionView
          ? formatWorkflowCompletionText(workflowCompletionView)
          : formatWorkflowTaskCompletionText(taskCompletionView);
        const continuation: "awaiting-replan" | "next-task" = next.status === "replanning" ? "awaiting-replan" : "next-task";
        const notice = next.status === "completed"
          ? "工作流已完成。"
          : next.status === "replanning"
            ? "当前任务已完成，等待架构师重规划，不会启动旧的后续任务。"
            : "下一任务将自动开始。";
        const presentation = workflowCompletionView
          ? { kind: "workflow-completion" as const, view: workflowCompletionView }
          : { kind: "task-completion" as const, view: taskCompletionView, continuation };
        deps.report.persistWorkflowState(next, ctx);
        return {
          content: [{ type: "text", text: `${completionReport}\n\n${notice}` }],
          details: attachWorkflowPresentation(next, presentation),
          terminate: true,
        };
      }
      case "block": {
        if (!state.workflowState) throw missingWorkflowError();
        const { taskId } = requireTaskHandoffIdentity(params, ctx);
        markQueuedTaskStarted(params, ctx);
        const next = blockWorkflowTask(state.workflowState, { taskId, reason: params.reason });
        deps.report.persistWorkflowState(next, ctx);
        state.workflowDispatchInFlight = false;
        return { content: [{ type: "text", text: deps.report.formatWorkflowPauseSummary(next) }], details: statusDetails(next), terminate: true };
      }
      case "resume": {
        if (!state.workflowState) throw missingWorkflowError();
        requireIdentity(validateWorkflowMutationIdentity(state.workflowState, params, ctx));
        if (state.workflowState.status === "replanning") {
          await deps.dispatch.scheduleWorkflow(ctx);
          return {
            content: [{ type: "text", text: "工作流仍在等待架构师重规划；已尝试继续架构调度。" }],
            details: statusDetails(state.workflowState),
            terminate: true,
          };
        }
        if (state.workflowState.status === "running") {
          const result = await deps.dispatch.resumeLocalWorkflow(ctx);
          const messages = {
            "blocked-by-compaction": "工作流仍在等待上下文压缩，不会并发启动任务。",
            "continuation-pending": "自动任务交接消息已排队，未重复派发。",
            "already-started": "当前任务已真实启动，未重复派发。",
            "dispatch-in-flight": "任务交接仍在进行，未重复派发。",
            scheduled: "已安全重新调度 Local 工作流。",
          };
          return {
            content: [{ type: "text", text: messages[result] }],
            details: statusDetails(state.workflowState),
            terminate: true,
          };
        }
        const next = resumeWorkflow(state.workflowState);
        deps.report.persistWorkflowState(next, ctx);
        return { content: [{ type: "text", text: "工作流已恢复，下一任务将自动开始。" }], details: statusDetails(next), terminate: true };
      }
      case "retry": {
        if (!state.workflowState) throw missingWorkflowError();
        requireIdentity(validateWorkflowMutationIdentity(state.workflowState, params, ctx));
        const next = retryWorkflowTask(state.workflowState, params.taskId, undefined, {
          confirmUnknownOutcome: params.confirmUnknownOutcome === true,
        });
        deps.report.persistWorkflowState(next, ctx);
        return { content: [{ type: "text", text: `任务 ${params.taskId ?? ""} 已重新排队，工作流将自动继续。` }], details: statusDetails(next), terminate: true };
      }
      case "cancel": {
        if (!state.workflowState) throw missingWorkflowError();
        requireIdentity(validateWorkflowMutationIdentity(state.workflowState, params, ctx));
        const next = cancelWorkflow(state.workflowState);
        deps.report.persistWorkflowState(next, ctx);
        state.workflowDispatchInFlight = false;
        return { content: [{ type: "text", text: "工作流已取消。" }], details: statusDetails(next), terminate: true };
      }
      default:
        throw new Error(`未知工作流动作：${params.action}`);
    }
  }

  return { workflowCommand, runTaskWorkflowAction, shouldOrchestrateConfiguredWorkflow };
}

export type WorkflowActions = ReturnType<typeof createWorkflowActions>;
