import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isThinkingLevel, roleLabel } from "../src/roles.ts";
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
  roleRuntime: Pick<ReturnType<typeof createRoleRuntime>, "automaticRole"> & Partial<Pick<ReturnType<typeof createRoleRuntime>, "suggestThinking">>;
  roleHandoff: Pick<ReturnType<typeof createRoleHandoff>, "checkSwitchRole" | "capture" | "finishSwitch">;
  userControl: Pick<ReturnType<typeof createWorkflowUserControl>, "suspend">;
  observeRejection: ReturnType<typeof createRepeatedRejectionGuard>["observe"];
}) {
  const { roleRuntime, roleHandoff, userControl, observeRejection } = dependencies;
  pi.registerTool({
    name: "switch_role",
    label: "Switch Role",
    description:
      "Switch the active Pi model and reasoning level for a configured responsibility. Reads the project model strategy and session overrides; switching never writes .pi/role-models.json. Auto model strategy pins provider/model: explicitly assess strength once on task entry after confirming the role; submit thinkingLevel and a bounded reason even when keeping the current strength. Successful decisions are recorded and only affect subsequent requests without changing responsibility or ending the run. Reassess within a task only for a material phase complexity/risk change; taskBoundary is only for an independent new ordinary task. Missing assessment gets one soft reminder, not an execution gate. Simple no-tool answers need no assessment-only call. Responsibility and model changes are automatic; stop, recovery and manual host overrides remain protected. Use /pi-init save to explicitly persist staged configuration.",
    promptSnippet: "Switch model and reasoning level for a configured project role",
    promptGuidelines: [
      "Call switch_role when entering a responsibility selected by the project's role-routing Skill or crossing a role boundary; do not repeat it within the same responsibility. Exception: when Auto model strategy is active, explicitly assess once at task entry after confirming the role, submitting thinkingLevel and a bounded non-sensitive reason with the current role even to keep the current strength. This does not change responsibility or end the run. Simple no-tool answers need no assessment-only call. Do not reassess merely for role changes or ordinary rounds; failures or cancellation must not trigger automatic retries.",
      "Keep one execution responsibility throughout a structure review: reading, analysis, recommendations and recording findings are one deliverable. Batch only genuine architecture decisions for a separate handoff; do not switch roles for each file or repeat already established evidence.",
      "A real role/model change during an active run ends that run; the runtime resumes unfinished work in a fresh run with the new role system prompt. Do not continue the old-role run after switching.",
      "After context compaction, reload, or session recovery, confirm the task boundary again instead of inheriting the previous role from the summary; call switch_role before resuming implementation, tests, docs, or shell work when the role is not already re-established.",
      `Use the role required by the current task. Keep implementation, tests, directly necessary explanations and authorized whole-task Git wrap-up with one execution owner; independent docs/version deliverables remain docs-commit. Architect may inspect local facts for current decisions only through ${ARCHITECT_READ_ONLY_TOOLS_TEXT}; no shell, codemode, MCP, writes or execution-task completion. Recovery, stop and unknown-outcome guards still take precedence.`,
    ],
    parameters: switchRoleParameters,
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("角色切换 ")) + theme.fg("muted", roleLabel(args.role)), 0, 0);
    },
    renderResult(result, _options, theme, context) {
      if (context.isError || (result.details as { ok?: boolean } | undefined)?.ok === false) return new Text(theme.fg("error", "角色切换失败"), 0, 0);
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
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "角色切换已取消。" }], details: { ok: false, code: "ROLE_SWITCH_CANCELLED" } };
      }
      if (runtimeState.userStopRequested) return { content: [{ type: "text", text: "自动执行已停止；切换职责不会恢复任务。请由用户明确继续。" }], details: { ok: false, code: "WORKFLOW_USER_STOPPED" }, terminate: true };
      const boundary = roleHandoff.checkSwitchRole(params.role);
      if (!boundary.allowed) {
        runtimeState.traceHandoff?.(ctx, "workflow.action_rejected", { toolCallId: _toolCallId, action: "switch_role", code: boundary.code, requiredRole: boundary.requiredRole });
        const rejection = observeRejection({ toolName: "switch_role", toolCallId: _toolCallId, role: params.role, code: boundary.code }, ctx);
        if (rejection.stop) {
          userControl.suspend(ctx, "repeated-rejection");
          runtimeState.traceHandoff?.(ctx, "workflow.rejection_stopped", { toolCallId: _toolCallId, code: rejection.code });
        }
        return { content: [{ type: "text", text: boundary.message + "\n" + (rejection.stop ? "同一身份的角色切换已连续被拒绝；当前回合结束，自动续跑已停止，等待用户明确处理。工作流未被完成、取消或重试。" : boundary.nextAction) }], details: { ok: false, ...boundary, rejectionStopped: rejection.stop }, ...(rejection.stop ? { terminate: true } : {}) };
      }
      if (params.thinkingLevel !== undefined) {
        if (!isThinkingLevel(params.thinkingLevel)) return { content: [{ type: "text", text: "建议的推理强度不合法" }], details: { ok: false, code: "AUTO_THINKING_LEVEL_INVALID" } };
        const result = roleRuntime.suggestThinking
          ? await roleRuntime.suggestThinking(params.role, params.thinkingLevel, params.reason, ctx, signal, params.taskBoundary)
          : { ok: false as const, code: "AUTO_NOT_AVAILABLE", message: "Auto 强度入口不可用" };
        return { content: [{ type: "text", text: result.message }], details: result };
      }
      const source = roleHandoff.capture(ctx);
      const recoveryRequired = runtimeState.roleRecoveryPending || runtimeState.roleRecoveryPersistenceFailed || Boolean(runtimeState.pendingWorkflowRecovery);
      const selection = await roleRuntime.automaticRole(params.role, ctx, signal);
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
            type: "text",
            text: `${prefix}：${result.role} · ${result.provider}/${result.model}，推理强度 ${result.thinkingLevel}${transition.handoffFailure ? "。当前回合结束；交接未确认，不会自动续跑，请检查会话。" : continuation}`,
          },
        ],
        details: { ...result, requestedRole: selection.requestedRole, reused, ...transition },
        terminate: transition.terminate,
      };
    },
  });
}
