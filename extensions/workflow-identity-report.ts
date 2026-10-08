import {
  workflowActionIdentity,
  workflowHandoffIdentity,
  workflowReplanIdentity,
} from "../src/workflow.js";
import type { WorkflowState } from "./runtime-state.ts";

export function formatWorkflowIdentityLines(workflowState: WorkflowState) {
  const lines = [
    `当前基础动作身份 JSON（后续变更动作仍须满足状态限制）：${JSON.stringify(workflowActionIdentity(workflowState))}`,
  ];
  if (workflowState.currentTaskId) lines.push(`当前任务：${workflowState.currentTaskId}`);
  if (workflowState.handoff) {
    lines.push(`当前任务结果身份 JSON（complete/block）：${JSON.stringify(workflowHandoffIdentity(workflowState))}`);
    lines.push(`任务结果验收条件：${workflowState.handoff.phase === "executing"
      ? "handoff 正在执行；仍须使用当前 branch 与当前任务身份"
      : workflowState.handoff.phase === "queued"
        ? "仅匹配当前身份、任务角色及活动 branch 后允许补记开始并验收"
        : `当前阶段 ${workflowState.handoff.phase} 不可直接验收`}`);
    lines.push(`handoff：${workflowState.handoff.handoffId} · attempt：${workflowState.handoff.attemptId} · 阶段：${workflowState.handoff.phase}`);
  } else if (workflowState.currentTaskId) {
    lines.push("当前任务结果身份：不可用（缺少活动 handoff；不得提交 complete/block）");
  }
  const replanIdentity = workflowReplanIdentity(workflowState);
  if (replanIdentity) lines.push(`当前重规划身份 JSON（architect replan）：${JSON.stringify(replanIdentity)}`);
  return lines;
}
