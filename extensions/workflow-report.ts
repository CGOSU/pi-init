import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, SelectList, Spacer, Text, type SelectItem } from "@earendil-works/pi-tui";
import {
  getWorkflowTask,
  workflowActionIdentity,
  workflowHandoffIdentity,
  workflowReplanIdentity,
} from "../src/workflow.ts";
import {
  WORKFLOW_RECOVERY_DISPOSITION_TYPE,
  parseWorkflowRecoveryDisposition,
} from "../src/workflow-recovery-disposition.ts";
import { createWorkflowPauseView } from "./workflow-pause-view.ts";
import { formatWorkflowPauseBlockLines, formatWorkflowPauseSummary as renderWorkflowPauseSummary } from "./workflow-pause-renderer.ts";
import { createCurrentWorkflowStatusView } from "./workflow-status-view.ts";
import {
  formatWorkflowStatusPanelSummary,
  formatWorkflowStatusText,
  workflowStatusBar,
  workflowStatusTaskItems,
} from "./workflow-status-renderer.ts";
import type { RunTimingEntryData } from "./contracts.ts";
import {
  createWorkflowCompletionView,
  createWorkflowTaskCompletionView,
} from "./workflow-completion-view.ts";
import {
  formatWorkflowCompletionText,
  formatWorkflowTaskCompletionText,
} from "./workflow-completion-renderer.ts";
import { createRunTimingView } from "./run-timing-view.ts";
import { formatRunTimingText } from "./run-timing-renderer.ts";
import {
  formatWorkflowDuration as formatDisplayDuration,
  formatWorkflowTimestamp as formatDisplayTimestamp,
} from "./workflow-view-format.ts";
import { textOf, type ExtensionRuntimeState, type WorkflowState } from "./runtime-state.ts";
import type { RoleRuntime } from "./role-runtime.ts";
import type { ActivityStatusReporter, ActivityStatusWorkflowNoticeSource } from "./activity-status.ts";

function formatWorkflowBlockLines(workflowState: WorkflowState) {
  return formatWorkflowPauseBlockLines(createWorkflowPauseView(workflowState));
}
function formatWorkflowPauseSummary(workflowState: WorkflowState) {
  return renderWorkflowPauseSummary(createWorkflowPauseView(workflowState));
}
export type WorkflowReportDependencies = {
  pi: ExtensionAPI;
  roleRuntime: RoleRuntime;
  activityStatus?: ActivityStatusReporter;
};

export function createWorkflowReport(
  state: ExtensionRuntimeState,
  deps: WorkflowReportDependencies,
) {
  const WORKFLOW_STATUS_REFRESH_MS = 1000;
  let workflowStatusTimer: ReturnType<typeof setInterval> | undefined;
  let workflowStatusContext: ExtensionContext | undefined;
  function stopWorkflowStatusTimer() {
    if (workflowStatusTimer) clearInterval(workflowStatusTimer);
    workflowStatusTimer = undefined;
    workflowStatusContext = undefined;
  }
  function currentWorkflowNoticeSource(
    ctx: ExtensionContext,
    view: ReturnType<typeof createCurrentWorkflowStatusView>,
  ): ActivityStatusWorkflowNoticeSource | undefined {
    const workflowState = state.workflowState;
    if (workflowState?.status === "completed" || workflowState?.status === "cancelled") return undefined;
    let sessionIdValue: unknown;
    try {
      sessionIdValue = ctx.sessionManager.getSessionId();
    } catch {
      sessionIdValue = undefined;
    }
    const sessionId = typeof sessionIdValue === "string" ? sessionIdValue : "";
    const contextGeneration = state.roleContextGeneration;
    const workflowIdentity = workflowState ? workflowActionIdentity(workflowState) : undefined;
    const handoffIdentity = workflowState ? workflowHandoffIdentity(workflowState) : undefined;
    const replanIdentity = workflowState ? workflowReplanIdentity(workflowState) : undefined;
    const restoreError = state.workflowRestoreError
      ?? (view.kind === "restore-error" ? { code: view.code, message: view.message, sourceEntryId: view.sourceEntryId } : undefined);

    if (restoreError) {
      return {
        kind: "restore-error",
        sessionId,
        contextGeneration,
        ...(workflowIdentity ? { workflowIdentity } : {}),
        ...(handoffIdentity ? { handoffIdentity } : {}),
        ...(replanIdentity ? { replanIdentity } : {}),
        cause: {
          code: restoreError.code,
          message: restoreError.message,
          ...(restoreError.sourceEntryId ? { sourceEntryId: restoreError.sourceEntryId } : {}),
        },
      };
    }
    if (view.kind !== "workflow" || (view.status !== "paused" && view.status !== "replanning")) return undefined;

    return {
      kind: view.status,
      sessionId,
      contextGeneration,
      workflowIdentity: view.identity.action,
      ...(view.identity.handoff ? { handoffIdentity: view.identity.handoff } : {}),
      ...(view.identity.replan ? { replanIdentity: view.identity.replan } : {}),
      cause: {
        ...(view.pause.reason.code ? { code: view.pause.reason.code } : {}),
        message: view.status === "paused"
          ? view.taskPauseReason ?? view.pause.reason.text
          : view.pendingRevision?.direction ?? view.pause.reason.text,
        ...(view.pause.blockedTasks.length > 0 ? {
          blockedTasks: view.pause.blockedTasks.map((blocked) => ({
            taskId: blocked.taskId,
            reason: blocked.reason,
            outcomeUnknown: workflowState?.tasks.find((task) => task.id === blocked.taskId)?.outcomeUnknown === true,
          })),
        } : {}),
      },
    };
  }

  function workflowStatusProjection(ctx: ExtensionContext) {
    const view = createCurrentWorkflowStatusView(state);
    const status = workflowStatusBar(view);
    if (!status) {
      state.workflowNoticeAcknowledgement = undefined;
      return undefined;
    }

    const restoreError = state.workflowRestoreError;
    const visibleStatus = restoreError && state.workflowState
      ? { text: `工作流恢复失败（${restoreError.code}）：${restoreError.message}`, color: "error" as const }
      : status;
    const source = currentWorkflowNoticeSource(ctx, view);
    if (!source) {
      state.workflowNoticeAcknowledgement = undefined;
      return visibleStatus;
    }

    const sourceKey = JSON.stringify(source);
    const acknowledgement = state.workflowNoticeAcknowledgement;
    const acknowledged = acknowledgement?.sessionId === source.sessionId
      && acknowledgement.contextGeneration === source.contextGeneration
      && acknowledgement.sourceKey === sourceKey;
    if (acknowledgement && !acknowledged) state.workflowNoticeAcknowledgement = undefined;
    const summary = source.kind === "restore-error"
      ? "⚑ 待处理：工作流恢复问题"
      : source.kind === "replanning"
        ? "⚑ 待处理：工作流重规划"
        : "⚑ 待处理：已暂停工作流";
    return {
      ...visibleStatus,
      notice: { source, sourceKey, summary, acknowledged },
    };
  }

  function renderWorkflowStatus(ctx: ExtensionContext) {
    deps.activityStatus?.setWorkflow(ctx, workflowStatusProjection(ctx));
  }

  function acknowledgeWorkflowNotice(ctx: ExtensionContext) {
    const current = workflowStatusProjection(ctx);
    const notice = current && "notice" in current ? current.notice : undefined;
    if (!notice) {
      deps.activityStatus?.setWorkflow(ctx, current);
      return {
        ok: false as const,
        error: { code: "WORKFLOW_NOTICE_NOT_ACTIVE", message: "当前没有可确认的工作流告警。" },
      };
    }
    if (!notice.source.sessionId.trim() || notice.source.sessionId !== notice.source.sessionId.trim()) {
      deps.activityStatus?.setWorkflow(ctx, current);
      return {
        ok: false as const,
        error: { code: "WORKFLOW_NOTICE_SESSION_ID_UNAVAILABLE", message: "无法读取当前 sessionId，未确认工作流告警。" },
      };
    }
    if (notice.source.workflowIdentity && notice.source.workflowIdentity.sessionId !== notice.source.sessionId) {
      deps.activityStatus?.setWorkflow(ctx, current);
      return {
        ok: false as const,
        error: { code: "WORKFLOW_NOTICE_SESSION_MISMATCH", message: "当前工作流身份不属于本 session，未确认其告警。" },
      };
    }
    if (notice.acknowledged) {
      deps.activityStatus?.setWorkflow(ctx, current);
      return { ok: true as const, value: { alreadyAcknowledged: true } };
    }
    state.workflowNoticeAcknowledgement = {
      sessionId: notice.source.sessionId,
      contextGeneration: notice.source.contextGeneration,
      sourceKey: notice.sourceKey,
    };
    renderWorkflowStatus(ctx);
    return { ok: true as const, value: { alreadyAcknowledged: false } };
  }

  function updateWorkflowStatus(ctx: ExtensionContext) {
    deps.roleRuntime.refreshRoleStatus(ctx, state.roleModeStatus);
    workflowStatusContext = ctx;
    renderWorkflowStatus(ctx);
    if (!state.workflowState || state.workflowState.status !== "running") {
      stopWorkflowStatusTimer();
      return;
    }
    if (workflowStatusTimer) return;
    workflowStatusTimer = setInterval(() => {
      const current = workflowStatusContext;
      if (!current || state.runtimeDisposed) {
        stopWorkflowStatusTimer();
        return;
      }
      renderWorkflowStatus(current);
    }, WORKFLOW_STATUS_REFRESH_MS);
    workflowStatusTimer.unref?.();
  }

  function dispose(ctx?: ExtensionContext) {
    stopWorkflowStatusTimer();
    state.workflowNoticeAcknowledgement = undefined;
    if (ctx) deps.activityStatus?.setWorkflow(ctx, undefined);
  }

  function persistWorkflowState(next: WorkflowState, ctx: ExtensionContext) {
    deps.pi.appendEntry("pi-init-workflow", next);
    state.workflowState = next;
    state.workflowRestoreError = undefined;
    updateWorkflowStatus(ctx);
    return next;
  }

  function persistWorkflowRecoveryDisposition(input: unknown) {
    const parsed = parseWorkflowRecoveryDisposition(input);
    if (!parsed.ok) {
      throw Object.assign(new Error(parsed.error.message), { code: parsed.error.code });
    }
    try {
      deps.pi.appendEntry(WORKFLOW_RECOVERY_DISPOSITION_TYPE, parsed.value);
    } catch (error) {
      throw Object.assign(
        new Error(`无法持久化工作流恢复隔离处置：${textOf(error)}`),
        { code: "WORKFLOW_RECOVERY_DISPOSITION_PERSIST_FAILED" },
      );
    }
    return parsed.value;
  }

  function formatWorkflowState(workflowState = state.workflowState) {
    return formatWorkflowStatusText(createCurrentWorkflowStatusView(state, workflowState));
  }

  async function showWorkflowProgress(ctx: ExtensionCommandContext) {
    if (!ctx.hasUI || ctx.mode !== "tui") {
      ctx.ui.notify(formatWorkflowStatusText(createCurrentWorkflowStatusView(state)), "info");
      return;
    }

    const initialView = createCurrentWorkflowStatusView(state);
    let stopLiveRefresh: (() => void) | undefined;
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const summary = new Text("", 0, 0);
      const refreshSummary = () => {
        summary.setText(theme.fg("text", formatWorkflowStatusPanelSummary(createCurrentWorkflowStatusView(state))));
      };
      const taskItems: SelectItem[] = workflowStatusTaskItems(initialView);

      const list = new SelectList(taskItems, Math.min(taskItems.length, 5), {
        selectedPrefix: (text) => theme.bg("selectedBg", theme.fg("accent", text)),
        selectedText: (text) => theme.bg("selectedBg", theme.fg("text", text)),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      }, {
        minPrimaryColumnWidth: 26,
        maxPrimaryColumnWidth: 32,
      });
      list.onSelect = () => done();
      list.onCancel = () => done();

      refreshSummary();
      const liveRefresh = setInterval(() => {
        refreshSummary();
        tui.requestRender();
      }, WORKFLOW_STATUS_REFRESH_MS);
      liveRefresh.unref?.();
      stopLiveRefresh = () => clearInterval(liveRefresh);

      const content = new Box(2, 1, (text) => theme.bg("customMessageBg", text));
      content.addChild(new Text(theme.bg("selectedBg", theme.fg("text", theme.bold(" 工作流任务进度 "))), 0, 0));
      content.addChild(new Spacer(1));
      content.addChild(summary);
      content.addChild(new Spacer(1));
      content.addChild(new Text(theme.fg("accent", theme.bold("任务列表")), 0, 0));
      content.addChild(list);
      content.addChild(new Spacer(1));
      content.addChild(new Text(theme.fg("muted", "↑↓ 浏览 · Enter 或 Esc 关闭"), 0, 0));

      const panelBorder = (left: string, right: string) => ({
        render: (width: number) => [
          theme.fg("borderAccent", `${left}${"─".repeat(Math.max(0, width - 2))}${right}`),
        ],
        invalidate: () => {},
      });
      const panelFrame = {
        render: (width: number) => {
          const innerWidth = Math.max(1, width - 2);
          const side = theme.fg("borderAccent", "│");
          return content.render(innerWidth).map((line) => `${side}${line}${side}`);
        },
        invalidate: () => content.invalidate(),
      };
      const container = new Container();
      container.addChild(panelBorder("┌", "┐"));
      container.addChild(panelFrame);
      container.addChild(panelBorder("└", "┘"));

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    }, {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "80%",
        minWidth: 50,
        maxHeight: "90%",
        margin: 1,
      },
    }).finally(() => {
      stopLiveRefresh?.();
      stopLiveRefresh = undefined;
    });
  }

  function formatWorkflowTimestamp(value: unknown, unavailableText: string) {
    return formatDisplayTimestamp(value, unavailableText);
  }

  function formatWorkflowDuration(milliseconds: number | undefined) {
    return formatDisplayDuration(milliseconds, "不可用（历史任务未记录有效的开始时间）");
  }

  function formatRunTimingReport(data: RunTimingEntryData = {}) {
    return formatRunTimingText(createRunTimingView(data));
  }

  function formatWorkflowTaskCompletion(task: ReturnType<typeof getWorkflowTask>) {
    return formatWorkflowTaskCompletionText(createWorkflowTaskCompletionView(task));
  }

  function formatWorkflowCompletion(
    workflowState: WorkflowState,
    finalTask?: ReturnType<typeof getWorkflowTask>,
  ) {
    return formatWorkflowCompletionText(createWorkflowCompletionView(workflowState, finalTask));
  }

  return {
    updateWorkflowStatus,
    acknowledgeWorkflowNotice,
    dispose,
    persistWorkflowState,
    persistWorkflowRecoveryDisposition,
    formatWorkflowState,
    formatWorkflowPauseSummary,
    formatWorkflowBlockNotice: (workflowState: WorkflowState) => {
      const lines = formatWorkflowBlockLines(workflowState);
      return lines.length > 0 ? lines.join("\n") : undefined;
    },
    showWorkflowProgress,
    formatWorkflowTimestamp,
    formatWorkflowDuration,
    formatRunTimingReport,
    formatWorkflowTaskCompletion,
    formatWorkflowCompletion,
  };
}

export type WorkflowReport = ReturnType<typeof createWorkflowReport>;
