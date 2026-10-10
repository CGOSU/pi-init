import { Text, type SelectItem } from "@earendil-works/pi-tui";
import { roleLabel } from "../src/roles.ts";
import type { ReportTheme } from "./contracts.ts";
import { formatWorkflowPauseBlockLines } from "./workflow-pause-renderer.ts";
import type { WorkflowStatusActivity, WorkflowStatusView } from "./workflow-status-view.ts";
import { formatWorkflowDuration, formatWorkflowTimestamp } from "./workflow-view-format.ts";
import { classifyWorkflowRecoveryError } from "../src/workflow-recovery-disposition.ts";

const ELAPSED_UNAVAILABLE = "不可用（工作流未记录有效的开始时间）";
const TASK_DURATION_UNAVAILABLE = "不可用（历史任务未记录有效的开始时间）";

export function workflowStatusActivityLabel(activity: WorkflowStatusActivity) {
  switch (activity) {
    case "awaiting-replan": return "等待架构师重规划";
    case "paused": return "已暂停";
    case "completed": return "已完成";
    case "cancelled": return "已取消";
    case "waiting-dispatch": return "等待调度";
    case "compaction-stalled": return "压缩等待异常";
    case "compacting": return "正在压缩上下文";
    case "dispatching": return "正在交接任务";
    case "waiting-task": return "等待任务启动";
    case "executing": return "任务执行中";
  }
}

function elapsedText(view: Extract<WorkflowStatusView, { kind: "workflow" }>) {
  return view.elapsed.kind === "available"
    ? formatWorkflowDuration(view.elapsed.milliseconds, ELAPSED_UNAVAILABLE)
    : ELAPSED_UNAVAILABLE;
}

function workflowIdentityLines(view: Extract<WorkflowStatusView, { kind: "workflow" }>) {
  const lines = [
    `当前基础动作身份 JSON（后续变更动作仍须满足状态限制）：${JSON.stringify(view.identity.action)}`,
  ];
  if (view.progress.currentTaskId) lines.push(`当前任务：${view.progress.currentTaskId}`);
  if (view.progress.currentTaskPosition !== undefined) {
    lines.push(`当前任务位置：第 ${view.progress.currentTaskPosition}/${view.progress.total} 项`);
  }
  if (view.identity.handoff && view.identity.handoffPhase) {
    const handoff = view.identity.handoff;
    lines.push(`当前任务结果身份 JSON（complete/block）：${JSON.stringify(handoff)}`);
    lines.push(`任务结果验收条件：${view.identity.handoffPhase === "executing"
      ? "handoff 正在执行；仍须使用当前 branch 与当前任务身份"
      : view.identity.handoffPhase === "queued"
        ? "仅匹配当前身份、任务角色及活动 branch 后允许补记开始并验收"
        : `当前阶段 ${view.identity.handoffPhase} 不可直接验收`}`);
    lines.push(`handoff：${handoff.handoffId} · attempt：${handoff.attemptId} · 阶段：${view.identity.handoffPhase}`);
  } else if (view.identity.handoffUnavailable && view.progress.currentTaskId) {
    lines.push("当前任务结果身份：不可用（缺少活动 handoff；不得提交 complete/block）");
  }
  if (view.identity.replan) {
    lines.push(`当前重规划身份 JSON（architect replan）：${JSON.stringify(view.identity.replan)}`);
  }
  return lines;
}

export function formatWorkflowStatusText(view: WorkflowStatusView) {
  if (view.kind === "no-workflow") return "当前没有活动工作流。";
  if (view.kind === "restore-error") {
    const classification = classifyWorkflowRecoveryError(view.code);
    const recoveryMessage = !classification.ok
      ? `当前不能隔离记录：${classification.error.message}`
      : classification.value.kind === "discardable"
        ? view.sourceEntryId
          ? `仅在项目受信任且 Agent 空闲时，核对原记录及潜在外部副作用后执行 /pi-init workflow discard-recovery ${view.sourceEntryId} --confirm-unknown-outcome。此操作保留原记录，不代表任务成功或已取消。`
          : "无法安全定位原 Session entry；当前不能隔离，请检查 Session branch 后重新加载。"
        : classification.value.kind === "recoverable"
          ? classification.value.message
          : `当前不允许隔离：${classification.value.message}`;
    return `无法恢复已保存的工作流（${view.code}）：${view.message}${view.sourceEntryId ? `\n原 Session entry ID：${view.sourceEntryId}` : ""}\n恢复建议：${recoveryMessage}`;
  }
  const lines = [
    `状态：${view.status} · workflowId：${view.identity.action.workflowId} · planVersion：${view.identity.action.planVersion} · recoveryGeneration：${view.identity.action.recoveryGeneration} · sessionId：${view.identity.action.sessionId}`,
    `阶段：${workflowStatusActivityLabel(view.activity)}`,
    `已完成任务（completed/total）：${view.progress.completed}/${view.progress.total}`,
    `总任务开始时间：${formatWorkflowTimestamp(view.startedAt, ELAPSED_UNAVAILABLE)}`,
    `总任务已运行时间：${elapsedText(view)}`,
    `规划：${view.planSummary}`,
    ...workflowIdentityLines(view),
  ];
  if (view.pauseCode) lines.push(`暂停类别：${view.pauseCode}`);
  if (view.taskPauseReason && view.pause.blockedTasks.length === 0) {
    lines.push(`暂停说明：${view.taskPauseReason}`);
  }
  lines.push(...formatWorkflowPauseBlockLines(view.pause));
  if (view.pendingRevision) {
    lines.push(`待处理 revision：${view.pendingRevision.revisionId}`);
    lines.push(`用户方向：${view.pendingRevision.direction}`);
  }
  lines.push(...view.tasks.map((task) => {
    const duration = task.status === "completed"
      ? ` · 耗时：${task.duration.kind === "available"
        ? formatWorkflowDuration(task.duration.milliseconds, TASK_DURATION_UNAVAILABLE)
        : TASK_DURATION_UNAVAILABLE}`
      : "";
    return `- [${task.status}] ${task.id} · ${task.role} · ${task.task}${duration}${task.completionSummary ? ` · ${task.completionSummary}` : ""}`;
  }));
  return lines.join("\n");
}

export function formatWorkflowStatusPanelSummary(view: WorkflowStatusView) {
  if (view.kind !== "workflow") return formatWorkflowStatusText(view);
  const lines = [
    `状态  ${workflowStatusActivityLabel(view.activity)} · workflowId  ${view.identity.action.workflowId} · planVersion  ${view.identity.action.planVersion} · recoveryGeneration  ${view.identity.action.recoveryGeneration}`,
    `已完成任务  ${view.progress.completed}/${view.progress.total}`,
    `总任务开始时间  ${formatWorkflowTimestamp(view.startedAt, ELAPSED_UNAVAILABLE)}`,
    `总任务已运行时间  ${elapsedText(view)}`,
    `规划  ${view.planSummary}`,
    ...(view.progress.currentTaskId ? [`当前任务  ${view.progress.currentTaskId}`] : []),
    ...(view.progress.currentTaskPosition !== undefined
      ? [`当前任务位置  第 ${view.progress.currentTaskPosition}/${view.progress.total} 项`]
      : []),
    ...(view.identity.handoff && view.identity.handoffPhase
      ? [`handoff  ${view.identity.handoff.handoffId} · attempt  ${view.identity.handoff.attemptId} · ${view.identity.handoffPhase}`]
      : []),
    ...(view.pauseCode ? [`暂停类别  ${view.pauseCode}`] : []),
    ...(view.taskPauseReason && view.pause.blockedTasks.length === 0
      ? [`暂停说明  ${view.taskPauseReason}`]
      : []),
    ...formatWorkflowPauseBlockLines(view.pause),
    ...(view.pendingRevision ? [
      `待处理 revision  ${view.pendingRevision.revisionId}`,
      `用户方向  ${view.pendingRevision.direction}`,
    ] : []),
  ];
  return lines.join("\n");
}

export function formatWorkflowControlCenterLabel(view: WorkflowStatusView) {
  if (view.kind === "no-workflow") return "无活动工作流";
  if (view.kind === "restore-error") return `工作流恢复失败（${view.code}）`;
  const currentPosition = view.progress.currentTaskPosition === undefined
    ? undefined
    : `当前第 ${view.progress.currentTaskPosition}/${view.progress.total} 项${view.progress.currentTaskId ? ` · ${view.progress.currentTaskId}` : ""}`;
  return [
    workflowStatusActivityLabel(view.activity),
    currentPosition,
    `已完成 ${view.progress.completed}/${view.progress.total}`,
  ].filter(Boolean).join(" · ");
}

export function workflowStatusTaskItems(view: WorkflowStatusView): SelectItem[] {
  if (view.kind === "workflow" && view.tasks.length > 0) {
    return view.tasks.map((task) => {
      const taskStatus = task.status === "completed"
        ? "✓ 已完成"
        : task.status === "in_progress"
          ? "● 进行中"
          : task.status === "blocked"
            ? "! 已阻塞"
            : "○ 待处理";
      const taskDuration = task.status === "completed"
        ? `耗时：${task.duration.kind === "available"
          ? formatWorkflowDuration(task.duration.milliseconds, TASK_DURATION_UNAVAILABLE)
          : TASK_DURATION_UNAVAILABLE}`
        : undefined;
      return {
        value: task.id,
        label: `${taskStatus} · ${task.id}`,
        description: [taskDuration, roleLabel(task.role), task.task, task.completionSummary].filter(Boolean).join(" · "),
      };
    });
  }
  return [{
    value: "close",
    label: view.kind === "restore-error" ? "工作流恢复失败" : "当前没有活动工作流",
    description: formatWorkflowStatusText(view),
  }];
}

export function workflowStatusBar(view: WorkflowStatusView): { text: string; color: "accent" | "warning" | "error" } | undefined {
  if (view.kind === "restore-error") {
    return { text: `工作流恢复失败（${view.code}）：${view.message}`, color: "error" };
  }
  if (view.kind === "no-workflow" || view.status === "completed" || view.status === "cancelled") return undefined;

  const elapsed = view.status === "running" && view.elapsed.kind === "available"
    ? shortDuration(view.elapsed.milliseconds)
    : undefined;
  const parts = [
    view.status === "running" ? "⏳" : "⏸",
    workflowStatusActivityLabel(view.activity),
    ...(view.progress.currentTaskPosition !== undefined
      ? [`当前项 ${view.progress.currentTaskPosition}/${view.progress.total}`]
      : []),
    elapsed ? `已运行 ${elapsed}` : undefined,
  ].filter(Boolean);
  return { text: parts.join(" · "), color: view.status === "running" ? "accent" : "warning" };
}

function shortDuration(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function renderWorkflowStatusResult(view: WorkflowStatusView, expanded: boolean, theme: ReportTheme) {
  if (view.kind !== "workflow") {
    const content = formatWorkflowStatusText(view);
    return new Text(theme.fg(view.kind === "restore-error" ? "error" : "muted", content), 0, 0);
  }
  const color = view.status === "running" ? "accent" : view.status === "completed" ? "success" : "warning";
  const icon = view.status === "running" ? "⏳" : view.status === "completed" ? "✓" : "⏸";
  const lines = [
    theme.fg(color, theme.bold(`${icon} 已完成 ${view.progress.completed}/${view.progress.total}`)),
    theme.fg("muted", `${workflowStatusActivityLabel(view.activity)}${view.progress.currentTaskPosition !== undefined ? ` · 当前项 ${view.progress.currentTaskPosition}/${view.progress.total}` : ""}${view.progress.currentTaskId ? ` · ${view.progress.currentTaskId}` : ""}`),
  ];
  if (expanded) {
    lines.push(theme.fg("accent", theme.bold("技术详情：")), formatWorkflowStatusText(view));
  } else {
    lines.push(theme.fg("muted", "展开结果以查看完整任务与身份状态。"));
  }
  return new Text(lines.join("\n"), 0, 0);
}
