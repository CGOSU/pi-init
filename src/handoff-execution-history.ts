import type { ContextEvent } from "@earendil-works/pi-coding-agent";

type Message = ContextEvent["messages"][number];
export type HistoryFailure = { ok: false; code: string; message: string; callId?: string; messageIndex?: number };
type HistoryResult<T> = { ok: true; value: T } | HistoryFailure;
export const historyFailure = (code: string, callId?: string, messageIndex?: number): HistoryFailure => ({
  ok: false, code, ...(callId ? { callId } : {}), ...(messageIndex !== undefined ? { messageIndex } : {}),
  message: `工具收敛核对失败：${code}${callId ? `；调用=${callId.slice(0, 120)}` : ""}${messageIndex !== undefined ? `；消息序号=${messageIndex}` : ""}。请核对真实结果，不要重复未知操作。`,
});

/** Pi 1.5 agent loop exits error/aborted turns before scheduling any generated tool proposal. */
export function normalizeToolProposals(messages: readonly Message[], executed: ReadonlySet<string> = new Set()): HistoryResult<{
  messages: Message[]; undispatched: ReadonlySet<Message>;
}> {
  const proposals = new Map<string, { failed: boolean }>();
  const undispatched = new Set<Message>();
  const normalized: Message[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || typeof message !== "object" || typeof message.role !== "string") return historyFailure("TOOL_MESSAGE_STRUCTURE", undefined, index);
    if (message.role !== "assistant") { normalized.push(message); continue; }
    if (!Array.isArray(message.content) || message.content.some(block => !block || typeof block !== "object" || typeof block.type !== "string")) return historyFailure("TOOL_MESSAGE_STRUCTURE", undefined, index);
    const failed = message.stopReason === "error" || message.stopReason === "aborted";
    for (const block of message.content) {
      if (block?.type !== "toolCall") continue;
      if (typeof block.id !== "string" || !block.id.trim() || typeof block.name !== "string" || !block.name.trim()) return historyFailure("TOOL_CALL_STRUCTURE", undefined, index);
      if (proposals.has(block.id)) return historyFailure("TOOL_CALL_DUPLICATE", block.id, index);
      if (failed && executed.has(block.id)) return historyFailure("FAILED_PROPOSAL_EXECUTED", block.id, index);
      proposals.set(block.id, { failed });
    }
    if (failed) {
      undispatched.add(message);
      normalized.push({ ...message, content: message.content.filter(block => block.type !== "toolCall") });
    } else normalized.push(message);
  }
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "toolResult" && proposals.get(message.toolCallId)?.failed) return historyFailure("FAILED_PROPOSAL_HAS_RESULT", message.toolCallId, index);
  }
  return { ok: true, value: { messages: normalized, undispatched } };
}

/** Ordinary history only. Workflow evidence continues to use its strict protocol. */
export function settleToolPairs(messages: readonly Message[]): HistoryResult<true> {
  const owners = new Map<string, number>();
  const results = new Set<string>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "system" || message.role === "user" || message.role === "custom") continue;
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") {
        if (owners.has(block.id)) return historyFailure("TOOL_CALL_DUPLICATE", block.id, index);
        owners.set(block.id, index);
      }
    } else if (message.role === "toolResult") {
      if (!owners.has(message.toolCallId)) return historyFailure("TOOL_RESULT_WITHOUT_CALL", message.toolCallId, index);
      if (results.has(message.toolCallId)) return historyFailure("TOOL_RESULT_DUPLICATE", message.toolCallId, index);
      results.add(message.toolCallId);
    } else return historyFailure("TOOL_MESSAGE_ROLE", undefined, index);
  }
  for (const [id, index] of owners) if (!results.has(id)) return historyFailure("TOOL_RESULT_MISSING", id, index);
  return { ok: true, value: true };
}
