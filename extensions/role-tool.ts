import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { roleLabel } from "../src/roles.ts";
import { switchRoleParameters } from "./contracts.ts";
import { shortModelName } from "./ui.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import type { createRoleRuntime } from "./role-runtime.ts";
import type { createRoleHandoff } from "./role-handoff.ts";
import type { createWorkflowUserControl } from "./workflow-user-control.ts";
import type { createRepeatedRejectionGuard } from "./workflow-status-polling.ts";

export function registerRoleTool(pi: ExtensionAPI, runtimeState: ExtensionRuntimeState, dependencies: {
  roleRuntime: Pick<ReturnType<typeof createRoleRuntime>, "automaticRole">;
  roleHandoff: Pick<ReturnType<typeof createRoleHandoff>, "checkSwitchRole" | "capture" | "finishSwitch">;
  userControl: Pick<ReturnType<typeof createWorkflowUserControl>, "suspend">;
  observeRejection: ReturnType<typeof createRepeatedRejectionGuard>["observe"];
}) {
  const { roleRuntime, roleHandoff, userControl, observeRejection } = dependencies;
  pi.registerTool({
    name: "switch_role",
    label: "Switch Role",
    description:
      "Switch the active Pi model and reasoning level for a configured responsibility. Reads the project roleModels mapping and current-session overrides; switching never writes .pi/role-models.json. Modes: auto applies immediately, confirm asks before automatic changes, manual requires /pi-init role. Use /pi-init save to explicitly persist staged role configuration.",
    promptSnippet: "Switch model and reasoning level for a configured project role",
    promptGuidelines: [
      "Call switch_role when entering a responsibility selected by the project's role-routing Skill or crossing a role boundary; do not repeat it within the same responsibility.",
      "Keep one execution responsibility throughout a structure review: reading, analysis, recommendations and recording findings are one deliverable. Batch only genuine architecture decisions for a separate handoff; do not switch roles for each file or repeat already established evidence.",
      "A real role/model change during an active run ends that run; the runtime resumes unfinished work in a fresh run with the new role system prompt. Do not continue the old-role run after switching.",
      "After context compaction, reload, or session recovery, confirm the task boundary again instead of inheriting the previous role from the summary; call switch_role before resuming implementation, tests, docs, or shell work when the role is not already re-established.",
      "Use the role ID required by the current task; architect only thinks, analyzes, decides, plans, and arranges responsibilities, while other configured role IDs may execute their assigned work. Architect must not gather evidence, execute commands, or connect to MCP.",
      "In manual mode, switch_role does not change models; ask the user to run /pi-init role <role> and retry.",
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
        return { content: [{ type: "text", text: "角色切换已取消。" }], details: {} };
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
      const source = roleHandoff.capture(ctx);
      const recoveryRequired = runtimeState.roleRecoveryPending || runtimeState.roleRecoveryPersistenceFailed || Boolean(runtimeState.pendingWorkflowRecovery);
      const selection = await roleRuntime.automaticRole(params.role, ctx);
      const transition = roleHandoff.finishSwitch(ctx, source, selection.result, signal?.aborted);
      const result = selection.result;
      const unchanged = source.activeRole?.role === result.role && source.activeRole.provider === result.provider
        && source.activeRole.model === result.model && source.activeRole.thinkingLevel === result.thinkingLevel;
      const reused = unchanged && !recoveryRequired;
      const prefix = reused ? "当前职责已确认，无需切换" : unchanged ? "已重新确认当前职责"
        : selection.requestedRole === result.role ? "已切换到" : `已按确认选择切换到 ${result.role}（建议为 ${selection.requestedRole}）`;
      return {
        content: [
          {
            type: "text",
            text: `${prefix}：${result.role} · ${result.provider}/${result.model}，推理强度 ${result.thinkingLevel}，模式 ${selection.mode}${reused ? "。沿当前职责继续未完成工作，不必再次确认。" : ""}${transition.terminate ? transition.handoffFailure ? "。当前回合结束；交接未确认，不会自动续跑，请检查会话。" : unchanged ? "。当前回合结束；由现有工作流调度器派发待办任务。" : "。当前回合结束；随后以新职责继续未完成工作。" : ""}`,
          },
        ],
        details: { ...result, mode: selection.mode, requestedRole: selection.requestedRole, reused, ...transition },
        terminate: transition.terminate,
      };
    },
  });
}
