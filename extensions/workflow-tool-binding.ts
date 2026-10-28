import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { workflowActionIdentity, workflowHandoffIdentity, workflowReplanIdentity, workflowHandoffMessageOnBranch } from "../src/workflow-handoff.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { activeRoleMatches } from "./runtime-state.ts";
import { hasCompleteToolPairs, identityMatches, isRecord, type ContextMessage } from "./role-context-protocol.ts";

type RunBinding = {
  sessionId: string;
  contextGeneration: number;
  roleGeneration: number;
  role: string;
  branchAnchor?: string;
  workflow: ReturnType<typeof workflowActionIdentity>;
  task: ReturnType<typeof workflowHandoffIdentity>;
  replan: ReturnType<typeof workflowReplanIdentity>;
  workflowStatus?: string;
  currentTaskId?: string;
};
const MAX_CALLS = 256;
const IDENTITY_FIELDS = ["workflowId", "planVersion", "sessionId", "recoveryGeneration", "revisionId", "attemptId", "handoffId"];
const TASK_ACTIONS = new Set(["complete", "block", "checkpoint"]);
const REPLAN_ACTIONS = new Set(["replan"]);
const MUTATION_ACTIONS = new Set(["resume", "retry", "cancel", "cancel-all", "request-replan", "request-goal"]);

export function createWorkflowToolBinding(pi: ExtensionAPI, state: ExtensionRuntimeState) {
  let request: RunBinding | undefined;
  let toolEpoch = 0;
  let uncertainTools = false;
  const activeTools = new Set<string>();
  const executedRoots = new Set<string>();
  let safeRequests = new WeakMap<RunBinding, number>();
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
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      contextGeneration: state.roleContextGeneration,
      roleGeneration: state.roleTransitionGeneration,
      role: JSON.stringify(state.activeRole ?? null),
      branchAnchor: branch.findLast(entry => typeof entry.id === "string")?.id,
      workflow: workflowActionIdentity(state.workflowState),
      task: workflowHandoffIdentity(state.workflowState),
      replan: workflowReplanIdentity(state.workflowState),
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
      if (!TASK_ACTIONS.has(action) && !REPLAN_ACTIONS.has(action) && !MUTATION_ACTIONS.has(action)) return params;
      return bindingError("WORKFLOW_RUN_BINDING_MISSING", "缺少本次工具调用的真实派发身份；不能以当前状态补齐旧结果。请等待当前任务回合或查询状态。");
    }
    if (stale(binding, ctx)) {
      return bindingError("WORKFLOW_RUN_BINDING_STALE", "工具所属回合、角色、任务或恢复身份已变化；拒绝将旧结果绑定到最新任务。");
    }
    if (TASK_ACTIONS.has(action)) return { ...binding.task, ...params };
    if (REPLAN_ACTIONS.has(action)) return { ...binding.replan, ...params };
    if (MUTATION_ACTIONS.has(action)) return { ...binding.workflow, ...params };
    return params;
  }

  pi.on("before_provider_request", (_event, ctx) => {
    try { request = capture(ctx); } catch { request = undefined; }
    // Missing safety evidence must not discard the ordinary tool identity binding.
    if (request) {
      try { if (providerBoundarySafe(ctx)) safeRequests.set(request, toolEpoch); } catch {}
    }
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
  pi.on("tool_result", event => { calls.delete(event.toolCallId); if (event.isError) uncertainTools = true; });
  function sourceBinding(message: object) {
    const key = messageKey(message);
    return sources.get(message) ?? (key ? sourceKeys.get(key) : undefined);
  }
  function source(message: object, ctx: ExtensionContext) {
    const binding = sourceBinding(message);
    return binding && !stale(binding, ctx) ? binding.task : undefined;
  }
  function isCurrentSource(message: object, ctx: ExtensionContext) {
    const binding = sourceBinding(message);
    return binding ? !stale(binding, ctx) : undefined;
  }
  function providerBoundarySafe(ctx: ExtensionContext) {
    const workflow = state.workflowState;
    const task = workflow?.tasks.find(task => task.id === workflow.currentTaskId);
    const identity = workflowHandoffIdentity(workflow);
    if (!ctx.isProjectTrusted() || state.runtimeDisposed || state.roleRecoveryPending || state.roleRecoveryPersistenceFailed
      || state.workflowRestoreError || state.pendingWorkflowRecovery || state.workflowDispatchInFlight
      || workflow?.status !== "running" || workflow.handoff?.phase !== "executing"
      || task?.status !== "in_progress" || task.outcomeUnknown || task.delegation
      || state.activeRole?.role !== task.role || !activeRoleMatches(state, ctx, pi.getThinkingLevel())
      || !identity || !workflowHandoffMessageOnBranch(ctx, identity)
      || activeTools.size || uncertainTools) return false;
    const branch = ctx.sessionManager.getBranch();
    const start = branch.findIndex(entry => entry.type === "custom_message"
      && entry.customType === "pi-init-workflow-task" && identityMatches(entry.details, identity));
    const messages = branch.slice(start + 1).flatMap(entry => entry.type === "message" ? [entry.message] : []);
    return persistedToolsComplete(messages);
  }
  function persistedToolsComplete(messages: readonly ContextMessage[]) {
    if (activeTools.size || uncertainTools || !hasCompleteToolPairs(messages) || messages.some(message => {
      if (message.role !== "toolResult") return false;
      const nested = isRecord(message) ? message.nestedCalls : undefined;
      return message.isError || nested !== undefined && (!isRecord(nested) || nested.complete !== true);
    })) return false;
    const results = new Set(messages.flatMap(message => message.role === "toolResult" ? [message.toolCallId] : []));
    return [...executedRoots].every(id => results.has(id));
  }
  function toolsSettled(ctx: ExtensionContext) {
    const workflow = state.workflowState;
    if (!workflow) return false;
    const branch = ctx.sessionManager.getBranch();
    const start = branch.findLastIndex(entry => entry.type === "custom_message" && entry.customType === "pi-init-workflow-task"
      && isRecord(entry.details) && entry.details.workflowId === workflow.workflowId
      && entry.details.sessionId === ctx.sessionManager.getSessionId());
    return start >= 0 && persistedToolsComplete(branch.slice(start + 1).flatMap(entry => entry.type === "message" ? [entry.message] : []));
  }
  function providerFailureGuard(message: object, ctx: ExtensionContext) {
    const binding = sourceBinding(message);
    if (!isRecord(message) || message.stopReason !== "error" || !Array.isArray(message.content)
      || message.content.some(part => isRecord(part) && part.type === "toolCall")
      || !binding || stale(binding, ctx) || safeRequests.get(binding) !== toolEpoch
      || !providerBoundarySafe(ctx) || ctx.hasPendingMessages()) return undefined;
    const epoch = toolEpoch;
    return (current: ExtensionContext) => !stale(binding, current) && safeRequests.get(binding) === epoch
      && epoch === toolEpoch && current.isIdle() && !current.hasPendingMessages() && providerBoundarySafe(current);
  }
  pi.on("agent_start", () => {
    uncertainTools = activeTools.size > 0;
    executedRoots.clear();
  });
  pi.on("tool_execution_start", event => {
    toolEpoch++;
    if (activeTools.size >= MAX_CALLS || activeTools.has(event.toolCallId)
      || event.parentToolCallId && !activeTools.has(event.parentToolCallId)) uncertainTools = true;
    if (activeTools.size < MAX_CALLS) activeTools.add(event.toolCallId);
    if (!event.parentToolCallId) {
      if (executedRoots.size >= MAX_CALLS) uncertainTools = true;
      else executedRoots.add(event.toolCallId);
    }
  });
  pi.on("tool_execution_end", event => {
    if (!activeTools.delete(event.toolCallId) || event.isError) uncertainTools = true;
  });

  function reset() { toolEpoch++; activeTools.clear(); executedRoots.clear(); uncertainTools = false; safeRequests = new WeakMap(); request = undefined; calls.clear(); messages = new WeakMap(); sources = new WeakMap(); messageKeys.clear(); sourceKeys.clear(); }
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", reset);
  pi.on("session_compact", reset);
  return { bind, source, isCurrentSource, providerFailureGuard, toolsSettled };
}
