const CONTINUATION_INPUTS = new Set([
  "继续",
  "继续吧",
  "继续执行",
  "继续当前任务",
  "继续当前工作流",
  "继续当前计划",
  "继续现有任务",
  "继续现有计划",
  "继续原计划",
  "继续完成当前任务",
  "按原计划继续",
  "接着做",
  "接着执行",
  "接着完成当前任务",
  "恢复",
  "恢复工作流",
  "恢复原工作流",
  "resume",
  "resume workflow",
  "continue",
  "continue workflow",
  "continue plan",
  "continue working",
  "continue the current task",
  "continue the current workflow",
  "continue the existing plan",
  "resume current workflow",
  "resume current task",
]);

export function isWorkflowContinuationInput(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/[。.!！?？,，；;:：]+$/u, "")
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase();
  return CONTINUATION_INPUTS.has(normalized);
}

export function isExplicitWorkflowReplanInput(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.normalize("NFKC").trim();
  return /^(?:追加任务|补充任务|重规划|重新规划|修改(?:当前|现有|原有)?计划|调整(?:当前|现有|原有)?计划|replan(?:\s+workflow)?|revise plan)(?:[：:\s，,。.!！?？-]|$)/iu.test(normalized);
}

export function isExplicitWorkflowChildInput(value: unknown): boolean {
  return typeof value === "string" && /^(?:创建子流程|子流程|独立子目标|start child workflow)\s*[：:]\s*\S/iu.test(value.normalize("NFKC").trim());
}
