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
  return typeof value === "string" && /^(?:新目标|插入目标|子目标|创建子流程|子流程|独立子目标|start child workflow|insert goal)\s*[：:]\s*\S/iu.test(value.normalize("NFKC").trim());
}
export function parseWorkflowControlInput(value: unknown): { stop: true; saveTodo: boolean } | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  const text = value.normalize("NFKC").trim();
  if (!text || /[`"“”‘’「」『』]/u.test(text) || /[?？]$/.test(text)) return undefined;
  if (/^(?:请|帮我|请你)?(?:实现|增加|添加|修复|研究|分析|测试|匹配|讨论|解释|如何|为什么|假设|如果)/u.test(text)
    || /^(?:please\s+)?(?:implement|add|fix|test|explain|discuss|how|why|if|when|after)\b/iu.test(text)
    || /(?:不要停止|别停止|不用停|不停止|don't stop|do not stop)/iu.test(text)
    || /(?:完成后|执行完|做完|结束后|修复后)/u.test(text)) return undefined;
  const clauses = text.split(/[，,。;；\n]/u);
  const savePattern = /(?:写(?:入|进|到)|输出到|保存到|整理到|记录到)\s*(?:todo(?:\.md)?|待办)/iu;
  const saveRequested = clauses.some(clause => savePattern.test(clause));
  const saveRefused = clauses.some(clause => savePattern.test(clause) && /(?:不要|别|不用|无需|禁止|不必|不准|不需要|do not|don't|never)/iu.test(clause));
  const saveTodo = saveRequested && !saveRefused;
  if (!saveTodo && /(?:实现|增加|添加|修复|研究|分析|测试|匹配|讨论|解释|如何|为什么|假设|如果)/u.test(text)) return undefined;
  const stop = /(?:^|[，,。;；\s]|之后|然后)(?:请|先|立即)?(?:停止(?:工作|执行)?|停下(?:工作)?|停一下|停|暂停(?:工作|执行)?|不要继续(?:执行|工作)?|stop(?: working| execution)?|pause(?: work)?)[。.!！\s]*$/iu.test(text);
  return stop || saveTodo ? { stop: true, saveTodo } : undefined;
}
