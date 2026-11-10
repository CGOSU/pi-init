import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { textOf, type ExtensionRuntimeState } from "./runtime-state.ts";
import type { createRoleRuntime } from "./role-runtime.ts";
import type { createWorkflowActions } from "./workflow-actions.ts";
import type { createWorkflowUserControl } from "./workflow-user-control.ts";
import type { createSessionHandoff } from "./session-handoff.ts";
import type { createDiagnosticControls } from "./diagnostic-controls.ts";
import type { createHandoffDiagnostics } from "./handoff-diagnostics.ts";

type ControlCenter = ReturnType<typeof import("./control-center.ts").createControlCenter>;
type ScaffoldRuntime = typeof import("./scaffold-runtime.ts");

export function registerExtensionCommand(pi: ExtensionAPI, runtimeState: ExtensionRuntimeState, dependencies: {
  roleRuntime: ReturnType<typeof createRoleRuntime>;
  workflowActions: Pick<ReturnType<typeof createWorkflowActions>, "workflowCommand">;
  userControl: Pick<ReturnType<typeof createWorkflowUserControl>, "suspend" | "resume">;
  sessionHandoff: Pick<ReturnType<typeof createSessionHandoff>, "fresh">;
  loadScaffoldRuntime: () => Promise<ScaffoldRuntime>;
  diagnosticsCommand: ReturnType<typeof createDiagnosticControls>["command"];
  trace: ReturnType<typeof createHandoffDiagnostics>["trace"];
}) {
  const { roleRuntime, workflowActions, userControl, sessionHandoff, loadScaffoldRuntime, diagnosticsCommand, trace } = dependencies;
  let controlCenterPromise: Promise<ControlCenter> | undefined;
  function loadControlCenter() {
    return controlCenterPromise ??= import("./control-center.ts").then(({ createControlCenter }) =>
      createControlCenter({
        state: runtimeState,
        roleRuntime,
        quickInit: async (targetDir, ctx) => (await loadScaffoldRuntime()).quickInit(targetDir, ctx),
        advancedInit: async (targetDir, ctx) => (await loadScaffoldRuntime()).advancedInit(targetDir, ctx),
        getThinkingLevel: () => pi.getThinkingLevel(),
        workflowCommand: workflowActions.workflowCommand,
        diagnosticsCommand,
      }),
    );
  }

  pi.registerCommand("pi-init", {
    description: "打开 Pi Init 控制中心：初始化项目、配置角色和切换模型",
    getArgumentCompletions: (prefix) => {
      const tokens = prefix.trim().split(/\s+/).filter(Boolean);
      if (tokens.length <= 1 && !prefix.endsWith(" ")) {
        const values = ["init", "advanced", "config", "save", "role", "workflow", "fresh", "diagnostics"];
        const matches = values.filter((value) => value.startsWith(tokens[0] ?? ""));
        return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
      }
      const action = tokens[0];
      const values = action === "role"
        ? runtimeState.configuredRoleNames
        : action === "config"
          ? [...runtimeState.configuredRoleNames, "workflow"]
          : action === "workflow"
            ? ["status", "acknowledge", "resume", "retry", "cancel", "fresh"]
            : [];
      const partial = prefix.endsWith(" ") ? "" : tokens.at(-1) ?? "";
      const matches = values.filter((value) => value.startsWith(partial));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = tokens.shift();
      try {
        if (!action) { await (await loadControlCenter()).showControlCenter(ctx); return; }
        if (action === "fresh") {
          if (tokens.length) { ctx.ui.notify("用法：/pi-init fresh", "error"); return; }
          await sessionHandoff.fresh(ctx); return;
        }
        if (action === "init") { await (await loadScaffoldRuntime()).quickInit(tokens.join(" ") || ".", ctx); return; }
        if (action === "advanced") { await (await loadScaffoldRuntime()).advancedInit(tokens.join(" ") || ".", ctx); return; }
        if (action === "config") {
          const center = await loadControlCenter();
          if (tokens[0]) await center.configureRole(tokens[0], ctx);
          else await center.configureRoleCenter(ctx);
          return;
        }
        if (action === "save") {
          const result = await roleRuntime.saveRoleConfig(ctx);
          ctx.ui.notify(result.message, result.ok ? "info" : "error");
          return;
        }
        if (action === "role") { await (await loadControlCenter()).switchRole(tokens[0], ctx); return; }
        if (action === "diagnostics") { await diagnosticsCommand(tokens.join(" ") || "menu", ctx); return; }
        if (action === "workflow") {
          const workflowAction = tokens.shift();
        if (workflowAction === "fresh") {
          if (tokens.length) { ctx.ui.notify("用法：/pi-init workflow fresh", "error"); return; }
          await workflowActions.workflowCommand("fresh", undefined, ctx); return;
        }
          if (workflowAction === "stop") { userControl.suspend(ctx, "user-command"); ctx.ui.notify("自动续跑已停止；未完成、取消或重试任务。", "info"); return; }

          await workflowActions.workflowCommand(workflowAction, tokens.shift(), ctx, tokens.includes("--confirm-unknown-outcome"));
          if (workflowAction === "cancel" && runtimeState.workflowState?.status === "cancelled") userControl.resume(ctx);
          return;
        }
        ctx.ui.notify("用法：/pi-init [init|advanced|config|save|role|workflow|fresh|diagnostics] [参数]", "error");
      } catch (error) {
        trace(ctx, "pi-init.command_failed");
        ctx.ui.notify(textOf(error), "error");
      }
    },
  });

}
