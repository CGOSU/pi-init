import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getWorkflowTask } from "../src/workflow.ts";
import { roleLabel, isValidRoleId } from "../src/roles.ts";
import type { ActiveRole, ExtensionRuntimeState } from "./runtime-state.ts";

import { nextWorkflowAction, type WorkflowNextAction } from "./workflow-action-policy.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SECTION_KEY = "pi_init_runtime";
const CONTINUITY_POLICY = "职责连续性：活动工作流的显式任务角色优先于模型自行判断；无活动任务时优先遵循用户明确指定的任务角色，否则按交付物选择职责。同一交付物内连续调查、实现和验证，分析 Bug、读取 API 文档本身不触发换角；仅在独立交付物或必要架构决策边界交接。architect 不执行；权限、身份、恢复、停止与未知副作用守卫始终优先。无工作流的连续性是路由指导，不代表运行时硬绑定。";

type RuntimeRoutingDependencies = {
  getActiveRole: (ctx: ExtensionContext) => ActiveRole | undefined;
  getThinkingLevel: () => string;
};

function workflowSummary(state: ExtensionRuntimeState) {
  const workflow = state.workflowState;
  if (!workflow || workflow.status === "completed" || workflow.status === "cancelled") return "无活动工作流";
  const task = workflow.currentTaskId ? getWorkflowTask(workflow, workflow.currentTaskId) : undefined;
  const taskSummary = task ? `${task.id}（${task.role}/${task.status}）` : "等待任务";
  const pause = workflow.status === "paused" ? `，暂停原因：${workflow.pauseReason ?? "未记录"}${workflow.taskPauseReason ? `（${workflow.taskPauseReason}）` : ""}。暂停不是当前任务执行授权，不沿用旧 attempt/handoff` : "";
  return `未结束工作流：${workflow.executor}/${workflow.status}，当前任务：${taskSummary}${pause}`;
}

function recoveryGuidance(state: ExtensionRuntimeState, step: WorkflowNextAction) {
  if (step.action === "recover") {
    const roleStatus = state.roleRecoveryPersistenceFailed ? "持久化失败" : state.roleRecoveryPending ? "pending" : "已确认";
    return `职责恢复：${roleStatus}。恢复指引见下一步；职责确认不是工作流执行授权。`;
  }
  return "职责恢复：已确认。简单无工具问答直接回答；不要调用 task_workflow(status)，当前职责匹配时不要重复 switch_role。自动交接已确认时只继续未完成工作，不为压缩重复换角。";
}

function buildRuntimeSection(
  state: ExtensionRuntimeState,
  ctx: ExtensionContext,
  deps: RuntimeRoutingDependencies,
) {
  const activeRole = deps.getActiveRole(ctx);
  const role = activeRole ? roleLabel(activeRole.role) : "未确认";
  const step = nextWorkflowAction(state);
  if (step.recovery === "stop") return [
    "自动执行已暂停，本轮只允许回答新的只读问题。",
    `当前职责：${role}`,
    workflowSummary(state),
    step.nextAction,
  ].join("\n");
  return [
    "当前运行状态（仅用于本轮职责路由，不改变持久状态）：",
    `当前职责：${role}`,
    workflowSummary(state),
    recoveryGuidance(state, step),
    `工作流下一步：${step.action}。${step.nextAction}`,
  ].join("\n");
}

export function createRuntimeRoutingContext(
  state: ExtensionRuntimeState,
  deps: RuntimeRoutingDependencies,
) {
    const policyRoot = new URL("../skills/pi-init-role-routing/", import.meta.url);
      const source = readFileSync(new URL("SKILL.md", policyRoot), "utf8");
      const frontmatterEnd = source.startsWith("---\n") ? source.indexOf("\n---", 4) : -1;
      const commonPolicy = frontmatterEnd < 0 ? source : source.slice(frontmatterEnd + 4).trim();
      const rolePolicies = new Map<string, string | undefined>();
      function rolePolicy(role: string | undefined) {
        if (!role || !isValidRoleId(role)) return undefined;
        if (!rolePolicies.has(role)) {
          try { rolePolicies.set(role, readFileSync(new URL("roles/" + role + ".md", policyRoot), "utf8")); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            rolePolicies.set(role, undefined);
          }
        }
        return rolePolicies.get(role);
      }
  function beforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext) {
    if (!event.systemPromptOptions?.sections) return;
    const sections = event.systemPromptOptions.sections;
    sections.pi_init_policy = "[pi-init 插件自有规范，已加载，无需重复读取SKILL.md]\n来源：" + fileURLToPath(new URL("SKILL.md", policyRoot))
      + "\n通用规范不改写项目AGENTS或历史，不默默覆盖项目具体要求；动态身份、恢复/停止状态及工具守卫优先。\n" + commonPolicy + "\n\n" + CONTINUITY_POLICY;
    // Keep static policy ahead of dynamic sections; let the host append section deltas.
    // Never replace the full prompt or copy authority into a conversation message.
    delete sections.pi_init_role_policy;
    delete sections.pi_init_execution;
    delete sections[SECTION_KEY];
    const active = deps.getActiveRole(ctx);
    const profile = rolePolicy(active?.role);
    if (profile) sections.pi_init_role_policy = "[当前插件角色说明，已加载]\n来源：" + fileURLToPath(new URL("roles/" + active!.role + ".md", policyRoot)) + "\n" + profile;
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "未选择";
    sections.pi_init_execution = `当前模型：${model}，推理强度：${deps.getThinkingLevel()}`;
    sections[SECTION_KEY] = buildRuntimeSection(state, ctx, deps);
  }

  return { beforeAgentStart };
}
