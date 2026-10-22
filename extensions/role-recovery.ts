import type { ContextEvent, ContextEventResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateWorkflowHandoffIdentity } from "../src/workflow.ts";
import { roleLabel } from "../src/roles.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { boundContextWindow, contextByteBudget } from "./role-context-budget.ts";
import { taskMemoryText, TASK_MEMORY_MESSAGE } from "./task-memory-runtime.ts";
import type { TaskMemoryRuntime } from "./task-memory-runtime.ts";

export const ROLE_RECOVERY_ENTRY_TYPE = "pi-init-role-recovery";
export const ROLE_RECOVERY_MESSAGE_TYPE = "pi-init-role-recovery";

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const ROLE_RECOVERY_REASON = "上下文刚完成压缩，职责尚未重新确认；请先成功调用 switch_role(role=...)。";
const SESSION_REARM_REASONS = new Set(["startup", "reload", "resume", "fork"]);

function isPendingEntry(entry: unknown) {
  if (!entry || typeof entry !== "object" || !("data" in entry)) return false;
  const data = (entry as { data?: unknown }).data;
  return data !== null && typeof data === "object" && (data as { status?: unknown }).status === "pending";
}

export function createRoleRecovery(
  pi: ExtensionAPI,
  state: ExtensionRuntimeState,
  contextView?: (event: ContextEvent, ctx: ExtensionContext) => ContextEventResult | undefined, onRejected?: RecoveryRejectionHandler, taskMemory?: Pick<TaskMemoryRuntime, "read" | "suspend">
) {
  function enterPending(reason: string) {
    state.roleRecoveryPending = true;
    try {
      pi.appendEntry(ROLE_RECOVERY_ENTRY_TYPE, { status: "pending", reason });
      state.roleRecoveryPersistenceFailed = false;
    } catch (error) {
      state.roleRecoveryPersistenceFailed = true;
      throw Object.assign(new Error(`无法持久化职责恢复门，执行工具仍保持阻断：${error instanceof Error ? error.message : String(error)}`), {
        code: "ROLE_RECOVERY_PERSIST_FAILED",
      });
    }
  }

  function restore(ctx: ExtensionContext, reason?: string) {
    const branch = ctx.sessionManager.getBranch();
    const entry = branch.findLast(
      (item) => item.type === "custom" && item.customType === ROLE_RECOVERY_ENTRY_TYPE,
    );
    if (state.roleRecoveryPersistenceFailed) {
      state.roleRecoveryPending = true;
      return;
    }
    if (branch.length > 0 && SESSION_REARM_REASONS.has(reason ?? "") && !isPendingEntry(entry)) {
      enterPending(reason ?? "startup");
      return;
    }
    state.roleRecoveryPending = isPendingEntry(entry);
  }

  function requireConfirmation(ctx: ExtensionContext, reason: string) {
    try {
      enterPending(reason);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  function reset() {
    state.roleRecoveryPending = false;
    state.roleRecoveryPersistenceFailed = false;
  }

  function afterCompact(event: { reason?: string }, ctx: ExtensionContext) {
    if (state.roleCompactionInFlight) return;
    requireConfirmation(ctx, event.reason ?? "unknown");
  }

  function acknowledge(role: string) {
    if (!state.roleRecoveryPending) return;
    try {
      pi.appendEntry(ROLE_RECOVERY_ENTRY_TYPE, { status: "acknowledged", role });
      state.roleRecoveryPending = false;
      state.roleRecoveryPersistenceFailed = false;
    } catch (error) {
      state.roleRecoveryPending = true;
      state.roleRecoveryPersistenceFailed = true;
      throw Object.assign(new Error(`无法持久化职责确认，恢复门仍保持阻断：${error instanceof Error ? error.message : String(error)}`), {
        code: "ROLE_RECOVERY_PERSIST_FAILED",
      });
    }
  }

  function context(event: ContextEvent, ctx: ExtensionContext) {
    const view = state.roleRecoveryPending && state.workflowState?.status !== "paused" ? undefined : contextView?.(event, ctx);
    function finalize(result: ContextEventResult | undefined) {
      const memory = taskMemory?.read(ctx);
      const memoryText = memory ? taskMemoryText(memory) : "";
      if (!result?.messages && !memoryText) return result;
      const original = result?.messages ?? event.messages;
      const hasMemory = original.some(message => message.role === "custom" && message.customType === TASK_MEMORY_MESSAGE);
      const messages = memoryText || hasMemory ? original.filter(message => message.role !== "custom" || message.customType !== TASK_MEMORY_MESSAGE) : original;
      if (memoryText) {
        const lastUser = messages.findLastIndex(message => message.role === "user");
        messages.splice(lastUser + 1, 0, { role: "custom", customType: TASK_MEMORY_MESSAGE, content: memoryText, display: false, timestamp: 0 } as ContextEvent["messages"][number]);
      }
      const summarized = new Set(memory?.status === "available" ? memory.memory?.observations.map(item => item.toolCallId) ?? [] : []);
      const workflow = state.workflowState;
      const task = workflow?.tasks.find(task => task.id === workflow.currentTaskId);
      const liveTask = workflow?.status === "running" && workflow.handoff?.phase === "executing"
        && task?.status === "in_progress" && !task.outcomeUnknown && state.activeRole?.role === task.role
        && !state.roleRecoveryPending && !state.roleRecoveryPersistenceFailed && !state.workflowRestoreError
        && !state.pendingWorkflowRecovery && !state.userStopRequested && !state.runtimeDisposed
        && validateWorkflowHandoffIdentity(workflow, workflow.handoff, ctx).ok;
      // Live task history belongs to the SDK token-budget/compaction path, not a second byte-sized sliding window.
      const bounded = boundContextWindow(messages, liveTask ? null : contextByteBudget(ctx.model?.contextWindow), summarized);
      const covered = !memoryText || bounded.messages.some(message => message.role === "custom" && message.customType === TASK_MEMORY_MESSAGE && message.content === memoryText);
      if (memoryText && (!covered || bounded.overBudget || memory?.status === "unavailable")) taskMemory?.suspend(ctx);
      const projected = bounded.checkpointed ? bounded.messages.map(message => {
        if (message.role !== "custom" || message.customType !== "pi-init-role-context-view-diagnostic" || typeof message.content !== "string") return message;
        return { ...message, content: message.content.replaceAll("完整模型消息已保留", "交接边界投影未执行，随后已应用有界预算检查点")
          .replaceAll("现有完整上下文", "现有有界观察").replaceAll("不要把本次视图描述为已隔离或已缩减。", "预算检查点不代表交接边界已可靠隔离。") };
      }) : bounded.messages;
      const diagnostic = messages.find(message => message.role === "custom" && message.customType === "pi-init-role-context-view-diagnostic");
      const code = diagnostic?.role === "custom" ? (diagnostic.details as { code?: string } | undefined)?.code : undefined;
      state.traceHandoff?.(ctx, "context.projected", { mode: state.workflowState?.status ?? "recovery", reasonCode: code,
        ...Object.fromEntries(Object.entries(bounded).filter(([key]) => key !== "messages")),
        outputBytes: Buffer.byteLength(JSON.stringify(projected)) });
      return { ...result, messages: projected };
    }
    if (!state.roleRecoveryPending) return finalize(view);
    const messages = (view?.messages ?? event.messages).filter((message) => {
      const candidate = message as { customType?: unknown };
      return candidate.customType !== ROLE_RECOVERY_MESSAGE_TYPE;
    });
    const activeRole = state.activeRole?.role ? roleLabel(state.activeRole.role) : "未知";
    const activeWorkflow = Boolean(state.workflowState && !["completed", "cancelled"].includes(state.workflowState.status));
    const roleRecoveryAction = state.roleModeStatus === "manual"
      ? "当前为 manual 模式：若当前角色与模型匹配，可用 switch_role 验证；否则需用户执行 /pi-init role <role>，不能反复调用 switch_role。"
      : "需要执行前调用 switch_role(role=...) 并等待成功。";
    const recoveryToolGuidance = state.activeRole?.role === "architect"
      ? `当前角色为 architect；${roleRecoveryAction} 在确认前不得读取文件、搜索、浏览、编辑、写入、执行 shell/test、初始化项目、协作或提交完成结果。无活动工作流且无需工具或新证据的简单问答可以直接回答，但不得把回答视为职责确认。`
      : `执行类工具仍被阻断；${roleRecoveryAction} 无活动工作流且无需工具或新证据的简单问答可以直接回答，但不得把回答视为职责确认。`;
    messages.push({
      role: "custom",
      customType: ROLE_RECOVERY_MESSAGE_TYPE,
      content: [
        "[PI-INIT 职责恢复门]",
        "检测到上下文刚完成压缩。压缩恢复了任务内容，但不代表职责边界已经恢复。",
        `扩展记录的上一个角色：${activeRole}（仅供参考，不要直接沿用）。`,
        activeWorkflow
          ? "恢复顺序：存在活动工作流，先调用 task_workflow(action=\"status\")；然后根据用户目标和公共 pi-init-role-routing Skill 重新判断职责；需要执行任务前必须重新确认职责。"
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
    return finalize({ messages });
  }

  function guardToolCall(event: { toolName: string; input?: Record<string, unknown> }) {
    if (event.toolName === "switch_role") return undefined;
    const readOnly = READ_ONLY_TOOLS.has(event.toolName);
    const workflowAction = event.toolName === "task_workflow" ? event.input?.action : undefined;
    if (state.roleRecoveryPending || state.roleRecoveryPersistenceFailed) {
      if (workflowAction !== "status" && !(state.activeRole?.role && state.activeRole.role !== "architect" && readOnly)) {
        return { block: true, reason: "[pi-init-role-recovery] " + ROLE_RECOVERY_REASON };
      }
    }
    const workflow = state.workflowState;
    if (workflowAction === "retry" || (workflowAction === "replan" && event.input?.confirmUnknownOutcome === true)) {
      const taskId = event.input?.taskId;
      const task = workflowAction === "replan"
        ? workflow?.tasks.find(item => item.outcomeUnknown)
        : workflow?.tasks.find(item => taskId === undefined ? item.status === "blocked" : item.id === taskId);
      if (task?.outcomeUnknown) return {
        block: true,
        reason: "[pi-init-workflow-authorization] 旧执行结果未知；模型布尔值不构成用户授权。请核对副作用，由用户执行 /pi-init workflow retry <taskId> --confirm-unknown-outcome 或使用工作流面板确认。",
      };
    }
    const unavailable = state.workflowRestoreError || state.pendingWorkflowRecovery || workflow?.status === "paused" || workflow?.status === "replanning";
    if (!unavailable || readOnly) return undefined;
    if (workflowAction && !["complete", "block", "clarify"].includes(String(workflowAction))) return undefined;
    return {
      block: true,
      reason: "[pi-init-workflow-execution] 工作流暂停、重规划或恢复未完成；职责确认不授权继续执行。先查询 task_workflow(status)，按暂停原因恢复或由用户确认未知结果重试。",
    };
  }

  pi.on("session_compact", (event, ctx) => afterCompact(event, ctx));
  pi.on("context", (event, ctx) => context(event, ctx));
  pi.on("tool_call", (event, ctx) => {
    const result = guardToolCall(event);
    if (result?.block) {
      const code = result.reason.startsWith("[pi-init-role-recovery]") ? "ROLE_RECOVERY_REQUIRED"
        : result.reason.startsWith("[pi-init-workflow-authorization]") ? "WORKFLOW_UNKNOWN_OUTCOME_CONFIRMATION_REQUIRED" : "WORKFLOW_EXECUTION_NOT_AUTHORIZED";
      state.traceHandoff?.(ctx, "workflow.action_rejected", { toolCallId: event.toolCallId, toolName: event.toolName, action: event.input && "action" in event.input ? event.input.action : undefined, code });
      onRejected?.(event, ctx, code);
    }
    return result;
  });

  return {
    restore,
    reset,
    requireConfirmation,
    afterCompact,
    acknowledge,
    context,
    guardToolCall,
  };
}

export type RoleRecovery = ReturnType<typeof createRoleRecovery>;
type RecoveryRejectionHandler = (event: { toolName: string; toolCallId: string; input?: Record<string, unknown> }, ctx: ExtensionContext, code: string) => void;
