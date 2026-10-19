import type { ContextEvent, ContextEventResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";
import { latestWorkflowRecoverySource } from "./workflow-recovery.ts";
import {
  hydrateWorkflowState,
  isWorkflowActive,
  workflowActionIdentity,
  workflowHandoffIdentity,
  workflowReplanIdentity,
} from "../src/workflow.ts";
import {
  COORDINATION_EVIDENCE_MESSAGE_TYPE,
  COORDINATION_REVIEW_MESSAGE_TYPE,
  coordinationHandoffIdentity,
} from "./coordination-runtime-protocol.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { reusableToolContext } from "./role-context-reuse.ts";

export const ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE = "pi-init-role-context-view-diagnostic";
const WORKFLOW_TASK_MESSAGE_TYPE = "pi-init-workflow-task";
const WORKFLOW_REPLAN_MESSAGE_TYPE = "pi-init-workflow-replan";
const MANAGED_HANDOFF_TYPES = new Set([
  WORKFLOW_TASK_MESSAGE_TYPE,
  WORKFLOW_REPLAN_MESSAGE_TYPE,
  COORDINATION_EVIDENCE_MESSAGE_TYPE,
  COORDINATION_REVIEW_MESSAGE_TYPE,
]);

type ContextMessage = ContextEvent["messages"][number];
type ContextAnchor = {
  customType: string;
  identity: Record<string, unknown>;
  role: string;
};

type ContextMessageRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ContextMessageRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageRecord(message: unknown): ContextMessageRecord | undefined {
  return isRecord(message) ? message : undefined;
}

function identityMatches(value: unknown, expected: Record<string, unknown>) {
  if (!isRecord(value)) return false;
  return Object.entries(expected).every(([key, item]) => value[key] === item);
}

function isManagedHandoffMessage(message: unknown) {
  const record = messageRecord(message);
  return record?.role === "custom" && typeof record.customType === "string" && MANAGED_HANDOFF_TYPES.has(record.customType);
}

function branchContainsExactlyOneAnchor(
  branch: unknown,
  customType: string,
  identity: Record<string, unknown>,
) {
  if (!Array.isArray(branch)) return false;
  const matches = branch.filter((entry) => {
    if (!isRecord(entry) || entry.type !== "custom_message" || entry.customType !== customType) return false;
    return identityMatches(entry.details, identity);
  });
  return matches.length === 1;
}

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

function toolCallIds(message: ContextMessageRecord): string[] | undefined {
  if (message.role !== "assistant") return [];
  if (!Array.isArray(message.content)) return undefined;
  const ids: string[] = [];
  for (const item of message.content) {
    if (!isRecord(item) || item.type !== "toolCall") continue;
    if (typeof item.id !== "string" || !item.id.trim() || ids.includes(item.id)) return undefined;
    ids.push(item.id);
  }
  return ids;
}

function hasCompleteToolPairs(messages: readonly ContextMessage[]) {
  const pending = new Set<string>();
  const completed = new Set<string>();
  for (const message of messages) {
    const record = messageRecord(message);
    if (!record || typeof record.role !== "string") return false;
    if (record.role === "system") return false;
    if (!["assistant", "user", "toolResult", "custom"].includes(record.role)) return false;
    if (record.role === "assistant") {
      const ids = toolCallIds(record);
      if (!ids) return false;
      for (const id of ids) {
        if (pending.has(id) || completed.has(id)) return false;
        pending.add(id);
      }
    } else if (record.role === "toolResult") {
      const id = record.toolCallId;
      if (typeof id !== "string" || !pending.has(id) || completed.has(id)) return false;
      pending.delete(id);
      completed.add(id);
    }
  }
  return pending.size === 0;
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

function diagnosticMessage(code: string, reason: string): ContextMessage {
  return {
    role: "custom",
    customType: ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE,
    content: [
      "[PI-INIT 请求局部上下文视图：未裁剪]",
      `错误码：${code}`,
      `完整模型消息已保留；原因：${reason}`,
      "请继续以现有完整上下文工作。不要把本次视图描述为已隔离或已缩减。",
    ].join("\n"),
    display: false,
    details: { code },
    timestamp: Date.now(),
  } as ContextMessage;
}

function failOpen(messages: ContextMessage[], code: string, reason: string): ContextEventResult {
  const clean = messages.filter((message) => messageRecord(message)?.customType !== ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE);
  return { messages: [...clean, diagnosticMessage(code, reason)] };
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

// A paused workflow has no executable handoff. Its persisted state is the trust
// anchor; a historical handoff is only a boundary for observations, never authority.
function pausedContextView(
  state: ExtensionRuntimeState,
  messages: ContextMessage[],
  ctx: ExtensionContext,
): ContextEventResult {
  const fail = (code: string, reason: string): ContextEventResult => ({
    messages: [
      ...messages.filter((message) => messageRecord(message)?.role === "user"),
      {
        ...diagnosticMessage(code, reason),
        content: `[PI-INIT 暂停恢复视图不可确认]\n错误码：${code}\n原因：${reason}\n仅保留用户指令；原始 branch 未改写。旧任务交接不是当前执行授权。暂停和职责恢复保护仍有效；先读取 task_workflow(action="status")，不得凭旧身份执行。`,
      } as ContextMessage,
    ],
  });
  try {
    const workflow = state.workflowState!;
    const sessionId = ctx.sessionManager.getSessionId();
    if (workflow.sessionId !== sessionId) return fail("ROLE_CONTEXT_VIEW_SESSION_MISMATCH", "暂停工作流属于其他 session");
    if (state.workflowRestoreError || state.coordinationRestoreError || state.roleRecoveryPersistenceFailed) {
      return fail("ROLE_CONTEXT_VIEW_RESTORE_UNCERTAIN", "持久状态或恢复门尚未可靠恢复");
    }
    if (state.roleCompactionInFlight || state.roleCompactionPhase === "compacting" || state.activeRoleCompaction || state.pendingRoleCompaction) {
      return fail("ROLE_CONTEXT_VIEW_COMPACTION_UNCERTAIN", "压缩边界尚未确认");
    }
    const branch = ctx.sessionManager.getBranch();
    const source = latestWorkflowRecoverySource(branch);
    const saved = hydrateWorkflowState(source.entry?.data);
    const current = hydrateWorkflowState(workflow);
    if (!source.entryId || branch.filter((entry) => entry.id === source.entryId).length !== 1
      || !saved.ok || !current.ok || !isDeepStrictEqual(saved.value, current.value)) {
      return fail("ROLE_CONTEXT_VIEW_PAUSED_SNAPSHOT_MISMATCH", "最新 branch 工作流快照与当前暂停状态/身份不一致");
    }
    const historical = branch.slice(0, source.index).filter((entry) => {
      const record = messageRecord(entry);
      return record?.type === "custom_message"
        && (record.customType === WORKFLOW_TASK_MESSAGE_TYPE || record.customType === WORKFLOW_REPLAN_MESSAGE_TYPE)
        && isRecord(record.details) && record.details.workflowId === workflow.workflowId;
    });
    const last = messageRecord(historical.at(-1));
    let selected: ContextMessage[];
    if (last) {
      const identity = last.details;
      if (!isRecord(identity) || identity.sessionId !== sessionId
        || typeof identity.planVersion !== "number" || identity.planVersion > workflow.planVersion
        || typeof identity.recoveryGeneration !== "number" || identity.recoveryGeneration > workflow.recoveryGeneration
        || typeof last.customType !== "string" || !branchContainsExactlyOneAnchor(branch, last.customType, identity)) {
        return fail("ROLE_CONTEXT_VIEW_BRANCH_MISMATCH", "历史任务边界身份不可核对");
      }
      const indices = messages.flatMap((message, index) => {
        const record = messageRecord(message);
        return record?.role === "custom" && record.customType === last.customType && identityMatches(record.details, identity) ? [index] : [];
      });
      if (indices.length !== 1) return fail("ROLE_CONTEXT_VIEW_MESSAGE_BOUNDARY_UNAVAILABLE", "历史任务边界在当前 context 中缺失或重复");
      const anchorIndex = indices[0];
      // Preserve user intent across the workflow, not just the last N messages.
      // The suffix retains current observations (including successful tool output).
      const first = messageRecord(historical[0]);
      const firstIndex = messages.findIndex((message) => {
        const record = messageRecord(message);
        return record?.role === "custom" && record.customType === first?.customType
          && isRecord(first?.details) && identityMatches(record.details, first.details);
      });
      if (firstIndex < 0) return fail("ROLE_CONTEXT_VIEW_PREVIOUS_BOUNDARY_UNAVAILABLE", "工作流起始消息边界不可核对");
      const previous = priorHandoffBoundary(messages, firstIndex, branch, sessionId);
      if (!previous.ok) return fail("ROLE_CONTEXT_VIEW_PREVIOUS_BOUNDARY_UNAVAILABLE", "工作流之前的交接边界不可核对");
      selected = [
        ...messages.slice(previous.index + 1, anchorIndex).filter((message) => messageRecord(message)?.role === "user"),
        ...messages.slice(anchorIndex + 1).filter((message) => !isManagedHandoffMessage(message)
          && messageRecord(message)?.customType !== ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE),
      ];
    } else {
      if (workflow.tasks.some((task) => task.status !== "pending") || workflow.currentTaskId || workflow.handoff) {
        return fail("ROLE_CONTEXT_VIEW_HANDOFF_UNAVAILABLE", "存在执行历史但无可验证的任务观察边界");
      }
      selected = messages.filter((message) => messageRecord(message)?.role === "user");
    }
    if (!hasCompleteToolPairs(selected)) return fail("ROLE_CONTEXT_VIEW_TOOL_PAIR_UNSAFE", "恢复窗口中的工具调用/结果配对不完整或重复");
    const identity = workflowActionIdentity(workflow);
    const snapshot = {
      ...identity,
      status: workflow.status,
      pauseReason: workflow.pauseReason,
      taskPauseReason: workflow.taskPauseReason,
      plan: workflow.plan,
      pendingRevision: workflow.pendingRevision,
      tasks: workflow.tasks.map((task) => ({
        taskId: task.id, status: task.status, blockReason: task.blockReason,
        outcomeUnknown: task.outcomeUnknown, contractRef: task.contract ? task.id : undefined,
        verificationRef: task.verification?.length ? task.id : undefined,
      })),
    };
    return { messages: [...selected, {
      role: "custom",
      customType: "pi-init-workflow-paused-context",
      content: [
        "系统生成的暂停恢复轻量快照（引用按需读取，不代表任务完成或证据已接受）：",
        JSON.stringify(snapshot),
        '工作流暂停不是当前任务执行授权；历史观察和旧交接仅供参考，不得复用旧 attempt/handoff。先调用 task_workflow(action="status") 核对暂停原因、契约和当前有效事实引用；通过有效恢复/重试/重规划转换且职责确认后才能执行，不重做已完成工作。',
      ].join("\n"),
      details: identity,
      display: false,
      timestamp: Date.now(),
    } as ContextMessage] };
  } catch {
    return fail("ROLE_CONTEXT_VIEW_PAUSED_BOUNDARY_UNAVAILABLE", "暂停恢复状态或 branch 边界不可读取");
  }
}

export function createRoleContextView(state: ExtensionRuntimeState) {
  function context(event: ContextEvent, ctx: ExtensionContext): ContextEventResult | undefined {
    if (!Array.isArray(event.messages)) {
      ctx.ui.notify("请求局部上下文视图无法识别 Pi 消息数组；未修改输入，保留宿主完整上下文。", "warning");
      return undefined;
    }
    if (state.runtimeDisposed) return undefined;
    if (state.workflowState?.status === "paused") return pausedContextView(state, event.messages, ctx);
    if (state.roleRecoveryPending || state.roleRecoveryPersistenceFailed) return undefined;
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

  return { context };
}

export type RoleContextView = ReturnType<typeof createRoleContextView>;
