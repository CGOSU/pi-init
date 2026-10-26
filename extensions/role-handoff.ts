import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { workflowActionIdentity, workflowHandoffIdentity, workflowReplanIdentity } from "../src/workflow.ts";
import { textOf, type ActiveRole, type ExtensionRuntimeState } from "./runtime-state.ts";
import { handoffSnapshotPrompt } from "./handoff-snapshot.ts";
import { checkWorkflowRoleSwitch } from "./workflow-action-policy.ts";

export const ROLE_HANDOFF_MESSAGE_TYPE = "pi-init-role-handoff";
const ROLE_HANDOFF_ENTRY_TYPE = "pi-init-role-handoff-state";

export type RoleHandoffCompaction = {
  pendingId: (ctx: ExtensionContext) => string | undefined;
  resumeAfterCompaction: (ctx: ExtensionContext, handoffId: string) => Promise<void>;
  retireCompaction: (handoffId: string) => void;
};

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
    const activeRole = deps.getActiveRole(ctx);
    const task = workflow?.tasks.find(task => task.id === workflow.currentTaskId);
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      contextGeneration: state.roleContextGeneration,
      runActive: state.agentRunActive,
      activeRole: activeRole ? { ...activeRole } : undefined,
      workKey: JSON.stringify({
        workflow: workflow ? { identity: workflowActionIdentity(workflow), status: workflow.status, handoff: workflowHandoffIdentity(workflow), replan: workflowReplanIdentity(workflow),
          task: task ? { id: task.id, status: task.status, outcomeUnknown: task.outcomeUnknown, delegated: Boolean(task.delegation) } : undefined,
          handoffPhase: workflow.handoff?.phase,
          continuationPhase: workflow.continuation?.kind === "review" ? undefined : workflow.continuation?.phase } : undefined,
      }),
    };
  }
  type Scope = ReturnType<typeof capture>;
  type Handoff = { handoffId: string; scope: Scope; targetRole: ActiveRole; roleTransitionGeneration: number; branchEntryIds: string[]; compactionRetired?: boolean };
  let pending: Handoff | undefined;
  let sending: Handoff | undefined;

  function sameScope(ctx: ExtensionContext, scope: Scope) {
    const current = capture(ctx);
    return !state.runtimeDisposed && !state.userStopRequested && current.sessionId === scope.sessionId
      && current.contextGeneration === scope.contextGeneration && current.workKey === scope.workKey;
  }
  function current(ctx: ExtensionContext, handoff: Handoff) {
    const branch = ctx.sessionManager.getBranch();
    return sameScope(ctx, handoff.scope) && handoff.roleTransitionGeneration === state.roleTransitionGeneration
      && handoff.branchEntryIds.every((id, index) => branch[index]?.id === id)
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
    const handoff: Handoff = { handoffId: randomUUID(), scope, targetRole: { ...result }, roleTransitionGeneration: state.roleTransitionGeneration,
      branchEntryIds: ctx.sessionManager.getBranch().map(entry => entry.id) };
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
    // Retain the retired boundary until reset/new handoff so settled cannot fall
    // through to the workflow scheduler after failed or unverified compaction.
    if (handoff.compactionRetired) return true;
    if (!current(ctx, handoff)) {
      pending = undefined;
      state.traceHandoff?.(ctx, "role.handoff_discarded", identity(handoff));
      return false;
    }
    if (state.agentRunActive || !ctx.isIdle() || state.roleCompactionInFlight || state.pendingRoleCompaction) return true;
    if (recoveryBlocked()) {
      pending = undefined;
      state.traceHandoff?.(ctx, "role.handoff_blocked_by_recovery", identity(handoff));
      ctx.ui.notify("职责恢复尚未确认；旧回合已结束，未自动启动角色交接，请先确认当前职责。", "warning");
      return true;
    }
    if (ctx.hasPendingMessages() || state.internalContinuationPending) return true;
    pending = undefined;
    sending = handoff;
    try {
      state.internalContinuationPending = true;
      await pi.sendMessage({
        customType: ROLE_HANDOFF_MESSAGE_TYPE,
        display: false,
        details: identity(handoff),
        content: [
          handoffSnapshotPrompt(state, handoff.targetRole.role),
          "上一职责回合已结束；以当前职责继续未完成工作，历史消息中的职责不覆盖当前职责。",
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

  function recoveryBlocked() {
    return state.roleRecoveryPending || state.roleRecoveryPersistenceFailed || state.workflowRestoreError || state.pendingWorkflowRecovery;
  }

  function pendingId(ctx: ExtensionContext) {
    return pending && !pending.compactionRetired && current(ctx, pending) && !recoveryBlocked() ? pending.handoffId : undefined;
  }

  async function resumeAfterCompaction(ctx: ExtensionContext, handoffId: string) {
    if (pending?.handoffId !== handoffId) return;
    await schedule(ctx);
  }

  function retireCompaction(handoffId: string) {
    if (pending?.handoffId === handoffId) pending.compactionRetired = true;
  }

  function reset() { pending = undefined; sending = undefined; }
  return { capture, finishSwitch, schedule, reset, pendingId, resumeAfterCompaction, retireCompaction, checkSwitchRole: (targetRole: string) => checkWorkflowRoleSwitch(state, targetRole) };
}
