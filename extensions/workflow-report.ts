import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, SelectList, Spacer, Text, type SelectItem } from "@earendil-works/pi-tui";
import {
  getWorkflowExecutionBounds,
  getWorkflowExecutionDuration,
  getWorkflowTask,
  getWorkflowTaskDuration,
  workflowProgress,
} from "../src/workflow.js";
import { roleLabel } from "../src/roles.js";
import { getRunTimingDuration } from "../src/run-timing.js";
import type { ReportTheme, RunTimingEntryData } from "./contracts.ts";
import type { ExtensionRuntimeState, WorkflowState } from "./runtime-state.ts";
import { workflowExecutorLabel } from "./role-runtime.ts";
import type { RoleRuntime } from "./role-runtime.ts";

export type WorkflowReportDependencies = {
  pi: ExtensionAPI;
  roleRuntime: RoleRuntime;
};

export function createWorkflowReport(
  state: ExtensionRuntimeState,
  deps: WorkflowReportDependencies,
) {
  function updateWorkflowStatus(ctx: ExtensionContext) {
    deps.roleRuntime.refreshRoleStatus(ctx, state.roleModeStatus);
    ctx.ui.setStatus("pi-init-workflow", undefined);
  }

  function persistWorkflowState(next: WorkflowState, ctx: ExtensionContext) {
    state.workflowState = next;
    deps.pi.appendEntry("pi-init-workflow", next);
    updateWorkflowStatus(ctx);
    return next;
  }

  function formatWorkflowState(workflowState = state.workflowState) {
    if (!workflowState) return "当前没有活动工作流。";
    const progress = workflowProgress(workflowState);
    const lines = [
      `状态：${workflowState.status}`,
      `进度：${progress.completed}/${progress.total}`,
      `总任务开始时间：${formatWorkflowTimestamp(getWorkflowExecutionBounds(workflowState).startedAt, "不可用（工作流未记录有效的开始时间）")}`,
      `总任务已运行时间：${formatWorkflowElapsedDuration(workflowState)}`,
      `执行器：${workflowExecutorLabel(workflowState.executor)}`,
      `规划：${workflowState.plan.summary}`,
    ];
    if (workflowState.currentTaskId) lines.push(`当前任务：${workflowState.currentTaskId}`);
    if (workflowState.pauseReason) {
      lines.push(`暂停原因：${workflowState.pauseReason}${workflowState.taskPauseReason ? ` · ${workflowState.taskPauseReason}` : ""}`);
    }
    if (workflowState.pendingRevision) {
      lines.push(`待处理 revision：${workflowState.pendingRevision.revisionId}`);
      lines.push(`用户方向：${workflowState.pendingRevision.direction}`);
    }
    lines.push(
      ...workflowState.tasks.map((task) => {
        const taskDuration = formatWorkflowTaskDuration(task);
        return `- [${task.status}] ${task.id} · ${task.role} · ${task.task}`
          + (taskDuration ? ` · ${taskDuration}` : "")
          + (task.completionSummary ? ` · ${task.completionSummary}` : "");
      }),
    );
    return lines.join("\n");
  }

  async function showWorkflowProgress(ctx: ExtensionCommandContext) {
    if (!ctx.hasUI || ctx.mode !== "tui") {
      ctx.ui.notify(formatWorkflowState(), "info");
      return;
    }

    const workflowState = state.workflowState;
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const statusLabel = workflowState?.status === "running"
        ? "运行中"
        : workflowState?.status === "replanning"
          ? "等待架构师重规划"
          : workflowState?.status === "paused"
            ? "已暂停"
            : workflowState?.status === "completed"
              ? "已完成"
              : workflowState?.status === "cancelled"
                ? "已取消"
                : "无活动";
      const progress = workflowState ? workflowProgress(workflowState) : undefined;
      const taskItems: SelectItem[] = workflowState?.tasks.map((task) => {
        const taskStatus = task.status === "completed"
          ? "✓ 已完成"
          : task.status === "in_progress"
            ? "● 进行中"
            : task.status === "blocked"
              ? "! 已阻塞"
              : "○ 待处理";
        const taskDuration = formatWorkflowTaskDuration(task);
        return {
          value: task.id,
          label: `${taskStatus} · ${task.id}`,
          description: [
            taskDuration,
            roleLabel(task.role),
            task.task,
            task.completionSummary,
          ].filter(Boolean).join(" · "),
        };
      }) ?? [];
      if (taskItems.length === 0) {
        taskItems.push({ value: "close", label: "当前没有活动工作流", description: "按 Enter 或 Esc 关闭" });
      }

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

      const content = new Box(2, 1, (text) => theme.bg("customMessageBg", text));
      content.addChild(new Text(theme.bg("selectedBg", theme.fg("text", theme.bold(" 工作流任务进度 "))), 0, 0));
      content.addChild(new Spacer(1));
      content.addChild(new Text(theme.fg("text", workflowState
        ? [
            `状态  ${statusLabel}`,
            `进度  ${progress?.completed ?? 0}/${progress?.total ?? 0}`,
            `总任务开始时间  ${formatWorkflowTimestamp(getWorkflowExecutionBounds(workflowState).startedAt, "不可用（工作流未记录有效的开始时间）")}`,
            `总任务已运行时间  ${formatWorkflowElapsedDuration(workflowState)}`,
            `执行器  ${workflowExecutorLabel(workflowState.executor)}`,
            `规划  ${workflowState.plan.summary}`,
            ...(workflowState.currentTaskId ? [`当前任务  ${workflowState.currentTaskId}`] : []),
            ...(workflowState.pauseReason ? [`暂停原因  ${workflowState.pauseReason}${workflowState.taskPauseReason ? ` · ${workflowState.taskPauseReason}` : ""}`] : []),
            ...(workflowState.pendingRevision ? [
              `待处理 revision  ${workflowState.pendingRevision.revisionId}`,
              `用户方向  ${workflowState.pendingRevision.direction}`,
            ] : []),
          ].join("\n")
        : "当前没有活动工作流。"), 0, 0));
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
    });
  }

  function formatWorkflowTimestamp(value: unknown, unavailableText: string) {
    if (typeof value !== "number" || !Number.isFinite(value)) return unavailableText;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return unavailableText;
    const pad = (part: number) => String(part).padStart(2, "0");
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absoluteOffset = Math.abs(offsetMinutes);
    const offset = `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
  }

  function formatWorkflowDuration(milliseconds: number | undefined) {
    if (milliseconds === undefined) return "不可用（历史任务未记录有效的开始时间）";
    if (milliseconds < 1000) return `${milliseconds} 毫秒`;

    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (hours > 0) parts.push(`${hours} 小时`);
    if (minutes > 0) parts.push(`${minutes} 分钟`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds} 秒`);
    const remainingMilliseconds = milliseconds % 1000;
    if (remainingMilliseconds > 0) parts.push(`${remainingMilliseconds} 毫秒`);
    return parts.join(" ");
  }

  function getWorkflowElapsedDuration(workflowState: WorkflowState, now = Date.now()) {
    const { startedAt, completedAt } = getWorkflowExecutionBounds(workflowState);
    const endAt = workflowState.status === "completed"
      ? completedAt
      : workflowState.status === "running"
        ? now
        : workflowState.updatedAt;
    if (!Number.isFinite(startedAt) || !Number.isFinite(endAt) || endAt < startedAt) return undefined;
    return endAt - startedAt;
  }

  function formatWorkflowElapsedDuration(workflowState: WorkflowState) {
    const duration = getWorkflowElapsedDuration(workflowState);
    return duration === undefined
      ? "不可用（工作流未记录有效的开始时间）"
      : formatWorkflowDuration(duration);
  }

  function formatWorkflowTaskDuration(task: WorkflowState["tasks"][number]) {
    return task.status === "completed"
      ? `耗时：${formatWorkflowDuration(getWorkflowTaskDuration(task))}`
      : undefined;
  }

  function formatRunTimingDuration(milliseconds: number | undefined) {
    return milliseconds === undefined
      ? "不可用（无效或不完整的时间戳）"
      : formatWorkflowDuration(milliseconds);
  }

  function runTimingSourceLabel(source: unknown) {
    if (source === "interactive") return "交互式输入";
    if (source === "rpc") return "RPC 输入";
    return "未知来源";
  }

  function formatRunTimingReport(data: RunTimingEntryData = {}) {
    return [
      "普通执行时间报告",
      `来源：${runTimingSourceLabel(data.source)}`,
      `开始时间：${formatWorkflowTimestamp(data.startedAt, "不可用（无效的开始时间）")}`,
      `结束时间：${formatWorkflowTimestamp(data.completedAt, "不可用（无效的结束时间）")}`,
      `总耗时：${formatRunTimingDuration(getRunTimingDuration(data))}`,
      "计时口径：从本次外部输入触发的首次 agent_start 到最终 agent_settled；仅表示本次 Agent 执行，不代表工作流任务或业务任务已完成。",
    ].join("\n");
  }

  function styleReportText(report: string, theme: ReportTheme) {
    return report.split("\n").map((line, index) => {
      if (index === 0) return theme.fg("accent", theme.bold(`◆ ${line}`));
      if (line.startsWith("总耗时：") || line.startsWith("整体总耗时：")) return theme.fg("warning", theme.bold(line));
      if (
        line.startsWith("摘要：") ||
        line.startsWith("目标：") ||
        line.startsWith("进度：") ||
        line.startsWith("任务摘要：") ||
        line.startsWith("验证：")
      ) return theme.fg("success", theme.bold(line));
      if (line.startsWith("验证结果：") || line.startsWith("汇总验证：")) {
        return theme.fg("success", theme.bold(line));
      }
      if (
        line.startsWith("冻结时间：") ||
        line.startsWith("开始时间：") ||
        line.startsWith("结束时间：") ||
        line.startsWith("实际开始时间：")
      ) return theme.fg("accent", line);
      if (line.startsWith("计时口径：")) return theme.fg("dim", line);
      if (line.startsWith("- ")) return theme.fg("muted", line);
      return theme.fg("text", line);
    }).join("\n");
  }

  function formatWorkflowTaskCompletion(task: ReturnType<typeof getWorkflowTask>) {
    if (!task) throw new Error("无法生成不存在的工作流任务完成报告");
    const verification = task.verification?.map((item) => `- ${item}`).join("\n") ?? "- 无";
    return [
      "任务完成报告",
      `任务：${task.id} · ${task.task}`,
      `角色：${roleLabel(task.role)}`,
      `开始时间：${formatWorkflowTimestamp(task.startedAt, "不可用（历史任务未记录开始时间）")}`,
      `结束时间：${formatWorkflowTimestamp(task.completedAt, "不可用（任务未记录结束时间）")}`,
      `总耗时：${formatWorkflowDuration(getWorkflowTaskDuration(task))}`,
      `摘要：${task.completionSummary ?? "无"}`,
      `验证：\n${verification}`,
    ].join("\n");
  }

  function formatWorkflowExecutionDuration(workflowState: WorkflowState) {
    const duration = getWorkflowExecutionDuration(workflowState);
    return duration === undefined
      ? "不可用（工作流缺少有效的整体开始或结束时间）"
      : formatWorkflowDuration(duration);
  }

  function formatWorkflowCompletion(workflowState: WorkflowState) {
    const progress = workflowProgress(workflowState);
    const bounds = getWorkflowExecutionBounds(workflowState);
    const taskSummaries = workflowState.tasks
      .map((task) => `- ${task.id}：${task.completionSummary ?? "无"}`)
      .join("\n") || "- 无";
    const verification = workflowState.tasks
      .flatMap((task) => (task.verification ?? []).map((item) => `- ${task.id}：${item}`))
      .join("\n") || "- 无";

    return [
      "工作流完成报告",
      `目标：${workflowState.plan.summary}`,
      `进度：${progress.completed}/${progress.total}`,
      "任务摘要：",
      taskSummaries,
      `开始时间：${formatWorkflowTimestamp(bounds.startedAt, "不可用（工作流未记录有效的开始时间）")}`,
      `结束时间：${formatWorkflowTimestamp(bounds.completedAt, "不可用（工作流未记录有效的结束时间）")}`,
      `总耗时：${formatWorkflowExecutionDuration(workflowState)}`,
      "验证：",
      verification,
    ].join("\n");
  }

  return {
    updateWorkflowStatus,
    persistWorkflowState,
    formatWorkflowState,
    showWorkflowProgress,
    formatWorkflowTimestamp,
    formatWorkflowDuration,
    formatRunTimingReport,
    styleReportText,
    formatWorkflowTaskCompletion,
    formatWorkflowCompletion,
  };
}

export type WorkflowReport = ReturnType<typeof createWorkflowReport>;
