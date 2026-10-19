import type { ContextEvent, ContextEventResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { activeContextView } from "./role-context-active.ts";
import { pausedContextView } from "./role-context-paused.ts";

export function createRoleContextView(state: ExtensionRuntimeState) {
  function context(event: ContextEvent, ctx: ExtensionContext): ContextEventResult | undefined {
    if (!Array.isArray(event.messages)) {
      ctx.ui.notify("请求局部上下文视图无法识别 Pi 消息数组；未修改输入，保留宿主完整上下文。", "warning");
      return undefined;
    }
    if (state.runtimeDisposed) return undefined;
    if (state.workflowState?.status === "paused") return pausedContextView(state, event.messages, ctx);
    if (state.roleRecoveryPending || state.roleRecoveryPersistenceFailed) return undefined;
    return activeContextView(state, event, ctx);
  }
  return { context };
}

export type RoleContextView = ReturnType<typeof createRoleContextView>;

export { ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE } from "./role-context-protocol.ts";
