import type { ContextMessage } from "./role-context-protocol.ts";
import { hasCompleteToolPairs, isRecord } from "./role-context-protocol.ts";

export type ToolSettlement = { ok: true } | { ok: false; code: string; message: string };
const fail = (code: string, root = "", child = ""): ToolSettlement => ({
  ok: false, code, message: `工具收敛核对失败：${code}${root ? `；外层=${root.slice(0, 100)}` : ""}${child ? `；子调用=${child.slice(0, 100)}` : ""}。请核对真实结果，不要重复未知操作。`,
});

/** SDK 1.5 receipts: argument omission is not execution uncertainty. No argument bodies are returned. */
export function nestedToolSettlement(value: unknown, root: string): ToolSettlement {
  if (!isRecord(value) || typeof value.complete !== "boolean" || !Array.isArray(value.calls)) return fail("NESTED_STRUCTURE", root);
  if (value.calls.length > 256 || !value.complete && value.calls.length >= 256) return fail("NESTED_CALL_LIMIT", root);
  if (!value.complete && !value.calls.length) return fail("NESTED_INCOMPLETE", root);
  const seen = new Set([root]);
  const siblings = new Map<string, number>();
  let argumentBytes = 0;
  let omitted = false;
  for (const call of value.calls) {
    if (!isRecord(call) || typeof call.id !== "string" || typeof call.name !== "string" || !call.name.trim()) return fail("NESTED_STRUCTURE", root);
    if (seen.has(call.id)) return fail("NESTED_DUPLICATE", root, call.id);
    const slash = call.id.lastIndexOf("/");
    const parent = call.id.slice(0, slash);
    const ordinal = call.id.slice(slash + 1);
    const next = (siblings.get(parent) ?? 0) + 1;
    if (!seen.has(parent) || ordinal !== String(next)) return fail("NESTED_CALL_MISSING", root, call.id);
    siblings.set(parent, next);
    seen.add(call.id);
    if (call.status === "unfinished") return fail("NESTED_UNFINISHED", root, call.id);
    if (!["ok", "error"].includes(call.status as string) || !Number.isFinite(call.durationMs) || (call.durationMs as number) < 0) return fail("NESTED_STRUCTURE", root, call.id);
    if (Object.hasOwn(call, "arguments")) {
      if (Object.hasOwn(call, "argumentsBytes")) return fail("NESTED_STRUCTURE", root, call.id);
      let bytes: number;
      try { bytes = Buffer.byteLength(JSON.stringify(call.arguments), "utf8"); } catch { return fail("NESTED_STRUCTURE", root, call.id); }
      if (bytes > 8192 || argumentBytes + bytes > 32768) return fail("NESTED_STRUCTURE", root, call.id);
      argumentBytes += bytes;
    } else {
      const bytes = call.argumentsBytes;
      if (!Number.isSafeInteger(bytes) || (bytes as number) <= 0 || !((bytes as number) > 8192 || argumentBytes + (bytes as number) > 32768)) return fail("NESTED_ARGUMENT_OMISSION_UNKNOWN", root, call.id);
      omitted = true;
    }
  }
  if (value.complete && omitted || !value.complete && !omitted) return fail("NESTED_INCOMPLETE", root);
  return { ok: true };
}

/** Only the currently executing, model-issued session_handoff call may lack its own result. */
export function generalToolSettlement(messages: readonly ContextMessage[], preparingId?: string): ToolSettlement {
  const filtered: ContextMessage[] = [];
  let preparingCalls = 0;
  for (const message of messages) {
    if (message.role === "system") continue;
    if (preparingId && message.role === "assistant" && Array.isArray(message.content)) {
      const content = message.content.filter(part => {
        if (part.type !== "toolCall" || part.id !== preparingId) return true;
        if (part.name !== "session_handoff") return true;
        preparingCalls++;
        return false;
      });
      filtered.push({ ...message, content });
    } else filtered.push(message);
  }
  if (preparingId && preparingCalls !== 1) return fail("PREPARING_CALL_IDENTITY", preparingId);
  if (!hasCompleteToolPairs(filtered)) return fail("TOOL_PAIRS_INCOMPLETE");
  for (const message of filtered) {
    if (message.role !== "toolResult" || !isRecord(message) || message.nestedCalls === undefined) continue;
    const result = nestedToolSettlement(message.nestedCalls, message.toolCallId as string);
    if (!result.ok) return result;
  }
  return { ok: true };
}
