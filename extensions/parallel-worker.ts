import { getPiInvocation } from "../src/gmc-client.js";
import {
  PARALLEL_BATCH_MAX_WORKERS,
  PARALLEL_RESULT_PROTOCOL,
  parseParallelWorkerResult,
} from "../src/parallel-batch.js";

export type ParallelWorkerSpec = {
  batchId: string;
  taskId: string;
  attemptId: string;
  baseCommit: string;
  cwd: string;
  task: string;
  files: string[];
  acceptanceCriteria: string[];
  model: string;
  thinkingLevel?: string;
};

type ExecResult = { code: number | null; stdout?: string; stderr?: string; killed?: boolean };
export const PARALLEL_WORKER_TIMEOUT_MS = 5 * 60 * 1000;
type Exec = (command: string, args: string[], options: { cwd: string; signal?: AbortSignal; timeout?: number }) => Promise<ExecResult>;

function diagnosticText(value: string | undefined) {
  if (!value?.trim()) return "";
  const redacted = value.trim().replace(/(authorization|api[-_]?key|token|password)\s*[:=]\s*\S+/gi, "$1=[redacted]");
  return redacted.length > 2048 ? `…${redacted.slice(-2048)}` : redacted;
}

function requiredText(value: unknown, label: string, max = 4096) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${label}过长`);
  return result;
}

function workerSpec(spec: ParallelWorkerSpec) {
  return {
    batchId: requiredText(spec.batchId, "batchId", 64),
    taskId: requiredText(spec.taskId, "taskId", 64),
    attemptId: requiredText(spec.attemptId, "attemptId", 128),
    baseCommit: requiredText(spec.baseCommit, "baseCommit", 128),
    cwd: requiredText(spec.cwd, "worker cwd", 4096),
    task: requiredText(spec.task, "worker task"),
    files: spec.files.map((file) => requiredText(file, "worker file", 1024)),
    acceptanceCriteria: spec.acceptanceCriteria.map((item) => requiredText(item, "acceptance criteria")),
    model: requiredText(spec.model, "worker model", 512),
    ...(spec.thinkingLevel ? { thinkingLevel: requiredText(spec.thinkingLevel, "thinkingLevel", 16) } : {}),
  };
}

export function buildParallelWorkerPrompt(spec: ParallelWorkerSpec) {
  const value = workerSpec(spec);
  return [
    "你是 Pi 并行批次中的独立开发测试 worker。",
    `批次：${value.batchId}；任务：${value.taskId}；attempt：${value.attemptId}；固定基线：${value.baseCommit}`,
    `当前工作目录是独立 worktree：${value.cwd}`,
    `允许修改的文件范围（只能修改这些路径及其子路径）：${value.files.join(", ")}`,
    `验收标准：${value.acceptanceCriteria.join("；")}`,
    "只在当前 worktree 工作。不要修改主工作区，不要调用 task_workflow 或 parallel_batch，不要创建 worktree，不要 commit、push 或删除工作区。",
    "先检查实际实现，再做最小正确修改；运行实际验证。若修改了允许范围外文件，必须报告阻塞，不得伪造完成。",
    `完成时只输出一个 JSON 对象，protocol 必须是 ${PARALLEL_RESULT_PROTOCOL}。允许的 key 只有 protocol、outcome、batchId、taskId、attemptId、baseCommit、completionSummary、implementationRationale、verification、changedFiles、reason；不要使用 status、state、success 等其他 key。complete 必须包含 batchId、taskId、attemptId、baseCommit、completionSummary、implementationRationale、非空 verification 数组和 changedFiles 数组；blocked 必须包含 reason。不要输出 Markdown、解释文字或其他 JSON。`,
    `用户任务：${value.task}`,
  ].join("\n\n");
}

function finalAssistantText(stdout: string) {
  const messages: Array<{ role?: string; stopReason?: string; errorMessage?: string; content?: Array<{ type?: string; text?: string }> }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "message_end" && event.message?.role === "assistant") {
        messages.push(event.message);
      } else if (event.type === "agent_end" && Array.isArray(event.messages)) {
        messages.push(...event.messages.filter((message: { role?: string }) => message?.role === "assistant"));
      }
    } catch {
      // Non-JSON diagnostics are ignored; the final structured result is still required.
    }
  }
  const message = messages.at(-1);
  const text = message?.content?.find((part) => part.type === "text")?.text;
  if (!text) {
    if (message?.errorMessage) throw new Error(`Pi worker provider 失败：${message.errorMessage}`);
    const stopReason = message?.stopReason && message.stopReason !== "pending" ? `（stopReason=${message.stopReason}）` : "";
    throw new Error(`Pi worker未返回最终 assistant 结果${stopReason}`);
  }
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

export async function runParallelWorker(
  exec: Exec,
  spec: ParallelWorkerSpec,
  signal?: AbortSignal,
  piInvocation: string | { command: string; args: string[] } = getPiInvocation(),
) {
  const value = workerSpec(spec);
  if (signal?.aborted) throw new Error("并行 worker 已取消");
  const args = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--approve",
    "--model", value.model,
    "--exclude-tools", "parallel_batch,task_workflow,switch_role",
    "--append-system-prompt",
    "最终回复必须只包含一个符合用户任务中 protocol 要求的 JSON 对象；不要输出 Markdown、解释文字或额外字段。",
  ];
  if (value.thinkingLevel) args.push("--thinking", value.thinkingLevel);
  args.push(buildParallelWorkerPrompt(value));
  const invocation = typeof piInvocation === "string"
    ? { command: piInvocation, args: [] }
    : piInvocation;
  const result = await exec(invocation.command, [...invocation.args, ...args], {
    cwd: value.cwd,
    signal,
    timeout: PARALLEL_WORKER_TIMEOUT_MS,
  });
  if (signal?.aborted) throw new Error("并行 worker 已取消");
  const diagnostic = diagnosticText(result.stderr);
  if (result.killed || result.code !== 0) {
    const reason = result.killed
      ? `被终止（可能是超时或取消，code=${result.code ?? "unknown"}）`
      : `退出失败（code=${result.code ?? "unknown"}）`;
    throw new Error(`Pi worker${reason}${diagnostic ? `；stderr：${diagnostic}` : ""}`);
  }
  let output;
  try {
    output = finalAssistantText(result.stdout ?? "");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${diagnostic ? `；stderr：${diagnostic}` : ""}`);
  }
  return parseParallelWorkerResult(output, {
    batchId: value.batchId,
    taskId: value.taskId,
    attemptId: value.attemptId,
    baseCommit: value.baseCommit,
  });
}

export async function runParallelWorkers(
  exec: Exec,
  specs: ParallelWorkerSpec[],
  signal?: AbortSignal,
) {
  if (!Array.isArray(specs) || specs.length === 0 || specs.length > PARALLEL_BATCH_MAX_WORKERS) {
    throw new Error(`并行 worker 数量必须在 1-${PARALLEL_BATCH_MAX_WORKERS} 之间`);
  }
  const controller = new AbortController();
  const abortController = () => controller.abort();
  if (signal) {
    if (signal.aborted) throw new Error("并行 worker 已取消");
    signal.addEventListener("abort", abortController, { once: true });
  }
  let cursor = 0;
  const results = new Array(specs.length);
  const workers = Array.from({ length: Math.min(PARALLEL_BATCH_MAX_WORKERS, specs.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= specs.length) return;
      results[index] = await runParallelWorker(exec, specs[index], controller.signal);
    }
  });
  try {
    const settled = await Promise.allSettled(workers);
    const failure = settled.find((item) => item.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
    return results;
  } finally {
    if (signal) signal.removeEventListener("abort", abortController);
  }
}
