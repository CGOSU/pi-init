import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  blockWorkflowTask,
  cloneState,
  ensureWorkflowReplanHandoff,
  getNextWorkflowTask,
  getWorkflowTask,
  hydrateWorkflowState,
  isWorkflowActive,
  markWorkflowTaskStarted,
  recoverWorkflowState,
  recordWorkflowNudge,
  setWorkflowHandoffPhase,
  startWorkflowTask,
  workflowActionIdentity,
  workflowHandoffIdentity,
  workflowHandoffMessageOnBranch,
  validateWorkflowExecutionRoles,
} from "../src/workflow.ts";
import { shouldCompactAfterWorkflowTask } from "../src/roles.ts";
import { latestWorkflowRecoverySource, workflowRestoreErrorForSource } from "./workflow-recovery.ts";
import {
  textOf,
  type ExtensionRuntimeState,
  type RoleCompactionContinuation,
  type WorkflowActionIdentity,
  type WorkflowHandoffIdentity,
  type WorkflowReplanIdentity,
  type WorkflowState,
} from "./runtime-state.ts";
import type { RoleRuntime } from "./role-runtime.ts";
import type { WorkflowMessages } from "./workflow-messages.ts";
import type { WorkflowReport } from "./workflow-report.ts";

export type WorkflowDispatchDependencies = {
  roleRuntime: RoleRuntime;
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

function isTaskCompletionContinuation(continuation: WorkflowState["continuation"]) {
  return (continuation?.kind === "schedule" || continuation?.kind === "replan")
    && continuation.reason === "task-completed";
}

export function createWorkflowDispatch(
  state: ExtensionRuntimeState,
  deps: WorkflowDispatchDependencies,
) {
  let localScheduleInFlight = false;

  function currentPendingRoleCompaction() {
    return state.pendingRoleCompaction;
  }

  function startTaskBoundaryCompaction(
    ctx: ExtensionContext,
    continuation: RoleCompactionContinuation,
    fromRole: string | undefined,
    toRole: string,
  ) {
    if (!fromRole || fromRole === toRole) return false;
    if (!shouldCompactAfterWorkflowTask({ mode: state.roleModeStatus, contextUsage: ctx.getContextUsage() })) return false;

    const current = state.workflowState;
    if (!current) return false;
    if (continuation.kind === "workflow-task") {
      if (current.handoff?.handoffId !== continuation.identity.handoffId) return false;
      deps.report.persistWorkflowState(setWorkflowHandoffPhase(current, "compacting"), ctx);
    } else if (continuation.kind === "workflow-replan" && current.continuation?.kind === "replan") {
      const next = cloneState(current);
      if (next.continuation?.kind === "replan") {
        next.continuation = { ...next.continuation, phase: "compacting" };
        deps.report.persistWorkflowState(next, ctx);
      }
    } else if (continuation.kind === "workflow-schedule" && current.continuation?.kind === "schedule") {
      const next = cloneState(current);
      if (next.continuation?.kind === "schedule") {
        next.continuation = { ...next.continuation, phase: "compacting" };
        deps.report.persistWorkflowState(next, ctx);
      }
    }

    state.pendingRoleCompaction ??= deps.roleRuntime.createPendingRoleCompaction(ctx, fromRole, toRole);
    state.pendingRoleCompaction.continuation = continuation;
    deps.roleRuntime.startPendingRoleCompaction(ctx);
    deps.report.updateWorkflowStatus(ctx);
    return true;
  }

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
    const taskCompletionPending = isTaskCompletionContinuation(current.continuation);
    state.workflowDispatchInFlight = true;
    const previousRole = deps.roleRuntime.activeRoleFor(ctx)?.role;
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
      const pendingRoleCompaction = currentPendingRoleCompaction();
      if (selection.transition && pendingRoleCompaction) {
        pendingRoleCompaction.continuation = { kind: "workflow-replan", identity };
        const refreshed = state.workflowState;
        if (refreshed?.continuation?.kind === "replan") {
          const next = cloneState(refreshed);
          if (next.continuation?.kind === "replan") {
            next.continuation = { ...next.continuation, phase: "compacting" };
            deps.report.persistWorkflowState(next, ctx);
          }
        }
        deps.roleRuntime.startPendingRoleCompaction(ctx);
        deps.report.updateWorkflowStatus(ctx);
        return;
      }
      if (taskCompletionPending && startTaskBoundaryCompaction(
        ctx,
        { kind: "workflow-replan", identity },
        previousRole,
        selection.result.role,
      )) return;
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
    deps.roleRuntime.disposeWorkflowCompaction();
    state.workflowDispatchInFlight = false;
    state.internalContinuationPending = false;
    state.pendingRoleCompaction = undefined;
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
          }
        }
      }
    }
    deps.report.updateWorkflowStatus(ctx);
  }

  function markCurrentTaskStarted(ctx: ExtensionContext) {
    const current = state.workflowState;
    if (!current || !current.currentTaskId || !isWorkflowActive(current)) return;
    const task = getWorkflowTask(current, current.currentTaskId);
    const identity = workflowHandoffIdentity(current);
    if (!task || !identity || task.executionStartedAt !== undefined) return;
    if (!["dispatching", "queued"].includes(current.handoff?.phase ?? "")) return;
    if (!workflowHandoffMessageOnBranch(ctx, identity)) return;
    try {
      deps.report.persistWorkflowState(markWorkflowTaskStarted(current, task.id), ctx);
    } catch (error) {
      ctx.ui.notify(`无法持久化任务 ${task.id} 的实际启动身份：${textOf(error)}；任务结果将保持未验收`, "error");
    }
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

  function blockWorkflowTaskFromDispatch(ctx: ExtensionContext, taskId: string, reason: string) {
    if (state.runtimeDisposed || !state.workflowState || state.workflowState.currentTaskId !== taskId || !isWorkflowActive(state.workflowState)) return;
    try {
      const blocked = blockWorkflowTask(state.workflowState, { taskId, reason });
      deps.report.persistWorkflowState(blocked, ctx);
      state.workflowDispatchInFlight = false;
      ctx.ui.notify(deps.report.formatWorkflowPauseSummary(blocked), "warning");
    } catch (error) {
      state.workflowDispatchInFlight = false;
      ctx.ui.notify(`无法记录任务 ${taskId} 的失败：${textOf(error)}`, "error");
    }
  }

  async function prepareAndDispatchCurrentTask(
    ctx: ExtensionContext,
    taskId: string,
    previousRole: string | undefined,
    taskCompletionPending: boolean,
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
      if (!currentHandoff(identity)) return;
      if (selection.result.role !== task.role) {
        const paused = blockWorkflowTask(state.workflowState!, {
          taskId,
          reason: `角色模式选择了 ${selection.result.role}，而任务要求 ${task.role}`,
        });
        if (!persistDispatchPause(ctx, paused, taskId)) return;
        ctx.ui.notify(deps.report.formatWorkflowPauseSummary(paused), "warning");
        return;
      }

      if (selection.transition && state.pendingRoleCompaction) {
        const current = state.workflowState!;
        deps.report.persistWorkflowState(setWorkflowHandoffPhase(current, "compacting"), ctx);
        state.pendingRoleCompaction.continuation = { kind: "workflow-task", taskId, identity };
        deps.roleRuntime.startPendingRoleCompaction(ctx);
        deps.report.updateWorkflowStatus(ctx);
        return;
      }
      if (taskCompletionPending && startTaskBoundaryCompaction(
        ctx,
        { kind: "workflow-task", taskId, identity },
        previousRole,
        selection.result.role,
      )) return;
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
    if (state.pendingWorkflowRecovery) {
      try {
        deps.report.persistWorkflowState(state.pendingWorkflowRecovery, ctx);
        state.pendingWorkflowRecovery = undefined;
      } catch (error) {
        ctx.ui.notify(`工作流恢复状态尚未持久化，暂不派发任务：${textOf(error)}`, "error");
        return;
      }
    }
    if (state.workflowRestoreError) return;
    if (
      localScheduleInFlight
      || state.workflowDispatchInFlight
      || state.roleCompactionInFlight
      || state.pendingRoleCompaction
      || !state.workflowState
    ) return;
    if (expectedIdentity && !sameIdentity(workflowIdentity(state.workflowState), expectedIdentity)) return;
    localScheduleInFlight = true;
    try {
      await scheduleWorkflowInternal(ctx);
    } finally {
      localScheduleInFlight = false;
    }
  }

  async function scheduleWorkflowInternal(ctx: ExtensionContext) {
    const current = state.workflowState;
    if (!current) return;
    const roleValidation = validateWorkflowExecutionRoles(current.tasks, { unfinishedOnly: true });
    if (!roleValidation.ok) {
      state.workflowRestoreError = { code: roleValidation.code, message: roleValidation.message };
      state.workflowDispatchInFlight = false;
      ctx.ui.notify(`工作流任务不可派发（${roleValidation.code}）：${roleValidation.message}`, "error");
      return;
    }
    if (current.status === "replanning") {
      await scheduleWorkflowReplan(ctx);
      return;
    }
    if (!isWorkflowActive(current)) return;
    if (current.currentTaskId) {
      const handoff = current.handoff;
      if (!handoff) return;
      if (["dispatching", "queued"].includes(handoff.phase)) return;
      if (["prepared", "waiting-role", "compacting"].includes(handoff.phase)) {
        state.workflowDispatchInFlight = true;
        await prepareAndDispatchCurrentTask(
          ctx,
          handoff.taskId,
          deps.roleRuntime.activeRoleFor(ctx)?.role,
          isTaskCompletionContinuation(current.continuation),
        );
        return;
      }
      if (handoff.phase !== "executing") return;
      const nudged = recordWorkflowNudge(current);
      if (nudged === current) return;
      deps.report.persistWorkflowState(nudged, ctx);
      if (nudged.status === "paused") {
        ctx.ui.notify(deps.report.formatWorkflowPauseSummary(nudged), "warning");
        return;
      }
      const identity = workflowHandoffIdentity(nudged);
      if (identity) {
        deps.messages.sendWorkflowTaskMessage(
          ctx,
          identity.taskId,
          "上一回合尚未收到任务完成或阻塞结果；请继续当前任务并在结束时调用 task_workflow，使用本消息中的当前执行身份。",
          identity,
        );
      }
      deps.report.updateWorkflowStatus(ctx);
      return;
    }

    const next = getNextWorkflowTask(current);
    if (!next) return;
    const taskCompletionPending = isTaskCompletionContinuation(current.continuation);
    state.workflowDispatchInFlight = true;
    const previousRole = deps.roleRuntime.activeRoleFor(ctx)?.role;
    const started = startWorkflowTask(current, next.id);
    try {
      deps.report.persistWorkflowState(started, ctx);
    } catch (error) {
      state.workflowDispatchInFlight = false;
      throw error;
    }
    await prepareAndDispatchCurrentTask(ctx, next.id, previousRole, taskCompletionPending);
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
    scheduleWorkflow,
    resumeLocalWorkflow,
    resetStaleWorkflowDispatch,
  };
}

export type WorkflowDispatch = ReturnType<typeof createWorkflowDispatch>;
