import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const COLLABORATION_ACTIONS = [
  "status", "list", "sessions", "session", "tail", "send", "broadcast", "feed", "thread", "reserve", "release",
] as const;

export const collaborationMessageParameters = Type.Object({
  action: StringEnum(COLLABORATION_ACTIONS, { description: "status | list | sessions | session | tail | send | broadcast | feed | thread | reserve | release" }),
  to: Type.Optional(Type.String({ description: "Agent name or run selector" })),
  runId: Type.Optional(Type.String({ description: "Specific subagent run id" })),
  message: Type.Optional(Type.String({ description: "Message text" })),
  replyTo: Type.Optional(Type.String({ description: "Message id to reply to" })),
  urgent: Type.Optional(Type.Boolean({ description: "Interrupt the recipient immediately" })),
  limit: Type.Optional(Type.Number({ description: "Maximum entries to return" })),
  includeCompleted: Type.Optional(Type.Boolean({ description: "Include completed runs" })),
  paths: Type.Optional(Type.Array(Type.String(), { description: "Paths to reserve or release" })),
  reason: Type.Optional(Type.String({ description: "Reservation reason" })),
});

export interface CollaborationToolResult {
  text: string;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export interface CollaborationToolApi {
  executeMessage(params: Record<string, unknown>, ctx: ExtensionContext): CollaborationToolResult;
  openOverlay(ctx: ExtensionContext): Promise<void>;
}

export function registerAgentMessageTool(pi: ExtensionAPI, api: CollaborationToolApi): void {
  pi.registerTool({
    name: "agent_message",
    label: "Agent Message",
    description: "Inspect collaborating agents, send direct or broadcast messages, reserve paths, and inspect subagent sessions.",
    promptSnippet: "Coordinate shared-workspace agents with messages and file reservations",
    promptGuidelines: [
      "Before editing shared files, reserve the narrowest path with agent_message action=reserve.",
      "Use direct messages for blockers and broadcasts for shared status; urgent messages interrupt the recipient.",
      "Use sessions, session, and tail instead of scanning Pi session directories manually.",
      "Reservations coordinate edit/write tools but do not sandbox shell commands or roll back partial changes.",
    ],
    parameters: collaborationMessageParameters,
    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "...";
      return new Text(theme.fg("toolTitle", theme.bold("协作 ")) + theme.fg("muted", action), 0, 0);
    },
    renderResult(result, _options, theme) {
      const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
      return new Text(theme.fg(result.isError ? "error" : "success", result.isError ? "✗ " : "✓ ") + text, 0, 0);
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = api.executeMessage(params as Record<string, unknown>, ctx);
      return { content: [{ type: "text", text: result.text }], details: result.details, isError: result.isError };
    },
  });
}

export function registerAgentsCommand(pi: ExtensionAPI, api: CollaborationToolApi): void {
  pi.registerCommand("agents", {
    description: "打开协作 Agent、消息和文件 reservation 面板",
    handler: async (_args, ctx) => api.openOverlay(ctx),
  });
}
