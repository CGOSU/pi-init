import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { workflowActionIdentity, workflowHandoffIdentity, workflowReplanIdentity } from "../src/workflow.ts";
import { coordinationHandoffIdentity } from "./coordination-runtime-protocol.ts";
import { roleLabel } from "../src/roles.ts";
import { textOf, type ActiveRole, type ExtensionRuntimeState } from "./runtime-state.ts";

export const ROLE_HANDOFF_MESSAGE_TYPE = "pi-init-role-handoff";
const ROLE_HANDOFF_ENTRY_TYPE = "pi-init-role-handoff-state";

type RoleHandoffDependencies = {
  getActiveRole: (ctx: ExtensionContext) => ActiveRole | undefined;
  requireRecovery: (ctx: ExtensionContext, reason: string) => void;
};

function sameRole(left: ActiveRole | undefined, right: ActiveRole) {
  return left?.role === right.role && left.provider === right.provider
    && left.model === right.model && left.thinkingLevel === right.thinkingLevel;
}

export function createRoleHandoff(pi: ExtensionAPI, state: ExtensionRuntimeState, deps: RoleHandoffDependencies) {
  function capture(ctx: ExtensionContext) {
    const workflow = state.workflowState;
    const coordination = state.coordinationRuntimeState;
    const activeRole = deps.getActiveRole(ctx);
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      contextGeneration: state.roleContextGeneration,
      runActive: state.agentRunActive,
      activeRole: activeRole ? { ...activeRole } : undefined,
      workKey: JSON.stringify({
        workflow: workflow ? { identity: workflowActionIdentity(workflow), status: workflow.status, handoff: workflowHandoffIdentity(workflow), replan: workflowReplanIdentity(workflow) } : undefined,
        coordination: coordination ? { identity: coordinationHandoffIdentity(coordination), coordinationId: coordination.coordination.coordinationId, sessionId: coordination.sessionId, recoveryGeneration: coordination.recoveryGeneration } : undefined,
      }),
    };
  }
  type Scope = ReturnType<typeof capture>;
  type Handoff = { handoffId: string; scope: Scope; targetRole: ActiveRole; roleTransitionGeneration: number };
  let pending: Handoff | undefined;
  let sending: Handoff | undefined;

  function sameScope(ctx: ExtensionContext, scope: Scope) {
    const current = capture(ctx);
    return !state.runtimeDisposed && current.sessionId === scope.sessionId
      && current.contextGeneration === scope.contextGeneration && current.workKey === scope.workKey;
  }
  function current(ctx: ExtensionContext, handoff: Handoff) {
    return sameScope(ctx, handoff.scope) && handoff.roleTransitionGeneration === state.roleTransitionGeneration
      && sameRole(deps.getActiveRole(ctx), handoff.targetRole);
  }
  function identity(handoff: Handoff) {
    return { handoffId: handoff.handoffId, sessionId: handoff.scope.sessionId, contextGeneration: handoff.scope.contextGeneration,
      roleTransitionGeneration: handoff.roleTransitionGeneration, fromRole: handoff.scope.activeRole?.role, role: handoff.targetRole.role };
  }
  function persist(handoff: Handoff, phase: "prepared" | "queued" | "uncertain") {
    pi.appendEntry(ROLE_HANDOFF_ENTRY_TYPE, { version: 1, ...identity(handoff), phase });
  }

  function finishSwitch(ctx: ExtensionContext, scope: Scope, result: ActiveRole, aborted = false) {
    if (!scope.runActive || sameRole(scope.activeRole, result)) return { terminate: false };
    if (aborted || !state.agentRunActive || !sameScope(ctx, scope)) {
      state.traceHandoff?.(ctx, "role.handoff_discarded", { role: result.role });
      return { terminate: true, handoffFailure: "stale-or-aborted" };
    }
    const handoff: Handoff = { handoffId: randomUUID(), scope, targetRole: { ...result }, roleTransitionGeneration: state.roleTransitionGeneration };
    try {
      persist(handoff, "prepared");
      pending = handoff;
      state.traceHandoff?.(ctx, "role.handoff_prepared", identity(handoff));
      return { terminate: true, handoffId: handoff.handoffId };
    } catch (error) {
      deps.requireRecovery(ctx, "role-handoff-persist-failed");
      ctx.ui.notify(`角色已切换，但交接记录保存失败；旧回合结束，不会自动续跑：${textOf(error)}`, "error");
      return { terminate: true, handoffFailure: "persist-failed" };
    }
  }

  async function schedule(ctx: ExtensionContext) {
    if (sending) return true;
    const handoff = pending;
    if (!handoff) return false;
    if (!current(ctx, handoff)) {
      pending = undefined;
      state.traceHandoff?.(ctx, "role.handoff_discarded", identity(handoff));
      return false;
    }
    if (state.agentRunActive || !ctx.isIdle() || state.roleCompactionInFlight || state.pendingRoleCompaction) return true;
    if (state.roleRecoveryPending || state.roleRecoveryPersistenceFailed) {
      pending = undefined;
      state.traceHandoff?.(ctx, "role.handoff_blocked_by_recovery", identity(handoff));
      ctx.ui.notify("职责恢复尚未确认；旧回合已结束，未自动启动角色交接，请先确认当前职责。", "warning");
      return true;
    }
    pending = undefined;
    sending = handoff;
    try {
      state.internalContinuationPending = true;
      await pi.sendMessage({
        customType: ROLE_HANDOFF_MESSAGE_TYPE,
        display: false,
        details: identity(handoff),
        content: [
          `职责交接已完成。当前职责：${roleLabel(handoff.targetRole.role)}（${handoff.targetRole.role}）。`,
          "上一角色回合已结束；本回合由新职责重新构建系统提示，不沿用上一回合的职责声明。",
          "按当前用户目标、已有工具结果和交接记录，只继续尚未完成的工作；不要重复已完成的调查或仅为确认而再次切角。",
          "旧 workflow/request 消息中的目标角色属于其原交接，不覆盖本回合的当前职责。需要返回原职责时明确交接本次获得的事实和待办。",
          "工作流或取证结果仍须使用当前真实身份，并由要求的角色提交；切角不等于完成、重规划或接受证据。若没有待办，直接结束，不创造新任务。",
        ].join("\n"),
      }, { triggerTurn: true });
      if (current(ctx, handoff)) persist(handoff, "queued");
      state.traceHandoff?.(ctx, "role.handoff_dispatched", identity(handoff));
    } catch (error) {
      if (current(ctx, handoff)) {
        state.internalContinuationPending = false;
        try { persist(handoff, "uncertain"); } catch {}
        deps.requireRecovery(ctx, "role-handoff-dispatch-unknown");
      }
      state.traceHandoff?.(ctx, "role.handoff_dispatch_unknown", identity(handoff));
      ctx.ui.notify(`无法确认职责交接消息的派发结果；不会自动重放，请检查当前职责与会话：${textOf(error)}`, "error");
    } finally {
      if (sending === handoff) sending = undefined;
    }
    return true;
  }

  function reset() { pending = undefined; sending = undefined; }
  return { capture, finishSwitch, schedule, reset };
}
