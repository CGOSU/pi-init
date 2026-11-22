import { readWorkflowIdentityContext, workflowHandoffMessageOnBranch } from "./workflow-session-adapter.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWorkflowCommand } from "./workflow-command.ts";
import type { WorkflowActionDependencies, WorkflowActionParameters, WorkflowActionResult } from "./workflow-action-types.ts";
export type { WorkflowActionDependencies } from "./workflow-action-types.ts";
import type { WorkflowMode } from "../../src/role-types.ts";
import { resolveRoleModel, shouldOrchestrateWorkflow } from "../../src/roles.ts";
import { workflowHandoffIdentity, workflowHandoffNotExecutingFailure } from "../../src/workflow-handoff.ts";
import { assertSupportedWorkflowFeatures } from "../../src/workflow-validation.ts";
import { normalizeReplanPlan } from "../../src/workflow-replan.ts";
import type { WorkflowLifecycleTransition } from "../../src/workflow-orchestrator.ts";
import { transitionWorkflowLifecycle } from "../../src/workflow-orchestrator.ts";
import type { WorkflowHandoffIdentity, WorkflowResult, WorkflowTask } from "../../src/workflow-types.ts";
import {
    applyWorkflowReplan,
    createWorkflowGoalState,
    createWorkflowState,
    requestWorkflowGoal,
    requestWorkflowReplan,
    validateWorkflowGoalPlan,
    validateWorkflowHandoffIdentity,
    validateWorkflowMutationIdentity,
    validateWorkflowPlan,
    validateWorkflowReplanIdentity,
    workflowActionIdentity
} from "../../src/workflow.ts";
import type { RoleRuntime } from "../role/role-runtime.ts";
import type { RuntimeStateAccess } from "../runtime-state.ts";
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
import { attachWorkflowPresentation } from "./workflow-presentation.ts";
import { createWorkflowRecoveryActions } from "./workflow-recovery-actions.ts";
import { createCurrentWorkflowStatusView } from "./workflow-status-view.ts";
import { workflowStatusToolSummary } from "./workflow-status-tool-text.ts";
import { transferFrozen } from "../../src/session-handoff.ts";
import { outgoingTransfer } from "../session/session-handoff-runtime.ts";
import { resetDispatchLock } from "./dispatch-lock.ts";

export function createWorkflowActions(
  state: RuntimeStateAccess<"workflowDispatchInFlight" | "workflowDispatchLease" | "workflowModeStatus" | "workflowRestoreError">,
  deps: WorkflowActionDependencies,
) {
  const recoveryActions = createWorkflowRecoveryActions(state, { report: deps.report, store: deps.store });
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
    const persisted = deps.store.persistWorkflowState(transition.state, ctx);
    resetDispatchLock(state);
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

  function shouldOrchestrateConfiguredWorkflow(mode: WorkflowMode, taskCount: number, orchestration?: unknown) {
    if (typeof shouldOrchestrateWorkflow !== "function") {
      throw new Error(
        "检测到 pi-init 运行时版本不一致：扩展与 src/roles.ts 不是同一版本，缺少 shouldOrchestrateWorkflow。请先执行 pi update --extensions，然后在 Pi 中执行 /reload；本地开发请重启 Pi，并确保使用同一份扩展和 src/roles.ts。",
      );
    }
    return shouldOrchestrateWorkflow({ mode, taskCount, orchestration });
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
    return requireIdentity(validateWorkflowHandoffIdentity(state.workflowState, params, readWorkflowIdentityContext(ctx)));
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

  function requireActiveWorkflow() {
    if (!state.workflowState) throw missingWorkflowError();
    return state.workflowState;
  }

  function requireExecutingTask(action: "complete" | "block", params: unknown, ctx: ExtensionContext) {
    const workflow = requireActiveWorkflow();
    guardQueuedTaskStart(action, ctx);
    const identity = requireTaskHandoffIdentity(params, ctx);
    const task = workflow.tasks.find((item) => item.id === identity.taskId);
    if (!task) throw new Error(`工作流任务不存在：${identity.taskId ?? "（未指定）"}`);
    requireTaskRole(task, ctx);
    return { workflow, identity, task };
  }

  const workflowCommand = createWorkflowCommand(state, { ...deps, recoveryActions, commitLifecycleTransition });

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
        return { content: [{ type: "text", text: "任务记忆已保存；任务仍在执行，未暂停、完成或重新派发。checkpoint不建立可换会话边界；若用户明确要求交接，由当前执行角色对未完成任务如实block并保留未知结果。工具与回合结束后再由用户执行 /pi-init fresh 核验其余安全条件。\n" + taskMemoryText(memory) }], details: { taskMemory: memory, checkpointSaved: true } };
      }
      case "request-replan":
      case "request-goal": {
        const workflow = requireActiveWorkflow();
        requireIdentity(validateWorkflowMutationIdentity(workflow, params, readWorkflowIdentityContext(ctx)));
        const actor = deps.roleRuntime.activeRoleFor(ctx)?.role;
        const currentTask = workflow.tasks.find(task => task.id === workflow.currentTaskId);
        const executorRequest = params.action === "request-replan" && workflow.status === "running"
          && workflow.handoff?.phase === "executing" && currentTask?.role === actor;
        if (actor !== "architect" && !executorRequest) {
          const step = nextWorkflowAction(state);
          const code = workflow.currentTaskId ? "WORKFLOW_TASK_BOUNDARY_REQUIRED" : "WORKFLOW_ARCHITECT_REQUIRED";
          throw Object.assign(new Error("只有 architect 可以安排目标归属或修正计划；所有执行任务共用同一队列。" + step.nextAction), {
            code, details: { ok: false, code, ...step },
          });
        }
        const grouped = params.action === "request-goal";
        const next = grouped
          ? requestWorkflowGoal(workflow, { direction: params.summary, parentGoalId: params.parentGoalId })
          : requestWorkflowReplan(workflow, { direction: params.summary });
        deps.store.persistWorkflowState(next, ctx);
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
        if (!shouldOrchestrateConfiguredWorkflow(config.workflowMode, plan.tasks.length, params.orchestration)) {
          return {
            content: [{
              type: "text",
              text: `当前工作流策略为 auto，规划包含 ${plan.tasks.length} 个任务（不超过 2 个）且未声明 orchestration=required，已跳过工作流编排，未创建活动工作流；请按各任务指定的角色顺序执行，架构角色不直接实现。此路径不能使用工作流 checkpoint/complete/block；确需持久检查点或恢复时，可由 architect 重新提交 plan 并声明 orchestration=required，不必增加无意义任务或重做调查。`,
            }],
            details: { workflowMode: config.workflowMode, taskCount: plan.tasks.length, orchestrated: false },
          };
        }

        const next = createWorkflowState({
          ...plan,
          executor: "local",
          sessionId: ctx.sessionManager.getSessionId(),
        });
        deps.store.persistWorkflowState(next, ctx);

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
        const full = params.detail === "full";
        const memoryText = memory && (full || params.evidenceIds?.length) ? taskMemoryText(memory) : "";
        const statusText = full ? deps.report.formatWorkflowState() : workflowStatusToolSummary(state, memory);
        return {
          content: [{ type: "text", text: `${statusText}${restoreDiagnostic}${memoryText ? "\n\n" + memoryText : ""}` }],
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
        const workflow = requireActiveWorkflow();
        if (workflow.currentTaskId) {
          const step = nextWorkflowAction(state);
          throw Object.assign(new Error("当前任务尚未结束，不能应用工作流重规划。" + step.nextAction), {
            code: "WORKFLOW_TASK_BOUNDARY_REQUIRED", details: { ok: false, code: "WORKFLOW_TASK_BOUNDARY_REQUIRED", ...step },
          });
        }
        if (deps.roleRuntime.activeRoleFor(ctx)?.role !== "architect") {
          throw new Error("只有架构角色可以应用工作流重规划；请先调用 switch_role(role=architect)");
        }
        if (workflow.status !== "replanning") {
          throw new Error("当前没有等待应用的工作流重规划");
        }
        const config = await deps.roleRuntime.readSessionRoleConfig(ctx);
        const grouped = workflow.pendingRevision?.kind === "goal";
        const plan = grouped ? validateWorkflowGoalPlan(workflow, params) : normalizeReplanPlan(params);
        assertConfiguredTaskRoles(config, plan.tasks, deps.roleRuntime.currentRole("architect", ctx));
        requireIdentity(validateWorkflowReplanIdentity(workflow, params, readWorkflowIdentityContext(ctx)));
        const next = grouped ? createWorkflowGoalState(workflow, params) : applyWorkflowReplan(workflow, {
          revisionId: params.revisionId, summary: params.summary, constraints: params.constraints, tasks: params.tasks,
          retainTaskIds: params.retainTaskIds, confirmUnknownOutcome: params.confirmUnknownOutcome === true, reason: params.reason,
        });
        deps.store.persistWorkflowState(next, ctx);
        resetDispatchLock(state);
        const nextStep = next.pauseReason === "architecture-review"
          ? nextWorkflowAction({ ...state, workflowState: next }).nextAction
          : "新计划将自动开始。";
        return {
          content: [{ type: "text", text: `${grouped ? "目标已加入共享队列；原目标、已完成成果与待执行任务保留，无父子运行栈。" : "已应用工作流重规划。"}\n${deps.report.formatWorkflowState(next)}\n\n${nextStep}` }],
          details: statusDetails(next),
          terminate: true,
        };
      }
      case "complete": {
        const { workflow, identity, task } = requireExecutingTask("complete", params, ctx);
        const verificationEvidenceIds = params.evidenceIds === undefined ? undefined : deps.taskMemory?.verificationSources(ctx, params.evidenceIds);
        if (params.evidenceIds !== undefined && !verificationEvidenceIds) throw Object.assign(new Error("验证来源运行时不可用"), { code: "TASK_MEMORY_UNAVAILABLE" });
        const transition = transitionWorkflowLifecycle(workflow, {
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
        const { workflow, identity } = requireExecutingTask("block", params, ctx);
        const transition = transitionWorkflowLifecycle(workflow, { type: "task-blocked", identity, reason: params.reason, outcomeUnknown: params.outcomeUnknown }, Date.now());
        commitLifecycleTransition(transition, ctx);
        return { content: [{ type: "text", text: deps.report.formatWorkflowPauseSummary(transition.state) }], details: statusDetails(transition.state), terminate: true };
      }
      case "resume": {
        const workflow = requireActiveWorkflow();
        requireIdentity(validateWorkflowMutationIdentity(workflow, params, readWorkflowIdentityContext(ctx)));
        if (workflow.status === "replanning") {
          await deps.dispatch.scheduleWorkflow(ctx);
          return {
            content: [{ type: "text", text: "工作流仍在等待架构师重规划；已尝试继续架构调度。" }],
            details: statusDetails(workflow),
            terminate: true,
          };
        }
        if (workflow.status === "running") {
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
            details: statusDetails(workflow),
            terminate: true,
          };
        }
        const transition = transitionWorkflowLifecycle(workflow, { type: "workflow-resumed", identity: workflowActionIdentity(workflow) }, Date.now());
        const next = commitLifecycleTransition(transition, ctx);
        return { content: [{ type: "text", text: "工作流已恢复，下一任务将自动开始。" }], details: statusDetails(next), terminate: true };
      }
      case "retry": {
        const workflow = requireActiveWorkflow();
        requireIdentity(validateWorkflowMutationIdentity(workflow, params, readWorkflowIdentityContext(ctx)));
        const transition = transitionWorkflowLifecycle(workflow, {
          type: "task-retried", identity: workflowActionIdentity(workflow), taskId: params.taskId,
          confirmUnknownOutcome: params.confirmUnknownOutcome === true,
        }, Date.now());
        const next = commitLifecycleTransition(transition, ctx);
        return { content: [{ type: "text", text: `任务 ${params.taskId ?? ""} 已重新排队，工作流将自动继续。` }], details: statusDetails(next), terminate: true };
      }
      case "cancel":
      case "cancel-all": {
        const workflow = requireActiveWorkflow();
        requireIdentity(validateWorkflowMutationIdentity(workflow, params, readWorkflowIdentityContext(ctx)));
        const transition = transitionWorkflowLifecycle(workflow, {
          type: "workflow-cancelled", identity: workflowActionIdentity(workflow),
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
