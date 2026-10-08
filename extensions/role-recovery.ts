import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isWorkflowActive } from "../src/workflow.js";
import { roleLabel } from "../src/roles.js";
import type { ExtensionRuntimeState } from "./runtime-state.ts";

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

export function createRoleRecovery(pi: ExtensionAPI, state: ExtensionRuntimeState) {
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

  function context(event: ContextEvent) {
    if (!state.roleRecoveryPending) return undefined;
    const messages = event.messages.filter((message) => {
      const candidate = message as { customType?: unknown };
      return candidate.customType !== ROLE_RECOVERY_MESSAGE_TYPE;
    });
    const activeRole = state.activeRole?.role ? roleLabel(state.activeRole.role) : "未知";
    const activeWorkflow = Boolean(state.workflowState && isWorkflowActive(state.workflowState));
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
    return { messages };
  }

  function guardToolCall(event: { toolName: string; input?: Record<string, unknown> }) {
    if (!state.roleRecoveryPending) return undefined;
    if (event.toolName === "switch_role") return undefined;
    if (state.activeRole?.role && state.activeRole.role !== "architect" && READ_ONLY_TOOLS.has(event.toolName)) return undefined;
    if (event.toolName === "task_workflow" && event.input?.action === "status") return undefined;
    return {
      block: true,
      reason: `[pi-init-role-recovery] ${ROLE_RECOVERY_REASON}`,
    };
  }

  pi.on("session_compact", (event, ctx) => afterCompact(event, ctx));
  pi.on("context", (event) => context(event));
  pi.on("tool_call", (event) => guardToolCall(event));

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
