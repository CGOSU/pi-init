import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { workflowActionIdentity, workflowHandoffIdentity, workflowReplanIdentity } from "../src/workflow-handoff.ts";
import { coordinationHandoffIdentity } from "./coordination-runtime-protocol.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";

type RunBinding = {
  sessionId: string;
  contextGeneration: number;
  roleGeneration: number;
  role: string;
  branchAnchor?: string;
  workflow: ReturnType<typeof workflowActionIdentity>;
  task: ReturnType<typeof workflowHandoffIdentity>;
  replan: ReturnType<typeof workflowReplanIdentity>;
  coordination: ReturnType<typeof coordinationHandoffIdentity>;
  workflowStatus?: string;
  currentTaskId?: string;
};
const MAX_CALLS = 256;
const IDENTITY_FIELDS = ["workflowId", "planVersion", "sessionId", "recoveryGeneration", "revisionId", "attemptId", "handoffId", "coordinationIdentity", "coordinationHandoffId"];
const TASK_ACTIONS = new Set(["complete", "block", "clarify", "checkpoint"]);
const REPLAN_ACTIONS = new Set(["replan", "review-child"]);
const MUTATION_ACTIONS = new Set(["resume", "retry", "cancel", "cancel-all", "request-replan", "request-child", "request-goal"]);

export function createWorkflowToolBinding(pi: ExtensionAPI, state: ExtensionRuntimeState) {
  let request: RunBinding | undefined;
  const calls = new Map<string, RunBinding>();
  let sources = new WeakMap<object, RunBinding>();
  const sourceKeys = new Map<string, RunBinding>();
  let messages = new WeakMap<object, RunBinding>();
  const messageKeys = new Map<string, RunBinding>();
  function messageKey(message: { timestamp?: unknown; provider?: unknown; model?: unknown }) {
    return typeof message.timestamp === "number" ? JSON.stringify([message.timestamp, message.provider, message.model]) : undefined;
  }

  function capture(ctx: ExtensionContext): RunBinding {
    const branch = ctx.sessionManager.getBranch();
    const coordination = state.coordinationRuntimeState;
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      contextGeneration: state.roleContextGeneration,
      roleGeneration: state.roleTransitionGeneration,
      role: JSON.stringify(state.activeRole ?? null),
      branchAnchor: branch.findLast(entry => typeof entry.id === "string")?.id,
      workflow: workflowActionIdentity(state.workflowState),
      task: workflowHandoffIdentity(state.workflowState),
      replan: workflowReplanIdentity(state.workflowState),
      coordination: coordination ? coordinationHandoffIdentity(coordination) : undefined,
      workflowStatus: state.workflowState?.status,
      currentTaskId: state.workflowState?.currentTaskId,
    };
  }

  function remember(id: string, binding: RunBinding) {
    if (calls.size >= MAX_CALLS) calls.delete(calls.keys().next().value!);
    calls.set(id, binding);
  }

  function stale(binding: RunBinding, ctx: ExtensionContext) {
    const current = capture(ctx);
    const previousAnchor = binding.branchAnchor;
    const previous = { ...binding };
    const now = { ...current };
    delete previous.branchAnchor;
    delete now.branchAnchor;
    return state.runtimeDisposed || JSON.stringify(previous) !== JSON.stringify(now)
      || (previousAnchor !== undefined && !ctx.sessionManager.getBranch().some(entry => entry.id === previousAnchor));
  }

  function bindingError(code: string, message: string): never {
    throw Object.assign(new Error(message), { code });
  }

  function bind<T extends Record<string, unknown>>(toolCallId: string, params: T, ctx: ExtensionContext): T {
    const binding = calls.get(toolCallId);
    calls.delete(toolCallId);
    const action = String(params.action);
    if (action === "status") return params;
    if (!binding) {
      // Explicit legacy identities still go through the existing domain validators.
      if (action !== "checkpoint" && IDENTITY_FIELDS.some(field => params[field] !== undefined)) return params;
      if (!TASK_ACTIONS.has(action) && !REPLAN_ACTIONS.has(action) && !MUTATION_ACTIONS.has(action)
        && action !== "report-evidence" && action !== "review-evidence") return params;
      return bindingError("WORKFLOW_RUN_BINDING_MISSING", "缺少本次工具调用的真实派发身份；不能以当前状态补齐旧结果。请等待当前任务回合或查询状态。");
    }
    if (stale(binding, ctx)) {
      return bindingError("WORKFLOW_RUN_BINDING_STALE", "工具所属回合、角色、任务或恢复身份已变化；拒绝将旧结果绑定到最新任务。");
    }
    if (TASK_ACTIONS.has(action)) return { ...binding.task, ...params };
    if (REPLAN_ACTIONS.has(action)) return { ...binding.replan, ...params };
    if (MUTATION_ACTIONS.has(action)) return { ...binding.workflow, ...params };
    if (action === "report-evidence" || action === "review-evidence" || (action === "request-evidence" && binding.coordination)) {
      if (params.coordinationIdentity !== undefined || params.coordinationHandoffId !== undefined) return params;
      return { ...params, coordinationIdentity: binding.coordination };
    }
    return params;
  }

  pi.on("before_provider_request", (_event, ctx) => {
    try { request = capture(ctx); } catch { request = undefined; }
  });
  pi.on("message_start", event => {
    if (!request || event.message.role !== "assistant") return;
    messages.set(event.message, request);
    const key = messageKey(event.message);
    if (key) {
      if (messageKeys.size >= MAX_CALLS) messageKeys.delete(messageKeys.keys().next().value!);
      messageKeys.set(key, request);
    }
  });
  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    const key = messageKey(event.message);
    const binding = messages.get(event.message) ?? (key ? messageKeys.get(key) : undefined);
    messages.delete(event.message);
    if (key) messageKeys.delete(key);
    if (!binding) return;
    sources.set(event.message, binding);
    if (key) {
      if (sourceKeys.size >= MAX_CALLS) sourceKeys.delete(sourceKeys.keys().next().value!);
      sourceKeys.set(key, binding);
    }
    for (const item of event.message.content) {
      if (item.type === "toolCall") remember(item.id, binding);
    }
  });
  pi.on("tool_call", event => {
    if (event.parentToolCallId && !calls.has(event.toolCallId)) {
      const parent = calls.get(event.parentToolCallId);
      if (parent) remember(event.toolCallId, parent);
    }
  });
  pi.on("tool_result", event => { calls.delete(event.toolCallId); });
  function source(message: object, ctx: ExtensionContext) {
    const key = messageKey(message);
    const binding = sources.get(message) ?? (key ? sourceKeys.get(key) : undefined);
    return binding && !stale(binding, ctx) ? binding.task : undefined;
  }
  function reset() { request = undefined; calls.clear(); messages = new WeakMap(); sources = new WeakMap(); messageKeys.clear(); sourceKeys.clear(); }
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);
  pi.on("session_compact", reset);
  return { bind, source };
}
