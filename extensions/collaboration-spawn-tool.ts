import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { startSubagentBatch, type SpawnBatch } from "./collaboration-spawn.ts";
import type { CollaborationDirs, SubagentTask } from "./collaboration-types.ts";

const taskSchema = Type.Object({
  task: Type.String({ description: "Shared-workspace task for the child Agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory override" })),
  files: Type.Optional(Type.Array(Type.String(), { description: "Allowed paths" })),
  acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { description: "Acceptance criteria" })),
});

export const subagentParameters = Type.Object({
  task: Type.Optional(Type.String({ description: "Single child Agent task" })),
  tasks: Type.Optional(Type.Array(taskSchema, { description: "Parallel child Agent tasks" })),
  cwd: Type.Optional(Type.String({ description: "Default shared working directory" })),
  role: Type.Optional(Type.String({ description: "pi-init role; required and resolved from roleModels (no fork default fallback)" })),
  type: Type.Optional(Type.String({ description: "Legacy alias for role; it never selects a fork default profile" })), 
});

export interface SubagentToolApi {
  ensureRegistered(ctx: ExtensionContext): boolean;
  dirs: CollaborationDirs;
  start(pi: ExtensionAPI, ctx: ExtensionContext, tasks: SubagentTask[], role?: string): Promise<SpawnBatch>;
}

export function registerSubagentTool(pi: ExtensionAPI, api: SubagentToolApi): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Spawn one or more child Pi Agents in the current shared working directory.",
    promptSnippet: "Spawn collaborating Agents in a shared workspace",
    promptGuidelines: [
      "Use this for independent shared-workspace tasks; reserve exact paths before editing.",
      "Use agent_message to coordinate blockers and inspect child sessions.",
      "A child Agent result is not task_workflow acceptance; verify the actual shared changes separately.",
      "This mode does not create Git worktrees or automatically roll back partial changes.",
    ],
    parameters: subagentParameters,
    renderCall(args, theme) {
      const count = Array.isArray(args.tasks) ? args.tasks.length : 1;
      return new Text(theme.fg("toolTitle", theme.bold("子 Agent ")) + theme.fg("muted", `${count} 个任务`), 0, 0);
    },
    renderResult(result, _options, theme) {
      const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
      return new Text(theme.fg(result.isError ? "error" : "success", result.isError ? "✗ " : "✓ ") + text, 0, 0);
    },
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!api.ensureRegistered(ctx)) {
        return { content: [{ type: "text", text: "无法注册当前 Agent。" }], isError: true };
      }
      const single = typeof params.task === "string" && params.task.trim();
      const parallel = Array.isArray(params.tasks) && params.tasks.length > 0;
      if (Boolean(single) === parallel) {
        return { content: [{ type: "text", text: "请只提供 task 或 tasks。" }], isError: true };
      }
      const tasks: SubagentTask[] = parallel
        ? params.tasks.map((task) => ({ task: task.task, cwd: task.cwd || params.cwd, files: task.files, acceptanceCriteria: task.acceptanceCriteria }))
        : [{ task: params.task, cwd: params.cwd }];
      const batch = await api.start(pi, ctx, tasks, typeof params.role === "string" ? params.role : typeof params.type === "string" ? params.type : undefined);
      return {
        content: [{ type: "text", text: `已启动 ${batch.records.length} 个共享工作区子 Agent；batch ${batch.batchRunId}。可使用 agent_message action=sessions 查看状态。` }],
        details: batch,
      };
    },
  });
}
