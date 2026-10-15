import {
  cloneState,
  cloneWorkflowParentFrame,
  cloneWorkflowStateCore,
  createWorkflowState,
} from "./workflow-model.ts";
import type {
  WorkflowParentFrame,
  WorkflowState,
  WorkflowStateCore,
  WorkflowSubworkflowSummary,
} from "./workflow-types.ts";
import { normalizeSubworkflowContract, assertSubworkflowTaskScope } from "./workflow-subworkflow.ts";
import { requestWorkflowReplan } from "./workflow-replan.ts";
import { cancelWorkflow } from "./workflow-transitions.ts";

function toWorkflowStateCore(state: WorkflowState): WorkflowStateCore {
  const { parentStack: _parentStack, ...core } = state;
  return core;
}

export function createNestedWorkflowState(parentState: WorkflowState, planInput: unknown, now = Date.now()): WorkflowState {
  const pendingRevision = parentState.pendingRevision;
  if (parentState.status !== "replanning" || pendingRevision?.kind !== "nested" || !pendingRevision.childGoal) {
    throw Object.assign(new Error("当前工作流没有待规划的嵌套目标"), { code: "WORKFLOW_NESTED_REQUEST_MISSING" });
  }
  if (parentState.currentTaskId || parentState.handoff) {
    throw Object.assign(new Error("父工作流必须先到达安全任务边界，才能开始嵌套工作流"), { code: "WORKFLOW_NESTED_PARENT_NOT_AT_BOUNDARY" });
  }
  if (parentState.parentStack?.length) {
    throw Object.assign(new Error("仅允许一层活动子流程；请在当前子流程内拆分任务"), { code: "WORKFLOW_NESTED_DEPTH_LIMIT" });
  }
  const contract = normalizeSubworkflowContract((planInput as Record<string, unknown>)?.subworkflowContract);

  const childState = createWorkflowState({
    ...(planInput as Record<string, unknown>),
    sessionId: parentState.sessionId,
    executor: parentState.executor,
  }, now);
  assertSubworkflowTaskScope(contract, childState.tasks);
  if (childState.workflowId === parentState.workflowId
    || parentState.parentStack?.some((frame) => frame.state.workflowId === childState.workflowId)) {
    throw Object.assign(new Error("嵌套工作流身份必须与祖先工作流不同"), { code: "WORKFLOW_NESTED_IDENTITY_COLLISION" });
  }

  const parentSnapshot = cloneState(parentState, now);
  parentSnapshot.status = "paused";
  parentSnapshot.pauseReason = "waiting-child-workflow";
  delete parentSnapshot.taskPauseReason;
  delete parentSnapshot.pendingRevision;
  delete parentSnapshot.handoff;
  delete parentSnapshot.currentTaskId;
  delete parentSnapshot.continuation;
  const revisionIndex = parentSnapshot.revisions.findIndex((revision) => revision.revisionId === pendingRevision.revisionId);
  if (revisionIndex < 0 || parentSnapshot.revisions[revisionIndex].status !== "requested") {
    throw Object.assign(new Error("嵌套工作流请求缺少有效 revision 审计记录"), { code: "WORKFLOW_NESTED_REVISION_MISSING" });
  }
  parentSnapshot.revisions[revisionIndex] = {
    ...parentSnapshot.revisions[revisionIndex],
    status: "applied",
    appliedAt: now,
  };

  const frame: WorkflowParentFrame = {
    ...(pendingRevision.requestedFromTaskId ? { parentTaskId: pendingRevision.requestedFromTaskId } : {}),
    state: toWorkflowStateCore(parentSnapshot),
  };
  childState.parentStack = [
    ...(parentState.parentStack ?? []).map((ancestor) => cloneWorkflowParentFrame(ancestor, now)),
    frame,
  ];
  childState.subworkflowHistory = [];
  childState.subworkflowContract = contract;
  return childState;
}

function createSubworkflowSummary(
  childState: WorkflowState,
  parentFrame: WorkflowParentFrame,
  status: "completed" | "cancelled",
  now: number,
): WorkflowSubworkflowSummary {
  return {
    workflowId: childState.workflowId,
    parentWorkflowId: parentFrame.state.workflowId,
    ...(parentFrame.parentTaskId ? { parentTaskId: parentFrame.parentTaskId } : {}),
    planVersion: childState.planVersion,
    summary: childState.plan.summary,
    status,
    ...(childState.subworkflowContract ? { contract: structuredClone(childState.subworkflowContract) } : {}),
    tasks: childState.tasks.map(({ id, task, status: taskStatus, completionSummary, verification, outcomeUnknown }) => ({
      id,
      task,
      status: taskStatus,
      ...(completionSummary !== undefined ? { completionSummary } : {}),
      ...(verification ? { verification: [...verification] } : {}),
      ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
    })),
    ...(childState.startedAt !== undefined ? { startedAt: childState.startedAt } : {}),
    completedAt: childState.completedAt ?? now,
  };
}

export function returnFromNestedWorkflow(
  childState: WorkflowState,
  status: "completed" | "cancelled",
  now = Date.now(),
): WorkflowState | undefined {
  const parentStack = childState.parentStack;
  if (!parentStack?.length) return undefined;
  const parentFrame = parentStack[parentStack.length - 1];
  const parentState: WorkflowState = {
    ...cloneWorkflowStateCore(parentFrame.state, now),
    parentStack: parentStack.slice(0, -1).map((frame) => cloneWorkflowParentFrame(frame, now)),
  };
  parentState.status = "running";
  parentState.recoveryGeneration += 1;
  delete parentState.pauseReason;
  delete parentState.taskPauseReason;
  delete parentState.pendingRevision;
  delete parentState.handoff;
  delete parentState.currentTaskId;
  delete parentState.completedAt;
  parentState.continuation = {
    kind: "schedule",
    phase: "pending",
    reason: status === "completed" ? "child-completed" : "child-cancelled",
  };
  parentState.subworkflowHistory = [
    ...(parentState.subworkflowHistory ?? []),
    createSubworkflowSummary(childState, parentFrame, status, now),
    ...(childState.subworkflowHistory ?? []),
  ];
  parentState.updatedAt = now;
  const review = requestWorkflowReplan(parentState, { direction: `审阅子流程「${childState.plan.summary}」的${status === "completed" ? "完成" : "取消"}结果：核查输出契约、实际验证、副作用以及父计划是否仍成立。未验收前不得启动父任务。` }, now);
  review.pauseReason = "child-result-review";
  return review;
}

export function cancelWorkflowTree(state: WorkflowState, now: number): WorkflowState {
  let cancelled = cancelWorkflow(state, now);
  while (cancelled.parentStack?.length) {
    const parent = returnFromNestedWorkflow(cancelled, "cancelled", now)!;
    cancelled = cancelWorkflow(parent, now);
  }
  return cancelled;
}
