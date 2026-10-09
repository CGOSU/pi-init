import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, SelectList, Spacer, Text, type SelectItem } from "@earendil-works/pi-tui";
import { getWorkflowTask } from "../src/workflow.ts";
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
import type { ExtensionRuntimeState, WorkflowState } from "./runtime-state.ts";
import type { RoleRuntime } from "./role-runtime.ts";

function formatWorkflowBlockLines(workflowState: WorkflowState) {
  return formatWorkflowPauseBlockLines(createWorkflowPauseView(workflowState));
}
function formatWorkflowPauseSummary(workflowState: WorkflowState) {
  return renderWorkflowPauseSummary(createWorkflowPauseView(workflowState));
}
export type WorkflowReportDependencies = {
  pi: ExtensionAPI;
  roleRuntime: RoleRuntime;
};

export function createWorkflowReport(
  state: ExtensionRuntimeState,
  deps: WorkflowReportDependencies,
) {
  const WORKFLOW_STATUS_KEY = "pi-init-workflow";
  const WORKFLOW_STATUS_REFRESH_MS = 1000;
  let workflowStatusTimer: ReturnType<typeof setInterval> | undefined;
  let workflowStatusContext: ExtensionContext | undefined;
  function stopWorkflowStatusTimer() {
    if (workflowStatusTimer) clearInterval(workflowStatusTimer);
    workflowStatusTimer = undefined;
    workflowStatusContext = undefined;
  }
  function renderWorkflowStatus(ctx: ExtensionContext) {
    const status = workflowStatusBar(createCurrentWorkflowStatusView(state));
    ctx.ui.setStatus(
      WORKFLOW_STATUS_KEY,
      status ? ctx.ui.theme?.fg?.(status.color, status.text) ?? status.text : undefined,
    );
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
    if (ctx?.hasUI) ctx.ui.setStatus(WORKFLOW_STATUS_KEY, undefined);
  }

  function persistWorkflowState(next: WorkflowState, ctx: ExtensionContext) {
    deps.pi.appendEntry("pi-init-workflow", next);
    state.workflowState = next;
    state.workflowRestoreError = undefined;
    updateWorkflowStatus(ctx);
    return next;
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
    dispose,
    persistWorkflowState,
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
