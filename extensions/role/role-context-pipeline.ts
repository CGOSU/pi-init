import type { ContextEvent, ContextEventResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { roleLabel } from "../../src/roles.ts";
import { TASK_MEMORY_MESSAGE } from "../../src/task-memory-protocol.ts";
import { validateWorkflowHandoffIdentity } from "../../src/workflow.ts";
import { restoreSystemMessagePositions } from "./context-system-messages.ts";
import { boundContextWindow, contextByteBudget } from "./role-context-budget.ts";
import { isWaitingWorkflowBoundary } from "./role-context-waiting.ts";
import { ROLE_RECOVERY_MESSAGE_TYPE } from "./role-recovery.ts";
import { ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE } from "./role-context-protocol.ts";
import { executingWorkflowTask, hasRecoveryGate, isWorkflowUnfinished, type RuntimeStateView } from "../runtime-state.ts";
import type { TaskMemoryRuntime } from "../workflow/task-memory-runtime.ts";
import { nextWorkflowAction } from "../workflow/workflow-action-policy.ts";
import { readWorkflowIdentityContext } from "../workflow/workflow-session-adapter.ts";

type RoleContextPipelineDependencies = {
  contextView?: (event: ContextEvent, ctx: ExtensionContext) => ContextEventResult | undefined;
  taskMemory?: Pick<TaskMemoryRuntime, "suspend">;
};

export function createRoleContextPipeline(
  pi: Pick<ExtensionAPI, "on">,
  state: RuntimeStateView,
  deps: RoleContextPipelineDependencies = {},
) {
  function finalizeContext(result: ContextEventResult | undefined, event: ContextEvent, ctx: ExtensionContext) {
    const messages = result?.messages ?? event.messages;
    const memory = messages.findLast(message => message.role === "custom" && message.customType === TASK_MEMORY_MESSAGE);
    if (!result?.messages && !memory) return result;
    const workflow = state.workflowState;
    const active = executingWorkflowTask(state);
    const liveTask = Boolean(active && !hasRecoveryGate(state) && !state.userStopRequested && !state.runtimeDisposed
      && validateWorkflowHandoffIdentity(active.workflow, active.handoff, readWorkflowIdentityContext(ctx)).ok);
    // Live task history belongs to the SDK token-budget/compaction path, not a second byte-sized sliding window.
    const summarizedIds = memory?.role === "custom" ? (memory.details as { summarizedToolCallIds?: unknown } | undefined)?.summarizedToolCallIds : undefined;
    const summarized = new Set(Array.isArray(summarizedIds) ? summarizedIds.filter((id): id is string => typeof id === "string") : []);
    // Replanning and waiting views preserve protected history, including unknown outcomes.
    // Their size belongs to SDK token budgeting, not a second byte limit that stops the workflow.
    const { messages: projected, ...budget } = boundContextWindow(messages, liveTask || workflow?.status === "replanning" || isWaitingWorkflowBoundary(state)
      ? null : contextByteBudget(ctx.model?.contextWindow), summarized);
    if (memory && (!projected.includes(memory) || budget.overBudget)) deps.taskMemory?.suspend(ctx);
    const diagnostic = messages.find(message => message.role === "custom" && message.customType === ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE);
    const code = diagnostic?.role === "custom" ? (diagnostic.details as { code?: string } | undefined)?.code : undefined;
    try {
      state.traceHandoff?.(ctx, "context.projected", { mode: state.workflowState?.status ?? "recovery", reasonCode: code,
        ...budget,
      });
    } catch {
      // Optional diagnostics must not replace the actual request projection with historical context.
    }
    return { ...result, messages: projected };
  }

  function context(event: ContextEvent, ctx: ExtensionContext) {
    const view = state.roleRecoveryPending && state.workflowState?.status !== "paused" ? undefined : deps.contextView?.(event, ctx);
    if (!state.roleRecoveryPending) return finalizeContext(view, event, ctx);
    const messages = (view?.messages ?? event.messages).filter((message) => {
      const candidate = message as { customType?: unknown };
      return candidate.customType !== ROLE_RECOVERY_MESSAGE_TYPE;
    });
    const activeRole = state.activeRole?.role ? roleLabel(state.activeRole.role) : "未知";
    const activeWorkflow = isWorkflowUnfinished(state.workflowState);
    const roleRecoveryAction = "需要执行前调用 switch_role(role=...) 并等待成功。";
    const recoveryToolGuidance = state.activeRole?.role === "architect"
      ? `当前角色为 architect；${roleRecoveryAction} 在确认前不得读取文件、搜索、浏览、编辑、写入、执行 shell/test、初始化项目、协作或提交完成结果。无活动工作流且无需工具或新证据的简单问答可以直接回答，但不得把回答视为职责确认。`
      : `执行类工具仍被阻断；${roleRecoveryAction} 无活动工作流且无需工具或新证据的简单问答可以直接回答，但不得把回答视为职责确认。`;
    messages.push({
      role: "custom",
      customType: ROLE_RECOVERY_MESSAGE_TYPE,
      content: [
        "[PI-INIT 职责恢复门]",
        "上下文或会话已恢复；任务内容恢复不代表职责边界已经确认。",
        `扩展记录的上一个角色：${activeRole}（仅供参考，不要直接沿用）。`,
        activeWorkflow
          ? nextWorkflowAction(state).nextAction
          : "当前没有活动工作流；无需工具或新证据的简单问答可以直接回答，不要调用 task_workflow(action=\"status\")，也不要把回答视为职责确认；需要执行任务前必须重新确认职责。",
        state.roleRecoveryPersistenceFailed
          ? "恢复门持久化失败：当前执行工具仍被阻断；不得继续或假设恢复已确认。"
          : "",
        recoveryToolGuidance,
      ].join("\n"),
      display: false,
      details: { activeRole: state.activeRole?.role },
      timestamp: Date.now(),
    } as ContextEvent["messages"][number]);
    return finalizeContext({ messages }, event, ctx);
  }

  pi.on("context_with_system", (event, ctx) => {
    const conversation = event.messages.filter(message => message.role !== "system");
    const result = context({ type: "context", messages: conversation }, ctx);
    if (!result?.messages) return result;
    if (result.messages.length === conversation.length && result.messages.every((message, index) => message === conversation[index])) return;
    // Ordinary context handlers make Pi collapse all system deltas into the request header.
    return { messages: restoreSystemMessagePositions(event.messages, result.messages) };
  });

  return { context };
}
