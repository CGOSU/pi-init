export function workflowPauseReasonLabel(reason: string | undefined): string {
  switch (reason) {
    case "child-result-review":
      return "子流程结果待核实；父任务不会启动，核实后 resume 返回架构审阅";
    case "architecture-review":
      return "等待架构师审阅；审阅后执行 /pi-init workflow resume";
    case "handoff-outcome-unknown":
      return "任务执行结果未知；先核对可能的外部副作用";
    case "legacy-execution-outcome-unknown":
      return "旧任务执行结果未知；先核对可能的外部副作用";
    case "boundary-compaction-failed":
    case "boundary-compaction-interrupted":
      return "任务边界压缩未完成；检查后执行 /pi-init workflow resume 重试";
    case "task-blocked":
      return "任务受阻；请查看阻塞原因";
    case "workflow-replan":
      return "等待架构师重规划";
    default:
      return reason ? "暂停原因类型未识别；展开查看技术详情" : "暂停原因未记录。";
  }
}
