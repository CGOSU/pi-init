import {
  type ExtensionAPI,
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
  requestWorkflowReplan, requestWorkflowGoal, markWorkflowTaskOutcomeUnknown, workflowActionIdentity } from "../src/workflow.ts";
import { Text } from "@earendil-works/pi-tui";
import { isExternalRunSource } from "../src/run-timing.ts";
import { isExplicitWorkflowReplanInput, isWorkflowContinuationInput, isExplicitWorkflowChildInput } from "../src/workflow-input-intent.ts";
import { createRoleRuntime } from "./role-runtime.ts";
import { registerActivityStatusSources } from "./activity-status-registration.ts";
import { createArchitectBoundary, ARCHITECT_ALLOWED_ACTIONS_TEXT } from "./architect-boundary.ts";
import { createExtensionRuntimeState, textOf } from "./runtime-state.ts";
import { createWorkflowActions } from "./workflow-actions.ts";
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
import { createWorkflowToolBinding } from "./workflow-tool-binding.ts";
import { fingerprint } from "./handoff-tool-diagnostics.ts";
import { createPausedStatusGuard, createWorkflowProgressObserver, createRepeatedRejectionGuard } from "./workflow-status-polling.ts";
import { createWorkflowDelivery } from "./workflow-delivery.ts";
import { createWorkflowUserControl } from "./workflow-user-control.ts";
import { registerContextBudgetMonitor } from "./context-budget-monitor.ts";
import { createTaskMemoryRuntime } from "./task-memory-runtime.ts";

type ControlCenterModule = typeof import("./control-center.ts");
type ControlCenter = ReturnType<ControlCenterModule["createControlCenter"]>;
type ScaffoldRuntime = typeof import("./scaffold-runtime.ts");
type ScaffoldOutcome = Awaited<ReturnType<ScaffoldRuntime["runScaffold"]>>;
const RUN_TIMING_ENTRY_TYPE = "pi-init-run-timing";
export default function initProjectExtension(pi: ExtensionAPI) {
  const runtimeState = createExtensionRuntimeState();
  let assistantFailureScope: string | undefined;
  function executionScope(ctx: ExtensionContext) {
    return JSON.stringify([ctx.sessionManager.getSessionId(), runtimeState.roleContextGeneration, runtimeState.roleTransitionGeneration, runtimeState.activeRole,
      workflowActionIdentity(runtimeState.workflowState), runtimeState.workflowState?.handoff?.handoffId]);
  }
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    assistantFailureScope = ["error", "aborted"].includes(event.message.stopReason) ? executionScope(ctx) : undefined;
  });
  const workflowBinding = createWorkflowToolBinding(pi, runtimeState);
  const taskMemory = createTaskMemoryRuntime(pi, runtimeState, workflowBinding, ctx => userControl.suspend(ctx, "task-memory-unavailable"));
  const workflowProgressObserver = createWorkflowProgressObserver(pi, runtimeState, { onRepeatedRead: ctx => userControl.suspend(ctx, "repeated-read") });
  const activityStatus = registerActivityStatusSources(pi);
  const roleContextView = createRoleContextView(runtimeState);
  const roleRecovery = createRoleRecovery(pi, runtimeState, roleContextView.context, (event, ctx, code) => {
    if (runtimeState.userStopRequested) { ctx.abort(); return; }
    const rejection = rejectionGuard.observe({ ...event, action: event.input?.action, role: event.input?.role, code }, ctx);
    if (rejection.stop) userControl.suspend(ctx, "repeated-guard-rejection");
  }, taskMemory);
  const runTimingDiagnostics = createRunTimingDiagnostics(
    pi,
    () => Boolean(runtimeState.workflowState && isWorkflowActive(runtimeState.workflowState)),
  );
  pi.registerTool(createEditGuardTool());
  let workflowDispatch: WorkflowDispatch;
  let workflowReport: ReturnType<typeof createWorkflowReport>;
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
    scheduleWorkflow: (ctx, identity, reason) => workflowDispatch.scheduleWorkflow(ctx, identity, reason),
    sendWorkflowReplanMessage: (ctx, identity) => workflowMessages.sendWorkflowReplanMessage(ctx, identity),
    acknowledgeRoleRecovery: roleRecovery.acknowledge,
    finishWorkflowBoundary: (ctx, identity, failed) => workflowDispatch.finishWorkflowBoundary(ctx, identity, failed),
  });
  const roleHandoff = createRoleHandoff(pi, runtimeState, { getActiveRole: roleRuntime.activeRoleFor, requireRecovery: roleRecovery.requireConfirmation });
  const userControl = createWorkflowUserControl(pi, runtimeState, {
    retire: () => { roleHandoff.reset(); roleRuntime.disposeWorkflowCompaction(); },
    interrupt: (ctx) => {
      const current = runtimeState.workflowState;
      if (!current || current.status !== "running" || !current.currentTaskId || !["executing", "queued", "dispatching"].includes(current.handoff?.phase ?? "")) return;
      const next = markWorkflowTaskOutcomeUnknown(current, { taskId: current.currentTaskId, reason: "活动回合中断或失败；已发生的副作用需核对，不自动重放。" });
      try { workflowReport.persistWorkflowState(next, ctx); }
      catch (error) { runtimeState.pendingWorkflowRecovery ??= next; throw error; }
    },
  });
  pi.on("tool_call", (event, ctx) => {
    const result = userControl.guardToolCall(event);
    if (result?.block) ctx.abort();
    return result;
  });
  registerContextBudgetMonitor(pi, runtimeState, roleRuntime);
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
  workflowReport = createWorkflowReport(runtimeState, {
    pi, roleRuntime, activityStatus,
    onWorkflowPersisted: (workflow) => {
      workflowProgressObserver.observe(workflow);
    },
  });
  workflowDispatch = createWorkflowDispatch(runtimeState, {
    roleRuntime,
    messages: workflowMessages,
    report: workflowReport,
    setCurrentContext: (ctx) => {
      runtimeState.currentContext = ctx;
    },
  });
  const workflowActions = createWorkflowActions(runtimeState, {
    roleRuntime,
    dispatch: workflowDispatch,
    report: workflowReport,
    taskMemory,
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
    workflowReport.persistWorkflowState(next, ctx);
    if (next.status === "replanning") await workflowDispatch.scheduleWorkflow(ctx);
  }

  async function captureWorkflowRevisionInput(
    event: { text?: unknown; source?: unknown },
    ctx: ExtensionContext,
  ) {
    if (
      !runtimeState.workflowState ||
      !["running", "replanning", "paused"].includes(runtimeState.workflowState.status) ||
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
      if (explicitReplan && revision.kind === "goal") {
        try {
          const next = requestWorkflowReplan(runtimeState.workflowState, { direction: event.text.trim() });
          await persistWorkflowDirection(next, ctx);
          ctx.ui.notify("目标插入已转为共享队列重规划；保留新目标意图和原有成果，当前任务不会被强行中断。", "info");
        } catch (error) { ctx.ui.notify(`无法调整队列请求：${textOf(error)}`, "warning"); }
        return true;
      }
      if (explicitChild !== (revision.kind === "goal")) {
        ctx.ui.notify("当前已有不同类型的待处理请求；未将新指令混入该请求，请先处理或取消当前请求。", "warning");
        return true;
      }
      try {
        const next = appendWorkflowReplanDirection(runtimeState.workflowState, event.text.trim());
        await persistWorkflowDirection(next, ctx);
        const nested = revision.kind === "goal";
        ctx.ui.notify(
          next.status === "replanning"
            ? nested
              ? `已将新目标合并到待处理的目标分组 ${revision.revisionId}，并交由架构师规划；原有成果与队列保留。`
              : `已将新指令合并到待处理 revision ${revision.revisionId}，并重新交给架构师重规划。`
            : nested
              ? `已将新目标合并到待处理的目标分组 ${revision.revisionId}，将在当前任务边界规划；原有成果与队列保留。`
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
        : requestWorkflowGoal(previous, { direction });
      await persistWorkflowDirection(next, ctx);
      ctx.ui.notify(
        explicitReplan
          ? next.currentTaskId
            ? `已记录父工作流重规划，将在当前任务 ${next.currentTaskId} 完成后交给架构师。`
            : "已记录父工作流重规划，等待架构师处理。"
          : next.currentTaskId
            ? `已记录共享队列新目标，将在当前任务 ${next.currentTaskId} 完成后规划；父工作流进度保留。`
            : "已记录共享队列新目标，等待架构师规划；原队列进度保留。",
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
    const control = await userControl.input(event, ctx);
    if (control) return control;
    if (await captureWorkflowRevisionInput(event, ctx)) return { action: "handled" };
    if (!runTimingDiagnostics.captureInput(event.source)) return { action: "continue" };
    return { action: "continue" };
  });

  pi.on("before_agent_start", (_event, ctx) => {
    assistantFailureScope = undefined;
    runtimeState.traceHandoff?.(ctx, "agent.continuation", { internal: runtimeState.internalContinuationPending });
    runTimingDiagnostics.beforeAgentStart(runtimeState.internalContinuationPending);
    runtimeState.internalContinuationPending = false;
  });

  pi.on("agent_start", (_event, ctx) => {
    if (runtimeState.userStopRequested && !userControl.allowsExternalTurn()) { ctx.abort(); return; }
    runtimeState.agentRunActive = true;
    workflowTaskConsumptionRunActive = !runtimeState.userStopRequested;
    runtimeState.currentContext = ctx;
    roleRuntime.refreshRoleStatus(ctx, runtimeState.roleModeStatus);
    runtimeState.internalContinuationPending = false;
    runTimingDiagnostics.agentStart();
  });

  pi.on("message_start", (event, ctx) => {
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
    if (runtimeState.userStopRequested) { settleExternalRunTiming(); userControl.settled(); return; }
    if (assistantFailureScope === executionScope(ctx) && runtimeState.workflowState
      && ["running", "replanning"].includes(runtimeState.workflowState.status)) {
      assistantFailureScope = undefined;
      userControl.suspend(ctx, "assistant-failure", true);
      settleExternalRunTiming();
      userControl.settled();
      return;
    }
    if (await roleHandoff.schedule(ctx)) {
      if (runtimeState.roleRecoveryPending || runtimeState.roleRecoveryPersistenceFailed) settleExternalRunTiming();
      return;
    }
    settleExternalRunTiming();
    roleRuntime.startPendingRoleCompaction(ctx);
    if (runtimeState.roleCompactionInFlight || runtimeState.pendingRoleCompaction) return;
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
    runtimeState.configuredRoleNames = [];
    runtimeState.currentContext = undefined;
  });

  pi.on("session_start", async (event, ctx) => {
    assistantFailureScope = undefined;
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
      workflowDispatch.restoreWorkflowState(ctx);
      userControl.restore(ctx);
      workflowProgressObserver.observe();
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
      if (!runtimeState.userStopRequested) {
            await workflowDispatch.scheduleWorkflow(ctx);
      }
    } catch (error) {
      ctx.ui.notify(textOf(error), "error");
    }
  });

  pi.on("session_tree", async (event, ctx) => {
    runtimeState.agentRunActive = false;
    roleHandoff.reset();
    workflowTaskConsumptionRunActive = false;
    workflowDispatch.restoreWorkflowState(ctx);
    userControl.restore(ctx);
    workflowProgressObserver.observe();
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
  });

  pi.registerCommand("pi-init", {
    description: "打开 Pi Init 控制中心：初始化项目、配置角色和切换模型",
    getArgumentCompletions: (prefix) => {
      const tokens = prefix.trim().split(/\s+/).filter(Boolean);
      if (tokens.length <= 1 && !prefix.endsWith(" ")) {
        const values = ["init", "advanced", "config", "save", "role", "mode", "workflow"];
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
        if (action === "init") { await (await loadScaffoldRuntime()).quickInit(tokens.join(" ") || ".", ctx); return; }
        if (action === "advanced") { await (await loadScaffoldRuntime()).advancedInit(tokens.join(" ") || ".", ctx); return; }
        if (action === "sync") { ctx.ui.notify("sync已退役：项目AGENTS和历史归维护者所有，不再同步覆盖。插件规则随pi-init更新，执行/reload或重启后生效。", "warning"); return; }
        if (action === "config") { await (await loadControlCenter()).configureRole(tokens[0], ctx); return; }
        if (action === "save") {
          const result = await roleRuntime.saveRoleConfig(ctx);
          ctx.ui.notify(result.message, result.ok ? "info" : "error");
          return;
        }
        if (action === "role") { await (await loadControlCenter()).switchRole(tokens[0], ctx); return; }
        if (action === "mode") { await (await loadControlCenter()).setSessionMode(tokens[0], ctx); return; }
        if (action === "workflow") {
          const workflowAction = tokens.shift();
          if (workflowAction === "stop") { userControl.suspend(ctx, "user-command"); ctx.ui.notify("自动续跑已停止；未完成、取消或重试任务。", "info"); return; }
          if ((workflowAction === "resume" || workflowAction === "retry") && !userControl.resume(ctx)) return;
          await workflowActions.workflowCommand(workflowAction, tokens.shift(), ctx, tokens.includes("--confirm-unknown-outcome"));
          if (workflowAction === "cancel" && runtimeState.workflowState?.status === "cancelled") userControl.resume(ctx);
          return;
        }
        ctx.ui.notify("用法：/pi-init [init|advanced|config|save|role|mode|workflow] [参数]", "error");
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
        theme.fg("muted", `保留 ${details.preserved.length} 个维护者已有文件`),
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
      `Manage an architecture-led sequential task workflow with a recommended size of ${WORKFLOW_RECOMMENDED_TASKS} tasks (a soft planning guideline, not a limit). The Architect only thinks, analyzes, decides, plans, and arranges responsibilities; executable tasks must use non-architect roles and the runtime rejects architect as a task role. Tasks complete one at a time, and the next task starts automatically after verified completion. Pause only for an explicit architecture review or a real blocker.`,
    promptSnippet: "Create and advance an architecture-led sequential implementation task workflow",
    promptGuidelines: [
      "Use task_workflow action=plan only for explicit planning, cross-module/high-risk work, or a plan that cannot be safely handled locally. Route clear instructions directly to the matching role; unclear, ambiguous, or cross-responsibility instructions start with architect. Before action=plan or action=replan, the active role must be architect; otherwise call switch_role(role=architect) first and never emit planning calls from developer-test or docs-commit.",
      "Never assign architect as an executable task role; planning validation rejects it, retained architect tasks cannot be applied by replan, and old active plans with architect execution tasks are not recovered or dispatched.",
      "Architect 只规划与决策，不读取、执行或连接 MCP。优先复用已有调查；缺少决策关键事实时才交给 docs-commit 集中补查，不因切角重读规则或重复调查。普通任务无需正式取证协议。",
      "本轮工具调用的工作流与协调身份由运行时绑定，通常只提交业务参数和真实结果，无需手填 workflow/session/attempt/handoff 等身份。兼容显式身份仍严格校验；不能套用最新状态提交旧回合结果。",
      `Architect 在 task_workflow 上只允许 ${ARCHITECT_ALLOWED_ACTIONS_TEXT}；实现、验证与结果提交必须由当前执行角色负责。`,
      "每项任务围绕一个可独立验收的交付物，使用task/constraints/files/acceptanceCriteria说明目标、非目标、产物和风险匹配的验证；不要按读取→修改→测试机械拆分。必要事实先调查，远期不确定内容在边界细化；缺少关键事实或权限时block，不建立正式证据或嵌套协议。",
      "workflowMode=auto skips persistence for a valid low-risk plan with at most two tasks; set reviewRequired=true only when the user initially asks for architecture review.",
      "Call task_workflow(action=complete) only after real implementation and verification; use block for missing requirements, permissions, credentials, destructive-operation approval, product decisions, or unrecoverable failures. These execution actions belong to the active implementation role, not architect.",
      "Discussion does not change workflow state. Use request-replan to revise the existing queue and request-goal to insert a goal group. Parent/child IDs express ownership only; all tasks share one workflow ID, ready queue and executor. New goal planning must explicitly retain existing pending task IDs; dependencies take precedence over priority, ties preserve order, and running tools are not preempted. Old nested workflows are retired and never resumed automatically.",
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
      function finish(result: Awaited<ReturnType<typeof workflowActions.runTaskWorkflowAction>>) {
        if (params.action === "complete" && !result.terminate) workflowDelivery.prepare(_toolCallId);
        if (params.action !== "status" || signal?.aborted) return result;
        const polling = pausedStatusGuard.observe(_toolCallId, ctx);
        if (!polling.stop) return result;
        const text = "暂停状态未发生变化，已结束本回合的重复状态轮询。工作流仍暂停，未恢复、完成或重试任务；请按已有状态说明处理阻塞或恢复问题。";
        if (polling.firstStop) {
          runtimeState.traceHandoff?.(ctx, "workflow.status_polling_stopped", { toolCallId: _toolCallId, code: polling.code });
          try { ctx.ui.notify(text, "warning"); } catch {}
        }
        return { ...result, content: [...result.content, { type: "text" as const, text }],
          details: { ...(result.details as Record<string, unknown>), statusPolling: { code: polling.code, stopped: true } }, terminate: true };
      }
      try {
        const stopped = userControl.guardToolCall({ toolName: "task_workflow", input: params });
        if (stopped) return { content: [{ type: "text", text: stopped.reason }], details: { ok: false, code: "WORKFLOW_USER_STOPPED" }, terminate: true };
        if (signal?.aborted || runtimeState.workflowRestoreError) return finish(await workflowActions.runTaskWorkflowAction(params, signal, ctx));
        const guard = roleRecovery.guardToolCall({ toolName: "task_workflow", input: params });
        if (guard?.block && (params.action === "retry" || params.action === "replan" || runtimeState.roleRecoveryPending || runtimeState.roleRecoveryPersistenceFailed)) {
          throw Object.assign(new Error(guard.reason), { code: guard.reason.startsWith("[pi-init-workflow-authorization]") ? "WORKFLOW_UNKNOWN_OUTCOME_CONFIRMATION_REQUIRED" : "WORKFLOW_EXECUTION_NOT_AUTHORIZED" });
        }
        let bound: typeof params;
        try { bound = workflowBinding.bind(_toolCallId, params, ctx); }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "WORKFLOW_RUN_BINDING_MISSING") throw error;
          return finish(await workflowActions.runTaskWorkflowAction(params, signal, ctx));
        }
        return finish(await workflowActions.runTaskWorkflowAction(bound, signal, ctx));
      } catch (error) {
        const value = error as { code?: unknown; message?: unknown };
        const code = typeof value?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) ? value.code : "WORKFLOW_ACTION_REJECTED";
        runtimeState.traceHandoff?.(ctx, "workflow.action_rejected", { toolCallId: _toolCallId, action: params.action, code, errorHash: fingerprint(value?.message) });
        const rejection = rejectionGuard.observe({ toolName: "task_workflow", toolCallId: _toolCallId, action: params.action, code }, ctx);
        if (rejection.stop) {
          userControl.suspend(ctx, "repeated-rejection");
          runtimeState.traceHandoff?.(ctx, "workflow.rejection_stopped", { toolCallId: _toolCallId, code: rejection.code });
          return { content: [{ type: "text", text: "同一身份的工作流动作已连续被拒绝，自动续跑已停止；未恢复、完成或重试任务。原错误码：" + code }], details: { ok: false, code, rejectionStopped: true }, terminate: true };
        }
        throw error;
      }
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
        const rejection = rejectionGuard.observe({ toolName: "switch_role", toolCallId: _toolCallId, role: params.role, code: boundary.code }, ctx);
        if (rejection.stop) {
          userControl.suspend(ctx, "repeated-rejection");
          runtimeState.traceHandoff?.(ctx, "workflow.rejection_stopped", { toolCallId: _toolCallId, code: rejection.code });
        }
        return { content: [{ type: "text", text: boundary.message + "\n" + (rejection.stop ? "同一身份的角色切换已连续被拒绝；当前回合结束，自动续跑已停止，等待用户明确处理。工作流未被完成、取消或重试。" : boundary.nextAction) }], details: { ok: false, ...boundary, rejectionStopped: rejection.stop }, ...(rejection.stop ? { terminate: true } : {}) };
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
  const pausedStatusGuard = createPausedStatusGuard(pi, runtimeState);
  const rejectionGuard = createRepeatedRejectionGuard(pi, runtimeState);
  const workflowDelivery = createWorkflowDelivery(pi, runtimeState);
  const diagnostics = createHandoffDiagnostics(pi, runtimeState);
  pi.registerCommand("blackbox", {
    description: "查看运行黑匣子的本地问题汇总（不触发模型回合）",
    handler: async (_args, ctx) => { ctx.ui.notify(await diagnostics.report(ctx), "info"); },
  });
}
