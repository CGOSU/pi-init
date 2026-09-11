import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join, posix, relative, win32 } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentProfile, CollaborationDirs, ListedRun, SettledSubagent, SubagentRunRecord, SubagentTask, SubagentTerminationReason } from "./collaboration-types.ts";
import { resolveCollaborationDirs } from "./collaboration-paths.ts";
import { listRuns, updateRun, writeRun } from "./collaboration-runs.ts";
import { findSessionFile, lastAssistantText } from "./collaboration-session-tail.ts";

export const DEFAULT_COLLABORATION_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_CONFIGURED_TIMEOUT_MS = 1 * 1000;
const MAX_CONFIGURED_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const RUN_HEARTBEAT_MS = 5 * 1000;
const CHILD_EXTENSION = fileURLToPath(new URL("./collaboration-runtime.ts", import.meta.url));
const CMD_META_PATTERN = /[&|<>^%\r\n]/u;

type ExecResult = { code: number | null; stdout?: string; stderr?: string; killed?: boolean };
type Exec = (command: string, args: string[], options?: Record<string, unknown>) => Promise<ExecResult>;
type CliInvocationOptions = {
  platform?: string;
  command?: string;
  execPath?: string;
  argv1?: string;
  parentCwd?: string;
  comSpec?: string;
};
type CliInvocation = { command: string; args: string[] };
type PreparedCmdShimArgs = { args: string[]; cleanup: () => Promise<void> };

const activeControllers = new Map<string, AbortController>();
const terminationReasons = new Map<string, SubagentTerminationReason>();

function markTerminationReason(recordId: string, reason: SubagentTerminationReason): void {
  if (!terminationReasons.has(recordId)) terminationReasons.set(recordId, reason);
}

export function resolveCollaborationTimeoutMs(raw = process.env.PI_COLLAB_TIMEOUT_MS): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_COLLABORATION_TIMEOUT_MS;
  if (!/^\d+$/u.test(value)) {
    throw new Error("PI_COLLAB_TIMEOUT_MS 必须是毫秒正整数");
  }
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_CONFIGURED_TIMEOUT_MS || timeoutMs > MAX_CONFIGURED_TIMEOUT_MS) {
    throw new Error(`PI_COLLAB_TIMEOUT_MS 必须在 ${MIN_CONFIGURED_TIMEOUT_MS} 到 ${MAX_CONFIGURED_TIMEOUT_MS} 毫秒之间`);
  }
  return timeoutMs;
}

function normalizeTimeoutMs(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("共享协作 Agent timeoutMs 必须是正整数");
  return timeoutMs;
}

export function formatCollaborationTimeout(timeoutMs: number | undefined): string {
  if (!timeoutMs || timeoutMs < 60 * 1000) return `${timeoutMs ?? DEFAULT_COLLABORATION_TIMEOUT_MS} 毫秒`;
  const minutes = timeoutMs / (60 * 1000);
  return Number.isInteger(minutes) ? `${minutes} 分钟` : `${Math.round(minutes * 10) / 10} 分钟`;
}

function terminationError(reason: SubagentTerminationReason, timeoutMs: number): string {
  if (reason === "timeout") return `子 Agent 被终止：超过 ${formatCollaborationTimeout(timeoutMs)} 的总时限，终止结果不予验收`;
  if (reason === "cancelled") return "子 Agent 被终止：用户取消，终止结果不予验收";
  return "子 Agent 被终止：进程被外部终止，终止结果不予验收";
}

export interface SpawnBatch {
  batchRunId: string;
  records: SubagentRunRecord[];
}

export interface SpawnCallbacks {
  onSettled?: (result: SettledSubagent) => void;
  onBatchSettled?: (batch: SpawnBatch, results: SettledSubagent[]) => void;
}

function resolveCurrentPiCliScript(options: CliInvocationOptions, platform: string) {
  const candidate = (options.argv1 ?? process.argv[1] ?? "").trim();
  if (!candidate) return undefined;
  const pathApi = platform === "win32" ? win32 : posix;
  const resolved = pathApi.normalize(pathApi.isAbsolute(candidate)
    ? candidate
    : pathApi.resolve(options.parentCwd ?? process.cwd(), candidate));
  const normalized = resolved.replaceAll("\\", "/").toLowerCase();
  if (pathApi.basename(resolved).toLowerCase() !== "cli.js") return undefined;
  if (process.env.PI_CODING_AGENT !== "true" && !normalized.includes("/pi-coding-agent/")) return undefined;
  return resolved;
}

export function resolveCliInvocation(args: string[], options: CliInvocationOptions = {}): CliInvocation {
  const configured = (options.command ?? process.env.PI_CLI_COMMAND ?? "").trim();
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command: configured || "pi", args: [...args] };

  if (!configured) {
    const cliScript = resolveCurrentPiCliScript(options, platform);
    if (cliScript) return { command: options.execPath ?? process.execPath, args: [cliScript, ...args] };
  }

  const command = configured || "pi.cmd";
  if (!/\.(?:cmd|bat)$/iu.test(command)) return { command, args: [...args] };
  if (CMD_META_PATTERN.test(command)) {
    throw new Error("Windows cmd fallback 无法安全执行包含 shell 特殊字符的 Pi CLI 路径");
  }
  return {
    command: options.comSpec ?? process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", ...(command.includes(" ") ? ["call"] : []), command, ...args],
  };
}

function isCmdShimInvocation(invocation: CliInvocation) {
  return invocation.args[0] === "/d" && invocation.args[1] === "/s" && invocation.args[2] === "/c";
}

function relativeLaunchPath(cwd: string, file: string) {
  return relative(cwd, file).replaceAll("\\", "/");
}

export async function prepareCmdShimArgs(
  args: string[],
  cwd: string,
  systemPrompt: string,
  prompt: string,
): Promise<PreparedCmdShimArgs> {
  const tempDir = await mkdtemp(join(cwd, ".pi-init-collaboration-"));
  const systemFile = join(tempDir, "system-prompt.txt");
  const promptFile = join(tempDir, "task-prompt.txt");
  try {
    const systemIndex = args.indexOf("--append-system-prompt");
    if (systemIndex < 0 || systemIndex + 1 >= args.length) {
      throw new Error("Windows cmd fallback 缺少 --append-system-prompt 参数");
    }
    await Promise.all([writeFile(systemFile, systemPrompt, "utf8"), writeFile(promptFile, prompt, "utf8")]);
    const next = [...args];
    next[systemIndex + 1] = relativeLaunchPath(cwd, systemFile);
    next[next.length - 1] = `@${relativeLaunchPath(cwd, promptFile)}`;
    if (next.some((value) => CMD_META_PATTERN.test(value))) {
      throw new Error("Windows cmd fallback 参数包含无法安全转义的 shell 特殊字符");
    }
    let cleaned = false;
    return {
      args: next,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part) && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();
}

function parseAssistantOutput(stdout: string): { text?: string; error?: string; sawToolUse: boolean; sessionId?: string } {
  let text: string | undefined;
  let error: string | undefined;
  let sessionId: string | undefined;
  let sawToolUse = false;
  const consumeMessage = (value: unknown, eventStopReason?: unknown) => {
    if (!value || typeof value !== "object") return;
    const message = value as Record<string, unknown>;
    if (message.role !== "assistant") return;
    const stopReason = message.stopReason ?? eventStopReason;
    if (stopReason === "toolUse") {
      sawToolUse = true;
      return;
    }
    const messageText = extractText(message.content);
    if (stopReason === "error" || typeof message.errorMessage === "string") {
      error = typeof message.errorMessage === "string" ? message.errorMessage : "assistant response failed";
      text = messageText || error;
      return;
    }
    if (messageText) text = messageText;
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const event = value as Record<string, unknown>;
    if (event.type === "session") {
      const id = event.id ?? event.sessionId;
      if (typeof id === "string") sessionId = id;
    }
    if (event.type === "message" || event.type === "message_end") {
      consumeMessage(event.message, event.stopReason);
      continue;
    }
    if (event.type === "agent_end") {
      if (Array.isArray(event.messages)) {
        for (const message of event.messages) consumeMessage(message, event.stopReason);
      } else {
        consumeMessage(event.message, event.stopReason);
      }
    }
  }
  return { text, error, sawToolUse, sessionId };
}

function promptFor(task: SubagentTask, parent: string, name: string, profile: AgentProfile): string {
  const scope = task.files?.length ? `\n允许修改路径：${task.files.join(", ")}` : "";
  const checks = task.acceptanceCriteria?.length ? `\n验收标准：${task.acceptanceCriteria.join("；")}` : "";
  return [`你是 ${profile.role} 角色的协作子 Agent ${name}，父 Agent 是 ${parent}。`, "在当前共享工作目录完成任务。修改前先使用 agent_message reserve；不要修改其他 Agent 已预留路径。", "不要执行 commit、push 或删除/重置他人修改；失败时如实报告，完成时给出摘要和实际验证。", scope, checks, "", task.task].join("\n");
}

function createRecord(task: SubagentTask, index: number, batchRunId: string, ctx: ExtensionContext, name: string, parentAgent: string | undefined, profile: AgentProfile | undefined, timeoutMs: number): SubagentRunRecord {
  const now = new Date().toISOString();
  return {
    recordId: `${batchRunId}-${index + 1}`,
    batchRunId,
    taskIndex: index,
    parentAgent: parentAgent || process.env.PI_AGENT_NAME || "orchestrator",
    parentSessionId: typeof ctx.sessionManager.getSessionId === "function" ? ctx.sessionManager.getSessionId() : undefined,
    parentPid: process.pid,
    name,
    taskPreview: task.task.slice(0, 1000),
    requestedCwd: task.cwd,
    cwd: task.cwd || ctx.cwd,
    status: "launching",
    launchMode: "process",
    startedAt: now,
    lastSeenAt: now,
    timeoutMs,
    model: profile ? `${profile.provider}/${profile.model}` : ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
  };
}

async function runOne(
  pi: ExtensionAPI,
  dirs: CollaborationDirs,
  record: SubagentRunRecord,
  task: SubagentTask,
  ctx: ExtensionContext,
  timeoutMs: number,
  profile: AgentProfile,
  controllers: Map<string, AbortController> = activeControllers,
): Promise<SettledSubagent> {
  const controller = new AbortController();
  controllers.set(record.recordId, controller);
  updateRun(dirs, record.recordId, { status: "running", lastSeenAt: new Date().toISOString(), timeoutMs });
  const timeout = setTimeout(() => {
    markTerminationReason(record.recordId, "timeout");
    controller.abort();
  }, timeoutMs);
  const heartbeat = setInterval(() => {
    updateRun(dirs, record.recordId, { lastSeenAt: new Date().toISOString() });
  }, RUN_HEARTBEAT_MS);
  heartbeat.unref?.();
  let cleanupLaunchFiles: (() => Promise<void>) | undefined;
  try {
    const env = {
      ...process.env,
      PI_AGENT_NAME: record.name,
      PI_COLLAB_SUBAGENT_DEPTH: String(Number(process.env.PI_COLLAB_SUBAGENT_DEPTH || 0) + 1),
      ...(task.files?.length ? { PI_COLLAB_INITIAL_RESERVATIONS: JSON.stringify(task.files) } : {}),
    };
    const prompt = promptFor(task, record.parentAgent, record.name, profile);
    const args = ["--mode", "json", "-p", "--no-extensions", "--extension", CHILD_EXTENSION, "--model", `${profile.provider}/${profile.model}`, "--thinking", profile.thinkingLevel, "--tools", profile.allowedTools.join(","), "--append-system-prompt", profile.systemPrompt, prompt];
    const invocation = resolveCliInvocation(args);
    let launchArgs = invocation.args;
    if (isCmdShimInvocation(invocation)) {
      const prepared = await prepareCmdShimArgs(args, record.cwd, profile.systemPrompt, prompt);
      const prefixLength = invocation.args.length - args.length;
      launchArgs = [...invocation.args.slice(0, prefixLength), ...prepared.args];
      cleanupLaunchFiles = prepared.cleanup;
    }
    const result = await (pi.exec as unknown as Exec)(invocation.command, launchArgs, { cwd: record.cwd, signal: controller.signal, env });
    const stdout = String(result.stdout ?? "");
    const parsed = parseAssistantOutput(stdout);
    const sessionFile = parsed.sessionId ? findSessionFile(parsed.sessionId) : undefined;
    const output = parsed.text || (sessionFile ? lastAssistantText(sessionFile) : undefined);
    const terminationReason = terminationReasons.get(record.recordId)
      ?? (result.killed ? "killed" : controller.signal.aborted ? "cancelled" : undefined);
    if (terminationReason) {
      const final: Partial<SubagentRunRecord> = {
        status: "failed",
        terminationReason,
        sessionId: parsed.sessionId,
        sessionFile,
        outputPreview: output || stdout.slice(0, 2000) || String(result.stderr || "").slice(0, 2000),
        error: terminationError(terminationReason, timeoutMs),
        exitCode: result.code ?? undefined,
        completedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      };
      updateRun(dirs, record.recordId, final);
      return { record: { ...record, ...final } };
    }
    const error = parsed.error || (result.code !== 0 ? String(result.stderr || `Pi worker exited with code ${result.code}`) : undefined);
    const final: Partial<SubagentRunRecord> = {
      status: error || !output ? "failed" : "completed",
      sessionId: parsed.sessionId,
      sessionFile,
      outputPreview: output || String(result.stderr || "").slice(0, 2000),
      error: error || (!output ? (parsed.sawToolUse ? "未返回最终 assistant 结果（最后 stopReason=toolUse）" : "未返回最终 assistant 结果") : undefined),
      exitCode: result.code ?? undefined,
      completedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    updateRun(dirs, record.recordId, final);
    return { record: { ...record, ...final }, resultText: output };
  } catch (error) {
    const terminationReason = terminationReasons.get(record.recordId)
      ?? (controller.signal.aborted ? "cancelled" : undefined);
    const final: Partial<SubagentRunRecord> = {
      status: "failed",
      terminationReason,
      error: terminationReason ? terminationError(terminationReason, timeoutMs) : error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    updateRun(dirs, record.recordId, final);
    return { record: { ...record, ...final }, resultText: final.error };
  } finally {
    try {
      await cleanupLaunchFiles?.();
    } catch {
      // Temporary prompt cleanup must not mask the child result.
    }
    clearTimeout(timeout);
    clearInterval(heartbeat);
    controllers.delete(record.recordId);
    terminationReasons.delete(record.recordId);
  }
}

export function startSubagentBatch(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  tasks: SubagentTask[],
  callbacks: SpawnCallbacks = {},
  options: { timeoutMs?: number; dirs?: CollaborationDirs; parentAgent?: string; profile?: AgentProfile } = {},
): SpawnBatch {
  const dirs = options.dirs ?? resolveCollaborationDirs();
  if (!options.profile) throw new Error("共享子 Agent 必须绑定 pi-init role 配置");
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs ?? resolveCollaborationTimeoutMs());
  const batchRunId = `batch-${randomUUID()}`;
  const records = tasks.map((task, index) => createRecord(task, index, batchRunId, ctx, `subagent-${batchRunId.slice(-8)}-${index + 1}`, options.parentAgent, options.profile, timeoutMs));
  for (const record of records) writeRun(dirs, record);
  const batch = { batchRunId, records };
  void Promise.all(records.map((record, index) => runOne(pi, dirs, record, tasks[index]!, ctx, timeoutMs, options.profile!)))
    .then((settled) => {
      for (const result of settled) callbacks.onSettled?.(result);
      callbacks.onBatchSettled?.({ batchRunId, records: settled.map((item) => item.record) }, settled);
    });
  return batch;
}

export function cancelSubagents(dirs: CollaborationDirs, records: ListedRun[]): number {
  let cancelled = 0;
  for (const record of records) {
    if (record.status !== "launching" && record.status !== "running") continue;
    const control = activeControllers.get(record.recordId);
    if (control) {
      markTerminationReason(record.recordId, "cancelled");
      control.abort();
      cancelled += 1;
    }
    updateRun(dirs, record.recordId, { status: "failed", terminationReason: "cancelled", error: "子 Agent 被终止：用户取消", completedAt: new Date().toISOString() });
  }
  return cancelled;
}


export function activeSubagentCount(): number {
  return activeControllers.size;
}

export function abortAllSubagents(): number {
  let count = 0;
  for (const [recordId, controller] of activeControllers) {
    markTerminationReason(recordId, "cancelled");
    controller.abort();
    count += 1;
  }
  return count;
}

export function abortSubagent(recordId: string): boolean {
  const controller = activeControllers.get(recordId);
  if (!controller) return false;
  markTerminationReason(recordId, "cancelled");
  controller.abort();
  return true;
}

export function defaultCollaborationExtensionPath(): string {
  return join(homedir(), ".pi", "agent", "extensions", "collaborating-agents", "index.ts");
}
