import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
    pi.appendEntry(ROLE_RECOVERY_ENTRY_TYPE, { status: "pending", reason });
  }

  function restore(ctx: ExtensionContext, reason?: string) {
    const branch = ctx.sessionManager.getBranch();
    const entry = branch.findLast(
      (item) => item.type === "custom" && item.customType === ROLE_RECOVERY_ENTRY_TYPE,
    );
    if (branch.length > 0 && SESSION_REARM_REASONS.has(reason ?? "") && !isPendingEntry(entry)) {
      enterPending(reason ?? "startup");
      return;
    }
    state.roleRecoveryPending = isPendingEntry(entry);
  }

  function reset() {
    state.roleRecoveryPending = false;
  }

  function afterCompact(event: { reason?: string }) {
    if (state.roleCompactionInFlight) return;
    enterPending(event.reason ?? "unknown");
  }

  function acknowledge(role: string) {
    if (!state.roleRecoveryPending) return;
    pi.appendEntry(ROLE_RECOVERY_ENTRY_TYPE, { status: "acknowledged", role });
    state.roleRecoveryPending = false;
  }

  function context(event: ContextEvent) {
    if (!state.roleRecoveryPending) return undefined;
    const messages = event.messages.filter((message) => {
      const candidate = message as { customType?: unknown };
      return candidate.customType !== ROLE_RECOVERY_MESSAGE_TYPE;
    });
    const activeRole = state.activeRole?.role ? roleLabel(state.activeRole.role) : "未知";
    messages.push({
      role: "custom",
      customType: ROLE_RECOVERY_MESSAGE_TYPE,
      content: [
        "[PI-INIT 职责恢复门]",
        "检测到上下文刚完成压缩。压缩恢复了任务内容，但不代表职责边界已经恢复。",
        `扩展记录的上一个角色：${activeRole}（仅供参考，不要直接沿用）。`,
        "恢复顺序：如存在活动工作流，先调用 task_workflow(action=\"status\")；然后根据用户目标和公共 pi-init-role-routing Skill 重新判断职责；最后必须调用 switch_role(role=...)。",
        "在 switch_role 成功前，只允许读取文件、查看工作流状态或调用 switch_role；不得编辑、写入、执行 shell/test、初始化项目或提交完成结果。",
      ].join("\n"),
      display: false,
      details: { activeRole: state.activeRole?.role },
      timestamp: Date.now(),
    } as ContextEvent["messages"][number]);
    return { messages };
  }

  function guardToolCall(event: { toolName: string; input?: Record<string, unknown> }) {
    if (!state.roleRecoveryPending) return undefined;
    if (event.toolName === "switch_role" || READ_ONLY_TOOLS.has(event.toolName)) return undefined;
    if (event.toolName === "task_workflow" && event.input?.action === "status") return undefined;
    return {
      block: true,
      reason: `[pi-init-role-recovery] ${ROLE_RECOVERY_REASON}`,
    };
  }

  pi.on("session_compact", (event) => afterCompact(event));
  pi.on("context", (event) => context(event));
  pi.on("tool_call", (event) => guardToolCall(event));

  return {
    restore,
    reset,
    afterCompact,
    acknowledge,
    context,
    guardToolCall,
  };
}

export type RoleRecovery = ReturnType<typeof createRoleRecovery>;
