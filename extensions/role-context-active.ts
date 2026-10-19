import type { ContextEvent, ContextEventResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isWorkflowActive, workflowHandoffIdentity, workflowReplanIdentity } from "../src/workflow.ts";
import { COORDINATION_EVIDENCE_MESSAGE_TYPE, COORDINATION_REVIEW_MESSAGE_TYPE, coordinationHandoffIdentity } from "./coordination-runtime-protocol.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { reusableToolContext } from "./role-context-reuse.ts";
import { type ContextMessage, WORKFLOW_TASK_MESSAGE_TYPE, WORKFLOW_REPLAN_MESSAGE_TYPE,
  isRecord, messageRecord, identityMatches, isManagedHandoffMessage, branchContainsExactlyOneAnchor, toolCallIds, hasCompleteToolPairs, failOpen } from "./role-context-protocol.ts";

type ContextAnchor = {
  customType: string;
  identity: Record<string, unknown>;
  role: string;
};

function acceptedReviewAnchor(
  state: ExtensionRuntimeState,
  sessionId: string,
  branch: unknown,
): ContextAnchor | undefined {
  const runtime = state.coordinationRuntimeState;
  const latestReview = runtime?.coordination.reviews.at(-1);
  if (
    !runtime
    || runtime.sessionId !== sessionId
    || runtime.handoff
    || runtime.coordination.phase !== "ready"
    || runtime.coordination.workflowLink
    || state.activeRole?.role !== "architect"
    || latestReview?.decision !== "accept"
  ) return undefined;

  const report = runtime.coordination.reports.find((item) => item.reportId === latestReview.reportId);
  const request = report && runtime.coordination.requests.find((item) => item.requestId === report.requestId);
  if (!report || !request) return undefined;

  if (!Array.isArray(branch)) return undefined;
  const matches = branch.filter((entry) => {
    if (!isRecord(entry) || entry.type !== "custom_message" || entry.customType !== COORDINATION_REVIEW_MESSAGE_TYPE) return false;
    const identity = entry.details;
    return isRecord(identity)
      && identity.coordinationId === runtime.coordination.coordinationId
      && identity.coordinationVersion === runtime.coordination.version
      && identity.sessionId === runtime.sessionId
      && identity.recoveryGeneration === runtime.recoveryGeneration
      && identity.requestId === request.requestId
      && identity.reportId === report.reportId
      && identity.role === "architect"
      && identity.kind === "review"
      && typeof identity.attemptId === "string"
      && typeof identity.handoffId === "string";
  });
  if (matches.length !== 1 || !isRecord(matches[0].details)) return undefined;
  return {
    customType: COORDINATION_REVIEW_MESSAGE_TYPE,
    identity: matches[0].details,
    role: "architect",
  };
}

function currentAnchor(
  state: ExtensionRuntimeState,
  branch: unknown,
  sessionId: string,
): ContextAnchor | undefined {
  const coordination = state.coordinationRuntimeState;
  const coordinationHandoff = coordination?.handoff;
  if (coordinationHandoff) {
    if (
      !coordination
      || coordination.sessionId !== sessionId
      || (coordinationHandoff.phase !== "queued" && coordinationHandoff.phase !== "executing")
    ) return undefined;
    const identity = coordinationHandoffIdentity(coordination);
    if (!identity) return undefined;
    return {
      customType: coordinationHandoff.kind === "review"
        ? COORDINATION_REVIEW_MESSAGE_TYPE
        : COORDINATION_EVIDENCE_MESSAGE_TYPE,
      identity: identity as unknown as Record<string, unknown>,
      role: coordinationHandoff.role,
    };
  }

  const workflow = state.workflowState;
  if (!workflow || workflow.sessionId !== sessionId) return acceptedReviewAnchor(state, sessionId, branch);

  if (
    workflow.status === "replanning"
    && workflow.continuation?.kind === "replan"
    && workflow.continuation.phase === "queued"
    && state.activeRole?.role === "architect"
  ) {
    const identity = workflowReplanIdentity(workflow);
    if (identity) return { customType: WORKFLOW_REPLAN_MESSAGE_TYPE, identity, role: "architect" };
  }

  if (isWorkflowActive(workflow) && workflow.currentTaskId) {
    const task = workflow.tasks.find((item) => item.id === workflow.currentTaskId);
    const identity = workflowHandoffIdentity(workflow);
    if (
      task?.status === "in_progress"
      && identity?.taskId === task.id
      && state.activeRole?.role === task.role
      && (workflow.handoff?.phase === "queued" || workflow.handoff?.phase === "executing")
    ) {
      return { customType: WORKFLOW_TASK_MESSAGE_TYPE, identity, role: task.role };
    }
  }

  return acceptedReviewAnchor(state, sessionId, branch);
}

function priorHandoffBoundary(
  messages: readonly ContextMessage[],
  anchorIndex: number,
  branch: unknown,
  sessionId: string,
): { ok: true; index: number } | { ok: false } {
  for (let index = anchorIndex - 1; index >= 0; index -= 1) {
    if (!isManagedHandoffMessage(messages[index])) continue;
    const message = messageRecord(messages[index]);
    if (!message || typeof message.customType !== "string" || !isRecord(message.details)
      || message.details.sessionId !== sessionId) return { ok: false };
    return branchContainsExactlyOneAnchor(branch, message.customType, message.details)
      ? { ok: true, index }
      : { ok: false };
  }
  return { ok: true, index: -1 };
}

function failureContextIndices(
  messages: readonly ContextMessage[],
  startIndex: number,
  endIndex: number,
): Set<number> | undefined {
  const selected = new Set<number>();
  for (let index = startIndex; index < endIndex; index += 1) {
    const record = messageRecord(messages[index]);
    if (!record) return undefined;
    if (record.role === "assistant" && (record.stopReason === "error" || (typeof record.errorMessage === "string" && record.errorMessage))) {
      selected.add(index);
    }
    if (record.role !== "toolResult" || record.isError !== true) continue;
    if (typeof record.toolCallId !== "string") return undefined;
    selected.add(index);
    let callIndex = -1;
    for (let candidate = index - 1; candidate >= startIndex; candidate -= 1) {
      const candidateRecord = messageRecord(messages[candidate]);
      if (candidateRecord?.role !== "assistant") continue;
      const ids = toolCallIds(candidateRecord);
      if (!ids) return undefined;
      if (ids.includes(record.toolCallId)) {
        callIndex = candidate;
        break;
      }
    }
    if (callIndex < 0) return undefined;
    const callRecord = messageRecord(messages[callIndex]);
    const callIds = callRecord && toolCallIds(callRecord);
    if (!callRecord || !callIds || callIds.length === 0) return undefined;
    selected.add(callIndex);
    for (let resultIndex = callIndex + 1; resultIndex < endIndex; resultIndex += 1) {
      const result = messageRecord(messages[resultIndex]);
      if (result?.role === "toolResult" && typeof result.toolCallId === "string" && callIds.includes(result.toolCallId)) {
        selected.add(resultIndex);
      }
    }
  }
  return selected;
}

function hasManagedWork(state: ExtensionRuntimeState) {
  if (state.workflowRestoreError || state.coordinationRestoreError) return true;
  if (state.workflowState && (state.workflowState.status === "running" || state.workflowState.status === "replanning")) return true;
  const coordination = state.coordinationRuntimeState;
  if (coordination?.handoff) return true;
  const latestReview = coordination?.coordination.reviews.at(-1);
  return Boolean(
    coordination
    && !coordination.coordination.workflowLink
    && coordination.coordination.phase === "ready"
    && state.activeRole?.role === "architect"
    && latestReview?.decision === "accept",
  );
}

function needsManagedView(state: ExtensionRuntimeState, sessionId: string) {
  if (state.workflowRestoreError || state.coordinationRestoreError) return true;
  if (state.workflowState?.sessionId === sessionId && (state.workflowState.status === "running" || state.workflowState.status === "replanning")) return true;
  const coordination = state.coordinationRuntimeState;
  if (coordination?.sessionId === sessionId && coordination.handoff) return true;
  const latestReview = coordination?.coordination.reviews.at(-1);
  return Boolean(
    coordination
    && coordination.sessionId === sessionId
    && !coordination.handoff
    && !coordination.coordination.workflowLink
    && coordination.coordination.phase === "ready"
    && state.activeRole?.role === "architect"
    && latestReview?.decision === "accept",
  );
}

export function activeContextView(state: ExtensionRuntimeState, event: ContextEvent, ctx: ExtensionContext): ContextEventResult | undefined {
  let managedWork: boolean;
  try {
    managedWork = hasManagedWork(state);
  } catch {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_STATE_INVALID", "持久化工作流或协调状态结构损坏；完整输入保留且不隔离");
  }
  if (!managedWork) return undefined;
  if (state.workflowRestoreError || state.coordinationRestoreError) {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_RESTORE_UNCERTAIN", "持久协作状态恢复失败；完整输入保留且不隔离");
  }
  if (state.roleCompactionInFlight || state.roleCompactionPhase === "compacting" || state.activeRoleCompaction || state.pendingRoleCompaction) {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_COMPACTION_UNCERTAIN", "当前存在压缩/恢复交接，消息边界映射不确定；完整输入保留且不隔离");
  }

  let sessionId: string;
  let branch: unknown;
  try {
    sessionId = ctx.sessionManager.getSessionId();
    branch = ctx.sessionManager.getBranch();
  } catch {
    if (!hasManagedWork(state)) return undefined;
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_SESSION_UNAVAILABLE", "当前 session/branch 身份不可读取");
  }
  const activeWorkflow = state.workflowState
    && (state.workflowState.status === "running" || state.workflowState.status === "replanning");
  const coordination = state.coordinationRuntimeState;
  const latestReview = coordination?.coordination.reviews.at(-1);
  const activeCoordination = Boolean(coordination?.handoff
    || (coordination
      && !coordination.coordination.workflowLink
      && coordination.coordination.phase === "ready"
      && state.activeRole?.role === "architect"
      && latestReview?.decision === "accept"));
  if (activeWorkflow && state.workflowState?.sessionId !== sessionId) {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_SESSION_MISMATCH", "当前 workflow 属于其他 session；完整输入保留且不隔离");
  }
  if (activeCoordination && coordination?.sessionId !== sessionId) {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_SESSION_MISMATCH", "当前协调 handoff 属于其他 session；完整输入保留且不隔离");
  }
  let managedForSession: boolean;
  try {
    managedForSession = needsManagedView(state, sessionId);
  } catch {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_STATE_INVALID", "持久化工作流或协调状态结构损坏；完整输入保留且不隔离");
  }
  if (!managedForSession) return undefined;
  if (event.messages.some((message) => messageRecord(message)?.role === "system")) {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_SYSTEM_MESSAGE_PRESENT", "context 输入包含 Pi 管理的 system message；为避免触碰 system/tool 状态而保留完整输入");
  }

  let anchor: ContextAnchor | undefined;
  try {
    anchor = currentAnchor(state, branch, sessionId);
  } catch {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_STATE_INVALID", "当前任务/request 身份结构损坏；完整输入保留且不隔离");
  }
  if (!anchor) {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_HANDOFF_UNAVAILABLE", "当前任务/request/role handoff 身份无法可靠映射到 branch");
  }
  let branchMatches: boolean;
  try {
    branchMatches = branchContainsExactlyOneAnchor(branch, anchor.customType, anchor.identity);
  } catch {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_BRANCH_INVALID", "活动 branch 结构损坏；完整输入保留且不隔离");
  }
  if (!branchMatches) {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_BRANCH_MISMATCH", "当前 handoff 在活动 branch 中缺失或重复；可能发生压缩/恢复映射变化");
  }

  const anchorIndices = event.messages.flatMap((message, index) => {
    const record = messageRecord(message);
    return record?.role === "custom"
      && record.customType === anchor.customType
      && identityMatches(record.details, anchor.identity)
      ? [index]
      : [];
  });
  if (anchorIndices.length !== 1) {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_MESSAGE_BOUNDARY_UNAVAILABLE", "当前 handoff 消息在 Pi context 中缺失或重复；完整输入未裁剪");
  }
  const anchorIndex = anchorIndices[0];
  const suffix = event.messages.slice(anchorIndex);
  let previousBoundary: { ok: true; index: number } | { ok: false };
  try {
    previousBoundary = priorHandoffBoundary(event.messages, anchorIndex, branch, sessionId);
  } catch {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_PREVIOUS_BOUNDARY_INVALID", "上一交接边界结构损坏；完整输入保留且不隔离");
  }
  if (!previousBoundary.ok) {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_PREVIOUS_BOUNDARY_UNAVAILABLE", "上一交接消息无法核对当前 branch；完整输入保留且不隔离");
  }
  const previousIndex = previousBoundary.index;
  const userStart = previousIndex >= 0 ? previousIndex + 1 : 0;
  const userIndices = new Set<number>();
  for (let index = userStart; index < anchorIndex; index += 1) {
    if (messageRecord(event.messages[index])?.role === "user") userIndices.add(index);
  }
  if (previousIndex < 0 && userIndices.size > 1) {
    const lastUser = [...userIndices].at(-1);
    userIndices.clear();
    if (lastUser !== undefined) userIndices.add(lastUser);
  }

  const failureStart = previousIndex >= 0 ? previousIndex + 1 : ([...userIndices].at(-1) ?? anchorIndex);
  const failures = failureContextIndices(event.messages, failureStart, anchorIndex);
  if (!failures) {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_FAILURE_BOUNDARY_UNAVAILABLE", "先前失败记录或其工具调用配对不完整");
  }
  const reused = reusableToolContext(event.messages, failureStart, anchorIndex);
  if (!reused) return failOpen(event.messages, "ROLE_CONTEXT_VIEW_REUSE_PAIR_UNSAFE", "上一窗口工具观察配对不完整，未尝试复用裁剪");
  const prefixIndices = [...new Set([...userIndices, ...failures, ...reused.indices])].sort((left, right) => left - right);
  const messages = [...prefixIndices.map((index) => event.messages[index]), ...suffix];
  if (!hasCompleteToolPairs(messages)) {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_TOOL_PAIR_UNSAFE", "裁剪后检测到不完整或重复的工具调用/结果配对");
  }
  if (state.activeRole?.role !== anchor.role) {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_ROLE_MISMATCH", "当前 active role 与 handoff 目标不一致");
  }
  if (reused.retainedGroups > 0) {
    messages.splice(prefixIndices.length, 0, { role: "custom", customType: "pi-init-prior-tool-observations", display: false,
      content: "以上为当前 branch 相邻交接窗口内的历史工具观察，供复用调查和验证；并非当前文件版本、测试结果或执行授权。来源变化、关键缺口或必要安全复核时定向补查，不复用旧角色/attempt/handoff 身份。", timestamp: Date.now() } as ContextMessage);
  }
  state.traceHandoff?.(ctx, "context.reused", { retainedGroups: reused.retainedGroups, retainedChars: reused.retainedChars, omittedGroups: reused.omittedGroups });
  return { messages };
}
