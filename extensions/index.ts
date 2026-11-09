import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { findMatchingRole, roleLabel } from "../src/roles.ts";
import { isWorkflowActive, markWorkflowTaskOutcomeUnknown, resetWorkflowNudges, workflowActionIdentity } from "../src/workflow.ts";
import { createWorkflowRevisionInput } from "./workflow-revision-input.ts";
import { registerExtensionCommand } from "./extension-command.ts";
import { registerProjectTool } from "./project-tool.ts";
import { registerWorkflowTool } from "./workflow-tool.ts";
import { registerRoleTool } from "./role-tool.ts";
import { createRoleRuntime } from "./role-runtime.ts";
import { registerActivityStatusSources } from "./activity-status-registration.ts";
import { createArchitectBoundary } from "./architect-boundary.ts";
import { createExtensionRuntimeState, textOf } from "./runtime-state.ts";
import { createWorkflowActions } from "./workflow-actions.ts";
import { createWorkflowDispatch, type WorkflowDispatch } from "./workflow-dispatch.ts";
import { createWorkflowMessages } from "./workflow-messages.ts";
import { createWorkflowReport } from "./workflow-report.ts";
import { createRunTimingView } from "./run-timing-view.ts";
import { renderRunTimingReport } from "./run-timing-renderer.ts";
import { createEditGuardTool } from "./edit-guard.ts";
import { createFileReviewRuntime } from "./file-review-runtime.ts";
import { createRoleRecovery } from "./role-recovery.ts";
import { createRoleContextView } from "./role-context-view.ts";
import { registerContextCapacity } from "./role-context-capacity.ts";
import { createRunTimingDiagnostics } from "./run-timing-diagnostics.ts";
import { createRuntimeRoutingContext } from "./runtime-routing-context.ts";
import {
  type ResolvedRoleConfig,
  type RunTimingEntryData,
} from "./contracts.ts";
import { createDiagnosticControls } from "./diagnostic-controls.ts";
import { createHandoffDiagnostics } from "./handoff-diagnostics.ts";
import { createRoleHandoff } from "./role-handoff.ts";
import { createWorkflowToolBinding } from "./workflow-tool-binding.ts";
import { createWorkflowStatusPollingGuard, createWorkflowProgressObserver, createRepeatedRejectionGuard } from "./workflow-status-polling.ts";
import { createWorkflowDelivery } from "./workflow-delivery.ts";
import { createWorkflowUserControl } from "./workflow-user-control.ts";
import { createTaskMemoryRuntime } from "./task-memory-runtime.ts";
import { registerAbnormalToolGuard } from "./abnormal-tool-guard.ts";
import { createSessionHandoff, outgoingTransfer } from "./session-handoff.ts";

type ScaffoldRuntime = typeof import("./scaffold-runtime.ts");
const RUN_TIMING_ENTRY_TYPE = "pi-init-run-timing";
export default function initProjectExtension(pi: ExtensionAPI) {
  const runtimeState = createExtensionRuntimeState();
  let assistantFailureScope: string | undefined;
  let failedAssistant: object | undefined;
  function executionScope(ctx: ExtensionContext) {
    return JSON.stringify([ctx.sessionManager.getSessionId(), runtimeState.roleContextGeneration, runtimeState.roleTransitionGeneration, runtimeState.activeRole,
      workflowActionIdentity(runtimeState.workflowState), runtimeState.workflowState?.handoff?.handoffId]);
  }
  const workflowBinding = createWorkflowToolBinding(pi, runtimeState);
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || workflowBinding.isCurrentSource(event.message, ctx) === false) return;
    assistantFailureScope = ["error", "aborted"].includes(event.message.stopReason) ? executionScope(ctx) : undefined;
    failedAssistant = assistantFailureScope ? event.message : undefined;
  });
  const taskMemory = createTaskMemoryRuntime(pi, runtimeState, workflowBinding,
    ctx => userControl.suspend(ctx, "task-memory-unavailable"),
    (ctx, id, dependencies) => sessionHandoff.readEvidence(ctx, id, dependencies),
    ctx => {
      const current = runtimeState.workflowState;
      if (!current) return;
      const next = resetWorkflowNudges(current);
      if (next === current) return;
      try { workflowReport.persistWorkflowState(next, ctx); }
      catch (error) {
        userControl.suspend(ctx, "task-memory-progress-unavailable");
        throw error;
      }
    });
  const workflowProgressObserver = createWorkflowProgressObserver(pi, runtimeState, { onRepeatedRead: ctx => userControl.suspend(ctx, "repeated-read") });
  const activityStatus = registerActivityStatusSources(pi);
  const roleContextView = createRoleContextView(runtimeState);
  registerContextCapacity(pi, runtimeState);
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
              acknowledgeRoleRecovery: roleRecovery.acknowledge,
            });
  const roleHandoff = createRoleHandoff(pi, runtimeState, { getActiveRole: roleRuntime.activeRoleFor, requireRecovery: roleRecovery.requireConfirmation });
  const userControl = createWorkflowUserControl(pi, runtimeState, {
    retire: () => roleHandoff.reset(),
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
  registerAbnormalToolGuard(pi, ctx => userControl.suspend(ctx, "abnormal-tool-arguments"));
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
    toolsSettled: workflowBinding.generalToolsSettled,
    offerSessionHandoff: ctx => sessionHandoff.beforeDispatch(ctx),
    guardSessionHandoff: ctx => { if (outgoingTransfer(ctx, runtimeState.workflowState)) sessionHandoff.beforeDispatch(ctx); },
    setCurrentContext: (ctx) => {
      runtimeState.currentContext = ctx;
    },
  });
  const sessionHandoff = createSessionHandoff(pi, runtimeState, {
    persist: workflowReport.persistWorkflowState, restore: workflowDispatch.restoreWorkflowState,
    schedule: workflowDispatch.scheduleWorkflow, toolsSettled: workflowBinding.toolsSettled,
    generalToolsSettled: workflowBinding.generalToolsSettled,
  });
  const workflowActions = createWorkflowActions(runtimeState, {
    roleRuntime,
    dispatch: workflowDispatch,
    report: workflowReport,
    taskMemory,
    freshSession: sessionHandoff.fresh, resumeExecution: userControl.resume,
  });
  let scaffoldRuntimePromise: Promise<ScaffoldRuntime> | undefined;
  function loadScaffoldRuntime() {
    return scaffoldRuntimePromise ??= import("./scaffold-runtime.ts");
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

  const captureWorkflowRevisionInput = createWorkflowRevisionInput(runtimeState, {
    persistWorkflowState: workflowReport.persistWorkflowState,
    scheduleWorkflow: workflowDispatch.scheduleWorkflow,
  });

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
    failedAssistant = undefined;
    runtimeState.traceHandoff?.(ctx, "agent.continuation", { internal: runtimeState.internalContinuationPending });
    runTimingDiagnostics.beforeAgentStart(runtimeState.internalContinuationPending);
    runtimeState.internalContinuationPending = false;
  });

  pi.on("agent_start", (_event, ctx) => {
    if (runtimeState.userStopRequested && !userControl.allowsExternalTurn()) { ctx.abort(); return; }
    ctx.ui.setWidget("pi-init-role-config", undefined);
    roleHandoff.reset(); // A host-started run consumes any waiting continuation.
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
      const resumeGuard = !_event.aborted && failedAssistant ? workflowBinding.providerFailureGuard(failedAssistant, ctx) : undefined;
      assistantFailureScope = undefined;
      failedAssistant = undefined;
      userControl.suspend(ctx, resumeGuard ? "provider-request-failed" : "assistant-failure", !resumeGuard, resumeGuard);
      if (resumeGuard) ctx.ui.notify("模型请求失败，已停止自动请求；当前任务身份与已保存成果保留。处理网络、限额或凭据问题后说“继续”，无需重试整个任务。", "warning");
      settleExternalRunTiming();
      userControl.settled();
      return;
    }
    if (await roleHandoff.schedule(ctx)) {
      if (runtimeState.roleRecoveryPending || runtimeState.roleRecoveryPersistenceFailed) settleExternalRunTiming();
      return;
    }
    settleExternalRunTiming();

    await workflowDispatch.scheduleWorkflow(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    runtimeState.agentRunActive = false;
    roleHandoff.reset();
    workflowTaskConsumptionRunActive = false;
    runtimeState.roleContextGeneration += 1;
    runtimeState.roleTransitionGeneration += 1;

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
    failedAssistant = undefined;
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
      const role = config.modelStrategy === "auto" ? undefined : findMatchingRole(config, ctx.model, thinkingLevel);
      runtimeState.activeRole = role && ctx.model
        ? {
            role,
            provider: ctx.model.provider,
            model: ctx.model.id,
            thinkingLevel,
          }
        : undefined;
      roleRuntime.setRoleStatus(ctx, runtimeState.sessionModeOverride ?? config.mode);
      const roleModelConfigs = config.modelStrategy === "auto" && config.autoModel
        ? [`◆ Auto · 固定模型\n  模型：${config.autoModel.provider}/${config.autoModel.model}\n  起始强度：${config.autoModel.initialThinkingLevel}\n  允许范围：${config.autoModel.minThinkingLevel}–${config.autoModel.maxThinkingLevel}\n  原职责映射保留但暂不使用，职责和共享流程不变。`]
        : Object.entries(config.roleModels).map(([configuredRole, model]) =>
          `◆ ${roleLabel(configuredRole)}\n  模型：${model.provider}/${model.model}\n  推理强度：${model.thinkingLevel}`,
        );
      if (ctx.mode === "tui") {
        // Info notifications share one slot in Pi; other startup notices can replace them.
        ctx.ui.setWidget(
          "pi-init-role-config",
          roleModelConfigs.length > 0
            ? `📌 Pi Init · 角色模型配置\n\n${roleModelConfigs.join("\n\n")}`.split("\n")
            : undefined,
        );
      }
      if (!runtimeState.userStopRequested) {
            await workflowDispatch.scheduleWorkflow(ctx);
      }
    } catch (error) {
      diagnostics.trace(ctx, "pi-init.initialization_failed");
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

  registerExtensionCommand(pi, runtimeState, {
    roleRuntime, workflowActions, userControl, sessionHandoff, loadScaffoldRuntime,
    diagnosticsCommand: (args, ctx) => diagnosticControls.command(args, ctx),
    trace: (...args) => diagnostics.trace(...args),
  });

  registerProjectTool(pi, loadScaffoldRuntime);

  registerWorkflowTool(pi, runtimeState, {
    workflowActions, roleRecovery, workflowBinding, userControl,
    observeStatusPolling: (id, ctx, request) => statusPollingGuard.observe(id, ctx, request),
    observeRejection: (event, ctx) => rejectionGuard.observe(event, ctx),
    prepareDelivery: id => workflowDelivery.prepare(id),
  });

  registerRoleTool(pi, runtimeState, {
    roleRuntime, roleHandoff, userControl,
    observeRejection: (event, ctx) => rejectionGuard.observe(event, ctx),
  });
  const statusPollingGuard = createWorkflowStatusPollingGuard(pi, runtimeState);
  const rejectionGuard = createRepeatedRejectionGuard(pi, runtimeState);
  const workflowDelivery = createWorkflowDelivery(pi, runtimeState);
  const diagnostics = createHandoffDiagnostics(pi, runtimeState);
  const diagnosticControls = createDiagnosticControls(diagnostics);
  pi.registerCommand("blackbox", {
    description: "查看运行诊断；menu 打开面板，export 受控导出，clear 确认清理（不上传）",
    handler: async (args, ctx) => { await diagnosticControls.command(args, ctx); },
  });
}
