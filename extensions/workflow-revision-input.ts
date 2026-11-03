import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendWorkflowReplanDirection, requestWorkflowReplan, requestWorkflowGoal } from "../src/workflow.ts";
import { isExternalRunSource } from "../src/run-timing.ts";
import { isExplicitWorkflowReplanInput, isWorkflowContinuationInput, isExplicitWorkflowChildInput } from "../src/workflow-input-intent.ts";
import { textOf, type ExtensionRuntimeState, type WorkflowState } from "./runtime-state.ts";

export function createWorkflowRevisionInput(runtimeState: ExtensionRuntimeState, dependencies: {
  persistWorkflowState: (next: WorkflowState, ctx: ExtensionContext) => void;
  scheduleWorkflow: (ctx: ExtensionContext) => Promise<void>;
}) {
  const { persistWorkflowState, scheduleWorkflow } = dependencies;
  async function persistWorkflowDirection(next: NonNullable<WorkflowState>, ctx: ExtensionContext) {
    persistWorkflowState(next, ctx);
    if (next.status === "replanning") await scheduleWorkflow(ctx);
  }

  async function captureWorkflowRevisionInput(
    event: { text?: unknown; source?: unknown },
    ctx: ExtensionContext,
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
    const explicitReplan = isExplicitWorkflowReplanInput(event.text);
    const explicitChild = isExplicitWorkflowChildInput(event.text);
    if (!explicitReplan && !explicitChild) return false;

    if (runtimeState.workflowState.pendingRevision) {
      const revision = runtimeState.workflowState.pendingRevision;
      if (explicitReplan && revision.kind === "goal") {
        try {
          const next = requestWorkflowReplan(runtimeState.workflowState, { direction: event.text.trim() });
          await persistWorkflowDirection(next, ctx);
          ctx.ui.notify("目标插入已转为共享队列重规划；保留新目标意图和原有成果，当前任务不会被强行中断。", "info");
        } catch (error) { ctx.ui.notify(`无法调整队列请求：${textOf(error)}`, "warning"); }
        return true;
      }
      if (explicitChild !== (revision.kind === "goal")) {
        ctx.ui.notify("当前已有不同类型的待处理请求；未将新指令混入该请求，请先处理或取消当前请求。", "warning");
        return true;
      }
      try {
        const next = appendWorkflowReplanDirection(runtimeState.workflowState, event.text.trim());
        await persistWorkflowDirection(next, ctx);
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
      const direction = event.text.trim();
      const next = explicitReplan
        ? requestWorkflowReplan(previous, { direction })
        : requestWorkflowGoal(previous, { direction });
      await persistWorkflowDirection(next, ctx);
      ctx.ui.notify(
        explicitReplan
          ? next.currentTaskId
            ? `已记录父工作流重规划，将在当前任务 ${next.currentTaskId} 完成后交给架构师。`
            : "已记录父工作流重规划，等待架构师处理。"
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
