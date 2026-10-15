import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  ROLE_MODES,
  findMatchingRole,
  roleLabel,
} from "../src/roles.ts";
import {
  WORKFLOW_RECOMMENDED_TASKS,
  isWorkflowActive,
  appendWorkflowReplanDirection,
  requestWorkflowNestedGoal,
  requestWorkflowReplan,
} from "../src/workflow.ts";
import { Text } from "@earendil-works/pi-tui";
import { isExternalRunSource } from "../src/run-timing.ts";
import { isExplicitWorkflowReplanInput, isWorkflowContinuationInput, isExplicitWorkflowChildInput } from "../src/workflow-input-intent.ts";
import { createRoleRuntime } from "./role-runtime.ts";
import { registerActivityStatusSources } from "./activity-status-registration.ts";
import { createArchitectBoundary, ARCHITECT_ALLOWED_ACTIONS_TEXT } from "./architect-boundary.ts";
import { createExtensionRuntimeState, textOf } from "./runtime-state.ts";
import { createWorkflowActions } from "./workflow-actions.ts";
import { createCoordinationRuntime, type CoordinationRuntime } from "./coordination-runtime.ts";
import { createWorkflowDispatch, type WorkflowDispatch } from "./workflow-dispatch.ts";
import { createWorkflowMessages } from "./workflow-messages.ts";
import { createWorkflowReport } from "./workflow-report.ts";
import { renderWorkflowPauseResult } from "./workflow-pause-renderer.ts";
import { createWorkflowPauseView } from "./workflow-pause-view.ts";
import { createRunTimingView } from "./run-timing-view.ts";
import { renderRunTimingReport } from "./run-timing-renderer.ts";
import { renderWorkflowOperationFailure, renderWorkflowPresentation } from "./workflow-result-renderer.ts";
import { workflowPresentationFromDetails } from "./workflow-presentation.ts";
import { createWorkflowStatusView } from "./workflow-status-view.ts";
import { formatWorkflowStatusText } from "./workflow-status-renderer.ts";
import { createEditGuardTool } from "./edit-guard.ts";
import { createFileReviewRuntime } from "./file-review-runtime.ts";
import { shortModelName } from "./ui.ts";
import { createRoleRecovery } from "./role-recovery.ts";
import { createRoleContextView } from "./role-context-view.ts";
import { createRunTimingDiagnostics } from "./run-timing-diagnostics.ts";
import { createRuntimeRoutingContext } from "./runtime-routing-context.ts";
import {
  initProjectParameters,
  switchRoleParameters,
  taskWorkflowParameters,
  type ResolvedRoleConfig,
  type RunTimingEntryData,
} from "./contracts.ts";
import { createHandoffDiagnostics } from "./handoff-diagnostics.ts";
import { createRoleHandoff } from "./role-handoff.ts";

type ControlCenterModule = typeof import("./control-center.ts");
type ControlCenter = ReturnType<ControlCenterModule["createControlCenter"]>;
type ScaffoldRuntime = typeof import("./scaffold-runtime.ts");
type ScaffoldOutcome = Awaited<ReturnType<ScaffoldRuntime["runScaffold"]>>;
const RUN_TIMING_ENTRY_TYPE = "pi-init-run-timing";
export default function initProjectExtension(pi: ExtensionAPI) {
  const runtimeState = createExtensionRuntimeState();
  const activityStatus = registerActivityStatusSources(pi);
  const roleContextView = createRoleContextView(runtimeState);
  const roleRecovery = createRoleRecovery(pi, runtimeState, roleContextView.context);
  const runTimingDiagnostics = createRunTimingDiagnostics(
    pi,
    () => Boolean(runtimeState.workflowState && isWorkflowActive(runtimeState.workflowState)),
  );
  pi.registerTool(createEditGuardTool());
  let workflowDispatch: WorkflowDispatch;
  let workflowReport: ReturnType<typeof createWorkflowReport>;
  let coordinationRuntime: CoordinationRuntime;
  const workflowMessages = createWorkflowMessages(runtimeState, {
    pi,
    setInternalContinuationPending: (value) => {
      runtimeState.internalContinuationPending = value;
    },
    persistWorkflowState: (next, ctx) => workflowReport.persistWorkflowState(next, ctx),
  });
  const roleRuntime = createRoleRuntime(pi, runtimeState, {
    activityStatus, getWorkflowState: () => runtimeState.workflowState,
    setWorkflowDispatchInFlight: (value) => {
      runtimeState.workflowDispatchInFlight = value;
    },
    requireRoleRecovery: roleRecovery.requireConfirmation,
    sendWorkflowTaskMessage: (ctx, taskId, note, identity) => workflowMessages.sendWorkflowTaskMessage(ctx, taskId, note, identity),
    scheduleWorkflow: (ctx, identity) => workflowDispatch.scheduleWorkflow(ctx, identity),
    sendWorkflowReplanMessage: (ctx, identity) => workflowMessages.sendWorkflowReplanMessage(ctx, identity),
    sendCoordinationMessage: (ctx, identity) => coordinationRuntime.sendCoordinationMessage(ctx, identity),
    acknowledgeRoleRecovery: roleRecovery.acknowledge,
    finishWorkflowBoundary: (ctx, identity, failed) => workflowDispatch.finishWorkflowBoundary(ctx, identity, failed),
    continueCoordinationBoundary: (ctx, identity, failed) => coordinationRuntime.continueCoordinationBoundary(ctx, identity, failed),
  });
  const roleHandoff = createRoleHandoff(pi, runtimeState, { getActiveRole: roleRuntime.activeRoleFor, requireRecovery: roleRecovery.requireConfirmation });
  createFileReviewRuntime(pi, {
    getActiveRole: roleRuntime.activeRoleFor,
    canReview: () => !runtimeState.roleRecoveryPending && !runtimeState.roleRecoveryPersistenceFailed,
    roleRecoveryPending: () => runtimeState.roleRecoveryPending,
    getDispatchBlockReason: (ctx) => {
      if (runtimeState.roleRecoveryPersistenceFailed) return "职责恢复记录持久化失败；扫描结果已保留，未启动 AI 审阅。";
      if (runtimeState.workflowRestoreError) return `工作流恢复失败（${runtimeState.workflowRestoreError.code}）；未启动 AI 审阅。`;
      if (runtimeState.pendingWorkflowRecovery) return "有待处理的工作流恢复；未启动 AI 审阅。";
      if (runtimeState.workflowState && !["completed", "cancelled"].includes(runtimeState.workflowState.status)) return "当前有未结束的工作流；未启动 AI 审阅。";
      if (runtimeState.workflowDispatchInFlight) return "工作流正在派发；未启动 AI 审阅。";
      if (!ctx.isIdle()) return "Agent 正忙；未启动或排队 AI 审阅。";
      return undefined;
    },
  });
  const runtimeRoutingContext = createRuntimeRoutingContext(runtimeState, {
    getActiveRole: roleRuntime.activeRoleFor,
    getThinkingLevel: () => pi.getThinkingLevel(),
  });
  pi.on("before_agent_start", runtimeRoutingContext.beforeAgentStart);
  createArchitectBoundary(pi, (ctx) => roleRuntime.activeRoleFor(ctx)?.role);
  coordinationRuntime = createCoordinationRuntime(runtimeState, {
    pi,
    roleRuntime,
    setInternalContinuationPending: (value) => {
      runtimeState.internalContinuationPending = value;
    },
  });
  workflowReport = createWorkflowReport(runtimeState, { pi, roleRuntime, activityStatus });
  workflowDispatch = createWorkflowDispatch(runtimeState, {
    roleRuntime,
    messages: workflowMessages,
    report: workflowReport,
    setCurrentContext: (ctx) => {
      runtimeState.currentContext = ctx;
    },
    onWorkflowRecovered: (previous, recovered, ctx) =>
      coordinationRuntime.reconcileWorkflowRecovery(previous, recovered, ctx),
  });
  const workflowActions = createWorkflowActions(runtimeState, {
    roleRuntime,
    dispatch: workflowDispatch,
    report: workflowReport,
    coordination: coordinationRuntime,
  });
  let scaffoldRuntimePromise: Promise<ScaffoldRuntime> | undefined;
  let controlCenterPromise: Promise<ControlCenter> | undefined;
  function loadScaffoldRuntime() {
    return scaffoldRuntimePromise ??= import("./scaffold-runtime.ts");
  }
  function loadControlCenter() {
    return controlCenterPromise ??= import("./control-center.ts").then(({ createControlCenter }) =>
      createControlCenter({
        state: runtimeState,
        roleRuntime,
        quickInit: async (targetDir, ctx) => (await loadScaffoldRuntime()).quickInit(targetDir, ctx),
        syncProject: async (targetDir, ctx) => (await loadScaffoldRuntime()).syncProject(targetDir, ctx),
        advancedInit: async (targetDir, ctx) => (await loadScaffoldRuntime()).advancedInit(targetDir, ctx),
        getThinkingLevel: () => pi.getThinkingLevel(),
        workflowCommand: workflowActions.workflowCommand,
      }),
    );
  }
  function settleExternalRunTiming() { runTimingDiagnostics.settle(); }
  let workflowTaskConsumptionRunActive = false;
  pi.registerEntryRenderer<RunTimingEntryData>(RUN_TIMING_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data && typeof entry.data === "object"
      ? entry.data as RunTimingEntryData
      : {};
    return renderRunTimingReport(createRunTimingView(data), theme);
  });

  pi.on("model_select", async (event, ctx) => {
    runtimeState.currentContext = ctx;

    let config: ResolvedRoleConfig;
    try {
      config = await roleRuntime.readSessionRoleConfig(ctx);
    } catch {
      roleRuntime.refreshRoleStatus(ctx, runtimeState.roleModeStatus);
      return;
    }
    if (roleRuntime.isManualRoleMode(config)) {
      await roleRuntime.writeBackManualModelSelection(event, ctx, config);
    }
    roleRuntime.refreshRoleStatus(ctx, roleRuntime.effectiveRoleMode(config));
  });

  async function persistWorkflowDirection(next: NonNullable<typeof runtimeState.workflowState>, ctx: ExtensionContext) {
    const previous = runtimeState.workflowState;
    if (previous && coordinationRuntime.isLinkedToWorkflow(previous)) coordinationRuntime.linkWorkflow(next, ctx);
    workflowReport.persistWorkflowState(next, ctx);
    if (next.status === "replanning") await workflowDispatch.scheduleWorkflow(ctx);
  }

  async function captureWorkflowRevisionInput(
    event: { text?: unknown; source?: unknown },
    ctx: ExtensionContext,
  ) {
    if (
      !runtimeState.workflowState ||
      !["running", "replanning"].includes(runtimeState.workflowState.status) ||
      !isExternalRunSource(event.source) ||
      typeof event.text !== "string" ||
      !event.text.trim() ||
      event.text.trim().startsWith("/")
    ) return false;

    // Ordinary continuation is not a direction change. Preserve the saved plan and let the
    // existing settled/recovery path resume whichever task or replan boundary is active.
    if (isWorkflowContinuationInput(event.text)) return false;
    const explicitReplan = isExplicitWorkflowReplanInput(event.text);
    const explicitChild = isExplicitWorkflowChildInput(event.text);
    if (!explicitReplan && !explicitChild) return false;

    if (runtimeState.workflowState.pendingRevision) {
      const revision = runtimeState.workflowState.pendingRevision;
      if (explicitChild !== (revision.kind === "nested")) {
        ctx.ui.notify("当前已有不同类型的待处理请求；未将新指令混入该请求，请先处理或取消当前请求。", "warning");
        return true;
      }
      try {
        const next = appendWorkflowReplanDirection(runtimeState.workflowState, event.text.trim());
        await persistWorkflowDirection(next, ctx);
        const nested = revision.kind === "nested";
        ctx.ui.notify(
          next.status === "replanning"
            ? nested
              ? `已将新目标合并到待处理的子工作流 ${revision.revisionId}，并交由架构师规划；父工作流保持不变。`
              : `已将新指令合并到待处理 revision ${revision.revisionId}，并重新交给架构师重规划。`
            : nested
              ? `已将新目标合并到待处理的子工作流 ${revision.revisionId}，将在当前任务边界规划；父工作流保持不变。`
              : `已将新指令合并到待处理 revision ${revision.revisionId}，将在任务边界交给架构师重规划。`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`无法记录工作流方向变更：${textOf(error)}`, "warning");
      }
      return true;
    }

    try {
      const previous = runtimeState.workflowState;
      if (!previous) return false;
      const direction = event.text.trim();
      const next = explicitReplan
        ? requestWorkflowReplan(previous, { direction })
        : requestWorkflowNestedGoal(previous, { direction });
      await persistWorkflowDirection(next, ctx);
      ctx.ui.notify(
        explicitReplan
          ? next.currentTaskId
            ? `已记录父工作流重规划，将在当前任务 ${next.currentTaskId} 完成后交给架构师。`
            : "已记录父工作流重规划，等待架构师处理。"
          : next.currentTaskId
            ? `已创建子工作流目标，将在当前任务 ${next.currentTaskId} 完成后规划；父工作流进度保留。`
            : "已创建子工作流目标，等待架构师规划；父工作流进度保留。",
        "info",
      );
    } catch (error) {
      ctx.ui.notify(`无法记录工作流方向变更：${textOf(error)}`, "warning");
    }
    return true;
  }

  pi.on("input", async (event, ctx) => {
    if (typeof event.text === "string" && event.text.trim().startsWith("/")) {
      return { action: "continue" };
    }
    if (await captureWorkflowRevisionInput(event, ctx)) return { action: "handled" };
    if (!runTimingDiagnostics.captureInput(event.source)) return { action: "continue" };
    return { action: "continue" };
  });

  pi.on("before_agent_start", (_event, ctx) => {
    runtimeState.traceHandoff?.(ctx, "agent.continuation", { internal: runtimeState.internalContinuationPending });
    runTimingDiagnostics.beforeAgentStart(runtimeState.internalContinuationPending);
    runtimeState.internalContinuationPending = false;
  });

  pi.on("agent_start", (_event, ctx) => {
    runtimeState.agentRunActive = true;
    workflowTaskConsumptionRunActive = true;
    runtimeState.currentContext = ctx;
    roleRuntime.refreshRoleStatus(ctx, runtimeState.roleModeStatus);
    runtimeState.internalContinuationPending = false;
    runTimingDiagnostics.agentStart();
  });

  pi.on("message_start", (event, ctx) => {
    coordinationRuntime.markCurrentHandoffStartedFromMessage(ctx, event.message);
    if (!workflowTaskConsumptionRunActive) return;
    workflowDispatch.markCurrentTaskStartedFromMessage(ctx, event.message);
  });

  pi.on("agent_end", () => {
    runtimeState.agentRunActive = false;
    workflowTaskConsumptionRunActive = false;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    runtimeState.agentRunActive = false;
    workflowTaskConsumptionRunActive = false;
    runtimeState.currentContext = ctx;
    roleRuntime.refreshRoleStatus(ctx, runtimeState.roleModeStatus);
    if (await roleHandoff.schedule(ctx)) {
      if (runtimeState.roleRecoveryPending || runtimeState.roleRecoveryPersistenceFailed) settleExternalRunTiming();
      return;
    }
    settleExternalRunTiming();
    roleRuntime.startPendingRoleCompaction(ctx);
    await coordinationRuntime.schedule(ctx);
    await workflowDispatch.scheduleWorkflow(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    runtimeState.agentRunActive = false;
    roleHandoff.reset();
    workflowTaskConsumptionRunActive = false;
    runtimeState.roleContextGeneration += 1;
    runtimeState.roleTransitionGeneration += 1;
    roleRuntime.disposeWorkflowCompaction();
    workflowReport.dispose(ctx);
    runtimeState.runtimeDisposed = true;
    runTimingDiagnostics.reset();
    runtimeState.internalContinuationPending = false;
    roleRecovery.reset();
    runtimeState.coordinationRuntimeState = undefined;
    runtimeState.coordinationRestoreError = undefined;
    runtimeState.configuredRoleNames = [];
    runtimeState.currentContext = undefined;
  });

  pi.on("session_start", async (event, ctx) => {
    runtimeState.agentRunActive = false;
    roleHandoff.reset();
    try {
      workflowTaskConsumptionRunActive = false;
      runtimeState.runtimeDisposed = false;
      runtimeState.roleContextGeneration += 1;
      runtimeState.roleTransitionGeneration += 1;
      runtimeState.sessionRoleConfigOverrides = {};
      runtimeState.configuredRoleNames = [];
      runtimeState.activeRole = undefined;
      runtimeState.workflowNoticeAcknowledgement = undefined;
      roleRecovery.restore(ctx, event.reason);
      runtimeState.currentContext = ctx;
      coordinationRuntime.restore(ctx);
      workflowDispatch.restoreWorkflowState(ctx);
      const config = await roleRuntime.readSessionRoleConfig(ctx);
      runtimeState.currentContext = ctx;
      runtimeState.workflowModeStatus = config.workflowMode;
      const thinkingLevel = pi.getThinkingLevel();
      const role = findMatchingRole(config, ctx.model, thinkingLevel);
      runtimeState.activeRole = role && ctx.model
        ? {
            role,
            provider: ctx.model.provider,
            model: ctx.model.id,
            thinkingLevel,
          }
        : undefined;
      roleRuntime.setRoleStatus(ctx, runtimeState.sessionModeOverride ?? config.mode);
      const roleModelConfigs = Object.entries(config.roleModels).map(([configuredRole, model]) =>
        `◆ ${roleLabel(configuredRole)}\n  模型：${model.provider}/${model.model}\n  推理强度：${model.thinkingLevel}`,
      );
      if (ctx.mode === "tui" && roleModelConfigs.length > 0) {
        ctx.ui.notify(
          `📌 Pi Init · 角色模型配置\n\n${roleModelConfigs.join("\n\n")}`,
          "info",
        );
      }
      await coordinationRuntime.schedule(ctx);
      await workflowDispatch.scheduleWorkflow(ctx);
    } catch (error) {
      ctx.ui.notify(textOf(error), "error");
    }
  });

  pi.on("session_tree", async (event, ctx) => {
    runtimeState.agentRunActive = false;
    roleHandoff.reset();
    workflowTaskConsumptionRunActive = false;
    coordinationRuntime.restore(ctx);
    workflowDispatch.restoreWorkflowState(ctx);
    if (event.oldLeafId !== event.newLeafId) {
      runtimeState.roleContextGeneration += 1;
      runtimeState.roleTransitionGeneration += 1;
      runtimeState.activeRole = undefined;
      runtimeState.workflowNoticeAcknowledgement = undefined;
      roleRecovery.requireConfirmation(ctx, "branch");
    } else {
      roleRecovery.restore(ctx);
    }
    workflowReport.updateWorkflowStatus(ctx);
    await coordinationRuntime.schedule(ctx);
  });

  pi.registerCommand("fast", { description: "按 Fast Path 请求执行一次任务（用法：/fast <任务描述>）", handler: async (args, ctx) => {
    const task = args.trim(), workflow = runtimeState.workflowState;
    const restoreError = runtimeState.workflowRestoreError;
    if (!task || !ctx.isIdle() || restoreError || (workflow && !["completed", "cancelled"].includes(workflow.status))) return ctx.ui.notify(
      !task ? "用法：/fast <任务描述>"
        : !ctx.isIdle() ? "Agent 正忙；请等待当前操作完成后再使用 /fast。"
          : restoreError ? `已保存的工作流无法恢复（${restoreError.code}）：${restoreError.message}；/fast 不会启动新任务。`
            : "当前有未结束的工作流；/fast 不会绕过或覆盖它，请按工作流流程继续。",
      "warning",
    );
    await pi.sendUserMessage(`用户通过 /fast 明确选择对下面这一项单次启用 Fast Path；这不是持久模式，也不修改模型或项目配置。\n这是对 Fast Path 自动适用条件的手动选择：不要因任务类型、范围、文件数、代码行数或修改复杂度而退回普通流程。直接定向读取最少必要上下文，完成任务所需修改和风险匹配的最小验证；不要仅因不符合自动适用条件而创建 task_workflow 或做例行留痕。\n安全、权限、需求/契约确认、数据保护、architect 职责限制、上下文恢复门、工作流保护和必要验证仍优先；若这些独立边界要求暂停或升级流程，简要说明具体原因，不要只以自动 Fast Path 资格为由退回。\n\n用户任务：\n${task}`);
  }});

  pi.registerCommand("pi-init", {
    description: "打开 Pi Init 控制中心：初始化项目、配置角色和切换模型",
    getArgumentCompletions: (prefix) => {
      const tokens = prefix.trim().split(/\s+/).filter(Boolean);
      if (tokens.length <= 1 && !prefix.endsWith(" ")) {
        const values = ["init", "advanced", "sync", "config", "save", "role", "mode", "workflow", "coordination"];
        const matches = values.filter((value) => value.startsWith(tokens[0] ?? ""));
        return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
      }
      const action = tokens[0];
      const values = action === "role"
        ? runtimeState.configuredRoleNames
        : action === "config"
          ? [...runtimeState.configuredRoleNames, "workflow"]
          : action === "mode"
          ? ROLE_MODES
          : action === "workflow"
            ? ["status", "acknowledge", "resume", "retry", "cancel"]
            : action === "coordination" ? ["resume", "reopen"] : [];
      const partial = prefix.endsWith(" ") ? "" : tokens.at(-1) ?? "";
      const matches = values.filter((value) => value.startsWith(partial));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = tokens.shift();
      try {
        if (!action) { await (await loadControlCenter()).showControlCenter(ctx); return; }
        if (action === "init") { await (await loadScaffoldRuntime()).quickInit(tokens.join(" ") || ".", ctx); return; }
        if (action === "advanced") { await (await loadScaffoldRuntime()).advancedInit(tokens.join(" ") || ".", ctx); return; }
        if (action === "sync") { await (await loadScaffoldRuntime()).syncProject(tokens.join(" ") || ".", ctx); return; }
        if (action === "config") { await (await loadControlCenter()).configureRole(tokens[0], ctx); return; }
        if (action === "save") {
          const result = await roleRuntime.saveRoleConfig(ctx);
          ctx.ui.notify(result.message, result.ok ? "info" : "error");
          return;
        }
        if (action === "role") { await (await loadControlCenter()).switchRole(tokens[0], ctx); return; }
        if (action === "mode") { await (await loadControlCenter()).setSessionMode(tokens[0], ctx); return; }
        if (action === "coordination") {
          const coordinationAction = tokens.shift();
          if (coordinationAction === "resume" && tokens.length === 0) {
            await coordinationRuntime.resumeBoundary(ctx);
            return;
          }
          if (coordinationAction === "reopen" && tokens.length >= 2) {
            const reportId = tokens.shift();
            const reason = tokens.join(" ");
            await coordinationRuntime.reopenReview(reportId, reason, ctx);
            return;
          }
          throw new Error("用法：/pi-init coordination resume | /pi-init coordination reopen <reportId> <原因>");
        }
        if (action === "workflow") {
          await workflowActions.workflowCommand(tokens.shift(), tokens.shift(), ctx, tokens.includes("--confirm-unknown-outcome"));
          return;
        }
        ctx.ui.notify("用法：/pi-init [init|advanced|config|save|role|mode|workflow|coordination] [参数]", "error");
      } catch (error) {
        ctx.ui.notify(textOf(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "init_project",
    label: "Initialize Project",
    description:
      "Generate AGENTS.md, project memory docs, and .pi/role-models.json. The package-published pi-init-role-routing Skill provides shared role semantics; project AGENTS.md references it and no project-level role Skill is generated. AGENTS.md also records the host platform and command conventions detected during initialization. Existing generated files may be overwritten after confirmation.",
    promptSnippet: "Initialize project context files and use the package-published pi-init-role-routing Skill",
    promptGuidelines: [
      "Use init_project when the user asks to initialize a project with AI Coding collaboration context.",
      "Before calling init_project, inspect available project metadata and provide description and testCommand when known.",
      "init_project records the current Pi host platform in AGENTS.md; if the target runs in WSL, a container, or a remote environment, mention that difference and update the generated context.",
      "Use init_project with dryRun=true first when the target project may already contain generated files.",
    ],
    parameters: initProjectParameters,
    renderCall(args, theme) {
      const target = typeof args.targetDir === "string" ? args.targetDir : ".";
      return new Text(
        theme.fg("toolTitle", theme.bold("pi-init ")) + theme.fg("muted", `初始化 ${target}`),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as ScaffoldOutcome | undefined;
      if (!details || !Array.isArray(details.files)) return new Text(theme.fg("error", "初始化失败"), 0, 0);
      if (details.cancelled) return new Text(theme.fg("warning", "已取消初始化"), 0, 0);
      const prefix = details.dryRun ? "预览" : "已生成";
      const lines = [
        theme.fg("success", `✓ ${prefix} ${details.files.length} 个文件`),
        details.conflicts.length > 0
          ? theme.fg("warning", `覆盖 ${details.conflicts.length} 个已有文件`)
          : theme.fg("muted", "无文件冲突"),
      ];
      if (expanded) lines.push(...details.files.map((file) => theme.fg("dim", `  ${file}`)));
      return new Text(lines.join("\n"), 0, 0);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "已取消，没有写入文件。" }], details: {} };
      }

      const targetDir = params.targetDir ?? ".";
      const options = {
        projectName: params.projectName,
        description: params.description,
        language: params.language,
        testCommand: params.testCommand,
        dryRun: params.dryRun,
        roleModels: params.roleModels,
      };
      const scaffold = await loadScaffoldRuntime();
      const result = await scaffold.runScaffold(ctx, targetDir, options, "conflicts");
      const text = scaffold.formatResult(result);

      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  pi.registerTool<typeof taskWorkflowParameters>({
    name: "task_workflow",
    label: "Task Workflow",
    description:
      `Manage an architecture-led sequential task workflow with a recommended size of ${WORKFLOW_RECOMMENDED_TASKS} tasks (a soft planning guideline, not a limit). The Architect only thinks, analyzes, decides, plans, and arranges responsibilities; executable tasks must use non-architect roles and the runtime rejects architect as a task role. Tasks complete one at a time, and the next task starts automatically after verified completion. Pause only for an explicit architecture review or a real blocker. Task contracts are optional for ordinary plans; a task may carry contract only together with accepted, non-stale coordination evidence for the current workflow revision, so ordinary tasks keep a contract-free path.`,
    promptSnippet: "Create and advance an architecture-led sequential implementation task workflow",
    promptGuidelines: [
      "Use task_workflow action=plan only for explicit planning, cross-module/high-risk work, or a plan that cannot be safely handled locally. Route clear instructions directly to the matching role; unclear, ambiguous, or cross-responsibility instructions start with architect. Before action=plan or action=replan, the active role must be architect; otherwise call switch_role(role=architect) first and never emit planning calls from developer-test or docs-commit.",
      "Never assign architect as an executable task role; planning validation rejects it, retained architect tasks cannot be applied by replan, and old active plans with architect execution tasks are not recovered or dispatched.",
      "Architect 不取证、不执行、不连接 MCP，只负责思考、分析、决策、规划和安排；architect 不得读取、搜索、浏览、运行 shell、编辑、写入或调用任何其他工具。需要最新实现、直接调用方或测试等结构化证据时，先 switch_role 到 docs-commit，由 docs-commit 核对 latest implementation, direct callers, and tests 后再交回 architect 规划。fresh structured evidence from docs-commit 必须由 docs-commit 提供，architect 不得自行完成低风险只读检查。",
      `Architect 在 task_workflow 上只允许 ${ARCHITECT_ALLOWED_ACTIONS_TEXT}；请求与审阅证据是纯协议动作，可传回当前 coordinationHandoffId 短引用，report-evidence 等执行动作仍被阻断。`,
      "task contract 与协调状态是双向门控：携带 contract 的任务必须有绑定当前 workflow revision 且已接受、未过期的协调证据，contract.evidence 必须引用该账本；没有协调证据的普通计划不要附带 contract，否则会被拒。",
      "workflowMode=auto skips persistence for a valid low-risk plan with at most two tasks; set reviewRequired=true only when the user initially asks for architecture review.",
      "Call task_workflow(action=complete) only after real implementation and verification; use block for missing requirements, permissions, credentials, destructive-operation approval, product decisions, or unrecoverable failures. These execution actions belong to the active implementation role, not architect.",
      "Discussion does not change workflow state. Only explicit child requests (子流程：目标 or request-child) create one independent child; additions update the current queue. Child planning requires subworkflowContract (inputs, expectedOutputs, acceptanceCriteria, allowedFiles). No recursive children. On return, architect must review-child using the current replan identity and structured verification; continue only if all expected outputs are accepted and the parent plan remains valid, otherwise replan or block. cancel ends the current child and returns for review; cancel-all ends the whole workflow without rolling back side effects.",
    ],
    parameters: taskWorkflowParameters,
    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "...";
      const taskCount = Array.isArray(args.tasks) ? ` · ${args.tasks.length} 个任务` : "";
      return new Text(theme.fg("toolTitle", theme.bold("工作流请求 ")) + theme.fg("muted", `${action}${taskCount}`), 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      const firstContent = result.content[0];
      const contentText = firstContent?.type === "text" ? firstContent.text : "";
      if (context.isError) return renderWorkflowOperationFailure(contentText, theme);
      const presentation = workflowPresentationFromDetails(result.details);
      if (presentation) return renderWorkflowPresentation(presentation, expanded, theme);

      const details = result.details as import("./runtime-state.ts").WorkflowState | undefined;
      if (!details || !Array.isArray(details.tasks)) {
        return new Text(contentText || "工作流已更新", 0, 0);
      }
      const statusView = createWorkflowStatusView(details, {
        roleCompactionPhase: "idle",
        workflowDispatchInFlight: false,
      });
      if (details.status === "paused") {
        return renderWorkflowPauseResult(
          createWorkflowPauseView(details),
          expanded,
          theme,
          formatWorkflowStatusText(statusView),
        );
      }
      return new Text(contentText || "工作流已更新", 0, 0);
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return workflowActions.runTaskWorkflowAction(params, signal, ctx);
    },
  });

  pi.registerTool({
    name: "switch_role",
    label: "Switch Role",
    description:
      "Switch the active Pi model and reasoning level for a configured responsibility. Reads the project roleModels mapping and current-session overrides; switching never writes .pi/role-models.json. Modes: auto applies immediately, confirm asks before automatic changes, manual requires /pi-init role. Use /pi-init save to explicitly persist staged role configuration.",
    promptSnippet: "Switch model and reasoning level for a configured project role",
    promptGuidelines: [
      "Call switch_role when entering a responsibility selected by the project's role-routing Skill or crossing a role boundary; do not repeat it within the same responsibility.",
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
      if (context.isError) return new Text(theme.fg("error", "角色切换失败"), 0, 0);
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
      const source = roleHandoff.capture(ctx);
      const selection = await roleRuntime.automaticRole(params.role, ctx);
      const transition = roleHandoff.finishSwitch(ctx, source, selection.result, signal?.aborted);
      const result = selection.result;
      const prefix = selection.requestedRole === result.role ? "已切换到" : `已按确认选择切换到 ${result.role}（建议为 ${selection.requestedRole}）`;
      return {
        content: [
          {
            type: "text",
            text: `${prefix}：${result.provider}/${result.model}，推理强度 ${result.thinkingLevel}，模式 ${selection.mode}${transition.terminate ? transition.handoffFailure ? "。当前回合结束；交接未确认，不会自动续跑，请检查会话。" : "。当前回合结束；随后以新职责继续未完成工作。" : ""}`,
          },
        ],
        details: { ...result, mode: selection.mode, requestedRole: selection.requestedRole, ...transition },
        terminate: transition.terminate,
      };
    },
  });
  createHandoffDiagnostics(pi, runtimeState);
}
