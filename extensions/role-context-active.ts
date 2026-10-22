import type { ContextEvent, ContextEventResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isWorkflowActive, workflowHandoffIdentity, workflowReplanIdentity } from "../src/workflow.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { reusableToolContext } from "./role-context-reuse.ts";
import { type ContextMessage, WORKFLOW_TASK_MESSAGE_TYPE, WORKFLOW_REPLAN_MESSAGE_TYPE,
  isRecord, messageRecord, identityMatches, isManagedHandoffMessage, branchContainsExactlyOneAnchor, hasCompleteToolPairs, failOpen, groupToolMessages } from "./role-context-protocol.ts";

type ContextAnchor = {
  customType: string;
  identity: Record<string, unknown>;
  role: string;
};

function currentAnchor(state: ExtensionRuntimeState, sessionId: string): ContextAnchor | undefined {
  const workflow = state.workflowState;
  if (!workflow || workflow.sessionId !== sessionId) return;
  if (workflow.status === "replanning" && workflow.continuation?.kind === "replan" && workflow.continuation.phase === "queued" && state.activeRole?.role === "architect") {
    const identity = workflowReplanIdentity(workflow);
    if (identity) return { customType: WORKFLOW_REPLAN_MESSAGE_TYPE, identity, role: "architect" };
  }
  const task = workflow.tasks.find(item => item.id === workflow.currentTaskId);
  const identity = workflowHandoffIdentity(workflow);
  if (isWorkflowActive(workflow) && task?.status === "in_progress" && identity?.taskId === task.id && state.activeRole?.role === task.role
    && (workflow.handoff?.phase === "queued" || workflow.handoff?.phase === "executing")) return { customType: WORKFLOW_TASK_MESSAGE_TYPE, identity, role: task.role };
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

function hasManagedWork(state: ExtensionRuntimeState) {
    return Boolean(state.workflowRestoreError || state.workflowState && ["running", "replanning"].includes(state.workflowState.status));
}

function needsManagedView(state: ExtensionRuntimeState, sessionId: string) {
    return Boolean(state.workflowRestoreError || state.workflowState?.sessionId === sessionId && ["running", "replanning"].includes(state.workflowState.status));
}

export function activeContextView(state: ExtensionRuntimeState, event: ContextEvent, ctx: ExtensionContext): ContextEventResult | undefined {
  let managedWork: boolean;
  try {
    managedWork = hasManagedWork(state);
  } catch {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_STATE_INVALID", "持久化工作流或协调状态结构损坏；完整输入保留且不隔离");
  }
  if (!managedWork) return undefined;
  if (state.workflowRestoreError) {
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
  if (activeWorkflow && state.workflowState?.sessionId !== sessionId) {
    return failOpen(event.messages, "ROLE_CONTEXT_VIEW_SESSION_MISMATCH", "当前 workflow 属于其他 session；完整输入保留且不隔离");
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
    anchor = currentAnchor(state, sessionId);
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
  const groups = groupToolMessages(event.messages, failureStart, anchorIndex);
  if (!groups) return failOpen(event.messages, "ROLE_CONTEXT_VIEW_REUSE_PAIR_UNSAFE", "上一窗口工具观察配对不完整，未尝试复用裁剪");
  const failures = new Set(groups.flatMap(group => {
    const failedResult = group.indices.some(index => {
      const message = messageRecord(event.messages[index]);
      return message?.role === "toolResult" && message.isError === true;
    });
    if (failedResult) return group.indices;
    const head = messageRecord(event.messages[group.indices[0]]);
    return head?.role === "assistant" && (head.stopReason === "error" || typeof head.errorMessage === "string" && head.errorMessage) ? [group.indices[0]] : [];
  }));
  const reused = reusableToolContext(event.messages, groups);
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
