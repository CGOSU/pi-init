import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isThinkingLevel, normalizeRoleId, roleLabel } from "../src/roles.ts";
import { switchRoleParameters } from "./contracts.ts";
import { shortModelName } from "./ui.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import type { createRoleRuntime } from "./role-runtime.ts";
import type { createRoleHandoff } from "./role-handoff.ts";
import type { createWorkflowUserControl } from "./workflow-user-control.ts";
import type { createRepeatedRejectionGuard } from "./workflow-status-polling.ts";
import { nextWorkflowAction } from "./workflow-action-policy.ts";
import { ARCHITECT_READ_ONLY_TOOLS_TEXT } from "./architect-boundary.ts";

export function registerRoleTool(pi: ExtensionAPI, runtimeState: ExtensionRuntimeState, dependencies: {
  roleRuntime: Pick<ReturnType<typeof createRoleRuntime>, "automaticRole">
    & Partial<Pick<ReturnType<typeof createRoleRuntime>, "suggestThinking" | "automaticRoleWithThinking" | "activeRoleFor">>;
  roleHandoff: Pick<ReturnType<typeof createRoleHandoff>, "checkSwitchRole" | "capture" | "finishSwitch">;
  userControl: Pick<ReturnType<typeof createWorkflowUserControl>, "suspend">;
  observeRejection: ReturnType<typeof createRepeatedRejectionGuard>["observe"];
}) {
  const { roleRuntime, roleHandoff, userControl, observeRejection } = dependencies;
  pi.registerTool({
    name: "switch_role",
    label: "Switch Role",
    description:
      "Switch the active Pi model and reasoning level for a configured responsibility. Reads the project model strategy and session overrides; switching never writes .pi/role-models.json. Under Auto model strategy, provider/model is pinned: entering architect defaults to maxThinkingLevel and entering docs-commit defaults to minThinkingLevel (auto-assessed, no follow-up call needed). For developer-test or custom roles, you may pass thinkingLevel and a bounded reason either together with switch_role when switching/confirming the role, or separately at task entry and material complexity/risk changes (e.g. dropping to minThinkingLevel for docs/wrap-up or raising to maxThinkingLevel for repeated failures). Missing assessment gets one soft reminder, not an execution gate. Simple no-tool answers need no assessment-only call. Stop, recovery and manual host overrides remain protected. Use /pi-init save to explicitly persist staged configuration.",
    promptSnippet: "Switch model and reasoning level for a configured project role",
    promptGuidelines: [
      "Call switch_role when entering a responsibility selected by the project's role-routing Skill or crossing a role boundary; do not repeat it within the same responsibility. Under Auto model strategy: architect automatically applies maxThinkingLevel and docs-commit automatically applies minThinkingLevel without extra assessment calls; when switching/confirming developer-test or custom roles you may include thinkingLevel and a bounded non-sensitive reason in the same call, or assess once at task entry / material phase change. Simple no-tool answers need no assessment-only call; failures or cancellation must not trigger automatic retries.",
      "Keep one execution responsibility throughout a structure review: reading, analysis, recommendations and recording findings are one deliverable. Batch only genuine architecture decisions for a separate handoff; do not switch roles for each file or repeat already established evidence.",
      "A real role/model change during an active run ends that run; the runtime resumes unfinished work in a fresh run with the new role system prompt. Do not continue the old-role run after switching.",
      "After context compaction, reload, or session recovery, confirm the task boundary again instead of inheriting the previous role from the summary; call switch_role before resuming implementation, tests, docs, or shell work when the role is not already re-established.",
      `Use the role required by the current task. Keep implementation, tests, directly necessary explanations and authorized whole-task Git wrap-up with one execution owner; independent docs/version deliverables remain docs-commit. Architect may inspect local facts for current decisions only through ${ARCHITECT_READ_ONLY_TOOLS_TEXT}; no shell, codemode, MCP, writes or execution-task completion. Recovery, stop and unknown-outcome guards still take precedence.`,
    ],
    parameters: switchRoleParameters,
    renderCall(args, theme) {
      const label = args.thinkingLevel !== undefined ? "Auto 强度评估 " : "角色切换 ";
      return new Text(theme.fg("toolTitle", theme.bold(label)) + theme.fg("muted", roleLabel(args.role)), 0, 0);
    },
    renderResult(result, _options, theme, context) {
      const failure = result.details as { ok?: boolean; operation?: string; code?: string } | undefined;
      if (context.isError || failure?.ok === false) {
        const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
        const label = context.args?.thinkingLevel !== undefined ? "Auto 强度评估被拒绝" : "角色切换失败";
        const feedback = failure?.operation ? text
          : `${label}${failure?.code ? ` [${failure.code}]` : ""}\n${text}\n状态变化未核实，请核对当前职责、模型和强度；不自动重试。`;
        return new Text(theme.fg("error", feedback), 0, 0);
      }
      const details = result.details as { role?: string; model?: string; thinkingLevel?: string } | undefined;
      return new Text(
        theme.fg("success", "✓ ") + theme.fg("accent", roleLabel(details?.role ?? "")) +
          theme.fg("muted", ` · ${shortModelName(details?.model ?? "")}/${details?.thinkingLevel ?? "off"}`),
        0,
        0,
      );
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const operation = params.thinkingLevel !== undefined ? "auto-thinking" : "role-switch";
      const snapshot = () => ({
        role: runtimeState.activeRole?.role,
        provider: ctx.model?.provider,
        model: ctx.model?.id,
        thinkingLevel: pi.getThinkingLevel(),
      });
      const before = snapshot();
      const fail = (code: string, message: string) => {
        const after = snapshot();
        const describe = (label: string, from: string | undefined, to: string | undefined) => from === to
          ? `${label}未变化（${to ?? "未确认"}）` : `${label}已变化：${from ?? "未确认"} → ${to ?? "未确认"}`;
        const modelName = (value: typeof before) => value.model ? `${value.provider}/${value.model}` : undefined;
        const status = [
          describe("职责", before.role, after.role),
          describe("模型", modelName(before), modelName(after)),
          describe("强度", before.thinkingLevel, after.thinkingLevel),
        ].join("；");
        const label = operation === "auto-thinking" ? "Auto 强度评估被拒绝" : "角色切换失败";
        return {
          content: [{ type: "text" as const, text: `${label} [${code}]\n${message}\n${status}。` }],
          details: { ok: false as const, code, operation, stateChange: { before, after } },
        };
      };
      if (signal?.aborted) return fail("ROLE_SWITCH_CANCELLED", "请求已取消；不自动重试。");
      if (runtimeState.userStopRequested) return { ...fail("WORKFLOW_USER_STOPPED", "自动执行已停止；切换职责不会恢复任务。请由用户明确继续。"), terminate: true };
      const boundary = roleHandoff.checkSwitchRole(params.role);
      if (!boundary.allowed) {
        runtimeState.traceHandoff?.(ctx, "workflow.action_rejected", { toolCallId: _toolCallId, action: "switch_role", code: boundary.code, requiredRole: boundary.requiredRole });
        const rejection = observeRejection({ toolName: "switch_role", toolCallId: _toolCallId, role: params.role, code: boundary.code }, ctx);
        if (rejection.stop) {
          userControl.suspend(ctx, "repeated-rejection");
          runtimeState.traceHandoff?.(ctx, "workflow.rejection_stopped", { toolCallId: _toolCallId, code: rejection.code });
        }
        const failure = fail(boundary.code, boundary.message + "\n" + (rejection.stop ? "同一身份的角色切换已连续被拒绝；当前回合结束，自动续跑已停止，等待用户明确处理。工作流未被完成、取消或重试。" : boundary.nextAction));
        return { ...failure, details: { ...failure.details, ...boundary, rejectionStopped: rejection.stop }, ...(rejection.stop ? { terminate: true } : {}) };
      }
      const recoveryRequired = runtimeState.roleRecoveryPending || runtimeState.roleRecoveryPersistenceFailed || Boolean(runtimeState.pendingWorkflowRecovery);
      const completeSwitch = (
        source: ReturnType<typeof roleHandoff.capture>,
        selection: { requestedRole: string; result: NonNullable<typeof runtimeState.activeRole> },
        extraText = "",
        extraDetails: Record<string, unknown> = {},
      ) => {
        const transition = roleHandoff.finishSwitch(ctx, source, selection.result, signal?.aborted);
        const result = selection.result;
        const unchanged = source.activeRole?.role === result.role && source.activeRole.provider === result.provider
          && source.activeRole.model === result.model && source.activeRole.thinkingLevel === result.thinkingLevel;
        const reused = unchanged && !recoveryRequired;
        const prefix = reused ? "当前职责已确认，无需切换" : unchanged ? "已重新确认当前职责"
          : "已切换到";
        const nextAction = nextWorkflowAction(runtimeState);
        const continuation = nextAction.action === "recover"
          ? "。职责确认不解除工作流暂停或恢复限制，仍不能执行任务。\n" + nextAction.nextAction + (transition.terminate ? "当前回合结束。" : "")
          : `${reused ? "。沿当前职责继续未完成工作，不必再次确认。" : ""}${transition.terminate ? unchanged ? "。当前回合结束；由现有工作流调度器派发待办任务。" : "。当前回合结束；随后以新职责继续未完成工作。" : ""}`;
        return {
          content: [
            {
              type: "text" as const,
              text: `${prefix}：${result.role} · ${result.provider}/${result.model}，推理强度 ${result.thinkingLevel}${extraText}${transition.handoffFailure ? "。当前回合结束；交接未确认，不会自动续跑，请检查会话。" : continuation}`,
            },
          ],
          details: { ...result, requestedRole: selection.requestedRole, reused, ...extraDetails, ...transition },
          terminate: transition.terminate,
        };
      };
      if (params.thinkingLevel !== undefined) {
        if (!isThinkingLevel(params.thinkingLevel)) return fail("AUTO_THINKING_LEVEL_INVALID", "建议的推理强度不合法");
        const normalized = normalizeRoleId(params.role);
        const currentActive = roleRuntime.activeRoleFor ? roleRuntime.activeRoleFor(ctx) : runtimeState.activeRole;
        const sameActiveRole = normalized.ok && currentActive?.role === normalized.value && !recoveryRequired;
        if (sameActiveRole || !roleRuntime.automaticRoleWithThinking) {
          const result = roleRuntime.suggestThinking
            ? await roleRuntime.suggestThinking(params.role, params.thinkingLevel, params.reason, ctx, signal, params.taskBoundary)
            : { ok: false as const, code: "AUTO_NOT_AVAILABLE", message: "Auto 强度入口不可用" };
          if (!result.ok) {
            const failure = fail(result.code, result.message);
            return { ...failure, details: { ...result, ...failure.details } };
          }
          return { content: [{ type: "text", text: result.message }], details: result };
        }
        const source = roleHandoff.capture(ctx);
        const outcome = await roleRuntime.automaticRoleWithThinking(
          params.role, params.thinkingLevel, params.reason, ctx, signal, params.taskBoundary,
        );
        if (!outcome.ok) {
          const failure = fail(outcome.code, outcome.message);
          return { ...failure, details: { ...outcome, ...failure.details } };
        }
        const assessmentText = outcome.persistFailed
          ? `（评估记录保存未获确认；实际强度为 ${outcome.result.thinkingLevel}，不自动重试或回放）`
          : "（Auto 强度评估理由已记录）";
        return completeSwitch(source, outcome, assessmentText, {
          assessment: outcome.assessment,
          ...(outcome.persistFailed ? { code: "AUTO_ASSESSMENT_PERSIST_FAILED", persistFailed: true } : {}),
        });
      }
      const source = roleHandoff.capture(ctx);
      const selection = await roleRuntime.automaticRole(params.role, ctx, signal);
      return completeSwitch(source, selection);
    },
  });
}
