import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import type { ContextGroup } from "./role-context-protocol.ts";

type Message = ContextEvent["messages"][number];
const MAX_GROUPS = 8;
const MAX_CHARS = 32_000;

export function reusableToolContext(messages: readonly Message[], groups: readonly ContextGroup[]) {
  const indices = new Set<number>();
  let retainedGroups = 0;
  let retainedChars = 0;
  let omittedGroups = 0;
  for (const group of [...groups].reverse()) {
    if (!group.calls.length || group.calls.some(call => call.name === "switch_role" || call.name === "task_workflow")
      || group.indices.some(index => messages[index].role === "toolResult" && messages[index].isError)) continue;
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
