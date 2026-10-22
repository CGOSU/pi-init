import type { ContextEventResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";
import { hydrateWorkflowState, workflowActionIdentity } from "../src/workflow.ts";
import { latestWorkflowRecoverySource } from "./workflow-recovery.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { type ContextMessage, ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE, WORKFLOW_TASK_MESSAGE_TYPE, WORKFLOW_REPLAN_MESSAGE_TYPE,
  isRecord, messageRecord, identityMatches, isManagedHandoffMessage, toolCallIds, hasCompleteToolPairs, diagnosticMessage } from "./role-context-protocol.ts";

// Repeated projections have no executable marker. Only complete read-only
// status groups may cross that boundary; old execution calls are never revived.
function pausedStatusObservations(messages: ContextMessage[]): Set<ContextMessage> | undefined {
  const selected = new Set<ContextMessage>();
  for (let index = 0; index < messages.length; index += 1) {
    const record = messageRecord(messages[index]);
    if (record?.role !== "assistant" || !Array.isArray(record.content)) continue;
    const calls = record.content.filter((item) => isRecord(item) && item.type === "toolCall");
    if (!calls.length || !calls.every((call) => isRecord(call)
      && call.name === "task_workflow" && isRecord(call.arguments) && call.arguments.action === "status")) continue;
    const ids = toolCallIds(record);
    if (!ids) return undefined;
    selected.add(messages[index]);
    for (let resultIndex = index + 1; resultIndex < messages.length; resultIndex += 1) {
      const result = messageRecord(messages[resultIndex]);
      if (result?.role === "toolResult" && typeof result.toolCallId === "string" && ids.includes(result.toolCallId)) {
        if (result.toolName !== "task_workflow") return undefined;
        selected.add(messages[resultIndex]);
      }
    }
  }
  return hasCompleteToolPairs(messages.filter((message) => selected.has(message))) ? selected : undefined;
}

// A paused workflow has no executable handoff. Its persisted state is the trust
// anchor; a historical handoff is only a boundary for observations, never authority.
export function pausedContextView(
  state: ExtensionRuntimeState,
  messages: ContextMessage[],
  ctx: ExtensionContext,
): ContextEventResult {
  const lastUser = messages.findLastIndex(message => messageRecord(message)?.role === "user");
  const recentObservation = (pausedStatusObservations(messages.slice(lastUser + 1))?.size ?? 0) > 0;
  const allObservations = pausedStatusObservations(messages);
  const workflowState = state.workflowState;
  const unchangedObservation = workflowState && [...(allObservations ?? [])].some(message => {
    const record = messageRecord(message);
    return record?.role === "toolResult" && record.isError !== true && isRecord(record.details)
      && identityMatches(record.details, workflowActionIdentity(workflowState))
      && record.details.status === workflowState.status && record.details.updatedAt === workflowState.updatedAt;
  });
  const statusObserved = recentObservation || Boolean(unchangedObservation);
  const fail = (code: string, reason: string): ContextEventResult => ({
    messages: [
      ...messages.filter((message) => protectedContextMessage(message)),
      {
        ...diagnosticMessage(code, reason),
        content: `[PI-INIT 暂停恢复视图不可确认]\n错误码：${code}\n原因：${reason}\n仅保留用户指令与宿主管理的 system 消息；原始 branch 未改写。旧任务交接不是当前执行授权。暂停和职责恢复保护仍有效。${statusObserved ? "本轮已有完整只读状态查询，但恢复边界仍无法确认；不要反复查询相同状态，报告此错误码并等待安全恢复检查。" : '本轮尚无完整只读状态观察；可查询一次 task_workflow(action="status")，不得凭旧身份执行。'}`,
        details: { code, statusObserved },
      } as ContextMessage,
    ],
  });
  try {
    const workflow = state.workflowState!;
    const sessionId = ctx.sessionManager.getSessionId();
    if (workflow.sessionId !== sessionId) return fail("ROLE_CONTEXT_VIEW_SESSION_MISMATCH", "暂停工作流属于其他 session");
    if (state.workflowRestoreError || state.roleRecoveryPersistenceFailed) {
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
        || typeof last.customType !== "string") {
        return fail("ROLE_CONTEXT_VIEW_BRANCH_MISMATCH", "历史任务边界身份不可核对");
      }
      const indices = messages.flatMap((message, index) => {
        const record = messageRecord(message);
        return record?.role === "custom" && record.customType === last.customType && identityMatches(record.details, identity) ? [index] : [];
      });
      // This is a historical observation window, not a current execution grant.
      const anchorIndex = indices.at(-1) ?? -1;
      // Persisted paused state is the trust anchor; ancient markers may be absent.
      if (anchorIndex < 0) {
        if (messages.some(isManagedHandoffMessage)) return fail("ROLE_CONTEXT_VIEW_BRANCH_MISMATCH", "当前观察边界缺失但仍有其他交接");
        const observations = pausedStatusObservations(messages);
        if (!observations) return fail("ROLE_CONTEXT_VIEW_TOOL_PAIR_UNSAFE", "只读状态观察配对不完整");
        selected = messages.filter((message) => protectedContextMessage(message) || observations.has(message));
      } else {
        if (messages.slice(anchorIndex + 1).some(isManagedHandoffMessage)) {
          return fail("ROLE_CONTEXT_VIEW_BRANCH_MISMATCH", "最新观察边界之后存在其他交接消息");
        }
        selected = messages.filter((message, index) => protectedContextMessage(message)
          || (index > anchorIndex && !isManagedHandoffMessage(message)
            && messageRecord(message)?.customType !== ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE
            && messageRecord(message)?.customType !== "pi-init-workflow-paused-context"));
      }
    } else {
      if (messages.some(isManagedHandoffMessage)) return fail("ROLE_CONTEXT_VIEW_BRANCH_MISMATCH", "无历史记录但存在交接消息");
      const observations = pausedStatusObservations(messages);
      if (!observations) return fail("ROLE_CONTEXT_VIEW_TOOL_PAIR_UNSAFE", "只读状态观察配对不完整");
      selected = messages.filter((message) => protectedContextMessage(message) || observations.has(message));
    }
    if (!hasCompleteToolPairs(selected.filter(message => messageRecord(message)?.role !== "system"))) return fail("ROLE_CONTEXT_VIEW_TOOL_PAIR_UNSAFE", "恢复窗口中的工具调用/结果配对不完整或重复");
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
        outcomeUnknown: task.outcomeUnknown,
        verificationRef: task.verification?.length ? task.id : undefined,
      })),
    };
    return { messages: [...selected, {
      role: "custom",
      customType: "pi-init-workflow-paused-context",
      content: [
        "系统生成的暂停恢复轻量快照（引用按需读取，不代表任务完成或证据已接受）：",
        JSON.stringify(snapshot),
        '工作流暂停不是当前任务执行授权；历史观察和旧交接仅供参考，不得复用旧 attempt/handoff。本轮已有与当前身份一致且未变化的只读 status 结果时直接使用，不重复查询；否则查询一次 task_workflow(action="status") 核对暂停原因、契约和当前有效事实引用。通过有效恢复/重试/重规划转换且职责确认后才能执行，不重做已完成工作。',
      ].join("\n"),
      details: identity,
      display: false,
      timestamp: Date.now(),
    } as ContextMessage] };
  } catch {
    return fail("ROLE_CONTEXT_VIEW_PAUSED_BOUNDARY_UNAVAILABLE", "暂停恢复状态或 branch 边界不可读取");
  }
}
function protectedContextMessage(message: unknown) {
  const role = messageRecord(message)?.role;
  return role === "user" || role === "system";
}
