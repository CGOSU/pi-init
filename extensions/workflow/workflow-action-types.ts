import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { taskWorkflowParameters } from "./workflow-tool-parameters.ts";
import type { RoleRuntime } from "../role/role-runtime.ts";
import type { WorkflowDispatch } from "./workflow-dispatch.ts";
import type { WorkflowReport } from "./workflow-report.ts";
import type { WorkflowStore } from "./workflow-store.ts";
import type { TaskMemoryRuntime } from "./task-memory-runtime.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type WorkflowActionDependencies = {
  roleRuntime: RoleRuntime;
  dispatch: WorkflowDispatch;
  report: WorkflowReport;
  store: Omit<WorkflowStore, "restoreSnapshot">;
  taskMemory?: TaskMemoryRuntime;
  freshSession?: (ctx: ExtensionCommandContext) => Promise<void>;
  resumeExecution?: (ctx: ExtensionContext) => boolean;
  startNewTask?: (ctx: ExtensionContext) => void;
};

export type WorkflowActionResult = {
  content: { type: "text"; text: string }[];
  details: unknown;
  terminate?: boolean;
};

export type WorkflowActionParameters = Parameters<ToolDefinition<typeof taskWorkflowParameters>["execute"]>[1];
