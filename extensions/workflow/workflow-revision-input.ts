import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendWorkflowReplanDirection, requestWorkflowReplan, requestWorkflowGoal } from "../../src/workflow.ts";
import { isExternalRunSource } from "../../src/run-timing.ts";
import { isExplicitWorkflowReplanInput, isWorkflowContinuationInput, isExplicitWorkflowChildInput } from "../../src/workflow-input-intent.ts";
import { executingWorkflowTask, isExecutionBlockedState, textOf, type ExtensionRuntimeState, type RuntimeStateView, type WorkflowState } from "../runtime-state.ts";
import { workflowHandoffMessageOnBranch } from "./workflow-session-adapter.ts";

export function workflowTaskCorrectionInput(
  state: RuntimeStateView, event: { text?: unknown; source?: unknown }, ctx: ExtensionContext,
) {
  if (!isExternalRunSource(event.source) || typeof event.text !== "string") return undefined;
  const correction = /^任务纠偏\s*[：:]\s*(\S[\s\S]*)$/u.exec(event.text.trim());
  if (!correction) return undefined;
  return applyWorkflowTaskCorrection(state, correction[1], ctx);
}

export function applyWorkflowTaskCorrection(state: RuntimeStateView, direction: string, ctx: ExtensionContext) {
  const active = executingWorkflowTask(state, ctx.sessionManager.getSessionId());
  if (!ctx.isProjectTrusted() || isExecutionBlockedState(state) || !active || active.workflow.pendingRevision
    || !workflowHandoffMessageOnBranch(ctx, active.handoff)) {
    ctx.ui.notify("没有可安全接收纠偏的执行中任务；不会恢复或重试旧任务。需改变计划时，按当前暂停提示处理或发送「重规划：<新方向>」。", "warning");
    return { action: "handled" as const };
  }
  return {
    action: "transform" as const,
    text: `任务纠偏（当前任务 ${active.task.id}）：${direction}\n沿用已确认事实和成果，不重复已排除的动作，优先做用户指定的下一项验证。此纠偏不改变目标、验收或权限；需要变更时说明冲突，等待用户明确要求重规划，不按新契约执行。`,
  };
}

export function createWorkflowRevisionInput(runtimeState: ExtensionRuntimeState, dependencies: {
  persistWorkflowState: (next: WorkflowState, ctx: ExtensionContext) => void;
  scheduleWorkflow: (ctx: ExtensionContext) => Promise<void>;
}) {
  const { persistWorkflowState, scheduleWorkflow } = dependencies;
  async function persistWorkflowDirection(next: NonNullable<WorkflowState>, ctx: ExtensionContext, reviewRequired?: true) {
    persistWorkflowState(next, ctx);
    // A reviewed natural-language revision must not start another run while the current one is settling.
    if (next.status === "replanning" && (!reviewRequired || (!runtimeState.agentRunActive && ctx.isIdle()))) {
      await scheduleWorkflow(ctx);
    }
  }

  async function captureWorkflowRevisionInput(
    event: { text?: unknown; source?: unknown },
    ctx: ExtensionContext,
    reviewRequired?: true,
  ) {
    if (
      !runtimeState.workflowState ||
      !["running", "replanning", "paused"].includes(runtimeState.workflowState.status) ||
      !isExternalRunSource(event.source) ||
      typeof event.text !== "string" ||
      !event.text.trim() ||
      event.text.trim().startsWith("/")
    ) return false;

    // Ordinary continuation is not a direction change. Preserve the saved plan and let the
    // existing settled/recovery path resume whichever task or replan boundary is active.
    if (isWorkflowContinuationInput(event.text)) return false;
    const replan = reviewRequired || isExplicitWorkflowReplanInput(event.text);
    const explicitChild = !reviewRequired && isExplicitWorkflowChildInput(event.text);
    if (!replan && !explicitChild) return false;
    const direction = reviewRequired ? event.text : event.text.trim();

    if (runtimeState.workflowState.pendingRevision) {
      const revision = runtimeState.workflowState.pendingRevision;
      if (replan && revision.kind === "goal") {
        try {
          const next = requestWorkflowReplan(runtimeState.workflowState, { direction, reviewRequired });
          await persistWorkflowDirection(next, ctx, reviewRequired);
          ctx.ui.notify("目标插入已转为共享队列重规划；保留新目标意图和原有成果，当前任务不会被强行中断。", "info");
        } catch (error) { ctx.ui.notify(`无法调整队列请求：${textOf(error)}`, "warning"); }
        return true;
      }
      if (explicitChild !== (revision.kind === "goal")) {
        ctx.ui.notify("当前已有不同类型的待处理请求；未将新指令混入该请求，请先处理或取消当前请求。", "warning");
        return true;
      }
      try {
        const next = appendWorkflowReplanDirection(runtimeState.workflowState, direction, undefined, reviewRequired);
        await persistWorkflowDirection(next, ctx, reviewRequired);
        const nested = revision.kind === "goal";
        ctx.ui.notify(
          next.status === "replanning"
            ? nested
              ? `已将新目标合并到待处理的目标分组 ${revision.revisionId}，并交由架构师规划；原有成果与队列保留。`
              : `已将新指令合并到待处理 revision ${revision.revisionId}，并重新交给架构师重规划。`
            : nested
              ? `已将新目标合并到待处理的目标分组 ${revision.revisionId}，将在当前任务边界规划；原有成果与队列保留。`
              : `已将新指令合并到待处理 revision ${revision.revisionId}，将在任务边界交给架构师重规划。`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`无法记录工作流方向变更：${textOf(error)}`, "warning");
      }
      return true;
    }

    try {
        const previous = runtimeState.workflowState;
        if (!previous) return false;
      const next = replan
        ? requestWorkflowReplan(previous, { direction, reviewRequired })
        : requestWorkflowGoal(previous, { direction });
      await persistWorkflowDirection(next, ctx, reviewRequired);
      ctx.ui.notify(
        replan
          ? next.currentTaskId
            ? `已记录工作流重规划，将在当前任务 ${next.currentTaskId} 到达安全边界后交给架构师。`
            : "已记录工作流重规划，等待架构师处理。"
          : next.currentTaskId
            ? `已记录共享队列新目标，将在当前任务 ${next.currentTaskId} 完成后规划；父工作流进度保留。`
            : "已记录共享队列新目标，等待架构师规划；原队列进度保留。",
        "info",
      );
    } catch (error) {
      ctx.ui.notify(`无法记录工作流方向变更：${textOf(error)}`, "warning");
    }
    return true;
  }

  return captureWorkflowRevisionInput;
}
