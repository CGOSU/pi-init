import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionDecision } from "../src/compaction-economics.ts";
import { workflowActionIdentity, workflowHandoffIdentity } from "../src/workflow.ts";
import type { ActiveRole, ExtensionRuntimeState } from "./runtime-state.ts";
import type { RoleMode } from "../src/role-types.ts";
import type { RoleRuntime } from "./role-runtime.ts";
import type { RoleHandoffCompaction } from "./role-handoff.ts";

const COOLDOWN_MS = 60_000;
const MAX_ATTEMPTS = 3;

type BudgetDependencies = {
  mode: (ctx: ExtensionContext) => Promise<RoleMode>;
  activeRole: (ctx: ExtensionContext) => ActiveRole | undefined;
  start: (ctx: ExtensionContext) => boolean;
  decide: (ctx: ExtensionContext) => CompactionDecision;
  roleHandoff?: Pick<RoleHandoffCompaction, "pendingId">;
};

/** Observation only: no timers, message dispatch, or independent compaction operation. */
export function createContextBudgetChecker(
  pi: Pick<ExtensionAPI, "getThinkingLevel">,
  state: ExtensionRuntimeState,
  deps: BudgetDependencies,
) {
  let observation: { key: string; attempts: number; at: number; tokens: number; minimum: number } | undefined;
  let checking = false;
  return async function checkContextBudget(ctx: ExtensionContext) {
    const usage = ctx.getContextUsage();
    const tokens = usage?.tokens ?? null;
    const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? null;
    // SDK-reported percent is retained as evidence; never clamp unusual values (e.g. 800%).
    const percent = usage?.percent ?? (tokens !== null && contextWindow && contextWindow > 0 ? tokens / contextWindow * 100 : null);
    const report = (decision: string, reason: string) => {
      state.traceHandoff?.(ctx, "context.budget_checked", { tokens, contextWindow, percent, decision, reason });
      return false;
    };
    const guard = () => state.userStopRequested ? "user-stop"
      : state.runtimeDisposed ? "disposed"
      : ctx.signal?.aborted ? "aborted"
      : state.roleRecoveryPending || state.roleRecoveryPersistenceFailed || state.workflowRestoreError
        || state.pendingWorkflowRecovery ? "recovery"
      : ctx.hasPendingMessages() || state.internalContinuationPending ? "queued-continuation"
      : undefined;
    const blocked = guard();
    if (blocked) return report("guard", blocked);
    if (checking || state.roleCompactionInFlight || state.pendingRoleCompaction || state.workflowDispatchInFlight) return report("inflight", "operation-pending");
    if (tokens === null || !Number.isFinite(tokens) || tokens < 0 || contextWindow === null || !Number.isFinite(contextWindow) || contextWindow <= 0) return report("unavailable", "usage-unavailable");
    const generation = state.roleContextGeneration;
    const transitionGeneration = state.roleTransitionGeneration;
    const sessionId = ctx.sessionManager.getSessionId();
    const modelKey = JSON.stringify([ctx.model?.provider, ctx.model?.id, pi.getThinkingLevel()]);
    const branchEntryIds = ctx.sessionManager.getBranch().map(entry => entry.id);
    checking = true;
    try {
      const mode = await deps.mode(ctx);
      if (mode !== "auto") return report("mode", mode);
      const changed = guard();
      if (changed) return report("guard", changed);
      if (modelKey !== JSON.stringify([ctx.model?.provider, ctx.model?.id, pi.getThinkingLevel()])
        || generation !== state.roleContextGeneration || transitionGeneration !== state.roleTransitionGeneration
        || sessionId !== ctx.sessionManager.getSessionId()
        || JSON.stringify(branchEntryIds) !== JSON.stringify(ctx.sessionManager.getBranch().map(entry => entry.id))) return report("guard", "context-changed");
      if (state.roleCompactionInFlight || state.pendingRoleCompaction || state.workflowDispatchInFlight) return report("inflight", "operation-pending");
      const role = deps.activeRole(ctx);
      if (!ctx.model || (state.activeRole && !role)) return report("guard", "role-model-mismatch");
      const storedWorkflow = state.workflowState;
      const inactiveWorkflowKey = storedWorkflow && ["completed", "cancelled"].includes(storedWorkflow.status)
        ? JSON.stringify([workflowActionIdentity(storedWorkflow), storedWorkflow.status]) : undefined;
      const workflow = inactiveWorkflowKey ? undefined : storedWorkflow;
      const task = workflow?.tasks.find(item => item.id === workflow.currentTaskId);
      const roleHandoffId = deps.roleHandoff?.pendingId(ctx);
      const identity = workflow && !roleHandoffId ? workflowHandoffIdentity(workflow) : undefined;
      if (workflow && !roleHandoffId && (workflow.status !== "running" || workflow.pendingRevision || workflow.continuation
        || workflow.handoff?.phase !== "executing" || !identity || !task || task.status !== "in_progress"
        || task.outcomeUnknown || task.delegation || identity.taskId !== task.id || role?.role !== task.role
        || identity.sessionId !== sessionId)) return report("guard", "task-identity-unverified");
      const key = JSON.stringify([sessionId, generation, transitionGeneration, ctx.model.provider, ctx.model.id, pi.getThinkingLevel(), role?.role, identity, roleHandoffId, inactiveWorkflowKey]);
      if (observation?.key !== key) observation = undefined;
      if (observation) {
        observation.minimum = Math.min(observation.minimum, tokens);
          if (observation.tokens - tokens >= Math.max(8192, contextWindow * 0.1)) {
            observation.attempts = 0;
            observation.tokens = tokens;
          }
        if (observation.attempts >= MAX_ATTEMPTS || Date.now() - observation.at < COOLDOWN_MS
          || tokens - observation.minimum < Math.max(8192, contextWindow * 0.05)) return report("cooldown", observation.attempts >= MAX_ATTEMPTS ? "attempt-limit" : "await-fresh-usage-growth");
      }
      const decision = deps.decide(ctx);
      if (!decision.ok) return report("unavailable", decision.code + ": " + decision.message);
      if (!decision.compact) return report("economics", decision.reason);
      observation = { key, attempts: (observation?.attempts ?? 0) + 1, at: Date.now(), tokens, minimum: tokens };
      const targetRole = role ?? { role: "", provider: ctx.model.provider, model: ctx.model.id, thinkingLevel: pi.getThinkingLevel() };
      state.pendingRoleCompaction = {
        fromRole: targetRole.role, toRole: targetRole.role, sessionId,
        contextGeneration: generation, roleTransitionGeneration: transitionGeneration, targetRole: { ...targetRole },
        budget: {
          branchEntryIds, identity, roleHandoffId, inactiveWorkflowKey, explicitRole: Boolean(role),
          snapshot: JSON.stringify({ kind: "context-budget", sessionId, role: role?.role ?? null,
            workflow: identity ?? null, task: task ? { id: task.id, status: task.status } : null,
            instruction: "Preserve the current unfinished task, constraints, decisions, changed files and actual verification. This is not a handoff; do not replay or dispatch work, mark it complete, or start another model turn." }),
        },
      };
      if (!deps.start(ctx)) {
        state.pendingRoleCompaction = undefined;
        return report("guard", "manager-refused");
      }
      report("started", "existing-compaction-manager");
      return true;
    } catch {
      return report("guard", "configuration-or-context-unavailable");
    } finally {
      checking = false;
    }
  };
}

/** SDK turn_end has persisted results. compact() aborts/waits for idle internally;
 * do not await completion in this boundary (would deadlock), enqueue or replay turns.
 */
export function registerContextBudgetMonitor(
  pi: ExtensionAPI,
  state: ExtensionRuntimeState,
  roleRuntime: Pick<RoleRuntime, "checkContextBudget">,
) {
  pi.on("turn_end", async (event, ctx) => {
    if (state.userStopRequested || state.runtimeDisposed || event.outcome !== "completed" || event.message.role !== "assistant") return;
    const calls = event.message.content.filter(part => part.type === "toolCall");
    if (event.toolResultEntryIds.length !== event.toolResults.length
      || calls.some(call => !event.toolResults.some(result => result.toolCallId === call.id))) return;
    await roleRuntime.checkContextBudget(ctx);
  });
}
