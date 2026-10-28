import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectWorkflowScheduleEffect, transitionWorkflowDispatch } from "../src/workflow-orchestrator.ts";
import type { } from "../src/workflow-types.ts";
import {
    blockWorkflowTask,
    ensureWorkflowReplanHandoff,
    getWorkflowTask,
    hydrateWorkflowState,
    isWorkflowActive,
    recordWorkflowNudge,
    recoverWorkflowState,
    setWorkflowHandoffPhase,
    startWorkflowTask,
    validateWorkflowExecutionRoles,
    WORKFLOW_MAX_NUDGES,
    workflowActionIdentity,
    workflowHandoffIdentity,
    workflowHandoffMessageOnBranch
} from "../src/workflow.ts";
import type { RoleRuntime } from "./role-runtime.ts";
import {
    textOf,
    type ExtensionRuntimeState,
    type WorkflowActionIdentity,
    type WorkflowHandoffIdentity,
    type WorkflowReplanIdentity,
    type WorkflowState,
} from "./runtime-state.ts";
import type { WorkflowMessages } from "./workflow-messages.ts";
import { latestWorkflowRecoverySource, workflowRestoreErrorForSource } from "./workflow-recovery.ts";
import type { WorkflowReport } from "./workflow-report.ts";
import { validateWorkflowTaskStartMessage } from "./workflow-start-evidence.ts";

export type WorkflowDispatchDependencies = {
  roleRuntime: RoleRuntime;
  offerSessionHandoff?: (ctx: ExtensionContext) => boolean;
  guardSessionHandoff?: (ctx: ExtensionContext) => void;
  messages: WorkflowMessages;
  report: WorkflowReport;
  setCurrentContext: (ctx: ExtensionContext) => void;
};

function workflowIdentity(state: WorkflowState): WorkflowActionIdentity {
  const identity = workflowActionIdentity(state);
  if (!identity) throw new Error("工作流状态缺少基础动作身份");
  return identity;
}

function sameIdentity(left: WorkflowActionIdentity, right: WorkflowActionIdentity) {
  return left.workflowId === right.workflowId
    && left.planVersion === right.planVersion
    && left.sessionId === right.sessionId
    && left.recoveryGeneration === right.recoveryGeneration;
}

function sameReplanIdentity(left: WorkflowReplanIdentity, right: WorkflowReplanIdentity) {
  return sameIdentity(left, right)
    && left.revisionId === right.revisionId
    && left.handoffId === right.handoffId;
}

// An accepted side ledger is not an opt-in. Existing contracts or an explicit
// workflow link are: deleting a contract must not downgrade an old formal plan.

export function createWorkflowDispatch(
  state: ExtensionRuntimeState,
  deps: WorkflowDispatchDependencies,
) {
  let localScheduleInFlight = false;
  function currentHandoff(expected: WorkflowHandoffIdentity) {
    const current = state.workflowState;
    const actual = current ? workflowHandoffIdentity(current) : undefined;
    return actual !== undefined
      && sameIdentity(actual, expected)
      && actual.taskId === expected.taskId
      && actual.attemptId === expected.attemptId
      && actual.handoffId === expected.handoffId;
  }

  function replanIdentity(current: WorkflowState): WorkflowReplanIdentity | undefined {
    if (current.status !== "replanning" || !current.pendingRevision || current.continuation?.kind !== "replan" || !current.continuation.handoffId) {
      return undefined;
    }
    return {
      ...workflowIdentity(current),
      revisionId: current.pendingRevision.revisionId,
      handoffId: current.continuation.handoffId,
    };
  }

  async function scheduleWorkflowReplan(ctx: ExtensionContext) {
    if (
      state.workflowDispatchInFlight
      || state.roleCompactionInFlight
      || state.pendingRoleCompaction
      || !state.workflowState
      || state.workflowState.status !== "replanning"
      || !state.workflowState.pendingRevision
    ) return;

    let current = state.workflowState;
    if (current.continuation?.kind === "replan" && ["dispatching", "queued"].includes(current.continuation.phase)) return;
    const ensured = ensureWorkflowReplanHandoff(current);
    if (!ensured) return;
    if (ensured !== current) deps.report.persistWorkflowState(ensured, ctx);
    current = ensured;
    const identity = replanIdentity(current);
    if (!identity) return;

    state.workflowDispatchInFlight = true;
    try {
      const selection = await deps.roleRuntime.automaticRole("architect", ctx);
      const latest = state.workflowState;
      const latestIdentity = latest ? replanIdentity(latest) : undefined;
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
      const latestIdentity = latest ? replanIdentity(latest) : undefined;
      if (!latestIdentity || !sameReplanIdentity(latestIdentity, identity)) return;
      state.workflowDispatchInFlight = false;
      ctx.ui.notify(`工作流已暂停等待架构师重规划：${textOf(error)}`, "warning");
    }
  }

  function restoreWorkflowState(ctx: ExtensionContext) {
    deps.setCurrentContext(ctx);

    state.workflowDispatchInFlight = false;
    state.internalContinuationPending = false;

    state.pendingWorkflowRecovery = undefined;
    state.workflowState = undefined;
    state.workflowRestoreError = undefined;
    const branch = ctx.sessionManager.getBranch();
    const source = latestWorkflowRecoverySource(branch);
    const { entry, entryId: sourceEntryId } = source;
    const sessionId = ctx.sessionManager.getSessionId();
    if (entry) {
      const data = "data" in entry ? entry.data : undefined;
      const restored = hydrateWorkflowState(data);
      if (!restored.ok) {
        const restoreError = workflowRestoreErrorForSource(restored, branch, source, sessionId);
        if (restoreError) {
          state.workflowRestoreError = restoreError;
          ctx.ui.notify(`无法恢复工作流状态（${restored.code}）：${restored.message}`, "error");
        }
      } else {
        const recovered = recoverWorkflowState(restored.value, sessionId);
        if (!recovered.ok) {
          const restoreError = workflowRestoreErrorForSource(recovered, branch, source, sessionId);
          if (restoreError) {
            state.workflowRestoreError = restoreError;
            ctx.ui.notify(`无法安全恢复工作流（${recovered.code}）：${recovered.message}`, "error");
          }
        } else {
          const roleValidation = isWorkflowActive(recovered.value)
            ? validateWorkflowExecutionRoles(recovered.value.tasks, { unfinishedOnly: true })
            : { ok: true as const };
          if (!roleValidation.ok) {
            // Keep the recovered identity only in memory so an explicit cancellation can be persisted safely.
            // Do not persist or dispatch an old plan that assigns executable work to architect.
            state.workflowState = recovered.value;
            state.workflowRestoreError = { code: roleValidation.code, message: roleValidation.message, ...(sourceEntryId ? { sourceEntryId } : {}) };
            ctx.ui.notify(
              `已保存的工作流包含不可执行角色（${roleValidation.code}）：${roleValidation.message}；原记录未修改，任务不会派发。请先检查状态并显式取消旧工作流，再另建计划。`,
              "error",
            );
          } else if (!recovered.changed) {
            state.workflowState = recovered.value;
          } else {
            try {
              deps.report.persistWorkflowState(recovered.value, ctx);
            } catch (error) {
              state.workflowState = undefined;
              state.pendingWorkflowRecovery = recovered.value;
              state.workflowRestoreError = {
                code: typeof error === "object" && error && "code" in error && typeof error.code === "string"
                  ? error.code
                  : "WORKFLOW_RECOVERY_PERSIST_FAILED",
                message: textOf(error),
              };
              ctx.ui.notify(`无法持久化工作流恢复状态：${textOf(error)}`, "error");
            }
            if (state.workflowState === recovered.value) {
                  }
          }
        }
      }
    }
    if (state.workflowState) deps.guardSessionHandoff?.(ctx);
    deps.report.updateWorkflowStatus(ctx);
  }

  function currentTaskStartCandidate(ctx: ExtensionContext) {
    const current = state.workflowState;
    if (state.runtimeDisposed || state.workflowRestoreError || state.pendingWorkflowRecovery
      || state.roleRecoveryPending || state.roleRecoveryPersistenceFailed
      || !current || !current.currentTaskId || !isWorkflowActive(current)) return;
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
      if (transition.state !== candidate.current) deps.report.persistWorkflowState(transition.state, ctx);
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
      deps.report.persistWorkflowState(workflowState, ctx);
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
      if (["prepared", "waiting-role", "compacting"].includes(before.handoff?.phase ?? "")) {
        deps.report.persistWorkflowState(setWorkflowHandoffPhase(before, "waiting-role"), ctx);
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
    if (state.userStopRequested) return;
    if (state.pendingWorkflowRecovery) {
      try {
        deps.report.persistWorkflowState(state.pendingWorkflowRecovery, ctx);
        state.pendingWorkflowRecovery = undefined;
      } catch (error) {
        ctx.ui.notify(`工作流恢复状态尚未持久化，暂不派发任务：${textOf(error)}`, "error");
        return;
      }
    }
    if (state.workflowRestoreError || localScheduleInFlight || state.workflowDispatchInFlight || !state.workflowState) return;
    if (expectedIdentity && !sameIdentity(workflowIdentity(state.workflowState), expectedIdentity)) return;
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
    try {
      } catch (error) {
      ctx.ui.notify(`证据绑定同步尚未持久化，已保存任务结果不会重放，暂不派发：${textOf(error)}`, "warning");
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
      const nudged = recordWorkflowNudge(current);
      if (nudged === current) return;
      if (nudged !== current) deps.report.persistWorkflowState(nudged, ctx);
      if (nudged.status === "paused") {
        ctx.ui.notify(deps.report.formatWorkflowPauseSummary(nudged), "warning");
        return;
      }
      const identity = workflowHandoffIdentity(nudged);
      if (identity) {
        const corrective = nudged.nudgeCount === WORKFLOW_MAX_NUDGES - 1;
        const note = corrective
          ? "无进展纠偏（仅此一次）：上一回合仍未提交完成或阻塞结果。停止重复查询相同 status、反复读取已检查内容或重复重规划；复用当前上下文中已核实的事实和已完成成果，直接执行当前任务下一项具体工作。不得重放结果未知或副作用不明的操作；若无法安全继续，立即 block 并如实说明阻塞和可能副作用。完成实际工作与验证后，用本消息当前身份调用 task_workflow(action=complete)。"
          : "上一回合尚未收到任务完成或阻塞结果；请继续当前任务并在结束时调用 task_workflow，使用本消息中的当前执行身份。";
        deps.messages.sendWorkflowTaskMessage(ctx, identity.taskId, note, identity);
      }
      deps.report.updateWorkflowStatus(ctx);
      return;
    }

    state.workflowDispatchInFlight = true;
    const started = startWorkflowTask(current, effect.taskId);
    try {
      deps.report.persistWorkflowState(started, ctx);
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
    if (state.roleCompactionInFlight || state.pendingRoleCompaction) {
      ctx.ui.notify("上下文压缩仍在进行，未重复派发任务；请等待压缩完成，或执行 /reload 后再使用 /pi-init workflow resume。", "warning");
      return "blocked-by-compaction";
    }
    if (workflow.continuation?.kind !== "review" && workflow.continuation?.phase === "compacting") {
      ctx.ui.notify("任务边界压缩尚未确认收敛，未切换角色或派发；请 /reload 后核对暂停状态，再显式 resume。", "warning");
      return "blocked-by-compaction";
    }
    if (state.internalContinuationPending) {
      ctx.ui.notify("自动任务交接消息已排队，未重复派发任务。", "info");
      return "continuation-pending";
    }
    if (handoff && ["dispatching", "queued"].includes(handoff.phase)) {
      ctx.ui.notify("任务交接已进入派发阶段；结果未确认，不会重发，请等待实际执行或核对恢复状态。", "warning");
      return "continuation-pending";
    }
    if (handoff?.phase === "executing") {
      ctx.ui.notify(`任务 ${handoff.taskId} 已真实启动，未重复派发任务。`, "info");
      return "already-started";
    }
    if (!resetStaleWorkflowDispatch()) {
      ctx.ui.notify("任务交接调度仍在进行，未重复派发任务。", "info");
      return "dispatch-in-flight";
    }

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
