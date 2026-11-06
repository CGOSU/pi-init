import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { WORKFLOW_RECOMMENDED_TASKS } from "../src/workflow.ts";
import { ARCHITECT_ALLOWED_ACTIONS_TEXT } from "./architect-boundary.ts";
import { taskWorkflowParameters } from "./contracts.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import type { createWorkflowActions } from "./workflow-actions.ts";
import type { createRoleRecovery } from "./role-recovery.ts";
import type { createWorkflowToolBinding } from "./workflow-tool-binding.ts";
import type { createWorkflowUserControl } from "./workflow-user-control.ts";
import type { createWorkflowStatusPollingGuard, createRepeatedRejectionGuard } from "./workflow-status-polling.ts";
import type { createWorkflowDelivery } from "./workflow-delivery.ts";
import { fingerprint } from "./handoff-tool-diagnostics.ts";
import { renderWorkflowPauseResult } from "./workflow-pause-renderer.ts";
import { createWorkflowPauseView } from "./workflow-pause-view.ts";
import { renderWorkflowOperationFailure, renderWorkflowPresentation } from "./workflow-result-renderer.ts";
import { workflowPresentationFromDetails } from "./workflow-presentation.ts";
import { createWorkflowStatusView } from "./workflow-status-view.ts";
import { formatWorkflowStatusText } from "./workflow-status-renderer.ts";

export function registerWorkflowTool(pi: ExtensionAPI, runtimeState: ExtensionRuntimeState, dependencies: {
  workflowActions: Pick<ReturnType<typeof createWorkflowActions>, "runTaskWorkflowAction">;
  roleRecovery: Pick<ReturnType<typeof createRoleRecovery>, "guardToolCall">;
  workflowBinding: Pick<ReturnType<typeof createWorkflowToolBinding>, "bind">;
  userControl: Pick<ReturnType<typeof createWorkflowUserControl>, "guardToolCall" | "suspend">;
  observeStatusPolling: ReturnType<typeof createWorkflowStatusPollingGuard>["observe"];
  observeRejection: ReturnType<typeof createRepeatedRejectionGuard>["observe"];
  prepareDelivery: ReturnType<typeof createWorkflowDelivery>["prepare"];
}) {
  const { workflowActions, roleRecovery, workflowBinding, userControl, observeStatusPolling, observeRejection, prepareDelivery } = dependencies;
  pi.registerTool<typeof taskWorkflowParameters>({
    name: "task_workflow",
    label: "Task Workflow",
    description:
      `Manage an architecture-led sequential task workflow with a recommended size of ${WORKFLOW_RECOMMENDED_TASKS} tasks (a soft planning guideline, not a limit). The Architect only thinks, analyzes, decides, plans, and arranges responsibilities; executable tasks must use non-architect roles and the runtime rejects architect as a task role. Tasks complete one at a time, and the next task starts automatically after verified completion. Pause for an explicit user request (including session handoff), an explicit architecture review, or a real blocker.`,
    promptSnippet: "Create and advance an architecture-led sequential implementation task workflow",
    promptGuidelines: [
      "Use task_workflow action=plan only for explicit planning, cross-module/high-risk work, or a plan that cannot be safely handled locally. Route clear instructions directly to the matching role; unclear, ambiguous, or cross-responsibility instructions start with architect. Before action=plan or action=replan, the active role must be architect; otherwise call switch_role(role=architect) first and never emit planning calls from developer-test or docs-commit.",
      "Never assign architect as an executable task role; planning validation rejects it, retained architect tasks cannot be applied by replan, and old active plans with architect execution tasks are not recovered or dispatched.",
      "Architect 只规划与决策，不读取、执行或连接 MCP。优先复用已有调查；缺少决策关键事实时才交给 docs-commit 集中补查，不因切角重读规则或重复调查。普通任务无需正式取证协议。",
      "本轮工具调用的工作流与协调身份由运行时绑定，通常只提交业务参数和真实结果，无需手填 workflow/session/attempt/handoff 等身份。兼容显式身份仍严格校验；不能套用最新状态提交旧回合结果。",
      "status默认返回可行动摘要。缺少checkpoint的有效来源ID时按需一次status(detail=full)，从任务记忆正文取observations[].id及revision；已知有效来源和当前revision直接复用，已有ID的原文用status(evidenceIds)定向读取，不重复查询无变化状态。checkpoint按需保存，不是complete、block或交接的新增前置条件。",
      "用户明确要求准备会话交接时，checkpoint只保存进展，不暂停活动任务。由当前执行角色按需保留进展，再对未完成任务如实block并保留未知结果；不伪造complete，不仅因保存checkpoint自动block。已task-blocked无需为交接retry；reload后先确认原执行职责，职责确认不解除业务暂停。工具与回合结束后由用户执行/pi-init fresh预览并核验其余安全条件，不提前声称可交接。",
      `Architect 在 task_workflow 上只允许 ${ARCHITECT_ALLOWED_ACTIONS_TEXT}；实现、验证与结果提交必须由当前执行角色负责。`,
      "每项任务围绕一个可独立验收的交付物，使用task/constraints/files/acceptanceCriteria说明目标、非目标、产物和风险匹配的验证；不要按读取→修改→测试机械拆分。必要事实先调查，远期不确定内容在边界细化；缺少关键事实或权限时block，不建立正式证据或嵌套协议。",
      "files通常用于定位和预估涉及范围；目标、验收与公共契约不变时，执行者可自主补充必要直接关联的helper、调用方、测试和构建接线，不仅因文件未列出就block、换角或request-replan。明确禁止修改、隔离和权限边界仍是硬约束，不借关联文件扩展业务目标；只有目标、验收、公共契约或硬边界确需改变时才走原重规划与确认流程。",
      "真实验证指检查实际执行且适合当前验收，不默认真机、人工浏览器或完整端到端。环境决定关键行为、特定环境故障或系统集成验收需要时，选择最小目标环境验证；关键链路可运行后尽早验证影响后续实现的假设。仅当前必需验收或正确性关键缺口阻塞；明确安排后续的系统/人工验收保留待办，不扩大当前代码任务，不自行删改已有必需验收。未测试不等于outcomeUnknown，有效结果按变更范围复用。",
      "workflowMode=auto默认仅按任务数跳过不超过两项的计划，不自动评估风险。计划需要持久检查点、恢复或职责调度时，在plan显式设置orchestration=required；按真实交付物拆分，不为触发编排凑任务。off仍拒绝规划。reviewRequired=true仅用于用户最初要求架构审阅的情形。",
      "Call task_workflow(action=complete) only after satisfying the current task's confirmed acceptance criteria with actually performed, applicable checks; keep explicitly deferred system or manual acceptance pending without claiming it passed. Use block for an explicit user request to pause or prepare session handoff, unmet required acceptance, missing requirements, permissions, credentials, destructive-operation approval, product decisions, or unrecoverable failures. These execution actions belong to the active implementation role, not architect.",
      "Discussion does not change workflow state. Use request-replan to revise the existing queue and request-goal to insert a goal group. Parent/child IDs express ownership only; all tasks share one workflow ID, ready queue and executor. New goal planning must explicitly retain existing pending task IDs; dependencies take precedence over priority, ties preserve order, and running tools are not preempted. Old nested workflows are retired and never resumed automatically.",
    ],
    parameters: taskWorkflowParameters,
    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "...";
      const taskCount = Array.isArray(args.tasks) ? ` · ${args.tasks.length} 个任务` : "";
      return new Text(theme.fg("toolTitle", theme.bold("工作流请求 ")) + theme.fg("muted", `${action}${taskCount}`), 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      const firstContent = result.content[0];
      const contentText = firstContent?.type === "text" ? firstContent.text : "";
      if (context.isError) return renderWorkflowOperationFailure(contentText, theme);
      const presentation = workflowPresentationFromDetails(result.details);
      if (presentation) return renderWorkflowPresentation(presentation, expanded, theme);
      if (!expanded && (result.details as { checkpointSaved?: boolean } | undefined)?.checkpointSaved === true) {
        return new Text("任务记忆已保存；任务未暂停", 0, 0);
      }

      const details = result.details as import("./runtime-state.ts").WorkflowState | undefined;
      if (!details || !Array.isArray(details.tasks)) {
        return new Text(contentText || "工作流已更新", 0, 0);
      }
      const statusView = createWorkflowStatusView(details, {
        roleCompactionPhase: "idle",
        workflowDispatchInFlight: false,
      });
      if (details.status === "paused") {
        return renderWorkflowPauseResult(
          createWorkflowPauseView(details),
          expanded,
          theme,
          formatWorkflowStatusText(statusView),
        );
      }
      return new Text(contentText || "工作流已更新", 0, 0);
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      function finish(result: Awaited<ReturnType<typeof workflowActions.runTaskWorkflowAction>>) {
        if (params.action === "complete" && !result.terminate) prepareDelivery(_toolCallId);
        if (params.action !== "status" || signal?.aborted) return result;
        const polling = observeStatusPolling(_toolCallId, ctx, params);
        if (!polling.stop) return result;
        const text = "等待状态未发生变化，已结束本回合的重复状态轮询。工作流状态保持不变，未恢复、完成或重试任务；请按已有状态说明处理阻塞或恢复问题。";
        if (polling.firstStop) {
          runtimeState.traceHandoff?.(ctx, "workflow.status_polling_stopped", { toolCallId: _toolCallId, code: polling.code });
          try { ctx.ui.notify(text, "warning"); } catch {}
        }
        return { ...result, content: [...result.content, { type: "text" as const, text }],
          details: { ...(result.details as Record<string, unknown>), statusPolling: { code: polling.code, stopped: true } }, terminate: true };
      }
      try {
        const stopped = userControl.guardToolCall({ toolName: "task_workflow", input: params });
        if (stopped) return { content: [{ type: "text", text: stopped.reason }], details: { ok: false, code: "WORKFLOW_USER_STOPPED" }, terminate: true };
        if (signal?.aborted || runtimeState.workflowRestoreError) return finish(await workflowActions.runTaskWorkflowAction(params, signal, ctx));
        const guard = roleRecovery.guardToolCall({ toolName: "task_workflow", input: params });
        if (guard?.block && (params.action === "retry" || params.action === "replan" || runtimeState.roleRecoveryPending || runtimeState.roleRecoveryPersistenceFailed)) {
          throw Object.assign(new Error(guard.reason), { code: guard.reason.startsWith("[pi-init-workflow-authorization]") ? "WORKFLOW_UNKNOWN_OUTCOME_CONFIRMATION_REQUIRED" : "WORKFLOW_EXECUTION_NOT_AUTHORIZED" });
        }
        let bound: typeof params;
        try { bound = workflowBinding.bind(_toolCallId, params, ctx); }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "WORKFLOW_RUN_BINDING_MISSING") throw error;
          return finish(await workflowActions.runTaskWorkflowAction(params, signal, ctx));
        }
        return finish(await workflowActions.runTaskWorkflowAction(bound, signal, ctx));
      } catch (error) {
        const value = error as { code?: unknown; message?: unknown };
        const code = typeof value?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) ? value.code : "WORKFLOW_ACTION_REJECTED";
        runtimeState.traceHandoff?.(ctx, "workflow.action_rejected", { toolCallId: _toolCallId, action: params.action, code, errorHash: fingerprint(value?.message) });
        const rejection = observeRejection({ toolName: "task_workflow", toolCallId: _toolCallId, action: params.action, code }, ctx);
        if (rejection.stop) {
          userControl.suspend(ctx, "repeated-rejection");
          runtimeState.traceHandoff?.(ctx, "workflow.rejection_stopped", { toolCallId: _toolCallId, code: rejection.code });
          return { content: [{ type: "text", text: "同一身份的工作流动作已连续被拒绝，自动续跑已停止；未恢复、完成或重试任务。原错误码：" + code }], details: { ok: false, code, rejectionStopped: true }, terminate: true };
        }
        throw error;
      }
    },
  });

}
