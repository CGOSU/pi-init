export function workflowPauseReasonLabel(reason: string | undefined): string {
  switch (reason) {
    case "architecture-review":
      return "等待架构师审阅；审阅后执行 /pi-init workflow resume";
    case "handoff-outcome-unknown":
      return "任务执行结果未知；先核对可能的外部副作用";
    case "legacy-execution-outcome-unknown":
      return "旧任务执行结果未知；先核对可能的外部副作用";
    case "task-blocked":
      return "任务受阻；请查看阻塞原因";
    case "workflow-replan":
      return "等待架构师重规划";
    default:
      return "暂停原因未记录；展开查看技术详情";
  }
}
