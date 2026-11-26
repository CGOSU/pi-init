import type { BeforeAgentStartEvent, ContextWithSystemEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getWorkflowTask } from "../../src/workflow.ts";
import { roleLabel, isValidRoleId } from "../../src/roles.ts";
import type { ActiveRole, RuntimeStateView } from "../runtime-state.ts";

import { nextWorkflowAction, type WorkflowNextAction } from "../workflow/workflow-action-policy.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SECTION_KEY = "pi_init_runtime";
const SECTION_OPEN = `<${SECTION_KEY}>\n`;
const SECTION_CLOSE = `\n</${SECTION_KEY}>`;

type ContextMessage = ContextWithSystemEvent["messages"][number];
type SystemDeltaMessage = Extract<ContextMessage, { role: "system" }>;
type RuntimeDeltaAnchor = {
  index: number;
  boundary: string;
  message: SystemDeltaMessage;
};

function formatRuntimeSection(existing: string, section: string) {
  return existing.startsWith(SECTION_OPEN) && existing.endsWith(SECTION_CLOSE)
    ? `${SECTION_OPEN}${section}${SECTION_CLOSE}`
    : section;
}

function messageBoundaryKey(message: ContextMessage) {
  if (message.role === "system") return ["system", message.timestamp, message.sections?.[SECTION_KEY] ?? null];
  if (message.role === "toolResult") return ["toolResult", message.timestamp, message.toolCallId];
  if (message.role === "custom") return ["custom", message.timestamp, message.customType];
  return [message.role, message.timestamp];
}

function prefixBoundarySignature(messages: ContextMessage[], endIndex: number) {
  const keys: unknown[] = [];
  for (let index = 0; index < endIndex; index++) keys.push(messageBoundaryKey(messages[index]));
  return JSON.stringify(keys);
}

type RuntimeRoutingDependencies = {
  getActiveRole: (ctx: ExtensionContext) => ActiveRole | undefined;
  getThinkingLevel: () => string;
};

function workflowSummary(state: RuntimeStateView) {
  const workflow = state.workflowState;
  if (!workflow || workflow.status === "completed" || workflow.status === "cancelled") return "无活动工作流";
  const task = workflow.currentTaskId ? getWorkflowTask(workflow, workflow.currentTaskId) : undefined;
  const taskSummary = task ? `${task.id}（${task.role}/${task.status}）` : "等待任务";
  const pause = workflow.status === "paused" ? `，暂停原因：${workflow.pauseReason ?? "未记录"}${workflow.taskPauseReason ? `（${workflow.taskPauseReason}）` : ""}。暂停不是当前任务执行授权，不沿用旧 attempt/handoff` : "";
  return `未结束工作流：${workflow.executor}/${workflow.status}，当前任务：${taskSummary}${pause}`;
}

function recoveryGuidance(state: RuntimeStateView, step: WorkflowNextAction) {
  if (step.action === "recover") {
    const roleStatus = state.roleRecoveryPersistenceFailed ? "持久化失败" : state.roleRecoveryPending ? "pending" : "已确认";
    return `职责恢复：${roleStatus}。恢复指引见下一步；职责确认不是工作流执行授权。`;
  }
  return "职责恢复：已确认。简单无工具问答直接回答；不要调用 task_workflow(status)，当前职责匹配时不要重复 switch_role。自动交接已确认时只继续未完成工作，不为压缩重复换角。";
}

function buildRuntimeSection(
  state: RuntimeStateView,
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
    `工作流下一步：${step.recovery === "wait" ? "wait" : step.action}。${step.nextAction}`,
  ].join("\n");
}

export function createRuntimeRoutingContext(
  state: RuntimeStateView,
  deps: RuntimeRoutingDependencies,
) {
  const policyRoot = new URL("../../skills/pi-init-role-routing/", import.meta.url);
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
  let anchorScope: string | undefined;
  let anchors: RuntimeDeltaAnchor[] = [];
  function beforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext) {
    anchorScope = undefined;
    anchors = [];
    if (!event.systemPromptOptions?.sections) return;
    const sections = event.systemPromptOptions.sections;
    sections.pi_init_policy = "[pi-init 插件自有规范，已加载，无需重复读取SKILL.md]\n来源：" + fileURLToPath(new URL("SKILL.md", policyRoot))
      + "\n通用规范不改写项目AGENTS或历史，不默默覆盖项目具体要求；动态身份、恢复/停止状态及工具守卫优先。\n" + commonPolicy;
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

  function contextWithSystem(event: ContextWithSystemEvent, ctx: ExtensionContext) {
    // A same-role confirmation or workflow state change can finish without starting
    // a fresh run. Never rewrite leading or historical system messages (which breaks
    // cached prompt prefixes); emit anchored request-local system deltas instead.
    const { messages } = event;
    let latestRuntime: string | undefined;
    let latestSystemIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role !== "system" || !message.sections || !(SECTION_KEY in message.sections)) continue;
      const value = message.sections[SECTION_KEY];
      if (typeof value !== "string") return;
      latestRuntime = value;
      latestSystemIndex = index;
      break;
    }
    if (latestRuntime === undefined) return;

    const scope = JSON.stringify([ctx.sessionManager?.getSessionId?.(), state.roleContextGeneration]);
    if (scope !== anchorScope) {
      anchorScope = scope;
      anchors = [];
    }

    const validAnchors: RuntimeDeltaAnchor[] = [];
    for (const anchor of anchors) {
      if (anchor.index <= latestSystemIndex || anchor.index > messages.length) break;
      if (prefixBoundarySignature(messages, anchor.index) !== anchor.boundary) break;
      validAnchors.push(anchor);
    }

    const section = buildRuntimeSection(state, ctx, deps);
    const formatted = formatRuntimeSection(latestRuntime, section);
    const effectiveRuntime = validAnchors.at(-1)?.message.sections?.[SECTION_KEY] ?? latestRuntime;

    if (effectiveRuntime !== formatted) {
      const last = messages.at(-1) as { timestamp?: number } | undefined;
      const delta: SystemDeltaMessage = {
        role: "system",
        content: "",
        sections: { [SECTION_KEY]: formatted },
        timestamp: typeof last?.timestamp === "number" ? last.timestamp : 0,
      };
      const entry: RuntimeDeltaAnchor = {
        index: messages.length,
        boundary: prefixBoundarySignature(messages, messages.length),
        message: delta,
      };
      if (validAnchors.at(-1)?.index === messages.length) {
        const priorRuntime = validAnchors.length > 1
          ? validAnchors[validAnchors.length - 2].message.sections?.[SECTION_KEY]
          : latestRuntime;
        if (priorRuntime === formatted) validAnchors.pop();
        else validAnchors[validAnchors.length - 1] = entry;
      } else {
        validAnchors.push(entry);
      }
    }

    if (validAnchors.length === 0) return;
    anchors = validAnchors;

    const updated: ContextMessage[] = [];
    let anchorCursor = 0;
    for (let index = 0; index < messages.length; index++) {
      while (anchorCursor < validAnchors.length && validAnchors[anchorCursor].index === index) {
        updated.push(validAnchors[anchorCursor++].message);
      }
      updated.push(messages[index]);
    }
    while (anchorCursor < validAnchors.length) updated.push(validAnchors[anchorCursor++].message);
    return { messages: updated };
  }

  return { beforeAgentStart, contextWithSystem };
}
