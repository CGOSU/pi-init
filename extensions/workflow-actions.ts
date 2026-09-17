import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyWorkflowReplan,
  blockWorkflowTask,
  cancelWorkflow,
  completeWorkflowTask,
  cloneState,
  buildRuntimeWorkflow,
  createWorkflowState,
  eventCursor,
  isWorkflowActive,
  projectRuntimeState,
  resumeWorkflow,
  retryWorkflowTask,
  validateWorkflowPlan,
} from "../src/workflow.js";
import { roleLabel, shouldOrchestrateWorkflow } from "../src/roles.js";
import { RuntimeClient, RuntimeClientError } from "./runtime-client.ts";
import { createRuntimeClientConfig } from "./runtime-client-config.ts";
import { textOf, type ExtensionRuntimeState, type WorkflowState } from "./runtime-state.ts";
import type { RoleRuntime } from "./role-runtime.ts";
import type { WorkflowDispatch } from "./workflow-dispatch.ts";
import type { WorkflowReport } from "./workflow-report.ts";

export type WorkflowActionDependencies = {
  roleRuntime: RoleRuntime;
  dispatch: WorkflowDispatch;
  report: WorkflowReport;
};

export function createWorkflowActions(
  state: ExtensionRuntimeState,
  deps: WorkflowActionDependencies,
) {
  function shouldOrchestrateConfiguredWorkflow(mode: string, taskCount: number) {
    if (typeof shouldOrchestrateWorkflow !== "function") {
      throw new Error(
        "检测到 pi-init 运行时版本不一致：扩展与 src/roles.js 不是同一版本，缺少 shouldOrchestrateWorkflow。请先执行 pi update --extensions，然后在 Pi 中执行 /reload；本地开发请重启 Pi，并确保使用同一份扩展和 src/roles.js。",
      );
    }
    return shouldOrchestrateWorkflow({ mode, taskCount });
  }
  function assertConfiguredTaskRoles(config: { roleModels: Record<string, unknown> }, tasks: Array<{ id: string; role: string }>) {
    const configuredRoles = new Set(Object.keys(config.roleModels));
    for (const task of tasks) {
      if (!configuredRoles.has(task.role)) {
        throw new Error(
          `工作流任务 ${task.id} 要求角色 ${roleLabel(task.role)}，但该角色未配置模型；请先执行 /pi-init config ${task.role}`,
        );
      }
    }
  }

  function runtimeAuthority(workflow = state.workflowState) {
    const authority = workflow?.runtimeAuthority;
    if (!authority || authority.kind !== "runtime") {
      throw new Error("runtime workflow 缺少已冻结的 Runtime authority");
    }
    return authority;
  }
  function runtimeClientFor(workflow = state.workflowState) {
    const authority = runtimeAuthority(workflow);
    if (!state.runtimeClient || state.runtimeClient.config.endpoint.address !== authority.endpoint) {
      state.runtimeClient = new RuntimeClient(createRuntimeClientConfig({
        endpoint: authority.endpoint,
        timeoutMs: authority.timeoutMs,
        retries: authority.retries,
        maxFrameBytes: authority.maxFrameBytes,
      }));
    }
    return state.runtimeClient;
  }
  function clearRuntimeTimer() {
    if (state.runtimePollTimer) clearTimeout(state.runtimePollTimer);
    state.runtimePollTimer = undefined;
  }

  function armRuntimePoll(ctx: ExtensionContext) {
    clearRuntimeTimer();
    if (!state.workflowState || !isWorkflowActive(state.workflowState)) return;
    const timer = setTimeout(() => {
      state.runtimePollTimer = undefined;
      void scheduleRuntimeWorkflow(ctx);
    }, 250);
    timer.unref?.();
    state.runtimePollTimer = timer;
  }
  function runtimeError(error: unknown, ctx: ExtensionContext) {
    const message = textOf(error);
    const code = error instanceof RuntimeClientError ? error.code : error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "runtime_error";
    state.runtimeError = { code, message };
    if (state.workflowState?.runtimeAuthority) {
      state.workflowState.runtimeAuthority.status = code === "recovery_unknown" ? "unknown" : "unavailable";
      state.workflowState.runtimeAuthority.error = { code, message };
      deps.report.persistWorkflowState(state.workflowState, ctx);
    }
    state.workflowDispatchInFlight = false;
    state.runtimeDispatchInFlight = false;
    ctx.ui.notify(`Runtime workflow 未能推进（${code}）：${message}`, "error");
  }
  async function submitRuntimeGraph(workflow: WorkflowState, ctx: ExtensionContext) {
    const authority = runtimeAuthority(workflow);
    const client = runtimeClientFor(workflow);
    const reply = await client.request({
      command: "submit_graph",
      payload: { protocol_version: 2, graph: authority.graph },
    }, { requestId: authority.submitRequestId });
    if (reply.response !== "graph_submitted" || reply.payload?.graph_revision?.graph_id !== authority.graphRevision.graphId) {
      throw new RuntimeClientError("unexpected_response", "Runtime graph submission response did not match the frozen revision");
    }
    const submitted = cloneState(workflow);
    submitted.runtimeAuthority.status = "submitted";
    deps.report.persistWorkflowState(submitted, ctx);
    return submitted;
  }

  async function scheduleRuntimeWorkflow(ctx: ExtensionContext) {
    const workflow = state.workflowState;
    if (!workflow || workflow.executor !== "runtime" || !isWorkflowActive(workflow) || state.runtimeDispatchInFlight) return;
    state.runtimeDispatchInFlight = true;
    clearRuntimeTimer();
    try {
      let current = workflow;
      if (runtimeAuthority(current).status === "pending") current = await submitRuntimeGraph(current, ctx);
      const authority = runtimeAuthority(current);
      const client = runtimeClientFor(current);
      // Omit after_event_id to use Runtime's read-before-ack subscription. The server retains the
      // confirmed cursor; after a daemon restart it replays unacknowledged events, which are
      // projected idempotently against the frozen pi-init cursor before the same cursor is acked.
      const events = await client.readEvents({
        graphId: authority.graphRevision.graphId,
        limit: 100,
      });
      const remote = await client.queryGraph({
        graphId: authority.graphRevision.graphId,
        revision: authority.graphRevision.revision,
      });
      let next = projectRuntimeState(current, remote, events);
      const cursor = eventCursor(events, authority.eventCursor, authority);
      if (events.length > 0 && cursor >= authority.eventCursor) {
        await client.acknowledgeEvents(authority.graphRevision.graphId, cursor, {
          requestId: `${authority.graphRevision.graphId}-ack-${cursor}`,
        });
        next = cloneState(next);
        next.runtimeAuthority.eventCursor = cursor;
      }
      deps.report.persistWorkflowState(next, ctx);
      state.runtimeError = undefined;
      if (next.status === "running") armRuntimePoll(ctx);
    } catch (error) {
      runtimeError(error, ctx);
    } finally {
      state.runtimeDispatchInFlight = false;
    }
  }

  async function cancelRuntimeWorkflow(ctx: ExtensionContext, reason: string) {
    const workflow = state.workflowState;
    const authority = runtimeAuthority(workflow);
    const client = runtimeClientFor(workflow);
    const remote = await client.queryGraph({
      graphId: authority.graphRevision.graphId,
      revision: authority.graphRevision.revision,
    });
    const attempt = remote.attempts?.find((item: any) => item.attempt_id === remote.active_attempt_id);
    if (!attempt) throw new RuntimeClientError("no_active_attempt", "Runtime has no active Attempt; refusing local-only cancellation");
    await client.cancelAttempt({
      graphRevision: authority.graphRevision,
      attemptId: attempt.attempt_id,
      leaseEpoch: attempt.lease_epoch,
      reason,
    }, { requestId: `${authority.graphRevision.graphId}-cancel-${attempt.attempt_id}-${attempt.lease_epoch}` });
    await scheduleRuntimeWorkflow(ctx);
  }

  async function retryRuntimeTask(ctx: ExtensionContext, taskId?: string) {
    const workflow = state.workflowState;
    const authority = runtimeAuthority(workflow);
    const target = taskId || workflow?.tasks.find((task) => task.status === "blocked")?.id;
    if (!target) throw new RuntimeClientError("missing_task", "Runtime retry requires a task id");
    await runtimeClientFor(workflow).retryTask({
      graphRevision: authority.graphRevision,
      taskId: target,
    }, { requestId: `${authority.graphRevision.graphId}-retry-${target}-${authority.eventCursor}` });
    const resumed = cloneState(workflow);
    resumed.status = "running";
    delete resumed.pauseReason;
    const resumedTask = resumed.tasks.find((task) => task.id === target);
    if (resumedTask) {
      resumedTask.status = "pending";
      delete resumedTask.blockReason;
    }
    resumed.runtimeAuthority.status = "submitted";
    deps.report.persistWorkflowState(resumed, ctx);
    await scheduleRuntimeWorkflow(ctx);
  }

  async function initializeRuntimeWorkflow(workflow: WorkflowState, config: any, ctx: ExtensionContext) {
    const clientConfig = createRuntimeClientConfig(config.runtime);
    const built = buildRuntimeWorkflow(workflow, config, ctx.cwd, clientConfig);
    const next = cloneState(workflow);
    next.runtimeAuthority = built.runtimeAuthority;
    state.runtimeClient = new RuntimeClient(clientConfig);
    deps.report.persistWorkflowState(next, ctx);
    if (next.status !== "paused") await scheduleRuntimeWorkflow(ctx);
    return state.workflowState ?? next;
  }

  function disposeRuntime() {
    clearRuntimeTimer();
    state.runtimeClient?.close();
    state.runtimeClient = undefined;
    state.runtimeDispatchInFlight = false;
  }

  state.runtimeBackend = {
    initialize: initializeRuntimeWorkflow,
    schedule: scheduleRuntimeWorkflow,
    cancel: cancelRuntimeWorkflow,
    retry: retryRuntimeTask,
    dispose: disposeRuntime,
  };

  async function workflowCommand(
    action: string | undefined,
    taskId: string | undefined,
    ctx: ExtensionCommandContext,
  ) {
    if (action === undefined || action === "status") {
      await deps.report.showWorkflowProgress(ctx);
      return;
    }
    if (!state.workflowState) {
      ctx.ui.notify("当前没有工作流。请先让架构角色调用 task_workflow(action=plan)。", "warning");
      return;
    }

    try {
      if (action === "resume") {
        if (state.workflowState.executor === "runtime") {
          deps.report.persistWorkflowState(resumeWorkflow(state.workflowState), ctx);
          await state.runtimeBackend.schedule(ctx);
          return;
        }
        if (state.workflowState.status === "replanning") {
          await deps.dispatch.scheduleWorkflow(ctx);
          return;
        }
        if (state.workflowState.status === "running") {
          await deps.dispatch.resumeLocalWorkflow(ctx);
          return;
        }
        deps.report.persistWorkflowState(resumeWorkflow(state.workflowState), ctx);
        await deps.dispatch.scheduleWorkflow(ctx);
        return;
      }
      if (action === "retry") {
        if (state.workflowState.executor === "runtime") {
          await state.runtimeBackend.retry(ctx, taskId);
          return;
        }
        deps.report.persistWorkflowState(retryWorkflowTask(state.workflowState, taskId), ctx);
        await deps.dispatch.scheduleWorkflow(ctx);
        return;
      }
      if (action === "cancel") {
        if (state.workflowState.executor === "runtime") {
          await state.runtimeBackend.cancel(ctx, "pi-init workflow cancellation");
          return;
        }
        const cancelled = cancelWorkflow(state.workflowState);
        deps.report.persistWorkflowState(cancelled, ctx);
        state.workflowDispatchInFlight = false;
        ctx.ui.notify("工作流已取消。", "info");
        return;
      }
      ctx.ui.notify("用法：/pi-init workflow [status|resume|retry <taskId>|cancel]", "error");
    } catch (error) {
      ctx.ui.notify(textOf(error), "error");
    }
  }

  async function runTaskWorkflowAction(
    params: any,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "工作流操作已取消。" }], details: {} };
    }
    if (params.action !== "status" && !ctx.isProjectTrusted()) {
      throw new Error("task_workflow 仅允许在受信任项目中运行；请先信任当前项目");
    }

    switch (params.action) {
      case "plan": {
        if (deps.roleRuntime.activeRoleFor(ctx)?.role !== "architect") {
          throw new Error("只有架构角色可以创建工作流；请先调用 switch_role(role=architect)");
        }
        if (state.workflowState && ["running", "paused", "replanning"].includes(state.workflowState.status)) {
          throw new Error("当前已有未结束的工作流，请先完成、取消或处理它");
        }

        const config = await deps.roleRuntime.readSessionRoleConfig(ctx);
        state.workflowModeStatus = config.workflowMode;
        state.workflowExecutorStatus = config.workflowExecutor;
        const plan = validateWorkflowPlan({
          summary: params.summary,
          constraints: params.constraints,
          tasks: params.tasks,
          reviewRequired: params.reviewRequired,
        });
        assertConfiguredTaskRoles(config, plan.tasks);
        if (config.workflowMode === "off") {
          throw new Error(
            "task_workflow 当前策略为 off；请先执行 /pi-init config workflow 选择 on 或 auto，或在 .pi/role-models.json 中将 workflowMode 设为 on/auto",
          );
        }
        if (config.workflowExecutor !== "runtime"
          && !shouldOrchestrateConfiguredWorkflow(config.workflowMode, plan.tasks.length)) {
          return {
            content: [{
              type: "text",
              text: `当前工作流策略为 auto，规划包含 ${plan.tasks.length} 个任务（不超过 2 个），已跳过工作流编排；请按各任务指定的角色切换后顺序执行这些任务，架构角色只负责规划，不直接实现。`,
            }],
            details: { workflowMode: config.workflowMode, taskCount: plan.tasks.length, orchestrated: false },
          };
        }

        let next = createWorkflowState({ ...plan, executor: config.workflowExecutor });
        if (next.executor === "runtime") next = await state.runtimeBackend.initialize(next, config, ctx);
        else deps.report.persistWorkflowState(next, ctx);
        if (next.status === "paused") {
          ctx.ui.notify("架构规划已保存，等待用户审阅。审阅后执行 /pi-init workflow resume。", "info");
          if (state.pendingRoleCompaction) state.pendingRoleCompaction.continuation = { kind: "workflow-review" };
        } else if (state.pendingRoleCompaction) {
          state.pendingRoleCompaction.continuation = { kind: "workflow-schedule" };
        }
        return {
          content: [{ type: "text", text: `已保存架构规划。\n${deps.report.formatWorkflowState(next)}${next.status === "paused" ? "\n\n当前按用户要求暂停，审阅后再执行。" : "\n\n将自动切换到第一个任务。"}` }],
          details: next,
          terminate: true,
        };
      }
      case "status":
        return {
          content: [{ type: "text", text: deps.report.formatWorkflowState() }],
          details: state.workflowState ?? {},
        };
      case "replan": {
        if (!state.workflowState) throw new Error("当前没有活动工作流");
        if (state.workflowState.executor === "runtime") {
          throw new Error("runtime workflow 的 graph revision 由 Runtime 冻结；当前不允许本地重规划");
        }
        if (deps.roleRuntime.activeRoleFor(ctx)?.role !== "architect") {
          throw new Error("只有架构角色可以应用工作流重规划；请先调用 switch_role(role=architect)");
        }
        if (state.workflowState.status !== "replanning") {
          throw new Error("当前没有等待应用的工作流重规划");
        }
        const config = await deps.roleRuntime.readSessionRoleConfig(ctx);
        const plan = validateWorkflowPlan({
          summary: params.summary,
          constraints: params.constraints,
          tasks: params.tasks,
        });
        assertConfiguredTaskRoles(config, plan.tasks);
        const next = applyWorkflowReplan(state.workflowState, {
          revisionId: params.revisionId,
          summary: params.summary,
          constraints: params.constraints,
          tasks: params.tasks,
          retainTaskIds: params.retainTaskIds,
        });
        deps.report.persistWorkflowState(next, ctx);
        state.workflowDispatchInFlight = false;
        return {
          content: [{ type: "text", text: `已应用工作流重规划。\n${deps.report.formatWorkflowState(next)}\n\n新计划将自动开始。` }],
          details: next,
          terminate: true,
        };
      }
      case "complete": {
        if (!state.workflowState) throw new Error("当前没有活动工作流");
        if (state.workflowState.executor === "runtime") {
          throw new Error("runtime workflow 只能由 Runtime 事件完成，不能由聊天或 task_workflow 直接 complete");
        }
        const taskId = params.taskId ?? state.workflowState.currentTaskId;
        const task = taskId ? state.workflowState.tasks.find((item) => item.id === taskId) : undefined;
        if (!task) throw new Error(`工作流任务不存在：${taskId ?? "（未指定）"}`);
        if (deps.roleRuntime.activeRoleFor(ctx)?.role !== task.role) {
          throw new Error(`任务 ${task.id} 要求角色 ${task.role}，当前角色不匹配；请先调用 switch_role`);
        }
        const next = completeWorkflowTask(state.workflowState, {
          taskId,
          completionSummary: params.completionSummary,
          implementationRationale: params.implementationRationale,
          verification: params.verification,
        });
        const completedTask = next.tasks.find((item) => item.id === task.id);
        const taskCompletionReport = deps.report.formatWorkflowTaskCompletion(completedTask);
        const completionReport = next.status === "completed"
          ? deps.report.formatWorkflowCompletion(next, completedTask)
          : taskCompletionReport;
        deps.report.persistWorkflowState(next, ctx);
        state.workflowTaskCompactionPending = next.status !== "completed";
        return {
          content: [{ type: "text", text: `${completionReport}\n\n${next.status === "completed" ? "工作流已完成。" : next.status === "replanning" ? "当前任务已完成，等待架构师重规划，不会启动旧的后续任务。" : "下一任务将自动开始。"}` }],
          details: next,
          terminate: true,
        };
      }
      case "block": {
        if (!state.workflowState) throw new Error("当前没有活动工作流");
        if (state.workflowState.executor === "runtime") {
          throw new Error("runtime workflow 只能由 Runtime 状态阻塞，不能由聊天或 task_workflow 直接 block");
        }
        const taskId = params.taskId ?? state.workflowState.currentTaskId;
        const next = blockWorkflowTask(state.workflowState, { taskId, reason: params.reason });
        deps.report.persistWorkflowState(next, ctx);
        state.workflowDispatchInFlight = false;
        const blockNotice = deps.report.formatWorkflowBlockNotice(next);
        ctx.ui.notify(
          [`工作流已暂停：任务 ${taskId} 被标记为阻塞。`, blockNotice].filter(Boolean).join("\n"),
          "warning",
        );
        return { content: [{ type: "text", text: deps.report.formatWorkflowState(next) }], details: next, terminate: true };
      }
      case "resume": {
        if (!state.workflowState) throw new Error("当前没有活动工作流");
        if (state.workflowState.executor === "runtime") {
          const next = resumeWorkflow(state.workflowState);
          deps.report.persistWorkflowState(next, ctx);
          await state.runtimeBackend.schedule(ctx);
          return { content: [{ type: "text", text: "Runtime workflow 已恢复，正在从 Runtime 查询继续。" }], details: next, terminate: true };
        }
        if (state.workflowState.status === "replanning") {
          await deps.dispatch.scheduleWorkflow(ctx);
          return {
            content: [{ type: "text", text: "工作流仍在等待架构师重规划；已尝试继续架构调度。" }],
            details: state.workflowState,
            terminate: true,
          };
        }
        if (state.workflowState.status === "running") {
          const result = await deps.dispatch.resumeLocalWorkflow(ctx);
          const messages = {
            "blocked-by-compaction": "工作流仍在等待上下文压缩，不会并发启动任务。",
            "continuation-pending": "自动任务交接消息已排队，未重复派发。",
            "already-started": "当前任务已真实启动，未重复派发。",
            "dispatch-in-flight": "任务交接仍在进行，未重复派发。",
            scheduled: "已安全重新调度 Local 工作流。",
          };
          return {
            content: [{ type: "text", text: messages[result] }],
            details: state.workflowState,
            terminate: true,
          };
        }
        const next = resumeWorkflow(state.workflowState);
        deps.report.persistWorkflowState(next, ctx);
        return { content: [{ type: "text", text: "工作流已恢复，下一任务将自动开始。" }], details: next, terminate: true };
      }
      case "retry": {
        if (!state.workflowState) throw new Error("当前没有活动工作流");
        if (state.workflowState.executor === "runtime") {
          await state.runtimeBackend.retry(ctx, params.taskId);
          return { content: [{ type: "text", text: "已向 Runtime 请求 retry，等待 Runtime 事件确认。" }], details: state.workflowState, terminate: true };
        }
        const next = retryWorkflowTask(state.workflowState, params.taskId);
        deps.report.persistWorkflowState(next, ctx);
        return { content: [{ type: "text", text: `任务 ${params.taskId ?? ""} 已重新排队，工作流将自动继续。` }], details: next, terminate: true };
      }
      case "cancel": {
        if (!state.workflowState) throw new Error("当前没有活动工作流");
        if (state.workflowState.executor === "runtime") {
          await state.runtimeBackend.cancel(ctx, "task_workflow requested Runtime cancellation");
          return { content: [{ type: "text", text: "已向 Runtime 请求取消，等待 Runtime 退出事件。" }], details: state.workflowState, terminate: true };
        }
        const next = cancelWorkflow(state.workflowState);
        deps.report.persistWorkflowState(next, ctx);
        state.workflowDispatchInFlight = false;
        return { content: [{ type: "text", text: "工作流已取消。" }], details: next, terminate: true };
      }
      default:
        throw new Error(`未知工作流动作：${params.action}`);
    }
  }

  return { workflowCommand, runTaskWorkflowAction, shouldOrchestrateConfiguredWorkflow };
}

export type WorkflowActions = ReturnType<typeof createWorkflowActions>;
