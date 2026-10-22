import { Buffer } from "node:buffer";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { fingerprint } from "./handoff-tool-diagnostics.ts";
import { groupToolMessages } from "./role-context-protocol.ts";
import type { ContextGroup } from "./role-context-protocol.ts";

type Message = ContextEvent["messages"][number];
const ANCHORS = new Set(["pi-init-workflow-task", "pi-init-workflow-replan",
  "pi-init-task-memory-view", "pi-init-role-handoff", "pi-init-workflow-paused-context", "pi-init-role-recovery", "pi-init-role-context-view-diagnostic"]);

export function contextByteBudget(contextWindow?: number) {
  return Number.isFinite(contextWindow) && contextWindow! > 0
    ? Math.max(8_000, Math.min(192_000, Math.floor(contextWindow! * 1.5))) : 192_000;
}

export function boundContextWindow(messages: Message[], budgetBytes: number | null = 192_000, summarizedToolCallIds: ReadonlySet<string> = new Set()) {
  let sizes: number[];
  try { sizes = messages.map(message => Buffer.byteLength(JSON.stringify(message))); }
  catch { return { messages, inputBytes: 0, outputBytes: 0, budgetBytes, checkpointed: false, overBudget: true, omittedMessages: 0, reason: "unserializable-context" }; }
  const inputBytes = sizes.reduce((sum, bytes) => sum + bytes, 2 + Math.max(0, messages.length - 1));
  const unchanged = (reason: string) => ({ messages, inputBytes, outputBytes: inputBytes, budgetBytes, checkpointed: false,
    overBudget: budgetBytes !== null && inputBytes > budgetBytes, omittedMessages: 0, reason });
  if (budgetBytes === null) return unchanged("sdk-token-budget");
  if (inputBytes <= budgetBytes) return unchanged("within-budget");
  if (messages.some(message => (message as { role: string }).role === "system")) return unchanged("system-message-present");
  const units = groupToolMessages(messages);
  if (!units) return unchanged("unsafe-tool-pairs");
  const pinned = new Set<ContextGroup>();
  const anchors = new Map<string, ContextGroup>();
  for (const unit of units) {
    const message = messages[unit.indices[0]];
    if (message.role === "user") pinned.add(unit);
    if (message.role === "custom" && ANCHORS.has(message.customType)) anchors.set(message.customType, unit);
  }
  for (const unit of anchors.values()) pinned.add(unit);
  for (const unit of units) {
    const summarized = unit.calls.length > 0 && unit.calls.every(call => summarizedToolCallIds.has(call.id));
    if (unit.failed && !summarized || unit.indices.includes(messages.length - 1)) pinned.add(unit);
  }
  const archiveLimit = Math.max(1_600, Math.min(12_000, Math.floor(budgetBytes / 3)));
  const unitBytes = (unit: ContextGroup) => unit.indices.reduce((sum, index) => sum + sizes[index] + 1, 0);
  let used = [...pinned].reduce((sum, unit) => sum + unitBytes(unit), 2);
  // Pruning only successes when protected evidence fills the budget erases task progress.
  if (used + archiveLimit > budgetBytes) return unchanged("protected-content-over-budget");
  const selected = new Set(pinned);
  for (const unit of [...units].sort((a, b) => b.indices.at(-1)! - a.indices.at(-1)!)) {
    if (selected.has(unit)) continue;
    const bytes = unitBytes(unit);
    if (used + bytes <= budgetBytes - archiveLimit) { selected.add(unit); used += bytes; }
  }
  const removed = units.filter(unit => !selected.has(unit));
  if (!removed.length) return unchanged("protected-content-over-budget");
  const toolCounts: Record<string, number> = {};
  for (const unit of removed) for (const call of unit.calls) toolCounts[call.name] = (toolCounts[call.name] ?? 0) + 1;
  const notes: Record<string, unknown>[] = [];
  const checkpoint = (): Message => ({ role: "custom", customType: "pi-init-context-checkpoint", display: false, timestamp: 0,
    content: "[PI-INIT 有界上下文检查点] 旧工具组/回复已从本次模型视图归档，session/branch 历史未改写。以下是历史观察，不证明当前版本、验证通过或执行授权；不得重放已经执行的修改、命令或提交。缺少关键事实时定向核对当前文件/状态，未知副作用仍按原安全门处理。\n" + JSON.stringify({
      omittedMessages: removed.reduce((sum, unit) => sum + unit.indices.length, 0), toolCounts,
      observationCount: removed.reduce((sum, unit) => sum + unit.calls.length, 0), observations: notes,
    }) } as Message);
  for (const unit of [...removed].reverse()) {
    for (const call of unit.calls) {
      if (notes.length >= 16) break;
      const result = unit.indices.map(index => messages[index]).find(message => message.role === "toolResult" && message.toolCallId === call.id);
      const content = result?.role === "toolResult" ? result.content : [];
      const text = content.filter(part => part.type === "text").map(part => part.text).join("\n");
      notes.push({ toolCallId: call.id, tool: call.name, inputHash: fingerprint(call.arguments),
        argumentsExcerpt: JSON.stringify(call.arguments)?.slice(0, 240), outputHash: fingerprint(content), outputChars: text.length,
        resultExcerpt: text.slice(-240), isError: result?.role === "toolResult" ? result.isError : undefined });
      if (Buffer.byteLength(JSON.stringify(checkpoint())) > archiveLimit) { notes.pop(); break; }
    }
    if (notes.length >= 16) break;
  }
  const kept = new Set([...selected].flatMap(unit => unit.indices));
  const projected = messages.filter((_message, index) => kept.has(index));
  const latestUser = projected.findLastIndex(message => message.role === "user");
  projected.splice(Math.max(0, latestUser + 1), 0, checkpoint());
  const outputBytes = Buffer.byteLength(JSON.stringify(projected));
  return { messages: projected, inputBytes, outputBytes, budgetBytes, checkpointed: true, overBudget: outputBytes > budgetBytes,
    omittedMessages: messages.length - projected.length + 1, reason: outputBytes > budgetBytes ? "protected-content-over-budget" : "checkpoint" };
}
