import type { ContextEvent, ContextEventResult } from "@earendil-works/pi-coding-agent";
export type ContextMessage = ContextEvent["messages"][number];

type ContextMessageRecord = Record<string, unknown>;

export const ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE = "pi-init-role-context-view-diagnostic";

export const WORKFLOW_TASK_MESSAGE_TYPE = "pi-init-workflow-task";

export const WORKFLOW_REPLAN_MESSAGE_TYPE = "pi-init-workflow-replan";

const MANAGED_HANDOFF_TYPES = new Set([WORKFLOW_TASK_MESSAGE_TYPE, WORKFLOW_REPLAN_MESSAGE_TYPE]);

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
  return groupToolMessages(messages) !== undefined;
}

// Request-local annotations use source time (0 if unavailable), never request wall time.
export function diagnosticMessage(code: string, reason: string, timestamp = 0): ContextMessage {
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
    timestamp,
  } as ContextMessage;
}

export function failOpen(messages: ContextMessage[], code: string, reason: string): ContextEventResult {
  const clean = messages.filter((message) => messageRecord(message)?.customType !== ROLE_CONTEXT_VIEW_DIAGNOSTIC_TYPE);
  return { messages: [...clean, diagnosticMessage(code, reason, clean.at(-1)?.timestamp ?? 0)] };
}
export type ContextGroup = { indices: number[]; calls: { id: string; name: string; arguments: unknown }[]; failed: boolean };
export function groupToolMessages(messages: readonly ContextMessage[], start = 0, end = messages.length): ContextGroup[] | undefined {
  const groups: ContextGroup[] = [];
  const owners = new Map<string, ContextGroup>();
  const completed = new Set<string>();
  for (let index = start; index < end; index++) {
    const message = messages[index];
    const record = messageRecord(message);
    if (!record || typeof record.role !== "string" || !["assistant", "user", "toolResult", "custom"].includes(record.role)) return undefined;
    if (record.role === "toolResult") {
      const id = record.toolCallId;
      const group = typeof id === "string" ? owners.get(id) : undefined;
      if (!group || typeof id !== "string" || completed.has(id)) return undefined;
      group.indices.push(index);
      group.failed ||= record.isError === true;
      completed.add(id);
      continue;
    }
    if (!toolCallIds(record)) return undefined;
    const group: ContextGroup = { indices: [index], calls: message.role === "assistant" ? message.content.filter(part => part?.type === "toolCall") : [],
      failed: record.role === "assistant" && (record.stopReason === "error" || record.stopReason === "aborted") };
    for (const call of group.calls) {
      if (owners.has(call.id)) return undefined;
      owners.set(call.id, group);
    }
    groups.push(group);
  }
  return owners.size === completed.size ? groups : undefined;
}
