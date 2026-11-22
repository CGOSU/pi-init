import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { findMatchingRole } from "../src/roles.ts";
import { clearRoleConfigNotice, showRoleConfigNotice } from "./role/role-config-notice.ts";
import { evaluateFileReviewDispatch } from "./file-review/file-review-dispatch-policy.ts";
import { clearWorkflowStopped, isWorkflowRunning, markWorkflowStopped, markWorkflowTaskOutcomeUnknown, resetWorkflowNudges, workflowActionIdentity } from "../src/workflow.ts";
import { createWorkflowRevisionInput, workflowTaskCorrectionInput } from "./workflow/workflow-revision-input.ts";
import { createWorkflowDirectionInput } from "./workflow/workflow-direction-input.ts";
import { isExternalRunSource } from "../src/run-timing.ts";
import { registerExtensionCommand } from "./extension-command.ts";
import { registerProjectTool } from "./project-tool.ts";
import { registerWorkflowTool } from "./workflow/workflow-tool.ts";
import { registerRoleTool } from "./role/role-tool.ts";
import { createRoleRuntime } from "./role/role-runtime.ts";
import { registerActivityStatusSources } from "./activity-status-registration.ts";
import { createArchitectBoundary } from "./role/architect-boundary.ts";
import { createExtensionRuntimeState, textOf } from "./runtime-state.ts";
import { createWorkflowActions } from "./workflow/workflow-actions.ts";
import { createWorkflowDispatch, type WorkflowDispatch } from "./workflow/workflow-dispatch.ts";
import { createWorkflowMessages } from "./workflow/workflow-messages.ts";
import { createWorkflowReport } from "./workflow/workflow-report.ts";
import { createWorkflowStore, type WorkflowStore } from "./workflow/workflow-store.ts";
import { createRunTimingView } from "./run-timing-view.ts";
import { renderRunTimingReport } from "./run-timing-renderer.ts";
import { createEditGuardTool } from "./edit-guard.ts";
import { createFileReviewRuntime } from "./file-review/file-review-runtime.ts";
import { createRoleRecovery } from "./role/role-recovery.ts";
import { createRoleContextView } from "./role/role-context-view.ts";
import { createRoleContextPipeline } from "./role/role-context-pipeline.ts";
import { registerContextCapacity } from "./role/role-context-capacity.ts";
import { createRunTimingDiagnostics } from "./diagnostics/run-timing-diagnostics.ts";
import { createRuntimeRoutingContext } from "./role/runtime-routing-context.ts";
import type { RunTimingEntryData } from "./run-timing-view.ts";
import { createDiagnosticControls } from "./diagnostics/diagnostic-controls.ts";
import { createHandoffDiagnostics } from "./diagnostics/handoff-diagnostics.ts";
import { createRoleHandoff } from "./role/role-handoff.ts";
import { createWorkflowToolBinding } from "./workflow/workflow-tool-binding.ts";
import { createWorkflowStatusPollingGuard, createWorkflowProgressObserver, createRepeatedRejectionGuard } from "./workflow/workflow-status-polling.ts";
import { createWorkflowDelivery } from "./workflow/workflow-delivery.ts";
import { createWorkflowUserControl } from "./workflow/workflow-user-control.ts";
import { createTaskMemoryRuntime } from "./workflow/task-memory-runtime.ts";
import { registerAbnormalToolGuard } from "./abnormal-tool-guard.ts";
import { createSessionHandoff, outgoingTransfer } from "./session/session-handoff-runtime.ts";

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
      const next = runtimeState.workflowState ? resetWorkflowNudges(runtimeState.workflowState) : undefined;
      if (!next || next === runtimeState.workflowState) return;
      try { workflowStore.persistWorkflowState(next, ctx); }
      catch (error) {
        userControl.suspend(ctx, "task-memory-progress-unavailable");
        throw error;
      }
    });
  function endArchitectureReviewTurn(ctx: ExtensionContext, reason?: string) {
    // The plan is already paused; end the round without adding a user stop.
    roleHandoff.reset();
    ctx.abort();
    if (reason) ctx.ui.notify(`${reason}本轮已停止，计划仍待审。批准当前计划：/pi-init workflow resume；要改方向：发送「重规划：<新方向>」，修订后仍待审。`, "warning");
  }
  const workflowProgressObserver = createWorkflowProgressObserver(pi, runtimeState, {
    onRepeatedRead: (ctx, stop) => {
      if (stop === "review") {
        endArchitectureReviewTurn(ctx, "待审期间重复读取未获得新信息。");
      } else {
        userControl.suspend(ctx, "repeated-read");
      }
    },
  });
  const activityStatus = registerActivityStatusSources(pi);
  const roleContextView = createRoleContextView(runtimeState);
  registerContextCapacity(pi, runtimeState);
  const roleRecovery = createRoleRecovery(pi, runtimeState, (event, ctx, code) => {
    if (runtimeState.userStopRequested) { ctx.abort(); return; }
    const rejection = rejectionGuard.observe({ ...event, action: event.input?.action, role: event.input?.role, code }, ctx);
    if (!rejection.stop) return;
    if (!rejection.reviewOnly) {
      userControl.suspend(ctx, "repeated-guard-rejection");
      return;
    }
    endArchitectureReviewTurn(ctx, rejection.firstStop
      ? "待审计划的执行门禁已被反复触发。"
      : undefined);
    if (rejection.firstStop) {
      runtimeState.traceHandoff?.(ctx, "workflow.rejection_stopped", { toolCallId: event.toolCallId, code: rejection.code });
    }
  });
  createRoleContextPipeline(pi, runtimeState, { contextView: roleContextView.context, taskMemory });
  const runTimingDiagnostics = createRunTimingDiagnostics(
    pi,
    () => Boolean(runtimeState.workflowState && isWorkflowRunning(runtimeState.workflowState)),
  );
  pi.registerTool(createEditGuardTool());
  let workflowDispatch: WorkflowDispatch;
  let workflowReport: ReturnType<typeof createWorkflowReport>;
  let workflowStore: WorkflowStore;
  const workflowMessages = createWorkflowMessages(runtimeState, {
    pi,
    setInternalContinuationPending: (value) => {
      runtimeState.internalContinuationPending = value;
    },
    persistWorkflowState: (next, ctx) => workflowStore.persistWorkflowState(next, ctx),
  });
  const roleRuntime = createRoleRuntime(pi, runtimeState, {
              activityStatus, getWorkflowState: () => runtimeState.workflowState,
              acknowledgeRoleRecovery: roleRecovery.acknowledge,
            });
  const roleHandoff = createRoleHandoff(pi, runtimeState, { getActiveRole: roleRuntime.activeRoleFor, requireRecovery: roleRecovery.requireConfirmation });
  const userControl = createWorkflowUserControl(pi, runtimeState, {
    retire: () => { roleHandoff.reset(); directionInput.invalidate(); },
    interrupt: (ctx) => {
      const current = runtimeState.workflowState;
      if (!current || current.status !== "running" || !current.currentTaskId || !["executing", "queued", "dispatching"].includes(current.handoff?.phase ?? "")) return;
      const next = markWorkflowTaskOutcomeUnknown(current, { taskId: current.currentTaskId, reason: "活动回合中断或失败；已发生的副作用需核对，不自动重放。" });
      try { workflowStore.persistWorkflowState(next, ctx); }
      catch (error) { runtimeState.pendingWorkflowRecovery ??= next; throw error; }
    },
    stopTimer: (ctx, stopped) => {
      const current = runtimeState.workflowState;
      if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) return;
      const next = stopped ? markWorkflowStopped(current) : clearWorkflowStopped(current);
      if (next === current) return;
      try { workflowStore.persistWorkflowState(next, ctx); }
      catch (error) { ctx.ui.notify("工作流计时标记未保存：" + textOf(error) + "；本次停止期间可能计入运行耗时，不影响任务状态。", "warning"); }
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
      const decision = evaluateFileReviewDispatch(runtimeState, ctx);
      return decision.allowed ? undefined : decision.message;
    },
  });
  const runtimeRoutingContext = createRuntimeRoutingContext(runtimeState, {
    getActiveRole: roleRuntime.activeRoleFor,
    getThinkingLevel: () => pi.getThinkingLevel(),
  });
  pi.on("before_agent_start", runtimeRoutingContext.beforeAgentStart);
  pi.on("context_with_system", runtimeRoutingContext.contextWithSystem);
  createArchitectBoundary(pi, (ctx) => roleRuntime.activeRoleFor(ctx)?.role);
  registerAbnormalToolGuard(pi, ctx => userControl.suspend(ctx, "abnormal-tool-arguments"));
  workflowReport = createWorkflowReport(runtimeState, {
    roleRuntime, activityStatus,
  });
  workflowStore = createWorkflowStore(runtimeState, {
    pi,
    onWorkflowPersisted: workflow => workflowProgressObserver.observe(workflow),
    traceWorkflowPersisted: ctx => runtimeState.traceHandoff?.(ctx, "workflow.persisted"),
    updateWorkflowStatus: workflowReport.updateWorkflowStatus,
  });
  workflowDispatch = createWorkflowDispatch(runtimeState, {
    roleRuntime,
    messages: workflowMessages,
    report: workflowReport,
    store: workflowStore,
    toolsSettled: workflowBinding.generalToolsSettled,
    offerSessionHandoff: ctx => sessionHandoff.beforeDispatch(ctx),
    guardSessionHandoff: ctx => { if (outgoingTransfer(ctx, runtimeState.workflowState)) sessionHandoff.beforeDispatch(ctx); },
    setCurrentContext: (ctx) => {
      runtimeState.currentContext = ctx;
    },
  });
  const sessionHandoff = createSessionHandoff(pi, runtimeState, {
    persist: workflowStore.persistWorkflowState, restore: workflowDispatch.restoreWorkflowState,
    schedule: workflowDispatch.scheduleWorkflow, toolsSettled: workflowBinding.toolsSettled,
    generalToolsSettled: workflowBinding.generalToolsSettled,
  });
  const workflowActions = createWorkflowActions(runtimeState, {
    roleRuntime,
    dispatch: workflowDispatch,
    report: workflowReport,
    store: workflowStore,
    taskMemory,
    freshSession: sessionHandoff.fresh, resumeExecution: userControl.resume, startNewTask: userControl.startNewTask,
  });
  let scaffoldRuntimePromise: Promise<ScaffoldRuntime> | undefined;
  function loadScaffoldRuntime() {
    return scaffoldRuntimePromise ??= import("./scaffold-runtime.ts");
  }
  function settleExternalRunTiming() { runTimingDiagnostics.settle(); }
  let workflowTaskConsumptionRunActive = false;
  function clearRunFailure() { assistantFailureScope = undefined; failedAssistant = undefined; }
  function resetAgentRun(retireHandoff = false) {
    runtimeState.agentRunActive = false;
    workflowTaskConsumptionRunActive = false;
    if (retireHandoff) roleHandoff.reset();
  }
  pi.registerEntryRenderer<RunTimingEntryData>(RUN_TIMING_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data && typeof entry.data === "object"
      ? entry.data as RunTimingEntryData
      : {};
    return renderRunTimingReport(createRunTimingView(data), theme);
  });

  pi.on("model_select", (_event, ctx) => {
    runtimeState.currentContext = ctx;
    roleRuntime.refreshRoleStatus(ctx);
  });
  const captureWorkflowRevisionInput = createWorkflowRevisionInput(runtimeState, {
    persistWorkflowState: workflowStore.persistWorkflowState,
    scheduleWorkflow: workflowDispatch.scheduleWorkflow,
  });

  const directionInput = createWorkflowDirectionInput(runtimeState, {
    readConfig: roleRuntime.resolveSessionRoleConfig,
    activeRoleFor: roleRuntime.activeRoleFor,
    revise: captureWorkflowRevisionInput,
    hasOutgoingTransfer: ctx => Boolean(outgoingTransfer(ctx, runtimeState.workflowState)),
  });

  pi.on("input", async (event, ctx) => {
    const inputGeneration = isExternalRunSource(event.source) ? directionInput.invalidate() : undefined;
    if (typeof event.text === "string" && event.text.trim().startsWith("/")) return { action: "continue" };
    const handled = (await userControl.input(event, ctx))
      ?? ((await captureWorkflowRevisionInput(event, ctx)) ? { action: "handled" as const } : undefined);
    if (handled) return handled;
    const direction = workflowTaskCorrectionInput(runtimeState, event, ctx)
      ?? (inputGeneration === undefined ? undefined : await directionInput.handle(event, ctx, inputGeneration));
    if (direction?.action === "handled") return direction;
    runTimingDiagnostics.captureInput(event.source);
    return direction ?? { action: "continue" };
  });

  pi.on("before_agent_start", (_event, ctx) => {
    clearRunFailure();
    runtimeState.traceHandoff?.(ctx, "agent.continuation", { internal: runtimeState.internalContinuationPending });
    runTimingDiagnostics.beforeAgentStart(runtimeState.internalContinuationPending);
    runtimeState.internalContinuationPending = false;
  });

  pi.on("agent_start", (_event, ctx) => {
    if (runtimeState.userStopRequested && !userControl.allowsExternalTurn()) { ctx.abort(); return; }
    clearRoleConfigNotice(ctx);
    roleHandoff.reset(); // A host-started run consumes any waiting continuation.
    runtimeState.agentRunActive = true;
    workflowTaskConsumptionRunActive = !runtimeState.userStopRequested;
    runtimeState.currentContext = ctx;
    roleRuntime.refreshRoleStatus(ctx);
    runtimeState.internalContinuationPending = false;
    runTimingDiagnostics.agentStart();
  });

  pi.on("message_start", (event, ctx) => {
    if (!workflowTaskConsumptionRunActive) return;
    workflowDispatch.markCurrentTaskStartedFromMessage(ctx, event.message);
  });

  pi.on("agent_end", () => resetAgentRun());

  pi.on("agent_settled", async (_event, ctx) => {
    resetAgentRun();
    runtimeState.currentContext = ctx;
    roleRuntime.refreshRoleStatus(ctx);
    if (runtimeState.userStopRequested) { settleExternalRunTiming(); userControl.settled(); return; }
    if (assistantFailureScope === executionScope(ctx) && runtimeState.workflowState
      && ["running", "replanning"].includes(runtimeState.workflowState.status)) {
      const resumeGuard = !_event.aborted && failedAssistant ? workflowBinding.providerFailureGuard(failedAssistant, ctx) : undefined;
      clearRunFailure();
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
    directionInput.invalidate();
    resetAgentRun(true);
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
    directionInput.invalidate();
    clearRunFailure();
    resetAgentRun(true);
    try {
      runtimeState.runtimeDisposed = false;
      runtimeState.roleContextGeneration += 1;
      runtimeState.roleTransitionGeneration += 1;
      runtimeState.sessionRoleConfigOverrides = {};
      runtimeState.configuredRoleNames = [];
      runtimeState.activeRole = undefined;
      runtimeState.workflowNoticeAcknowledgement = undefined;
      roleRecovery.restore(ctx, event.reason);
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
      roleRuntime.refreshRoleStatus(ctx);
      showRoleConfigNotice(ctx, config);
      if (!runtimeState.userStopRequested) {
            await workflowDispatch.scheduleWorkflow(ctx);
      }
    } catch (error) {
      diagnostics.trace(ctx, "pi-init.initialization_failed");
      ctx.ui.notify(textOf(error), "error");
    }
  });

  pi.on("session_tree", async (event, ctx) => {
    directionInput.invalidate();
    resetAgentRun(true);
    workflowDispatch.restoreWorkflowState(ctx, { updateStatus: false });
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
    description: "运行诊断：menu 面板，export 有限脱敏导出，clear 确认清理，resume 显式恢复后续记录（project/global/handoff；不上传）",
    handler: async (args, ctx) => { await diagnosticControls.command(args, ctx); },
  });
}
