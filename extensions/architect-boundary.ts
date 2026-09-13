import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ARCHITECT_ROLE = "architect";
const ALLOWED_TASK_WORKFLOW_ACTIONS = new Set(["plan", "replan", "status"]);
const ARCHITECT_BOUNDARY_REASON =
  "[pi-init-architect-boundary] 架构师不取证、不执行、不连接 MCP，只负责思考、分析、决策、规划和安排；运行时仅允许调用 switch_role，以及 task_workflow 的 plan、replan、status。read/grep/find/ffgrep/fffind/browser、shell、edit/write、subagent/agent_message、MCP/mcpScript、直连 MCP 和未知工具均被阻断；需要其他职责时请先调用 switch_role。";
const TASK_WORKFLOW_BOUNDARY_REASON =
  `${ARCHITECT_BOUNDARY_REASON} task_workflow 的其他动作（包括 complete、block、resume、retry、cancel）均被阻断。`;
const NON_ARCHITECT_WORKFLOW_PLAN_REASON =
  "只有架构角色可以执行 task_workflow 的 plan/replan；请先调用 switch_role(role=architect)。";

function isTaskWorkflowAction(input: unknown): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  try {
    const action = (input as { action?: unknown }).action;
    return typeof action === "string" && ALLOWED_TASK_WORKFLOW_ACTIONS.has(action);
  } catch {
    return false;
  }
}

function isAllowedArchitectToolCall(toolName: unknown, input: unknown): boolean {
  if (toolName === "switch_role") return true;
  return toolName === "task_workflow" && isTaskWorkflowAction(input);
}

function isArchitectOnlyWorkflowPlan(toolName: unknown, input: unknown): boolean {
  if (toolName !== "task_workflow" || input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const action = (input as { action?: unknown }).action;
  return action === "plan" || action === "replan";
}

export function createArchitectBoundary(
  pi: ExtensionAPI,
  getActiveRole: (ctx: ExtensionContext) => string | undefined,
  onBlocked?: (toolName: string, ctx: ExtensionContext) => void,
) {
  pi.on("tool_call", (event, ctx) => {
    const toolName = typeof event?.toolName === "string" ? event.toolName : undefined;
    const activeRole = getActiveRole(ctx);
    if (activeRole !== ARCHITECT_ROLE) {
      if (isArchitectOnlyWorkflowPlan(toolName, event?.input)) {
        return { block: true, reason: NON_ARCHITECT_WORKFLOW_PLAN_REASON };
      }
      return undefined;
    }
    if (isAllowedArchitectToolCall(toolName, event?.input)) return undefined;

    if (toolName) {
      try {
        onBlocked?.(toolName, ctx);
      } catch {
        // Keep the architectural guard fail-closed even if state reporting fails.
      }
    }
    return {
      block: true,
      reason: toolName === "task_workflow" ? TASK_WORKFLOW_BOUNDARY_REASON : ARCHITECT_BOUNDARY_REASON,
    };
  });
}
