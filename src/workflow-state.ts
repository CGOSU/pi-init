import { randomUUID } from "node:crypto";
import { hasOwn } from "./value-guards.ts";
import { WORKFLOW_STATE_VERSION } from "./workflow-protocol.ts";
import {
  assertSupportedWorkflowFeatures, assertWorkflowGoalReferences, normalizeExecutor,
  normalizeIdentityToken, requireRecord, validateWorkflowPlan, workflowError,
} from "./workflow-validation.ts";
import { getWorkflowExecutionBounds } from "./workflow-queries.ts";
import type {
  WorkflowPlanSnapshot, WorkflowPlanSummary, WorkflowRevision, WorkflowState, WorkflowStateCore, WorkflowTask,
} from "./workflow-types.ts";

export function cloneTask(task: WorkflowTask): WorkflowTask {
  return {
    ...task,
    files: [...task.files],
    acceptanceCriteria: [...task.acceptanceCriteria],
    dependsOn: [...task.dependsOn],
    ...(task.verification ? { verification: task.verification.map(check => typeof check === "string" ? check : { ...check }) } : {}),
    ...(task.verificationEvidenceIds ? { verificationEvidenceIds: [...task.verificationEvidenceIds] } : {}),
    ...(task.delegation ? { delegation: { ...task.delegation } } : {}),
  };
}

export function clonePlan(plan: WorkflowPlanSummary | WorkflowPlanSnapshot): WorkflowPlanSummary {
  return {
    summary: plan.summary,
    constraints: [...(plan.constraints ?? [])],
  };
}

export function cloneRevision(revision: WorkflowRevision): WorkflowRevision {
  return {
    ...revision,
    ...(revision.retainedTaskIds ? { retainedTaskIds: [...revision.retainedTaskIds] } : {}),
    ...(revision.replacedTaskIds ? { replacedTaskIds: [...revision.replacedTaskIds] } : {}),
    ...(revision.addedTaskIds ? { addedTaskIds: [...revision.addedTaskIds] } : {}),
    ...(revision.previousPlan ? { previousPlan: clonePlan(revision.previousPlan) } : {}),
    ...(revision.previousTaskIds ? { previousTaskIds: [...revision.previousTaskIds] } : {}),
    ...(revision.previousTasks ? { previousTasks: revision.previousTasks.map(cloneTask) } : {}),
    ...(revision.replacedTasks ? { replacedTasks: revision.replacedTasks.map(cloneTask) } : {}),
    ...(revision.newPlan
      ? {
          newPlan: {
            ...clonePlan(revision.newPlan),
            tasks: revision.newPlan.tasks.map(cloneTask),
          },
        }
      : {}),
  };
}

export function createWorkflowState(input: unknown, now = Date.now()): WorkflowState {
  const plan = validateWorkflowPlan(input);
  const source = requireRecord(input, "工作流规划格式无效");
  const executor = normalizeExecutor(source.executor);
  const workflowId = normalizeIdentityToken(source.workflowId ?? randomUUID(), "工作流 workflowId");
  const sessionId = normalizeIdentityToken(source.sessionId, "工作流 sessionId");
  assertWorkflowGoalReferences(undefined, workflowId, plan.tasks);
  return {
    version: WORKFLOW_STATE_VERSION,
    workflowId,
    sessionId,
    planVersion: 0,
    recoveryGeneration: 0,
    executor,
    authority: executor,
    status: plan.reviewRequired ? "paused" : "running",
    pauseReason: plan.reviewRequired ? "architecture-review" : undefined,
    continuation: plan.reviewRequired ? { kind: "review" } : { kind: "schedule", phase: "pending", reason: "plan-created" },
    plan: {
      summary: plan.summary,
      constraints: plan.constraints,
    },
    tasks: plan.tasks,
    currentTaskId: undefined,
    nudgeCount: 0,
    revisions: [],
    createdAt: now,
    updatedAt: now,
    pausedMilliseconds: 0,
  };
}

/**
 * Prepare an independent state for a transition at `now`, not a generic deep clone.
 * Accrue elapsed pause time before advancing updatedAt; also normalize the version,
 * identity counters and executor while copying nested mutable state.
 */
export function cloneWorkflowStateCore(state: WorkflowStateCore, now = state.updatedAt ?? Date.now()): WorkflowStateCore {
  const { startedAt } = getWorkflowExecutionBounds(state);
  const pauseStart = Math.max(startedAt ?? now, state.updatedAt ?? now);
  const pausedMilliseconds = state.pausedMilliseconds === undefined ? undefined
    : (state.status === "paused" || state.stoppedAt !== undefined) && startedAt !== undefined
      ? state.pausedMilliseconds + Math.max(0, now - pauseStart)
      : state.pausedMilliseconds;
  return {
    ...state,
    ...(pausedMilliseconds !== undefined ? { pausedMilliseconds } : {}),
    version: WORKFLOW_STATE_VERSION,
    planVersion: state.planVersion ?? 0,
    recoveryGeneration: state.recoveryGeneration ?? 0,
    executor: normalizeExecutor(state.executor),
    ...(state.authority !== undefined ? { authority: normalizeExecutor(state.authority) } : {}),
    plan: clonePlan(state.plan),
    tasks: state.tasks.map(cloneTask),
    ...(state.goals ? { goals: state.goals.map((goal) => ({ ...goal, constraints: [...goal.constraints] })) } : {}),
    revisions: (state.revisions ?? []).map(cloneRevision),
    ...(state.pendingRevision ? { pendingRevision: { ...state.pendingRevision } } : {}),
    ...(state.handoff ? { handoff: { ...state.handoff } } : {}),
    ...(state.continuation ? { continuation: { ...state.continuation } } : {}),
    updatedAt: now,
  };
}

/** Validate feature/authority boundaries, then prepare a transition copy. */
export function cloneState(state: WorkflowState, now = Date.now()): WorkflowState {
  assertSupportedWorkflowFeatures(state);
  if (hasOwn(state, "runtimeAuthority")) {
    throw workflowError("WORKFLOW_STATE_RUNTIME_RETIRED", "旧 Runtime 工作流 authority 已退役；不能克隆或本地执行");
  }
  const executor = normalizeExecutor(state.executor);
  const authority = normalizeExecutor(
    hasOwn(state, "authority") ? state.authority : executor,
  );
  if (authority !== executor) throw new Error("工作流 authority 不允许在创建后切换");
  return {
    ...cloneWorkflowStateCore(state, now),
    executor,
    authority,
  };
}
