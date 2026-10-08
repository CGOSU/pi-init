import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
} from "../src/workflow.js";
import { resolveRoleModel, shouldOrchestrateWorkflow, unwrapRoleResult } from "../src/roles.js";
import { textOf, type ExtensionRuntimeState, type WorkflowActionIdentity } from "./runtime-state.ts";
import type { RoleRuntime } from "./role-runtime.ts";
import type { WorkflowDispatch } from "./workflow-dispatch.ts";
import type { WorkflowReport } from "./workflow-report.ts";

export type WorkflowActionDependencies = {
  roleRuntime: RoleRuntime;
  dispatch: WorkflowDispatch;
  report: WorkflowReport;
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

  function requireIdentity(result: { ok: boolean; code?: string; message?: string }) {
    if (!result.ok) {
      throw Object.assign(new Error(result.message ?? "工作流执行身份无效"), {
        code: result.code ?? "WORKFLOW_ACTION_IDENTITY_INVALID",
      });
    }
  }

  function shouldOrchestrateConfiguredWorkflow(mode: string, taskCount: number) {
    if (typeof shouldOrchestrateWorkflow !== "function") {
      throw new Error(
        "检测到 pi-init 运行时版本不一致：扩展与 src/roles.js 不是同一版本，缺少 shouldOrchestrateWorkflow。请先执行 pi update --extensions，然后在 Pi 中执行 /reload；本地开发请重启 Pi，并确保使用同一份扩展和 src/roles.js。",
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
        const error = unwrapRoleResult(resolved);
        error.message = `工作流任务 ${task.id} 无法解析角色 ${task.role} 的模型：${error.message}`;
        throw error;
      }
    }
  }

  async function workflowCommand(
    action: string | undefined,
    taskId: string | undefined,
    ctx: ExtensionCommandContext,
    confirmUnknownOutcome = false,
  ) {
    if (action === undefined || action === "status") {
      await deps.report.showWorkflowProgress(ctx);
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
        ctx.ui.notify("工作流已取消。", "info");
        return;
      }
      ctx.ui.notify("用法：/pi-init workflow [status|resume|retry <taskId> [--confirm-unknown-outcome]|cancel]", "error");
    } catch (error) {
      ctx.ui.notify(textOf(error), "error");
    }
  }

  async function runTaskWorkflowAction(
    params: any,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "工作流操作已取消。" }], details: {} };
    }
    if (params.action !== "status" && !ctx.isProjectTrusted()) {
      throw new Error("task_workflow 仅允许在受信任项目中运行；请先信任当前项目");
    }
    const mayStartFreshSessionWorkflow = params.action === "plan"
      && state.workflowRestoreError?.code === "WORKFLOW_SESSION_MISMATCH";
    if (params.action !== "status" && state.workflowRestoreError && !mayStartFreshSessionWorkflow) {
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
          details: next,
          terminate: true,
        };
      }
      case "status":
        return {
          content: [{ type: "text", text: deps.report.formatWorkflowState() }],
          details: state.workflowState ?? (state.workflowRestoreError ? { error: state.workflowRestoreError } : {}),
        };
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
          details: next,
          terminate: true,
        };
      }
      case "complete": {
        if (!state.workflowState) throw missingWorkflowError();
        requireIdentity(validateWorkflowHandoffIdentity(state.workflowState, params, ctx));
        const taskId = params.taskId;
        const task = taskId ? state.workflowState.tasks.find((item) => item.id === taskId) : undefined;
        if (!task) throw new Error(`工作流任务不存在：${taskId ?? "（未指定）"}`);
        if (deps.roleRuntime.activeRoleFor(ctx)?.role !== task.role) {
          throw new Error(`任务 ${task.id} 要求角色 ${task.role}，当前角色不匹配；请先调用 switch_role`);
        }
        const next = completeWorkflowTask(state.workflowState, {
          taskId,
          completionSummary: params.completionSummary,
          implementationRationale: params.implementationRationale,
          verification: params.verification,
        });
        const completedTask = next.tasks.find((item) => item.id === task.id);
        const taskCompletionReport = deps.report.formatWorkflowTaskCompletion(completedTask);
        const completionReport = next.status === "completed"
          ? deps.report.formatWorkflowCompletion(next, completedTask)
          : taskCompletionReport;
        deps.report.persistWorkflowState(next, ctx);
        return {
          content: [{ type: "text", text: `${completionReport}\n\n${next.status === "completed" ? "工作流已完成。" : next.status === "replanning" ? "当前任务已完成，等待架构师重规划，不会启动旧的后续任务。" : "下一任务将自动开始。"}` }],
          details: next,
          terminate: true,
        };
      }
      case "block": {
        if (!state.workflowState) throw missingWorkflowError();
        requireIdentity(validateWorkflowHandoffIdentity(state.workflowState, params, ctx));
        const taskId = params.taskId;
        const next = blockWorkflowTask(state.workflowState, { taskId, reason: params.reason });
        deps.report.persistWorkflowState(next, ctx);
        state.workflowDispatchInFlight = false;
        return { content: [{ type: "text", text: deps.report.formatWorkflowPauseSummary(next) }], details: next, terminate: true };
      }
      case "resume": {
        if (!state.workflowState) throw missingWorkflowError();
        requireIdentity(validateWorkflowMutationIdentity(state.workflowState, params, ctx));
        if (state.workflowState.status === "replanning") {
          await deps.dispatch.scheduleWorkflow(ctx);
          return {
            content: [{ type: "text", text: "工作流仍在等待架构师重规划；已尝试继续架构调度。" }],
            details: state.workflowState,
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
            details: state.workflowState,
            terminate: true,
          };
        }
        const next = resumeWorkflow(state.workflowState);
        deps.report.persistWorkflowState(next, ctx);
        return { content: [{ type: "text", text: "工作流已恢复，下一任务将自动开始。" }], details: next, terminate: true };
      }
      case "retry": {
        if (!state.workflowState) throw missingWorkflowError();
        requireIdentity(validateWorkflowMutationIdentity(state.workflowState, params, ctx));
        const next = retryWorkflowTask(state.workflowState, params.taskId, undefined, {
          confirmUnknownOutcome: params.confirmUnknownOutcome === true,
        });
        deps.report.persistWorkflowState(next, ctx);
        return { content: [{ type: "text", text: `任务 ${params.taskId ?? ""} 已重新排队，工作流将自动继续。` }], details: next, terminate: true };
      }
      case "cancel": {
        if (!state.workflowState) throw missingWorkflowError();
        requireIdentity(validateWorkflowMutationIdentity(state.workflowState, params, ctx));
        const next = cancelWorkflow(state.workflowState);
        deps.report.persistWorkflowState(next, ctx);
        state.workflowDispatchInFlight = false;
        return { content: [{ type: "text", text: "工作流已取消。" }], details: next, terminate: true };
      }
      default:
        throw new Error(`未知工作流动作：${params.action}`);
    }
  }

  return { workflowCommand, runTaskWorkflowAction, shouldOrchestrateConfiguredWorkflow };
}

export type WorkflowActions = ReturnType<typeof createWorkflowActions>;
