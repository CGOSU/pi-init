import { workflowHandoffMessageOnBranch } from "./workflow-session-adapter.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectWorkflowScheduleEffect, transitionWorkflowDispatch } from "../../src/workflow-orchestrator.ts";
import {
    blockWorkflowTask,
    ensureWorkflowReplanHandoff,
    getWorkflowTask,
    hydrateWorkflowState,
    isWorkflowRunning,
    markWorkflowTaskOutcomeUnknown,
    recordWorkflowNudge,
    recoverWorkflowState,
    setWorkflowHandoffPhase,
    startWorkflowTask,
    validateWorkflowExecutionRoles,
    WORKFLOW_MAX_NUDGES,
    workflowActionIdentity,
    workflowHandoffIdentity,
    workflowReplanIdentity,
} from "../../src/workflow.ts";
import type { RoleRuntime } from "../role/role-runtime.ts";
import {
    matchPolicy,
    textOf,
    type RuntimeStateAccess,
    type WorkflowActionIdentity,
    type WorkflowHandoffIdentity,
    type WorkflowReplanIdentity,
    type WorkflowState,
} from "../runtime-state.ts";
import type { WorkflowMessages } from "./workflow-messages.ts";
import { latestWorkflowRecoverySource, workflowRestoreErrorForSource } from "./workflow-recovery-source.ts";
import type { WorkflowReport } from "./workflow-report.ts";
import type { WorkflowStore } from "./workflow-store.ts";
import { validateWorkflowTaskStartMessage } from "./workflow-start-evidence.ts";
import type { ToolSettlement } from "../session/general-tool-settlement.ts";

export type WorkflowDispatchDependencies = {
  roleRuntime: RoleRuntime;
  offerSessionHandoff?: (ctx: ExtensionContext) => boolean;
  guardSessionHandoff?: (ctx: ExtensionContext) => void;
  toolsSettled?: (ctx: ExtensionContext) => ToolSettlement;
  messages: WorkflowMessages;
  report: Pick<WorkflowReport, "updateWorkflowStatus" | "formatWorkflowPauseSummary">;
  store: Pick<WorkflowStore, "persistWorkflowState" | "restoreSnapshot">;
  setCurrentContext: (ctx: ExtensionContext) => void;
};

function sameActionIdentity(left: WorkflowActionIdentity, right: WorkflowActionIdentity) {
  return left.workflowId === right.workflowId
    && left.planVersion === right.planVersion
    && left.sessionId === right.sessionId
    && left.recoveryGeneration === right.recoveryGeneration;
}

function sameReplanIdentity(left: WorkflowReplanIdentity, right: WorkflowReplanIdentity) {
  return sameActionIdentity(left, right)
    && left.revisionId === right.revisionId
    && left.handoffId === right.handoffId;
}

// An accepted side ledger is not an opt-in. Existing contracts or an explicit
// workflow link are: deleting a contract must not downgrade an old formal plan.

export function createWorkflowDispatch(
  state: RuntimeStateAccess<
    | "workflowDispatchInFlight"
    | "internalContinuationPending"
    | "pendingWorkflowRecovery"
    | "workflowRestoreError"
  >,
  deps: WorkflowDispatchDependencies,
) {
  let localScheduleInFlight = false;
  function currentHandoff(expected: WorkflowHandoffIdentity) {
    const current = state.workflowState;
    const actual = current ? workflowHandoffIdentity(current) : undefined;
    return actual !== undefined
      && sameActionIdentity(actual, expected)
      && actual.taskId === expected.taskId
      && actual.attemptId === expected.attemptId
      && actual.handoffId === expected.handoffId;
  }

  async function scheduleWorkflowReplan(ctx: ExtensionContext) {
    if (
      state.workflowDispatchInFlight
      || !state.workflowState
      || state.workflowState.status !== "replanning"
      || !state.workflowState.pendingRevision
    ) return;

    let current = state.workflowState;
    if (current.continuation?.kind === "replan" && ["dispatching", "queued"].includes(current.continuation.phase)) return;
    const ensured = ensureWorkflowReplanHandoff(current);
    if (!ensured) return;
    if (ensured !== current) deps.store.persistWorkflowState(ensured, ctx);
    current = ensured;
    const identity = workflowReplanIdentity(current);
    if (!identity) return;

    state.workflowDispatchInFlight = true;
    try {
      const selection = await deps.roleRuntime.automaticRole("architect", ctx);
      const latest = state.workflowState;
      const latestIdentity = workflowReplanIdentity(latest);
      if (!latestIdentity || !sameReplanIdentity(latestIdentity, identity)) return;
      if (selection.result.role !== "architect") {
        state.workflowDispatchInFlight = false;
        ctx.ui.notify(
          `工作流已暂停等待架构师重规划：当前角色为 ${selection.result.role}，请切换到架构设计后执行 /pi-init workflow resume。`,
          "warning",
        );
        return;
      }
      deps.messages.sendWorkflowReplanMessage(ctx, identity);
    } catch (error) {
      const latest = state.workflowState;
      const latestIdentity = workflowReplanIdentity(latest);
      if (!latestIdentity || !sameReplanIdentity(latestIdentity, identity)) return;
      state.workflowDispatchInFlight = false;
      ctx.ui.notify(`工作流已暂停等待架构师重规划：${textOf(error)}`, "warning");
    }
  }

  function restoreFromEntry(
    ctx: ExtensionContext,
    branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
    source: ReturnType<typeof latestWorkflowRecoverySource>,
    sessionId: string,
  ) {
    const entry = source.entry;
    if (!entry) return false;
    const recordRestoreError = (failure: { code: string; message: string }, prefix: string) => {
      const restoreError = workflowRestoreErrorForSource(failure, branch, source, sessionId);
      if (!restoreError) return false;
      state.workflowRestoreError = restoreError;
      ctx.ui.notify(`${prefix}（${failure.code}）：${failure.message}`, "error");
      return false;
    };
    const restored = hydrateWorkflowState("data" in entry ? entry.data : undefined);
    if (!restored.ok) return recordRestoreError(restored, "无法恢复工作流状态");
    const recovered = recoverWorkflowState(restored.value, sessionId);
    if (!recovered.ok) return recordRestoreError(recovered, "无法安全恢复工作流");
    const roleValidation = isWorkflowRunning(recovered.value)
      ? validateWorkflowExecutionRoles(recovered.value.tasks, { unfinishedOnly: true })
      : { ok: true as const };
    if (!roleValidation.ok) {
      // Keep the recovered identity only in memory so an explicit cancellation can be persisted safely.
      // Do not persist or dispatch an old plan that assigns executable work to architect.
      deps.store.restoreSnapshot(recovered.value);
      state.workflowRestoreError = { code: roleValidation.code, message: roleValidation.message, ...(source.entryId ? { sourceEntryId: source.entryId } : {}) };
      ctx.ui.notify(`已保存的工作流包含不可执行角色（${roleValidation.code}）：${roleValidation.message}；原记录未修改，任务不会派发。请先检查状态并显式取消旧工作流，再另建计划。`, "error");
      return false;
    }
    if (!recovered.changed) { deps.store.restoreSnapshot(recovered.value); return false; }
    try {
      deps.store.persistWorkflowState(recovered.value, ctx);
      return true;
    } catch (error) {
      deps.store.restoreSnapshot(undefined);
      state.pendingWorkflowRecovery = recovered.value;
      state.workflowRestoreError = {
        code: typeof error === "object" && error && "code" in error && typeof error.code === "string" ? error.code : "WORKFLOW_RECOVERY_PERSIST_FAILED",
        message: textOf(error),
      };
      ctx.ui.notify(`无法持久化工作流恢复状态：${textOf(error)}`, "error");
      return false;
    }
  }

  function restoreWorkflowState(ctx: ExtensionContext, options?: { updateStatus?: boolean }) {
    deps.setCurrentContext(ctx);
    state.workflowDispatchInFlight = false;
    state.internalContinuationPending = false;
    state.pendingWorkflowRecovery = undefined;
    deps.store.restoreSnapshot(undefined);
    state.workflowRestoreError = undefined;
    const branch = ctx.sessionManager.getBranch();
    const statusUpdated = restoreFromEntry(ctx, branch, latestWorkflowRecoverySource(branch), ctx.sessionManager.getSessionId());
    if (state.workflowState) deps.guardSessionHandoff?.(ctx);
    if (!statusUpdated && options?.updateStatus !== false) deps.report.updateWorkflowStatus(ctx);
  }

  function currentTaskStartCandidate(ctx: ExtensionContext) {
    const current = state.workflowState;
    if (state.runtimeDisposed || state.workflowRestoreError || state.pendingWorkflowRecovery
      || state.roleRecoveryPending || state.roleRecoveryPersistenceFailed
      || !current || !current.currentTaskId || !isWorkflowRunning(current)) return;
    const task = getWorkflowTask(current, current.currentTaskId);
    const identity = workflowHandoffIdentity(current);
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!task || task.status !== "in_progress" || !identity
      || typeof sessionId !== "string" || sessionId !== current.sessionId || identity.sessionId !== sessionId) return;
    if (!["dispatching", "queued"].includes(current.handoff?.phase ?? "")) return;
    if (task.startedAt !== undefined || task.executionStartedAt !== undefined || current.handoff?.startedAt !== undefined) return;
    return { current, task, identity };
  }

  function persistCurrentTaskStarted(ctx: ExtensionContext, candidate: NonNullable<ReturnType<typeof currentTaskStartCandidate>>) {
    try {
      const transition = transitionWorkflowDispatch(candidate.current, { type: "task-started", identity: candidate.identity }, Date.now());
      if (transition.state !== candidate.current) deps.store.persistWorkflowState(transition.state, ctx);
    } catch (error) {
      ctx.ui.notify(`无法持久化任务 ${candidate.task.id} 的实际启动身份：${textOf(error)}；任务结果将保持未验收`, "error");
    }
  }

  function markCurrentTaskStarted(ctx: ExtensionContext) {
    const candidate = currentTaskStartCandidate(ctx);
    if (!candidate || !workflowHandoffMessageOnBranch(ctx, candidate.identity)) return;
    persistCurrentTaskStarted(ctx, candidate);
  }

  function markCurrentTaskStartedFromMessage(ctx: ExtensionContext, message: unknown) {
    const candidate = currentTaskStartCandidate(ctx);
    if (!candidate || !validateWorkflowTaskStartMessage(message, candidate.identity).ok) return;
    // Pi's no-turn custom-message path appends to the branch before message_start;
    // the active agent-loop path emits this event before the matching branch entry exists.
    if (workflowHandoffMessageOnBranch(ctx, candidate.identity)) return;
    persistCurrentTaskStarted(ctx, candidate);
  }

  function persistDispatchPause(ctx: ExtensionContext, workflowState: WorkflowState, taskId: string) {
    try {
      deps.store.persistWorkflowState(workflowState, ctx);
      state.workflowDispatchInFlight = false;
      return true;
    } catch (error) {
      state.workflowDispatchInFlight = false;
      ctx.ui.notify(`无法记录任务 ${taskId} 的暂停状态：${textOf(error)}`, "error");
      return false;
    }
  }

  async function prepareAndDispatchCurrentTask(
    ctx: ExtensionContext,
    taskId: string,
  ) {
    const before = state.workflowState;
    const identity = before ? workflowHandoffIdentity(before) : undefined;
    const task = before ? getWorkflowTask(before, taskId) : undefined;
    if (!before || !identity || !task || before.currentTaskId !== taskId) return;
    try {
      if (["prepared", "compacting"].includes(before.handoff?.phase ?? "")) {
        deps.store.persistWorkflowState(setWorkflowHandoffPhase(before, "waiting-role"), ctx);
      }
      const selection = await deps.roleRuntime.automaticRole(task.role, ctx);
      if (state.userStopRequested || !currentHandoff(identity)) return;
      if (selection.result.role !== task.role) {
        const paused = blockWorkflowTask(state.workflowState!, {
          taskId,
          reason: `角色模式选择了 ${selection.result.role}，而任务要求 ${task.role}`,
        });
        if (!persistDispatchPause(ctx, paused, taskId)) return;
        ctx.ui.notify(deps.report.formatWorkflowPauseSummary(paused), "warning");
        return;
      }

      deps.messages.sendWorkflowTaskMessage(ctx, taskId, undefined, identity);
      deps.report.updateWorkflowStatus(ctx);
    } catch (error) {
      const current = state.workflowState;
      if (!current || !currentHandoff(identity)) return;
      const paused = blockWorkflowTask(current, {
        taskId,
        reason: `无法切换到 ${task.role}：${textOf(error)}`,
      });
      if (!persistDispatchPause(ctx, paused, taskId)) return;
      ctx.ui.notify(deps.report.formatWorkflowPauseSummary(paused), "error");
    }
  }

  async function scheduleWorkflow(ctx: ExtensionContext, expectedIdentity?: WorkflowActionIdentity) {
    state.traceHandoff?.(ctx, "workflow.schedule", { localScheduleInFlight });
    if (state.userStopRequested || state.roleRecoveryPending || state.roleRecoveryPersistenceFailed) return;
    if (state.pendingWorkflowRecovery) {
      try {
        deps.store.persistWorkflowState(state.pendingWorkflowRecovery, ctx);
        state.pendingWorkflowRecovery = undefined;
      } catch (error) {
        ctx.ui.notify(`工作流恢复状态尚未持久化，暂不派发任务：${textOf(error)}`, "error");
        return;
      }
    }
    if (state.workflowRestoreError || localScheduleInFlight || state.workflowDispatchInFlight || !state.workflowState) return;
    if (expectedIdentity && !sameActionIdentity(workflowActionIdentity(state.workflowState), expectedIdentity)) return;
    localScheduleInFlight = true;
    try { await scheduleWorkflowInternal(ctx); }
    finally { localScheduleInFlight = false; }
  }

  async function scheduleWorkflowInternal(ctx: ExtensionContext) {
    if (state.userStopRequested) return;
    const current = state.workflowState;
    if (!current) return;
    const roleValidation = validateWorkflowExecutionRoles(current.tasks, { unfinishedOnly: true });
    if (!roleValidation.ok) {
      state.workflowRestoreError = { code: roleValidation.code, message: roleValidation.message };
      state.workflowDispatchInFlight = false;
      ctx.ui.notify(`工作流任务不可派发（${roleValidation.code}）：${roleValidation.message}`, "error");
      return;
    }
    if (deps.offerSessionHandoff?.(ctx)) return;
    const effect = selectWorkflowScheduleEffect(current);
    if (!effect) return;
    if (effect.kind === "replan") {
      await scheduleWorkflowReplan(ctx);
      return;
    }
    if (effect.kind === "dispatch-task") {
      state.workflowDispatchInFlight = true;
      await prepareAndDispatchCurrentTask(ctx, effect.taskId);
      return;
    }
    if (effect.kind === "nudge-task") {
      state.traceHandoff?.(ctx, "workflow.nudge_requested");
      if ((current.nudgeCount ?? 0) + 1 >= WORKFLOW_MAX_NUDGES) {
        const settlement = deps.toolsSettled?.(ctx);
        if (!settlement?.ok) {
          const paused = markWorkflowTaskOutcomeUnknown(current, {
            taskId: current.currentTaskId!, reason: settlement?.message ?? "缺少工具结果收敛依据，不能将停滞登记为已知阻塞。",
          });
          if (persistDispatchPause(ctx, paused, current.currentTaskId!)) ctx.ui.notify(deps.report.formatWorkflowPauseSummary(paused), "warning");
          return;
        }
      }
      const nudged = recordWorkflowNudge(current);
      if (nudged === current) return;
      deps.store.persistWorkflowState(nudged, ctx);
      if (nudged.status === "paused") {
        ctx.ui.notify(deps.report.formatWorkflowPauseSummary(nudged), "warning");
        return;
      }
      const identity = workflowHandoffIdentity(nudged);
      if (identity) {
        const corrective = nudged.nudgeCount === WORKFLOW_MAX_NUDGES - 1;
        const note = corrective
          ? "无进展纠偏（仅此一次）：近期未登记新的阶段进展或提交任务结果。停止重复查询相同 status、反复读取已检查内容或重复重规划；复用已核实成果，推进当前任务下一项具体工作。已有阶段成果时可用真实新来源保存checkpoint，不为刷新计数重复检查或改写文案，也不要求每轮登记。不得重放未知副作用；无法安全继续时如实block，达到当前验收后complete，不把阶段进展冒充整项完成。"
          : "当前任务尚未完成；沿现有成果继续下一项具体工作，使用本消息中的当前执行身份。需要保留真实阶段成果时可按需checkpoint；重复旧来源不刷新进展，也不要求每轮保存。满足验收后complete，确有阻塞时block。";
        deps.messages.sendWorkflowTaskMessage(ctx, identity.taskId, note, identity);
      }
      deps.report.updateWorkflowStatus(ctx);
      return;
    }

    state.workflowDispatchInFlight = true;
    const started = setWorkflowHandoffPhase(startWorkflowTask(current, effect.taskId), "waiting-role");
    try {
      deps.store.persistWorkflowState(started, ctx);
    } catch (error) {
      state.workflowDispatchInFlight = false;
      throw error;
    }
    await prepareAndDispatchCurrentTask(ctx, effect.taskId);
  }

  async function resumeLocalWorkflow(ctx: ExtensionContext) {
    const workflow = state.workflowState;
    if (!workflow || workflow.executor !== "local" || workflow.status !== "running") {
      throw new Error("只有运行中的 Local 工作流可以执行安全恢复");
    }
    const handoff = workflow.handoff;
    const blocked = matchPolicy([
      [() => workflow.continuation?.kind !== "review" && workflow.continuation?.phase === "compacting", ["blocked-by-compaction", "任务边界压缩尚未确认收敛，未切换角色或派发；请 /reload 后核对暂停状态，再显式 resume。", "warning"] as const],
      [() => state.internalContinuationPending, ["continuation-pending", "自动任务交接消息已排队，未重复派发任务。", "info"] as const],
      [() => handoff && ["dispatching", "queued"].includes(handoff.phase), ["continuation-pending", "任务交接已进入派发阶段；结果未确认，不会重发，请等待实际执行或核对恢复状态。", "warning"] as const],
      [() => handoff?.phase === "executing", ["already-started", `任务 ${handoff?.taskId} 已真实启动，未重复派发任务。`, "info"] as const],
      [() => localScheduleInFlight, ["dispatch-in-flight", "任务交接调度仍在进行，未重复派发任务。", "info"] as const],
    ]);
    if (blocked) {
      ctx.ui.notify(blocked[1], blocked[2]);
      return blocked[0];
    }
    resetStaleWorkflowDispatch();
    await scheduleWorkflow(ctx);
    return "scheduled";
  }

  function resetStaleWorkflowDispatch() {
    if (localScheduleInFlight) return false;
    state.workflowDispatchInFlight = false;
    return true;
  }

  return {

    scheduleWorkflowReplan,
    restoreWorkflowState,
    markCurrentTaskStarted,
    markCurrentTaskStartedFromMessage,
    scheduleWorkflow,
    resumeLocalWorkflow,
    resetStaleWorkflowDispatch,
  };
}

export type WorkflowDispatch = ReturnType<typeof createWorkflowDispatch>;
