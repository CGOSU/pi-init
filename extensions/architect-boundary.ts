import { isRecord } from "../src/value-guards.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ARCHITECT_ROLE = "architect";
/** architect 允许的 task_workflow 动作由这一份定义同时驱动运行时边界与工具/交接指导。 */
export const ARCHITECT_ALLOWED_TASK_WORKFLOW_ACTIONS = ["plan", "replan", "status", "request-replan", "request-goal"] as const;
export const ARCHITECT_ALLOWED_ACTIONS_TEXT = ARCHITECT_ALLOWED_TASK_WORKFLOW_ACTIONS.join("、");
const ALLOWED_TASK_WORKFLOW_ACTIONS = new Set<string>(ARCHITECT_ALLOWED_TASK_WORKFLOW_ACTIONS);
export const ARCHITECT_READ_ONLY_TOOLS = [
  "read", "grep", "find", "ls", "ffgrep", "fffind", "graph_locate", "graph_inspect", "obs_recall",
] as const;
export const ARCHITECT_READ_ONLY_TOOLS_TEXT = ARCHITECT_READ_ONLY_TOOLS.join("、");
const READ_ONLY_TOOLS = new Set<string>(ARCHITECT_READ_ONLY_TOOLS);
const ARCHITECT_BOUNDARY_REASON =
  `[pi-init-architect-boundary] 架构师只负责分析、决策、规划和安排；为当前决策可用的本地只读工具仅限 ${ARCHITECT_READ_ONLY_TOOLS_TEXT}，另可调用 switch_role 及 task_workflow 的 ${ARCHITECT_ALLOWED_ACTIONS_TEXT}。恢复、停止和未知结果守卫仍优先。执行、验收、file_review 登记、shell/bash、codemode、browser、edit/write、初始化、协作、MCP（含只读包装）及未知工具均被阻断；需要执行时请交给匹配角色。`;
const TASK_WORKFLOW_BOUNDARY_REASON =
  `${ARCHITECT_BOUNDARY_REASON} task_workflow 的其他动作（包括 complete、block、resume、retry、cancel）均被阻断。`;
const NON_ARCHITECT_WORKFLOW_PLAN_REASON =
  "只有架构角色可以执行 task_workflow 的 plan/replan；请先调用 switch_role(role=architect)。";

function isTaskWorkflowAction(input: unknown): boolean {
  if (!isRecord(input)) return false;
  try {
    const action = (input as { action?: unknown }).action;
    return typeof action === "string" && ALLOWED_TASK_WORKFLOW_ACTIONS.has(action);
  } catch {
    return false;
  }
}

function isAllowedArchitectToolCall(toolName: unknown, input: unknown): boolean {
  if (toolName === "switch_role") return true;
  if (typeof toolName === "string" && READ_ONLY_TOOLS.has(toolName)) return true;
  return toolName === "task_workflow" && isTaskWorkflowAction(input);
}

function isArchitectOnlyWorkflowPlan(toolName: unknown, input: unknown): boolean {
  if (toolName !== "task_workflow" || !isRecord(input)) {
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
