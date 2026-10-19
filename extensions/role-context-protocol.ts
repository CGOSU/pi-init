import type { ContextEvent, ContextEventResult } from "@earendil-works/pi-coding-agent";
import { COORDINATION_EVIDENCE_MESSAGE_TYPE, COORDINATION_REVIEW_MESSAGE_TYPE } from "./coordination-runtime-protocol.ts";

export type ContextMessage = ContextEvent["messages"][number];

type ContextMessageRecord = Record<string, unknown>;

export const ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE = "pi-init-role-context-view-diagnostic";

export const WORKFLOW_TASK_MESSAGE_TYPE = "pi-init-workflow-task";

export const WORKFLOW_REPLAN_MESSAGE_TYPE = "pi-init-workflow-replan";

const MANAGED_HANDOFF_TYPES = new Set([
  WORKFLOW_TASK_MESSAGE_TYPE,
  WORKFLOW_REPLAN_MESSAGE_TYPE,
  COORDINATION_EVIDENCE_MESSAGE_TYPE,
  COORDINATION_REVIEW_MESSAGE_TYPE,
]);

export function isRecord(value: unknown): value is ContextMessageRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function messageRecord(message: unknown): ContextMessageRecord | undefined {
  return isRecord(message) ? message : undefined;
}

export function identityMatches(value: unknown, expected: Record<string, unknown>) {
  if (!isRecord(value)) return false;
  return Object.entries(expected).every(([key, item]) => value[key] === item);
}

export function isManagedHandoffMessage(message: unknown) {
  const record = messageRecord(message);
  return record?.role === "custom" && typeof record.customType === "string" && MANAGED_HANDOFF_TYPES.has(record.customType);
}

export function branchContainsExactlyOneAnchor(
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

export function toolCallIds(message: ContextMessageRecord): string[] | undefined {
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

export function hasCompleteToolPairs(messages: readonly ContextMessage[]) {
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

export function diagnosticMessage(code: string, reason: string): ContextMessage {
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

export function failOpen(messages: ContextMessage[], code: string, reason: string): ContextEventResult {
  const clean = messages.filter((message) => messageRecord(message)?.customType !== ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE);
  return { messages: [...clean, diagnosticMessage(code, reason)] };
}
