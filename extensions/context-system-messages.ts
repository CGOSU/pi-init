import type { ContextEvent } from "@earendil-works/pi-coding-agent";

type Message = ContextEvent["messages"][number];

/** Keep host system deltas at their original boundaries in an ordered conversation projection. */
export function restoreSystemMessagePositions(original: Message[], projected: Message[]): Message[] {
  const positions = new Map(original.map((message, index) => [message, index]));
  const restored: Message[] = [];
  const annotations: Message[] = [];
  let cursor = 0;

  function keepSystemsBefore(end: number) {
    while (cursor < end) {
      const message = original[cursor++];
      if (message.role === "system") restored.push(message);
    }
  }

  for (const message of projected) {
    if (message.role === "system") throw new Error("Conversation projections must not introduce system messages.");
    const position = positions.get(message);
    if (position === undefined) {
      annotations.push(message);
      continue;
    }
    if (position < cursor) throw new Error("Conversation projections must preserve retained message order.");
    keepSystemsBefore(position);
    restored.push(...annotations, message);
    annotations.length = 0;
    cursor = position + 1;
  }
  // Trailing host deltas still precede newly appended recovery/report annotations.
  keepSystemsBefore(original.length);
  restored.push(...annotations);
  return restored;
}
