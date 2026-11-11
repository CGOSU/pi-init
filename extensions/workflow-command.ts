import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { transferFrozen } from "../src/session-handoff.ts";
import { transitionWorkflowLifecycle, type WorkflowLifecycleTransition } from "../src/workflow-orchestrator.ts";
import { workflowActionIdentity } from "../src/workflow.ts";
import { outgoingTransfer } from "./session-handoff.ts";
import { textOf, type ExtensionRuntimeState } from "./runtime-state.ts";
import { runWorkflowPanelRequest } from "./workflow-panel-actions.ts";
import type { WorkflowActionDependencies } from "./workflow-action-types.ts";
import type { createWorkflowRecoveryActions } from "./workflow-recovery-actions.ts";

type WorkflowCommandDependencies = Pick<WorkflowActionDependencies, "dispatch" | "report" | "freshSession" | "resumeExecution"> & {
  recoveryActions: ReturnType<typeof createWorkflowRecoveryActions>;
  commitLifecycleTransition: (transition: WorkflowLifecycleTransition, ctx: ExtensionContext) => void;
};

/** User-command adaptation only; shared persistence and execution guards remain with the action runtime. */
export function createWorkflowCommand(state: ExtensionRuntimeState, deps: WorkflowCommandDependencies) {
  const { recoveryActions, commitLifecycleTransition } = deps;
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
      state.traceHandoff?.(ctx, "pi-init.workflow_failed");
      ctx.ui.notify(textOf(error), "error");
    }
  }
  return workflowCommand;
}
