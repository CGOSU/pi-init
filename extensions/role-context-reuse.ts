import type { ContextEvent } from "@earendil-works/pi-coding-agent";

type Message = ContextEvent["messages"][number];
const MAX_GROUPS = 8;
const MAX_CHARS = 32_000;

export function reusableToolContext(messages: readonly Message[], start: number, end: number) {
  const groups: { indices: number[]; ids: Set<string>; results: Set<string>; eligible: boolean }[] = [];
  const owners = new Map<string, typeof groups[number]>();
  for (let index = start; index < end; index++) {
    const message = messages[index];
    if (message.role === "assistant") {
      const calls = message.content.filter(part => part.type === "toolCall");
      if (!calls.length) continue;
      const group = { indices: [index], ids: new Set<string>(), results: new Set<string>(),
        eligible: calls.every(call => call.name !== "switch_role" && call.name !== "task_workflow") };
      for (const call of calls) {
        if (owners.has(call.id)) return undefined;
        group.ids.add(call.id);
        owners.set(call.id, group);
      }
      groups.push(group);
    } else if (message.role === "toolResult") {
      const group = owners.get(message.toolCallId);
      if (!group || group.results.has(message.toolCallId)) return undefined;
      group.indices.push(index);
      group.results.add(message.toolCallId);
      if (message.isError) group.eligible = false;
    }
  }
  const indices = new Set<number>();
  let retainedGroups = 0;
  let retainedChars = 0;
  let omittedGroups = 0;
  for (const group of groups.reverse()) {
    if (group.results.size !== group.ids.size) return undefined;
    if (!group.eligible) continue;
    if (retainedGroups >= MAX_GROUPS) { omittedGroups++; continue; }
    let chars: number;
    try { chars = group.indices.reduce((total, index) => total + JSON.stringify(messages[index]).length, 0); }
    catch { return undefined; }
    if (retainedChars + chars > MAX_CHARS) { omittedGroups++; continue; }
    retainedGroups++;
    retainedChars += chars;
    for (const index of group.indices) indices.add(index);
  }
  return { indices, retainedGroups, retainedChars, omittedGroups };
}
