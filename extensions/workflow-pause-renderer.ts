import { Text } from "@earendil-works/pi-tui";
import type { ReportTheme } from "./contracts.ts";
import type { WorkflowPauseAction, WorkflowPauseView } from "./workflow-pause-view.ts";

export function formatWorkflowPauseStep(step: WorkflowPauseAction): string {
  switch (step.kind) {
    case "verify-external-effects":
      return "先核对是否已产生外部副作用。";
    case "retry-task":
      return step.confirmUnknownOutcome
        ? `核对后显式执行 /pi-init workflow retry ${step.taskId} --confirm-unknown-outcome。`
        : `解决阻塞原因后执行 /pi-init workflow retry ${step.taskId}。`;
    case "replan":
      return step.route === "task_workflow"
        ? "如果需求或方案已改变，请让架构师通过 task_workflow(action=\"replan\") 重规划。"
        : "如果需求或方案已改变，请让架构师重规划。";
    case "resume":
      return "审阅后执行 /pi-init workflow resume。";
  }
}

export function formatWorkflowPauseBlockLines(view: WorkflowPauseView): string[] {
  return view.blockedTasks.flatMap((task) => [
    `阻塞任务：${task.taskId}`,
    `暂停原因：${task.reason}`,
    "恢复建议：",
    ...task.recoverySteps.map((step, index) => `  ${index + 1}. ${formatWorkflowPauseStep(step)}`),
  ]);
}

export function formatWorkflowPauseSummary(view: WorkflowPauseView): string {
  const lines = ["⏸ 工作流已暂停"];
  if (view.blockedTasks.length > 0) {
    lines.push(...formatWorkflowPauseBlockLines(view));
  } else {
    lines.push(`暂停原因：${view.reason.text}`);
    if (view.recoverySteps.length > 0) {
      lines.push("恢复建议：", ...view.recoverySteps.map((step, index) => `  ${index + 1}. ${formatWorkflowPauseStep(step)}`));
    }
  }
  return lines.join("\n");
}

export function renderWorkflowPauseResult(
  view: WorkflowPauseView,
  expanded: boolean,
  theme: ReportTheme,
  technicalDetails: string,
) {
  const progress = view.progress;
  const lines = [
    theme.fg("warning", theme.bold("⏸ 工作流已暂停")),
    theme.fg("muted", `进度：${progress.completed}/${progress.total}${progress.currentTaskId ? ` · 当前任务：${progress.currentTaskId}` : ""}`),
  ];
  if (view.blockedTasks.length > 0) {
    for (const task of view.blockedTasks) {
      lines.push(
        theme.fg("accent", theme.bold(`阻塞任务：${task.taskId}`)),
        theme.fg("warning", `暂停原因：${task.reason}`),
        theme.fg("accent", theme.bold("恢复建议：")),
        ...task.recoverySteps.map((step, index) => theme.fg("text", `  ${index + 1}. ${formatWorkflowPauseStep(step)}`)),
      );
    }
  } else {
    lines.push(theme.fg("warning", `暂停原因：${view.reason.text}`));
    if (view.recoverySteps.length > 0) {
      lines.push(
        theme.fg("accent", theme.bold("恢复建议：")),
        ...view.recoverySteps.map((step, index) => theme.fg("text", `  ${index + 1}. ${formatWorkflowPauseStep(step)}`)),
      );
    }
  }
  if (expanded) {
    lines.push(theme.fg("accent", theme.bold("技术详情：")), technicalDetails);
  } else {
    lines.push(theme.fg("muted", "展开结果以查看完整任务与身份状态。"));
  }
  return new Text(lines.join("\n"), 0, 0);
}
