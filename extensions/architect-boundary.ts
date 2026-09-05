import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ARCHITECT_ROLE = "architect";
const ALLOWED_TOOLS = new Set(["switch_role", "task_workflow"]);
const ARCHITECT_BOUNDARY_REASON =
  "[pi-init-architect-boundary] 架构师只负责分析、决策和计划；请先调用 switch_role(role=\"docs-commit\")，由文档与提交工程师收集并交接证据。";

export function createArchitectBoundary(
  pi: ExtensionAPI,
  getActiveRole: (ctx: ExtensionContext) => string | undefined,
) {
  pi.on("tool_call", (event, ctx) => {
    if (getActiveRole(ctx) !== ARCHITECT_ROLE || ALLOWED_TOOLS.has(event.toolName)) return undefined;
    return {
      block: true,
      reason: ARCHITECT_BOUNDARY_REASON,
    };
  });
}
