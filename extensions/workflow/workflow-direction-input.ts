import type { ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { transferFrozen } from "../../src/session-handoff.ts";
import { isWorkflowContinuationInput, parseExplicitWorkflowQuestionInput } from "../../src/workflow-input-intent.ts";
import { classifyWorkflowDirection, type DirectionContract } from "../role/architect-direction-model.ts";
import type { RoleRuntime } from "../role/role-runtime.ts";
import { executingWorkflowTask, isExecutionBlockedState, type RuntimeStateView } from "../runtime-state.ts";
import { isAwaitingArchitectureReview } from "./workflow-action-policy.ts";
import { applyWorkflowTaskCorrection, type createWorkflowRevisionInput } from "./workflow-revision-input.ts";
import { workflowHandoffMessageOnBranch } from "./workflow-session-adapter.ts";

const DIRECTION_TIMEOUT_MS = 30_000;
const HANDLED = { action: "handled" } as const;

export function createWorkflowDirectionInput(state: RuntimeStateView, deps: {
  readConfig: RoleRuntime["resolveSessionRoleConfig"];
  activeRoleFor: RoleRuntime["activeRoleFor"];
  revise: ReturnType<typeof createWorkflowRevisionInput>;
  hasOutgoingTransfer: (ctx: ExtensionContext) => boolean;
}) {
  let generation = 0;
  let pending: AbortController | undefined;

  function invalidate() {
    generation += 1;
    pending?.abort();
    return generation;
  }

  async function handle(event: InputEvent, ctx: ExtensionContext, inputGeneration: number): Promise<InputEventResult | undefined> {
    if (typeof event.text !== "string" || !event.text.trim() || isWorkflowContinuationInput(event.text)) return;
    if (inputGeneration !== generation) return HANDLED;
    const session = ctx.sessionManager;
    const sessionId = session.getSessionId();
    const workflow = state.workflowState;
    if (!workflow || workflow.sessionId !== sessionId || !ctx.isProjectTrusted()
      || isExecutionBlockedState(state) || transferFrozen(workflow)
      || Boolean(workflow.pendingRevision) || workflow.tasks.some(task => task.outcomeUnknown)) return;

    const active = executingWorkflowTask(state, sessionId);
    const reviewing = isAwaitingArchitectureReview(workflow) && !workflow.handoff;
    if (!reviewing && (!active || deps.activeRoleFor(ctx)?.role !== active.task.role
      || !workflowHandoffMessageOnBranch(ctx, active.handoff))) return;
    if (deps.hasOutgoingTransfer(ctx)) return;

    const explicitQuestion = parseExplicitWorkflowQuestionInput(event.text);
    if (explicitQuestion) {
      state.traceHandoff?.(ctx, "workflow.direction_classified", {
        outcome: "explicit-question",
        durationMs: 0,
      });
      return { action: "transform", text: explicitQuestion };
    }

    const branchAnchor = session.getLeafId();
    const contextGeneration = state.roleContextGeneration;
    const transitionGeneration = state.roleTransitionGeneration;
    const overrides = state.sessionRoleConfigOverrides;
    const isCurrent = () => inputGeneration === generation && !isExecutionBlockedState(state) && ctx.isProjectTrusted()
      && state.workflowState === workflow && session.getSessionId() === sessionId
      && state.roleContextGeneration === contextGeneration && state.roleTransitionGeneration === transitionGeneration
      && state.sessionRoleConfigOverrides === overrides && !deps.hasOutgoingTransfer(ctx)
      && (!active || deps.activeRoleFor(ctx)?.role === active.task.role)
      && (!branchAnchor || session.getBranch().some(entry => entry.id === branchAnchor));
    const contract: DirectionContract = {
      goal: workflow.plan.summary,
      constraints: workflow.plan.constraints,
      ...(active && { currentTask: { goal: active.task.task, acceptanceCriteria: active.task.acceptanceCriteria } }),
    };
    const controller = new AbortController();
    pending = controller;
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), DIRECTION_TIMEOUT_MS);
    const cancelled = new Promise<undefined>(resolve => {
      controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
    });
    const result = await Promise.race([
      cancelled,
      deps.readConfig(ctx).then(config => (isCurrent() && !controller.signal.aborted)
        ? classifyWorkflowDirection(ctx, config, contract, event.text, controller.signal)
        : undefined).catch(() => ({ ok: false, code: "model-failed" } as const)),
    ]).finally(() => {
      clearTimeout(timer);
      if (pending === controller) pending = undefined;
    });

    if (inputGeneration !== generation) return HANDLED;
    const trace = (outcome: string, code?: string) => {
      state.traceHandoff?.(ctx, "workflow.direction_classified", {
        outcome,
        ...(code ? { code } : {}),
        durationMs: Date.now() - startedAt,
      });
    };
    const choices = active
      ? "「问答：<内容>」、「任务纠偏：<指令>」或「重规划：<新方向>」"
      : "「问答：<内容>」或「重规划：<新方向>」";
    function unapplied(reason: string) {
      ctx.ui.notify(`未应用这条输入：${reason}。请核对当前状态，可用${choices}明确指定；不会自动重试、恢复或批准。`, "warning");
      return HANDLED;
    }
    async function confirmFallbackContinue(failureCode: string, reason: string): Promise<InputEventResult | undefined> {
      if (event.source !== "interactive" || !ctx.hasUI || typeof ctx.ui?.confirm !== "function") {
        return unapplied(reason);
      }
      const message = [
        `${reason}，无法确认这条输入是否为普通问答。`,
        "选择确认：原样发送，不会自动登记重规划或批准计划；接收方仍可按当前权限执行工具和操作，不是只读问答。",
        `选择取消：暂不发送，可改用${choices}明确指定。`,
      ].join("\n");
      let confirmed = false;
      try { confirmed = Boolean(await ctx.ui.confirm("架构方向判断未完成，按普通消息发送（沿用当前权限）？", message)); }
      catch { confirmed = false; }
      if (inputGeneration !== generation) return HANDLED;
      if (!isCurrent()) {
        trace("stale-state");
        return unapplied("确认期间会话或工作流状态已经变化");
      }
      if (confirmed) {
        trace("fallback-continue", failureCode);
        return undefined;
      }
      return unapplied(reason);
    }
    if (!isCurrent()) {
      trace("stale-state");
      return unapplied("会话或工作流状态已经变化");
    }
    if (controller.signal.aborted) {
      trace("timeout");
      return await confirmFallbackContinue("timeout", "架构方向判断超时");
    }
    if (!result || !result.ok) {
      if (result?.code === "not-configured") {
        trace("skipped", "not-configured");
        return;
      }
      const code = result?.code ?? "model-failed";
      trace("failed", code);
      const reason = code === "model-unavailable" ? "没有可用的已配置架构模型"
        : code === "invalid-response" ? "架构模型未返回合法方向" : "架构方向判断失败";
      return await confirmFallbackContinue(code, reason);
    }
    if (result.direction === null) {
      trace("none");
      return;
    }
    if (result.direction === "correction") {
      if (!active) {
        trace("rejected", "no-active-task");
        return unapplied("待审计划没有执行中任务，不能接收任务纠偏");
      }
      trace("correction");
      return applyWorkflowTaskCorrection(state, event.text, ctx);
    }
    trace("replan");
    const applied = await deps.revise(event, ctx, true);
    if (!applied) return unapplied("当前工作流状态不能记录重规划");
    return HANDLED;
  }

  return { handle, invalidate };
}
