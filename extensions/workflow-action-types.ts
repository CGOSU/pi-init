import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { taskWorkflowParameters } from "./contracts.ts";
import type { RoleRuntime } from "./role-runtime.ts";
import type { WorkflowDispatch } from "./workflow-dispatch.ts";
import type { WorkflowReport } from "./workflow-report.ts";
import type { TaskMemoryRuntime } from "./task-memory-runtime.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type WorkflowActionDependencies = {
  roleRuntime: RoleRuntime;
  dispatch: WorkflowDispatch;
  report: WorkflowReport;
  taskMemory?: TaskMemoryRuntime;
  freshSession?: (ctx: ExtensionCommandContext) => Promise<void>;
  resumeExecution?: (ctx: ExtensionContext) => boolean;
};

export type WorkflowActionResult = {
  content: { type: "text"; text: string }[];
  details: unknown;
  terminate?: boolean;
};

export type WorkflowActionParameters = Parameters<ToolDefinition<typeof taskWorkflowParameters>["execute"]>[1];
