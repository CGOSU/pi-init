import { isDeepStrictEqual } from "node:util";
import type { ContextEventResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hydrateWorkflowState, workflowActionIdentity } from "../src/workflow.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { latestWorkflowRecoverySource } from "./workflow-recovery.ts";
import { nextWorkflowAction } from "./workflow-action-policy.ts";
import { type ContextMessage, branchContainsExactlyOneAnchor, failOpen, groupToolMessages,
  identityMatches, isManagedHandoffMessage, isRecord, messageRecord } from "./role-context-protocol.ts";

// Internal runtime state only: persisted message labels never establish this boundary.
export function isWaitingWorkflowBoundary(state: ExtensionRuntimeState) {
  const workflow = state.workflowState;
  return workflow?.status === "running" && !workflow.currentTaskId && !workflow.handoff
    && workflow.continuation?.kind === "schedule" && workflow.continuation.phase === "pending";
}

/** A persisted schedule boundary is an observation anchor, never an executable handoff. */
export function waitingContextView(state: ExtensionRuntimeState, messages: ContextMessage[], ctx: ExtensionContext): ContextEventResult | undefined {
  const workflow = state.workflowState;
  if (!workflow || !isWaitingWorkflowBoundary(state)) return undefined;
  const fail = (reason: string) => failOpen(messages, "ROLE_CONTEXT_VIEW_WAITING_BOUNDARY_UNAVAILABLE", reason);
  try {
    if (state.pendingWorkflowRecovery || state.roleRecoveryPersistenceFailed || state.roleRecoveryPending) return fail("等待调度的恢复状态尚未确认");
    const sessionId = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch();
    const source = latestWorkflowRecoverySource(branch);
    const saved = hydrateWorkflowState(source.entry?.data);
    const current = hydrateWorkflowState(workflow);
    if (workflow.sessionId !== sessionId || !source.entryId || source.entry?.customType !== "pi-init-workflow"
      || branch.filter(entry => entry.id === source.entryId).length !== 1
      || !saved.ok || !current.ok || !isDeepStrictEqual(saved.value, current.value)) return fail("等待调度快照与当前 branch/工作流不一致");
    const anchor = branch.slice(0, source.index).findLast(entry => entry.type === "custom_message"
      && ["pi-init-workflow-task", "pi-init-workflow-replan"].includes(entry.customType));
    if (!anchor || anchor.type !== "custom_message" || !isRecord(anchor.details)
      || anchor.details.workflowId !== workflow.workflowId || anchor.details.sessionId !== sessionId
      || !Number.isSafeInteger(anchor.details.planVersion) || Number(anchor.details.planVersion) < 0 || Number(anchor.details.planVersion) > workflow.planVersion
      || !Number.isSafeInteger(anchor.details.recoveryGeneration) || Number(anchor.details.recoveryGeneration) < 0 || Number(anchor.details.recoveryGeneration) > workflow.recoveryGeneration
      || !branchContainsExactlyOneAnchor(branch, anchor.customType, anchor.details)) return fail("历史交接边界无法核对");
    const identity = anchor.details;
    const indices = messages.flatMap((message, index) => message.role === "custom"
      && message.customType === anchor.customType && identityMatches(message.details, identity) ? [index] : []);
    if (indices.length !== 1 || messages.slice(indices[0] + 1).some(isManagedHandoffMessage)) return fail("等待窗口缺失、重复或包含其他交接");
    const groups = groupToolMessages(messages);
    if (!groups) return fail("历史工具调用/结果配对不完整，保留完整输入");
    const kept = new Set(groups.filter(group => group.failed || group.indices.some(index => index > indices[0])
      || group.indices.some(index => {
        const message = messageRecord(messages[index]);
        return message?.role === "user" || message?.role === "custom" && !isManagedHandoffMessage(message)
          || message?.role === "assistant" && typeof message.errorMessage === "string" && message.errorMessage.length > 0;
      })).flatMap(group => group.indices));
    const selected = messages.filter((message, index) => kept.has(index) && !isManagedHandoffMessage(message)
      && messageRecord(message)?.customType !== "pi-init-workflow-waiting-context");
    const snapshot = { ...workflowActionIdentity(workflow), sourceEntryId: source.entryId,
      plan: workflow.plan, status: workflow.status, continuation: workflow.continuation,
      tasks: workflow.tasks.map(task => ({ taskId: task.id, role: task.role, status: task.status,
        blockReason: task.blockReason, outcomeUnknown: task.outcomeUnknown,
        resultRef: task.completionSummary || task.verification?.length ? task.id : undefined })) };
    const result = { messages: [...selected, { role: "custom", customType: "pi-init-workflow-waiting-context", display: false,
      content: "[PI-INIT 等待调度观察]\n" + JSON.stringify(snapshot)
        + "\n当前没有可执行任务身份；历史交接不是当前执行授权。已应用的规划不应重复提交，已完成结果按来源查询，不重放。"
        + nextWorkflowAction(state).nextAction + ' 处理当前用户新增约束后结束本回合，让调度在安全边界运行；不要反复查询状态或自行抢先切换任务角色。完整历史按需调用 task_workflow(action="status", detail="full")。',
      details: { ...workflowActionIdentity(workflow), sourceEntryId: source.entryId }, timestamp: workflow.updatedAt } as ContextMessage] };
    return result;
  } catch {
    return fail("等待调度快照或 branch 结构不可读取");
  }
}
