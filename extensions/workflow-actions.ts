import type { ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { } from "typebox";
import type { WorkflowMode } from "../src/role-types.ts";
import { resolveRoleModel, shouldOrchestrateWorkflow } from "../src/roles.ts";
import { workflowHandoffIdentity, workflowHandoffMessageOnBranch, workflowHandoffNotExecutingFailure } from "../src/workflow-handoff.ts";
import type { WorkflowLifecycleTransition } from "../src/workflow-orchestrator.ts";
import { transitionWorkflowLifecycle } from "../src/workflow-orchestrator.ts";
import type { WorkflowHandoffIdentity, WorkflowResult, WorkflowTask } from "../src/workflow-types.ts";
import {
    applyWorkflowReplan,
    assertSupportedWorkflowFeatures,
    createWorkflowGoalState,
    createWorkflowState,
    normalizeReplanPlan,
    requestWorkflowGoal,
    requestWorkflowReplan,
    validateWorkflowGoalPlan,
    validateWorkflowHandoffIdentity,
    validateWorkflowMutationIdentity,
    validateWorkflowPlan,
    validateWorkflowReplanIdentity,
    workflowActionIdentity
} from "../src/workflow.ts";
import { taskWorkflowParameters } from "./contracts.ts";
import type { RoleRuntime } from "./role-runtime.ts";
import { textOf, type ExtensionRuntimeState } from "./runtime-state.ts";
import type { TaskMemoryRuntime } from "./task-memory-runtime.ts";
import { taskMemoryText } from "./task-memory-runtime.ts";
import { nextWorkflowAction } from "./workflow-action-policy.ts";
import {
    formatWorkflowCompletionText,
    formatWorkflowTaskCompletionText,
} from "./workflow-completion-renderer.ts";
import {
    createWorkflowCompletionView,
    createWorkflowTaskCompletionView,
} from "./workflow-completion-view.ts";
import { type WorkflowDispatch } from "./workflow-dispatch.ts";
import { runWorkflowPanelRequest } from "./workflow-panel-actions.ts";
import { attachWorkflowPresentation } from "./workflow-presentation.ts";
import { createWorkflowRecoveryActions } from "./workflow-recovery-actions.ts";
import type { WorkflowReport } from "./workflow-report.ts";
import { createCurrentWorkflowStatusView } from "./workflow-status-view.ts";
import { transferFrozen } from "../src/session-handoff.ts";
import { outgoingTransfer } from "./session-handoff.ts";

export type WorkflowActionDependencies = {
  roleRuntime: RoleRuntime;
  dispatch: WorkflowDispatch;
  report: WorkflowReport;
  taskMemory?: TaskMemoryRuntime;
  freshSession?: (ctx: ExtensionCommandContext) => Promise<void>;
  resumeExecution?: (ctx: ExtensionContext) => boolean;
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
  const recoveryActions = createWorkflowRecoveryActions(state, { report: deps.report });
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
    return attachWorkflowPresentation({ ...details, workflowNextStep: nextWorkflowAction({ ...state, workflowState }) }, {
      kind: "workflow-status",
      view: createCurrentWorkflowStatusView(state, workflowState),
    });
  }

  function commitLifecycleTransition(transition: WorkflowLifecycleTransition, ctx: ExtensionContext) {
    const persisted = deps.report.persistWorkflowState(transition.state, ctx);

    state.workflowDispatchInFlight = false;
    return persisted;
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
    return requireIdentity(validateWorkflowHandoffIdentity(state.workflowState, params, ctx));
  }

  function requireTaskRole(task: WorkflowTask, ctx: ExtensionContext) {
    const activeRole = deps.roleRuntime.activeRoleFor(ctx)?.role;
    if (activeRole === task.role) return;
    const details = {
      ok: false,
      code: "WORKFLOW_TASK_ROLE_MISMATCH",
      taskId: task.id,
      requiredRole: task.role,
      activeRole,
      nextAction: `保持当前任务未完成；使用任务要求的 ${task.role} 职责继续执行，不能以其他角色提交 complete/block。`,
    };
    throw Object.assign(new Error(`[PI-INIT_WORKFLOW_ERROR] ${JSON.stringify(details)}`), {
      code: details.code,
      details,
    });
  }

  function guardQueuedTaskStart(action: "complete" | "block" | "clarify", ctx: ExtensionContext) {
    const current = state.workflowState;
    const phase = current?.handoff?.phase;
    if (!current || phase !== "queued") return;
    const identity = workflowHandoffIdentity(current);
    const branchMatched = identity !== undefined && workflowHandoffMessageOnBranch(ctx, identity);
    if (branchMatched) return;
    const failure = workflowHandoffNotExecutingFailure(phase, { branchMatched });
    throw Object.assign(new Error(`queued handoff 尚未被任务消息消费，拒绝以 ${action} 结果先行启动任务：${failure.message}`), {
      code: failure.code,
      details: failure,
    });
  }

  function markCurrentTaskStarted(ctx: ExtensionContext) {
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
  }

  async function workflowCommand(
    action: string | undefined,
    taskId: string | undefined,
    ctx: ExtensionCommandContext,
    confirmUnknownOutcome = false,
  ) {
    if (action === "fresh") {
      if (!deps.freshSession) { ctx.ui.notify("宿主未接通安全会话交接入口。", "warning"); return; }
      await deps.freshSession(ctx);
      return "close-panel" as const;
    }
    if (action === "acknowledge") {
      if (taskId !== undefined || confirmUnknownOutcome) {
        ctx.ui.notify("用法：/pi-init workflow acknowledge（只确认当前工作流告警，不接受来源参数）", "error");
        return;
      }
      try {
        const result = deps.report.acknowledgeWorkflowNotice(ctx);
        if (!result.ok) {
          ctx.ui.notify(result.error.message, "warning");
        } else {
          ctx.ui.notify(result.value.alreadyAcknowledged
            ? "当前工作流告警已确认；详细状态和恢复守卫仍保留。"
            : "已确认当前工作流告警；仅收起前台突出提示，工作流状态和恢复守卫未改变。", "info");
        }
      } catch (error) {
        ctx.ui.notify(textOf(error), "error");
      }
      return;
    }
    if (action === "discard-recovery") {
      try {
        recoveryActions.discard(taskId, confirmUnknownOutcome, ctx);
      } catch (error) {
        const code = typeof error === "object" && error && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined;
        ctx.ui.notify(`${code ? `[${code}] ` : ""}${textOf(error)}`, "error");
      }
      return;
    }
    if (action === undefined || action === "status") {
      const request = await deps.report.showWorkflowProgress(ctx);
              if (request) {
          const result = await runWorkflowPanelRequest(request, ctx, state, (nextAction, nextTaskId, confirmed) => workflowCommand(nextAction, nextTaskId, ctx, confirmed));
          if (result === "close-panel") return result;
        }
      const diagnostic = recoveryActions.diagnostic();
      if (diagnostic) ctx.ui.notify(diagnostic, "error");
      return;
    }
    if (transferFrozen(state.workflowState) || outgoingTransfer(ctx, state.workflowState)) {
      ctx.ui.notify("此会话队列正在交接或已转移，只读保留；请在目标会话继续，不在旧会话重试或重规划。", "warning");
      return;
    }
    if (!state.workflowState) {
      const restoreError = state.workflowRestoreError;
      ctx.ui.notify(
        restoreError
          ? recoveryActions.diagnostic() ?? `无法恢复工作流（${restoreError.code}）：${restoreError.message}`
          : "当前没有工作流。请先让架构角色调用 task_workflow(action=plan)。",
        restoreError ? "error" : "warning",
      );
      return;
    }

    try {
      if ((action === "resume" || action === "retry") && deps.resumeExecution && !deps.resumeExecution(ctx)) return;
      if (action === "resume") {
        if (state.workflowState.status === "replanning") {
          await deps.dispatch.scheduleWorkflow(ctx);
          return;
        }
        if (state.workflowState.status === "running") {
          await deps.dispatch.resumeLocalWorkflow(ctx);
          return;
        }
        const transition = transitionWorkflowLifecycle(state.workflowState, { type: "workflow-resumed", identity: workflowActionIdentity(state.workflowState) }, Date.now());
        commitLifecycleTransition(transition, ctx);
        await deps.dispatch.scheduleWorkflow(ctx);
        return;
      }
      if (action === "retry") {
        const transition = transitionWorkflowLifecycle(state.workflowState, { type: "task-retried", identity: workflowActionIdentity(state.workflowState), taskId, confirmUnknownOutcome }, Date.now());
        commitLifecycleTransition(transition, ctx);
        await deps.dispatch.scheduleWorkflow(ctx);
        return;
      }
      if (action === "cancel" || action === "cancel-all") {
        const transition = transitionWorkflowLifecycle(state.workflowState, { type: "workflow-cancelled", identity: workflowActionIdentity(state.workflowState) }, Date.now());
        commitLifecycleTransition(transition, ctx);
        ctx.ui.notify("工作流已取消；副作用未自动回滚。", "info");
        return;
      }
      ctx.ui.notify("用法：/pi-init workflow [status|acknowledge|resume|retry <taskId> [--confirm-unknown-outcome]|cancel|cancel-all|discard-recovery <entryId> --confirm-unknown-outcome]", "error");
    } catch (error) {
      ctx.ui.notify(textOf(error), "error");
    }
  }

  async function runTaskWorkflowAction(
    params: WorkflowActionParameters,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<WorkflowActionResult> {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "本次工作流工具操作已中止；工作流状态未更改。" }], details: {} };
    }
    if (params.action !== "status" && (transferFrozen(state.workflowState) || outgoingTransfer(ctx, state.workflowState))) {
      throw Object.assign(new Error("跨session交接期间当前队列只读；请在目标会话继续"), { code: "WORKFLOW_SESSION_TRANSFERRED" });
    }
    assertSupportedWorkflowFeatures(params);
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
      case "checkpoint": {
        const identity = requireTaskHandoffIdentity(params, ctx);
        if (!deps.taskMemory) throw Object.assign(new Error("任务记忆运行时不可用"), { code: "TASK_MEMORY_UNAVAILABLE" });
        const memory = deps.taskMemory.checkpoint(ctx, identity, params.checkpoint, params.expectedMemoryRevision, params.memoryFiles);
        return { content: [{ type: "text", text: "任务记忆已保存；任务未被完成或重新派发。\n" + taskMemoryText(memory) }], details: { taskMemory: memory, checkpointSaved: true } };
      }
      case "request-replan":
      case "request-goal": {
        if (!state.workflowState) throw missingWorkflowError();
        requireIdentity(validateWorkflowMutationIdentity(state.workflowState, params, ctx));
        const actor = deps.roleRuntime.activeRoleFor(ctx)?.role;
        const currentTask = state.workflowState.tasks.find(task => task.id === state.workflowState!.currentTaskId);
        const executorRequest = params.action === "request-replan" && state.workflowState.status === "running"
          && state.workflowState.handoff?.phase === "executing" && currentTask?.role === actor;
        if (actor !== "architect" && !executorRequest) {
          const step = nextWorkflowAction(state);
          const code = state.workflowState.currentTaskId ? "WORKFLOW_TASK_BOUNDARY_REQUIRED" : "WORKFLOW_ARCHITECT_REQUIRED";
          throw Object.assign(new Error("只有 architect 可以安排目标归属或修正计划；所有执行任务共用同一队列。" + step.nextAction), {
            code, details: { ok: false, code, ...step },
          });
        }
        const grouped = params.action === "request-goal";
        const next = grouped
          ? requestWorkflowGoal(state.workflowState, { direction: params.summary, parentGoalId: params.parentGoalId })
          : requestWorkflowReplan(state.workflowState, { direction: params.summary });
        deps.report.persistWorkflowState(next, ctx);
        return { content: [{ type: "text", text: (grouped ? "已记录插入目标；在安全边界规划同一任务队列，父子关系仅表达归属，不创建子工作流。" : "已记录父计划修正/追加请求；保留有效任务，在安全边界重规划当前队列。") + "\n" + nextWorkflowAction({ ...state, workflowState: next }).nextAction }], details: statusDetails(next), terminate: !next.currentTaskId };
      }
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

        if (next.status === "paused") {
          ctx.ui.notify("架构规划已保存，等待用户审阅。审阅后执行 /pi-init workflow resume。", "info");

        }
        return {
          content: [{ type: "text", text: `已保存架构规划。\n${deps.report.formatWorkflowState(next)}${next.status === "paused" ? "\n\n当前按用户要求暂停，审阅后再执行。" : "\n\n将自动切换到第一个任务。"}` }],
          details: statusDetails(next),
          terminate: true,
        };
      }
      case "status": {
        const restoreDiagnostic = recoveryActions.diagnostic()
          ? `\n\n${recoveryActions.diagnostic()}；不会改写原记录或派发任务。`
          : "";
        const memory = deps.taskMemory?.read(ctx, params.evidenceIds);
        const memoryText = memory ? taskMemoryText(memory) : "";
        return {
          content: [{ type: "text", text: `${deps.report.formatWorkflowState()}${restoreDiagnostic}${memoryText ? "\n\n" + memoryText : ""}` }],
          details: {
            ...(state.workflowRestoreError
              ? { ...(state.workflowState ?? {}), error: state.workflowRestoreError, recovery: recoveryActions.status() }
              : state.workflowState
                ? statusDetails(state.workflowState)
                : statusDetails({})),
            ...(memory ? { taskMemory: memory } : {}),
          },
        };
      }
      case "replan": {
        if (!state.workflowState) throw missingWorkflowError();
        if (state.workflowState.currentTaskId) {
          const step = nextWorkflowAction(state);
          throw Object.assign(new Error("当前任务尚未结束，不能应用工作流重规划。" + step.nextAction), {
            code: "WORKFLOW_TASK_BOUNDARY_REQUIRED", details: { ok: false, code: "WORKFLOW_TASK_BOUNDARY_REQUIRED", ...step },
          });
        }
        if (deps.roleRuntime.activeRoleFor(ctx)?.role !== "architect") {
          throw new Error("只有架构角色可以应用工作流重规划；请先调用 switch_role(role=architect)");
        }
        if (state.workflowState.status !== "replanning") {
          throw new Error("当前没有等待应用的工作流重规划");
        }
        const config = await deps.roleRuntime.readSessionRoleConfig(ctx);
        const grouped = state.workflowState.pendingRevision?.kind === "goal";
        const plan = grouped ? validateWorkflowGoalPlan(state.workflowState, params) : normalizeReplanPlan(params);
        assertConfiguredTaskRoles(config, plan.tasks, deps.roleRuntime.currentRole("architect", ctx));
        requireIdentity(validateWorkflowReplanIdentity(state.workflowState, params, ctx));
        const next = grouped ? createWorkflowGoalState(state.workflowState, params) : applyWorkflowReplan(state.workflowState, {
          revisionId: params.revisionId, summary: params.summary, constraints: params.constraints, tasks: params.tasks,
          retainTaskIds: params.retainTaskIds, confirmUnknownOutcome: params.confirmUnknownOutcome === true, reason: params.reason,
        });
        deps.report.persistWorkflowState(next, ctx);
        state.workflowDispatchInFlight = false;
        return {
          content: [{ type: "text", text: `${grouped ? "目标已加入共享队列；原目标、已完成成果与待执行任务保留，无父子运行栈。" : "已应用工作流重规划。"}\n${deps.report.formatWorkflowState(next)}\n\n新计划将自动开始。` }],
          details: statusDetails(next),
          terminate: true,
        };
      }
      case "complete": {
        if (!state.workflowState) throw missingWorkflowError();
        guardQueuedTaskStart("complete", ctx);
        const identity = requireTaskHandoffIdentity(params, ctx);
        const { taskId } = identity;
        const task = taskId ? state.workflowState.tasks.find((item) => item.id === taskId) : undefined;
        if (!task) throw new Error(`工作流任务不存在：${taskId ?? "（未指定）"}`);
        requireTaskRole(task, ctx);
        const verificationEvidenceIds = params.evidenceIds === undefined ? undefined : deps.taskMemory?.verificationSources(ctx, params.evidenceIds);
        if (params.evidenceIds !== undefined && !verificationEvidenceIds) throw Object.assign(new Error("验证来源运行时不可用"), { code: "TASK_MEMORY_UNAVAILABLE" });
        markCurrentTaskStarted(ctx);
        const transition = transitionWorkflowLifecycle(state.workflowState, {
          type: "task-completed", verificationEvidenceIds, identity,
          completionSummary: params.completionSummary,
          implementationRationale: params.implementationRationale,
          verification: params.verification,
        }, Date.now());
        const next = transition.taskState;
        const completedTask = next.tasks.find((item) => item.id === task.id);
        const taskCompletionView = createWorkflowTaskCompletionView(completedTask);
        const workflowCompletionView = next.status === "completed"
          ? createWorkflowCompletionView(next, completedTask)
          : undefined;
        const activeNext = transition.state;
        const completionReport = workflowCompletionView
          ? formatWorkflowCompletionText(workflowCompletionView)
          : formatWorkflowTaskCompletionText(taskCompletionView);
        const continuation: "awaiting-replan" | "next-task" = activeNext.status === "replanning" ? "awaiting-replan" : "next-task";
        const notice = activeNext.status === "completed"
            ? "工作流已完成。"
            : activeNext.status === "replanning"
              ? "当前任务已完成，等待架构师重规划，不会启动旧的后续任务。"
              : "下一任务将自动开始。";
        const presentation = workflowCompletionView
          ? { kind: "workflow-completion" as const, view: workflowCompletionView }
          : { kind: "task-completion" as const, view: taskCompletionView, continuation };
        commitLifecycleTransition(transition, ctx);
        return {
          content: [{ type: "text", text: `${completionReport}\n\n${notice}` }],
          details: attachWorkflowPresentation(activeNext, presentation),
          terminate: activeNext.status !== "completed",
        };
      }
      case "block": {
        if (!state.workflowState) throw missingWorkflowError();
        guardQueuedTaskStart("block", ctx);
        const identity = requireTaskHandoffIdentity(params, ctx);
        const task = state.workflowState.tasks.find((item) => item.id === identity.taskId);
        if (!task) throw new Error(`工作流任务不存在：${identity.taskId}`);
        requireTaskRole(task, ctx);
        markCurrentTaskStarted(ctx);
        const transition = transitionWorkflowLifecycle(state.workflowState, { type: "task-blocked", identity, reason: params.reason, outcomeUnknown: params.outcomeUnknown }, Date.now());
        commitLifecycleTransition(transition, ctx);
        return { content: [{ type: "text", text: deps.report.formatWorkflowPauseSummary(transition.state) }], details: statusDetails(transition.state), terminate: true };
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
        const transition = transitionWorkflowLifecycle(state.workflowState, { type: "workflow-resumed", identity: workflowActionIdentity(state.workflowState) }, Date.now());
        const next = commitLifecycleTransition(transition, ctx);
        return { content: [{ type: "text", text: "工作流已恢复，下一任务将自动开始。" }], details: statusDetails(next), terminate: true };
      }
      case "retry": {
        if (!state.workflowState) throw missingWorkflowError();
        requireIdentity(validateWorkflowMutationIdentity(state.workflowState, params, ctx));
        const transition = transitionWorkflowLifecycle(state.workflowState, {
          type: "task-retried", identity: workflowActionIdentity(state.workflowState), taskId: params.taskId,
          confirmUnknownOutcome: params.confirmUnknownOutcome === true,
        }, Date.now());
        const next = commitLifecycleTransition(transition, ctx);
        return { content: [{ type: "text", text: `任务 ${params.taskId ?? ""} 已重新排队，工作流将自动继续。` }], details: statusDetails(next), terminate: true };
      }
      case "cancel":
      case "cancel-all": {
        if (!state.workflowState) throw missingWorkflowError();
        requireIdentity(validateWorkflowMutationIdentity(state.workflowState, params, ctx));
        const transition = transitionWorkflowLifecycle(state.workflowState, {
          type: "workflow-cancelled", identity: workflowActionIdentity(state.workflowState),
        }, Date.now());
        const cancelled = commitLifecycleTransition(transition, ctx);
        return { content: [{ type: "text", text: "工作流已取消。" }], details: statusDetails(cancelled), terminate: true };
      }
      default:
        throw new Error(`未知工作流动作：${params.action}`);
    }
  }

  return { workflowCommand, runTaskWorkflowAction, shouldOrchestrateConfiguredWorkflow };
}

export type WorkflowActions = ReturnType<typeof createWorkflowActions>;
type WorkflowActionParameters = Parameters<ToolDefinition<typeof taskWorkflowParameters>["execute"]>[1];
