import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { writeFile } from "node:fs/promises";

/** Real SDK scheduling with a deterministic in-process provider; no network or real business tools. */
export async function sdkAssistantTurn(stopReason, sideEffectPath, id = "proposal") {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const model = { id: "test", name: "test", provider: "test", api: "openai-responses", input: ["text"],
    reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };
  let response = 0;
  const agent = new Agent({
    initialState: { model, tools: [{ name: "write_marker", label: "write marker", description: "isolated execution marker",
      parameters: Type.Object({}), async execute() {
        await writeFile(sideEffectPath, "executed", "utf8");
        return { content: [{ type: "text", text: "done" }], details: {} };
      } }] },
    streamFn: () => {
      const first = response++ === 0;
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage,
        content: first ? [{ type: "thinking", thinking: "Unfinished planning" }, { type: "toolCall", id, name: "write_marker", arguments: {} }] : [],
        stopReason: first ? stopReason : "stop", timestamp: Date.now(),
        ...(["error", "aborted"].includes(stopReason) && first ? { errorMessage: "terminated" } : {}) };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push(["error", "aborted"].includes(message.stopReason)
        ? { type: "error", reason: message.stopReason, error: message }
        : { type: "done", reason: message.stopReason, message });
      return stream;
    },
  });
  const started = new Set();
  agent.subscribe(event => { if (event.type === "tool_execution_start") started.add(event.toolCallId); });
  await agent.prompt("Test scheduling only");
  return { messages: agent.state.messages, started };
}
