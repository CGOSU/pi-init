import { randomUUID } from "node:crypto";
import { cloneState } from "./workflow-state.ts";
import { WORKFLOW_STATE_VERSION } from "./workflow-protocol.ts";
import type { HydratedWorkflowState, WorkflowRecoveryResult, WorkflowState } from "./workflow-types.ts";

// Hydration validates stored data; recovery migrates identities and fences unobserved execution.
function hasWorkflowIdentity(state: HydratedWorkflowState): state is WorkflowState {
  return typeof state.workflowId === "string"
    && typeof state.sessionId === "string"
    && typeof state.planVersion === "number" && Number.isSafeInteger(state.planVersion) && state.planVersion >= 0
    && typeof state.recoveryGeneration === "number" && Number.isSafeInteger(state.recoveryGeneration) && state.recoveryGeneration >= 0;
}

export function recoverWorkflowState(
  state: HydratedWorkflowState,
  currentSessionId: unknown,
): WorkflowRecoveryResult {
  if (typeof currentSessionId !== "string" || !currentSessionId) {
    return { ok: false, code: "WORKFLOW_SESSION_ID_UNAVAILABLE", message: "无法从 Pi 公共 SessionManager 读取当前 sessionId" };
  }
  const legacy = Number.isInteger(state?.legacySourceVersion);
  if (!legacy && state.sessionId !== currentSessionId) {
    return { ok: false, code: "WORKFLOW_SESSION_MISMATCH", message: "已保存的工作流属于其他 Pi session；不会恢复或重放" };
  }

  if (!legacy && !hasWorkflowIdentity(state)) {
    return { ok: false, code: "WORKFLOW_STATE_INVALID", message: "已保存的工作流缺少有效身份，无法安全恢复" };
  }
  if (!legacy && hasWorkflowIdentity(state)
    && (state.status === "completed" || state.status === "cancelled") && !state.handoff) {
    return { ok: true, value: state, changed: false };
  }

  const workflowId = legacy ? randomUUID() : state.workflowId;
  const sessionId = legacy ? currentSessionId : state.sessionId;
  const planVersion = legacy
    ? (state.revisions ?? []).filter((revision) => revision.status === "applied").length
    : state.planVersion;
  if (typeof workflowId !== "string" || typeof sessionId !== "string"
    || typeof planVersion !== "number" || !Number.isSafeInteger(planVersion) || planVersion < 0) {
    return { ok: false, code: "WORKFLOW_STATE_INVALID", message: "已保存的工作流缺少有效身份，无法安全恢复" };
  }
  const migrated: WorkflowState = {
    ...state,
    workflowId,
    sessionId,
    planVersion,
    recoveryGeneration: (state.recoveryGeneration ?? 0) + 1,
    version: WORKFLOW_STATE_VERSION,
  };
  delete migrated.legacySourceVersion;
  if (!migrated.handoff && migrated.continuation?.kind !== "review"
    && migrated.continuation?.phase === "compacting" && migrated.status !== "paused") {
    migrated.status = "paused";
    migrated.pauseReason = "boundary-compaction-interrupted";
    migrated.taskPauseReason = "任务边界压缩在恢复前未确认完成；结果已保留，核对后执行 /pi-init workflow resume。";
  }
  const currentTask = migrated.currentTaskId
    ? migrated.tasks.find((task) => task.id === migrated.currentTaskId)
    : undefined;
  const legacyInProgressTasks = legacy
    ? migrated.tasks.filter((task) => task.status === "in_progress")
    : [];

  if (legacy && legacyInProgressTasks.length > 0) {
    for (const task of legacyInProgressTasks) {
      task.status = "blocked";
      task.outcomeUnknown = true;
      task.blockReason = "旧工作流缺少 attempt/handoff 身份，无法确认任务是否产生副作用；核对后显式 retry";
    }
    migrated.status = "paused";
    migrated.pauseReason = "legacy-execution-outcome-unknown";
    migrated.taskPauseReason = `任务 ${legacyInProgressTasks.map((task) => task.id).join(", ")} 的旧执行结果未知`;
    migrated.currentTaskId = undefined;
    delete migrated.handoff;
    delete migrated.continuation;
  } else if (migrated.handoff) {
    const previousHandoff = migrated.handoff;
    const hasExecutionEvidence = currentTask?.outcomeUnknown === true
      || currentTask?.executionStartedAt !== undefined
      || currentTask?.startedAt !== undefined
      || previousHandoff.startedAt !== undefined;
    if (!hasExecutionEvidence
      && (previousHandoff.phase === "prepared" || previousHandoff.phase === "waiting-role" || previousHandoff.phase === "compacting")) {
      migrated.handoff = {
        ...previousHandoff,
        attemptId: randomUUID(),
        handoffId: randomUUID(),
        recoveryGeneration: migrated.recoveryGeneration,
        phase: "prepared",
        createdAt: Date.now(),
      };
    } else {
      if (!currentTask) return { ok: false, code: "WORKFLOW_HANDOFF_STATE_MISMATCH", message: "已保存 handoff 找不到当前任务" };
      currentTask.status = "blocked";
      currentTask.outcomeUnknown = true;
      currentTask.blockReason = "任务交接已进入派发/执行阶段但没有业务验收结果；核对可能的副作用后显式 retry";
      migrated.status = "paused";
      migrated.pauseReason = "handoff-outcome-unknown";
      migrated.taskPauseReason = `任务 ${currentTask.id} 的执行结果未知`;
      migrated.currentTaskId = undefined;
      delete migrated.handoff;
      delete migrated.continuation;
      migrated.nudgeCount = 0;
    }
  } else if (migrated.continuation?.kind === "replan") {
    migrated.continuation = {
      ...migrated.continuation,
      phase: "pending",
      handoffId: randomUUID(),
    };
  }

  if (migrated.status === "running" && !migrated.currentTaskId && !migrated.continuation) {
    migrated.continuation = { kind: "schedule", phase: "pending" };
  }
  if (migrated.status === "paused" && migrated.pauseReason === "architecture-review") {
    migrated.continuation = { kind: "review" };
  }
  if (migrated.status === "replanning" && migrated.pendingRevision && !migrated.continuation) {
    migrated.continuation = {
      kind: "replan",
      revisionId: migrated.pendingRevision.revisionId,
      phase: "pending",
      handoffId: randomUUID(),
    };
  }

  // Time since the last saved snapshot is unobserved after reload, not confirmed execution.
  const recovered = cloneState({ ...migrated, status: "paused" });
  recovered.status = migrated.status;
  return { ok: true, value: recovered, changed: true };
}
