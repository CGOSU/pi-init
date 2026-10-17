import type { ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { } from "typebox";
import {
  applyWorkflowReplan,
  createNestedWorkflowState,
  createWorkflowState,
  validateWorkflowHandoffIdentity,
  validateWorkflowMutationIdentity,
  validateWorkflowReplanIdentity,
  validateWorkflowPlan,
  workflowActionIdentity,
  requestWorkflowTaskClarification, requestWorkflowReplan, requestWorkflowGoal, createWorkflowGoalState, validateWorkflowGoalPlan, normalizeReplanPlan } from "../src/workflow.ts";
import { resolveRoleModel, shouldOrchestrateWorkflow } from "../src/roles.ts";
import { createWorkflowRecoveryActions } from "./workflow-recovery-actions.ts";
import type { WorkflowMode } from "../src/role-types.ts";
import type { WorkflowHandoffIdentity, WorkflowResult, WorkflowTask } from "../src/workflow-types.ts";
import type { AcceptedEvidenceReference } from "../src/coordination-types.ts";
import { checkWorkflowTaskContractReadiness } from "../src/workflow-task-contract.ts";
import { parseWorkflowTaskClarificationInput } from "../src/workflow-clarification.ts";
import { textOf, type ExtensionRuntimeState, type WorkflowActionIdentity } from "./runtime-state.ts";
import type { RoleRuntime } from "./role-runtime.ts";
import type { WorkflowDispatch } from "./workflow-dispatch.ts";
import type { WorkflowReport } from "./workflow-report.ts";
import type { CoordinationRuntime } from "./coordination-runtime.ts";
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
import { workflowHandoffMessageOnBranch, workflowHandoffNotExecutingFailure, workflowHandoffIdentity } from "../src/workflow-handoff.ts";
import { transitionWorkflowLifecycle } from "../src/workflow-orchestrator.ts";
import type { WorkflowLifecycleTransition } from "../src/workflow-orchestrator.ts";
import { assertSubworkflowTaskScope } from "../src/workflow-subworkflow.ts";
import { runWorkflowPanelRequest } from "./workflow-panel-actions.ts";

export type WorkflowActionDependencies = {
  roleRuntime: RoleRuntime;
  dispatch: WorkflowDispatch;
  report: WorkflowReport;
  coordination: CoordinationRuntime;
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
    return attachWorkflowPresentation(details, {
      kind: "workflow-status",
      view: createCurrentWorkflowStatusView(state, workflowState),
    });
  }

  function commitLifecycleTransition(transition: WorkflowLifecycleTransition, ctx: ExtensionContext) {
    const persisted = deps.report.persistWorkflowState(transition.state, ctx);
    for (const effect of transition.effects) {
      deps.roleRuntime.retireWorkflowContinuation(effect.identity);
    }
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

  function requireTaskContractsReady(
    tasks: WorkflowTask[],
    acceptedEvidence: AcceptedEvidenceReference[],
    coordinated: boolean,
  ) {
    // 任务契约与协调状态是双向门控：契约错误必须带上 taskId、前置条件和下一步指引，
    // 且不得建议通过改环境权限或删除契约绕过。
    const contractError = (code: string, taskId: string, message: string, extra: Record<string, unknown>) => {
      const details = { ok: false, code, message, taskId, ...extra };
      return Object.assign(new Error(`[PI-INIT_TASK_CONTRACT_ERROR] ${JSON.stringify(details)}`), { code, details });
    };
    for (const task of tasks) {
      if (coordinated && !task.contract) {
        throw contractError(
          "TASK_CONTRACT_REQUIRED",
          task.id,
          `协调任务 ${task.id} 缺少结构化任务契约`,
          {
            precondition: "协调计划中每个可执行任务必须携带版本 1 的结构化任务契约，且契约 evidence 必须指向当前已接受且未过期的协调证据",
            nextAction: `由 architect 为任务 ${task.id} 补全契约（outcome、requirementSources、expectedBehavior、evidence、clarificationResolutions、fixedDecisions、invariants、nonGoals、blockingQuestions、engineeringDiscretion、verification），再使用当前身份重新提交 plan/replan；不得通过调整权限或接受门设置规避契约要求。`,
          },
        );
      }
      if (!coordinated && task.contract) {
        throw contractError(
          "TASK_CONTRACT_REQUIRES_COORDINATION",
          task.id,
          `任务 ${task.id} 携带契约但当前没有关联的协调证据状态`,
          {
            precondition: "任务契约必须与当前 workflow revision 已接受且未过期的协调证据同时存在",
            nextAction: `先完成与该 workflow revision 绑定的取证链路（request-evidence → report-evidence → review-evidence 接受），再由 architect 使用当前身份重新提交携带契约的 plan/replan；不得通过调整权限、改写契约证据或绕过接受门来规避该前置条件。`,
          },
        );
      }
      if (!task.contract) continue;
      if (coordinated && task.contract.requirementSources.length === 0) {
        throw contractError(
          "TASK_CONTRACT_REQUIREMENT_SOURCE_MISSING",
          task.id,
          `协调任务 ${task.id} 必须显式列出需求来源`,
          {
            precondition: "协调任务的 requirementSources 必须至少列出一条已确认的需求来源",
            nextAction: `由 architect 为任务 ${task.id} 补充 requirementSources 后重新提交 plan/replan。`,
          },
        );
      }
      const readiness = checkWorkflowTaskContractReadiness(task.contract, acceptedEvidence);
      if (!readiness.ok) {
        throw contractError(readiness.code, task.id, readiness.message, {
          ...(readiness.field ? { field: readiness.field } : {}),
          precondition: "契约引用必须指向当前已接受且未过期的证据，且不得包含关键未决问题",
          nextAction: `先按诊断修正任务 ${task.id} 的契约证据引用或未决问题，由 architect 使用当前身份重新提交 plan/replan。`,
        });
      }
    }
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

  function guardQueuedTaskStart(action: "complete" | "block" | "clarify", ctx: ExtensionContext) {
    const current = state.workflowState;
    const phase = current?.handoff?.phase;
    if (!current || phase !== "queued") return;
    const task = current.currentTaskId
      ? current.tasks.find((item) => item.id === current.currentTaskId)
      : undefined;
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
      if (request) await runWorkflowPanelRequest(request, ctx, state, (nextAction, nextTaskId, confirmed) => workflowCommand(nextAction, nextTaskId, ctx, confirmed));
      const diagnostic = recoveryActions.diagnostic();
      if (diagnostic) ctx.ui.notify(diagnostic, "error");
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
        if (deps.coordination.isLinkedToWorkflow(state.workflowState)) deps.coordination.linkWorkflow(transition.state, ctx);
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
        const transition = transitionWorkflowLifecycle(state.workflowState, { type: "workflow-cancelled", identity: workflowActionIdentity(state.workflowState), returnToParent: action !== "cancel-all" }, Date.now());
        if (transition.returnedToParent && deps.coordination.isLinkedToWorkflow(state.workflowState)) deps.coordination.linkWorkflow(transition.state, ctx);
        commitLifecycleTransition(transition, ctx);
        ctx.ui.notify(transition.returnedToParent ? "当前子流程已取消；父流程等待结果处置，副作用未自动回滚。" : "工作流已取消；副作用未自动回滚。", "info");
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
    if (params.action !== "status" && state.coordinationRestoreError) {
      throw Object.assign(new Error(`无法恢复协作状态（${state.coordinationRestoreError.code}）：${state.coordinationRestoreError.message}`), {
        code: state.coordinationRestoreError.code,
        details: { ok: false, ...state.coordinationRestoreError },
      });
    }

    switch (params.action) {
      case "request-replan":
      case "request-child":
      case "request-goal": {
        if (!state.workflowState) throw missingWorkflowError();
        requireIdentity(validateWorkflowMutationIdentity(state.workflowState, params, ctx));
        if (deps.roleRuntime.activeRoleFor(ctx)?.role !== "architect") throw new Error("只有 architect 可以安排目标归属或修正计划；所有执行任务共用同一队列");
        const grouped = params.action === "request-child" || params.action === "request-goal";
        const next = grouped
          ? requestWorkflowGoal(state.workflowState, { direction: params.summary, parentGoalId: params.parentGoalId })
          : requestWorkflowReplan(state.workflowState, { direction: params.summary });
        if (deps.coordination.isLinkedToWorkflow(state.workflowState)) deps.coordination.linkWorkflow(next, ctx);
        deps.report.persistWorkflowState(next, ctx);
        return { content: [{ type: "text", text: grouped ? "已记录插入目标；在安全边界规划同一任务队列，父子关系仅表达归属，不创建子工作流。" : "已记录父计划修正/追加请求；保留有效任务，在安全边界重规划当前队列。" }], details: statusDetails(next), terminate: true };
      }
      case "review-child": {
        if (!state.workflowState) throw missingWorkflowError();
        const identity = requireIdentity(validateWorkflowReplanIdentity(state.workflowState, params, ctx));
        if (deps.roleRuntime.activeRoleFor(ctx)?.role !== "architect") throw new Error("只有 architect 可以审阅子流程结果与父计划影响；实际查证应通过证据请求完成");
        const transition = transitionWorkflowLifecycle(state.workflowState, { type: "child-reviewed", identity, review: params.childReview }, Date.now());
        if (deps.coordination.isLinkedToWorkflow(state.workflowState)) deps.coordination.linkWorkflow(transition.state, ctx);
        commitLifecycleTransition(transition, ctx);
        const decision = params.childReview?.decision;
        return { content: [{ type: "text", text: decision === "continue" ? "子流程输出已验收，父计划仍有效；可继续原队列。" : decision === "replan" ? "已记录父计划影响；请使用当前重规划身份提交更新后的父计划。" : "子流程结果已阻塞，父任务不会启动；核实后执行 /pi-init workflow resume 重开架构审阅。" }], details: statusDetails(transition.state), terminate: decision !== "replan" };
      }
      case "request-evidence": {
        const result = deps.coordination.requestEvidence(params.request, params.coordinationIdentity, params.coordinationHandoffId, ctx);
        return {
          content: [{ type: "text", text: `已持久化取证请求 ${result.request.requestId}（${result.request.questionId}）；将自动派发 docs-commit。` }],
          details: { coordination: deps.coordination.status(), request: result.request },
          terminate: true,
        };
      }
      case "report-evidence": {
        const result = deps.coordination.reportEvidence(params.report, params.coordinationIdentity, params.coordinationHandoffId, ctx);
        return {
          content: [{ type: "text", text: `已持久化取证报告 ${result.report.reportId}；将自动返还 architect 审阅。` }],
          details: { coordination: deps.coordination.status(), report: result.report },
          terminate: true,
        };
      }
      case "review-evidence": {
        const result = deps.coordination.reviewEvidence(params.review, params.coordinationIdentity, params.coordinationHandoffId, ctx);
        const decision = result.review?.decision;
        return {
          content: [{ type: "text", text: decision === "accept"
            ? "证据审阅已接受；关键证据就绪，可由 architect 规划开发任务。"
            : decision === "more"
              ? "已记录补查缺口；architect 必须使用当前 handoff 身份（coordinationHandoffId 或完整 coordinationIdentity）创建明确回应缺口的新 request-evidence，期间不会派发开发任务。"
              : "已记录证据阻塞决定；不会派发开发任务。" }],
          details: { coordination: deps.coordination.status(), review: result.review },
          terminate: decision === "block",
        };
      }
      case "clarify": {
        if (!state.workflowState) throw missingWorkflowError();
        guardQueuedTaskStart("clarify", ctx);
        const identity = requireTaskHandoffIdentity(params, ctx);
        markCurrentTaskStarted(ctx);
        const task = state.workflowState.tasks.find((item) => item.id === identity.taskId);
        if (!task) throw Object.assign(new Error(`澄清任务不存在：${identity.taskId}`), { code: "WORKFLOW_CLARIFICATION_TASK_MISSING" });
        if (task.role !== "developer-test" || deps.roleRuntime.activeRoleFor(ctx)?.role !== "developer-test") {
          throw Object.assign(new Error("clarify 只能由当前 developer-test 执行任务提交"), { code: "WORKFLOW_CLARIFICATION_ROLE_FORBIDDEN" });
        }
        const parsed = parseWorkflowTaskClarificationInput(params.clarification);
        if (!parsed.ok) {
          throw Object.assign(new Error(parsed.message), { code: parsed.code, details: parsed });
        }
        if (!task.contract) {
          throw Object.assign(new Error("普通非协调任务没有澄清契约；使用既有 block 流程，不得伪造协调状态"), {
            code: "WORKFLOW_CLARIFICATION_CONTRACT_MISSING",
          });
        }
        if (!deps.coordination.isLinkedToWorkflow(state.workflowState)) {
          throw Object.assign(new Error("协调账本未绑定当前 workflow revision；澄清不会推进或派发"), {
            code: "COORDINATION_WORKFLOW_LINK_MISMATCH",
          });
        }
        const next = requireIdentity(requestWorkflowTaskClarification(state.workflowState, parsed.value));
        try {
          deps.coordination.linkWorkflow(next, ctx);
          deps.report.persistWorkflowState(next, ctx);
        } catch (error) {
          const message = textOf(error);
          state.workflowRestoreError ??= { code: "WORKFLOW_CLARIFICATION_PERSIST_FAILED", message };
          state.workflowDispatchInFlight = false;
          ctx.ui.notify(`澄清状态持久化失败（${message}）；当前执行将停止，恢复前不会派发或重放。`, "error");
          return {
            content: [{ type: "text", text: `无法持久化澄清；当前执行将停止，且不会自动重放副作用：${message}` }],
            details: { ok: false, code: "WORKFLOW_CLARIFICATION_PERSIST_FAILED", message },
            terminate: true,
          };
        }
        state.workflowDispatchInFlight = false;
        return {
          content: [{ type: "text", text: `已保存澄清 ${next.tasks.find((item) => item.id === identity.taskId)?.clarification?.issueId}；任务未标记完成，当前 revision 已交回 architect。不得继续按未决规则实现或重放副作用。` }],
          details: statusDetails(next),
          terminate: true,
        };
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
        const coordinatedPlan = deps.coordination.isRelevantForNewWorkflowPlan();
        const acceptedEvidence: AcceptedEvidenceReference[] = coordinatedPlan ? deps.coordination.assertReadyForWorkflow() : [];
        requireTaskContractsReady(plan.tasks, acceptedEvidence, coordinatedPlan);
        if (config.workflowMode === "off") {
          throw new Error(
            "task_workflow 当前策略为 off；请先执行 /pi-init config workflow 选择 on 或 auto，或在 .pi/role-models.json 中将 workflowMode 设为 on/auto",
          );
        }
        if (!coordinatedPlan && !shouldOrchestrateConfiguredWorkflow(config.workflowMode, plan.tasks.length)) {
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
        if (coordinatedPlan) deps.coordination.linkWorkflow(next, ctx);
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
        const restoreDiagnostic = recoveryActions.diagnostic()
          ? `\n\n${recoveryActions.diagnostic()}；不会改写原记录或派发任务。`
          : "";
        const coordinationStatus = deps.coordination.status();
        const coordinationText = coordinationStatus ? `\n\n${deps.coordination.summary()}` : "";
        return {
          content: [{ type: "text", text: `${deps.report.formatWorkflowState()}${restoreDiagnostic}${coordinationText}` }],
          details: {
            ...(state.workflowRestoreError
              ? { ...(state.workflowState ?? {}), error: state.workflowRestoreError, recovery: recoveryActions.status() }
              : state.workflowState
                ? statusDetails(state.workflowState)
                : statusDetails({})),
            ...(coordinationStatus ? { coordination: coordinationStatus } : {}),
          },
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
        const grouped = state.workflowState.pendingRevision?.kind === "goal";
        const plan = grouped ? validateWorkflowGoalPlan(state.workflowState, params) : state.workflowState.pendingRevision?.kind !== "nested" ? normalizeReplanPlan(params) : validateWorkflowPlan({
          summary: params.summary,
          constraints: params.constraints,
          tasks: params.tasks,
        });
        assertConfiguredTaskRoles(config, plan.tasks, deps.roleRuntime.currentRole("architect", ctx));
        requireIdentity(validateWorkflowReplanIdentity(state.workflowState, params, ctx));
        const coordinatedPlan = deps.coordination.isLinkedToWorkflow(state.workflowState);
        const acceptedEvidence: AcceptedEvidenceReference[] = coordinatedPlan ? deps.coordination.assertReadyForWorkflow() : [];
        const nested = state.workflowState.pendingRevision?.kind === "nested";
        if (state.workflowState.pauseReason === "child-result-review") {
          const child = state.workflowState.subworkflowHistory?.findLast((entry) => entry.parentWorkflowId === state.workflowState!.workflowId);
          if (child?.reviews?.at(-1)?.decision !== "replan") throw new Error("必须先 review-child 审阅子流程输出并明确 replan，不能跳过结果验收直接改写父计划");
        }
        const next = grouped ? createWorkflowGoalState(state.workflowState, params) : nested
          ? createNestedWorkflowState(state.workflowState, { ...plan, subworkflowContract: params.subworkflowContract })
          : applyWorkflowReplan(state.workflowState, {
              revisionId: params.revisionId,
              summary: params.summary,
              constraints: params.constraints,
              tasks: params.tasks,
              retainTaskIds: params.retainTaskIds,
              confirmUnknownOutcome: params.confirmUnknownOutcome === true,
              reason: params.reason,
            });
        if (next.subworkflowContract) assertSubworkflowTaskScope(next.subworkflowContract, next.tasks.filter((task) => task.status !== "completed" && task.status !== "superseded"));
        requireTaskContractsReady(
          next.tasks.filter((task) => task.status !== "completed" && task.status !== "superseded"),
          acceptedEvidence,
          coordinatedPlan,
        );
        if (coordinatedPlan) deps.coordination.linkWorkflow(next, ctx);
        deps.report.persistWorkflowState(next, ctx);
        state.workflowDispatchInFlight = false;
        return {
          content: [{ type: "text", text: `${grouped ? "目标已加入共享队列；原目标、已完成成果与待执行任务保留，无父子运行栈。" : nested ? "已按历史请求创建兼容子工作流，原记录保留。" : "已应用工作流重规划。"}\n${deps.report.formatWorkflowState(next)}\n\n新计划将自动开始。` }],
          details: statusDetails(next),
          terminate: true,
        };
      }
      case "complete": {
        if (!state.workflowState) throw missingWorkflowError();
        guardQueuedTaskStart("complete", ctx);
        const identity = requireTaskHandoffIdentity(params, ctx);
        markCurrentTaskStarted(ctx);
        const { taskId } = identity;
        const task = taskId ? state.workflowState.tasks.find((item) => item.id === taskId) : undefined;
        if (!task) throw new Error(`工作流任务不存在：${taskId ?? "（未指定）"}`);
        if (deps.roleRuntime.activeRoleFor(ctx)?.role !== task.role) {
          throw new Error(`任务 ${task.id} 要求角色 ${task.role}，当前角色不匹配；请先调用 switch_role`);
        }
        const transition = transitionWorkflowLifecycle(state.workflowState, {
          type: "task-completed", identity,
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
        const completedNested = transition.returnedToParent;
        const activeNext = transition.state;
        if (completedNested && deps.coordination.isLinkedToWorkflow(state.workflowState)) {
          deps.coordination.linkWorkflow(activeNext, ctx);
        }
        const completionReport = workflowCompletionView
          ? formatWorkflowCompletionText(workflowCompletionView)
          : formatWorkflowTaskCompletionText(taskCompletionView);
        const continuation: "awaiting-replan" | "next-task" = activeNext.status === "replanning" ? "awaiting-replan" : "next-task";
        const notice = completedNested
          ? "子流程已完成，已返回父流程等待输出验收与父计划影响审阅；未验收前不会启动父任务。"
          : activeNext.status === "completed"
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
          terminate: true,
        };
      }
      case "block": {
        if (!state.workflowState) throw missingWorkflowError();
        guardQueuedTaskStart("block", ctx);
        const identity = requireTaskHandoffIdentity(params, ctx);
        markCurrentTaskStarted(ctx);
        const transition = transitionWorkflowLifecycle(state.workflowState, { type: "task-blocked", identity, reason: params.reason }, Date.now());
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
        if (deps.coordination.isLinkedToWorkflow(state.workflowState)) deps.coordination.linkWorkflow(transition.state, ctx);
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
          type: "workflow-cancelled", identity: workflowActionIdentity(state.workflowState), returnToParent: params.action !== "cancel-all",
        }, Date.now());
        if (transition.returnedToParent && deps.coordination.isLinkedToWorkflow(state.workflowState)) {
          deps.coordination.linkWorkflow(transition.state, ctx);
        }
        const cancelled = commitLifecycleTransition(transition, ctx);
        if (transition.returnedToParent) {
          return {
            content: [{ type: "text", text: `子流程已取消，已返回父流程等待处置；取消不代表依赖已满足或副作用已回滚。\n${deps.report.formatWorkflowState(cancelled)}` }],
            details: statusDetails(cancelled),
            terminate: true,
          };
        }
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
