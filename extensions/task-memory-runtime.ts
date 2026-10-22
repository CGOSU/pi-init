import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { createTaskMemory, recordTaskObservations, checkpointTaskMemory, parseTaskMemory, parseTaskCheckpoint, taskMemoryScope, taskMemoryError, type TaskMemory, type TaskObservation, type TaskSourceVersion, parseTaskMemoryIdentity } from "../src/task-memory.ts";
import { workflowHandoffIdentity, workflowHandoffMessageOnBranch } from "../src/workflow-handoff.ts";
import type { WorkflowHandoffIdentity } from "../src/workflow-types.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { fingerprint } from "./handoff-tool-diagnostics.ts";

export const TASK_MEMORY_ENTRY = "pi-init-task-memory";
export const TASK_MEMORY_MESSAGE = "pi-init-task-memory-view";
type Entry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];
type MemoryBinding = { source: (message: object, ctx: ExtensionContext) => WorkflowHandoffIdentity | undefined };
export type TaskMemoryView = { status: "available" | "legacy" | "unavailable"; memory?: TaskMemory; reason?: string; applicability?: "historical" | "matches-checkpoint-files" | "changed" | "unverified"; evidence?: { id: string; text: string; truncated: boolean }[] };
function bounded(text: string, maximum: number) {
  if (text.length <= maximum) return text;
  const marker = "\n[中间省略；可按来源读取]\n";
  const head = Math.floor((maximum - marker.length) / 2);
  return text.slice(0, head) + marker + text.slice(-(maximum - marker.length - head));
}
function contentText(content: unknown) {
  return Array.isArray(content) ? content.filter(item => item && typeof item === "object" && item.type === "text" && typeof item.text === "string").map(item => item.text).join("\n") : "";
}
function sameIdentity(left: WorkflowHandoffIdentity, right: WorkflowHandoffIdentity) {
  return Object.keys(left).every(key => left[key as keyof WorkflowHandoffIdentity] === right[key as keyof WorkflowHandoffIdentity]);
}
export function createTaskMemoryRuntime(pi: ExtensionAPI, state: ExtensionRuntimeState, binding: MemoryBinding, onFailure?: (ctx: ExtensionContext) => void) {
  const failures = new Set<string>();
  const stopped = new Set<string>();
  function suspend(ctx: ExtensionContext) {
    const current = identity(ctx);
    if (!current) return;
    const key = scope(ctx, current);
    if (stopped.has(key)) return;
    stopped.add(key);
    onFailure?.(ctx);
  }
  function identity(ctx: ExtensionContext) {
    if (!ctx.isProjectTrusted()) return undefined;
    const workflow = state.workflowState;
    if (!workflow || workflow.sessionId !== ctx.sessionManager.getSessionId()) return undefined;
    const current = workflowHandoffIdentity(workflow);
    if (current) return current;
    const taskId = workflow.currentTaskId ?? workflow.tasks.find(item => item.status === "in_progress" || item.status === "blocked")?.id;
    if (!taskId) return undefined;
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type !== "custom" || entry.customType !== TASK_MEMORY_ENTRY) continue;
      const raw = entry.data && typeof entry.data === "object" ? entry.data as Record<string, unknown> : undefined;
      const saved = parseTaskMemoryIdentity(raw?.identity);
      if (saved && saved.sessionId === workflow.sessionId && saved.workflowId === workflow.workflowId
        && saved.planVersion === workflow.planVersion && saved.taskId === taskId) return saved;
    }
    return undefined;
  }
  function scope(ctx: ExtensionContext, current: WorkflowHandoffIdentity) { return JSON.stringify([ctx.cwd, current]); }
  function sourceObservation(branch: Entry[], id: string, current: WorkflowHandoffIdentity): TaskObservation | undefined {
    const resultIndex = branch.findIndex(entry => entry.id === id);
    const result = branch[resultIndex];
    if (!result || result.type !== "message" || result.message.role !== "toolResult") return undefined;
    const message = result.message;
    let ownerIndex = -1;
    for (let index = resultIndex - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some(part => part.type === "toolCall" && part.id === message.toolCallId)) { ownerIndex = index; break; }
    }
    if (ownerIndex < 0) return undefined;
    const anchor = branch.slice(0, ownerIndex).findLast(entry => entry.type === "custom_message" && entry.customType === "pi-init-workflow-task");
    if (!anchor || anchor.type !== "custom_message" || !anchor.details || typeof anchor.details !== "object") return undefined;
    const details = anchor.details as WorkflowHandoffIdentity;
    if (taskMemoryScope(details) !== taskMemoryScope(current)) return undefined;
    const owner = branch[ownerIndex];
    if (owner.type !== "message" || owner.message.role !== "assistant") return undefined;
    const call = owner.message.content.find(part => part.type === "toolCall" && part.id === message.toolCallId);
    if (!call || call.type !== "toolCall" || call.name === "task_workflow" || call.name === "switch_role") return undefined;
    const text = contentText(message.content);
    const data = message.details && typeof message.details === "object" ? message.details as Record<string, unknown> : {};
    const failed = message.isError || data.ok === false || typeof data.exitCode === "number" && data.exitCode !== 0;
    return { id, messageEntryId: owner.id, toolCallId: message.toolCallId, toolName: message.toolName,
      inputHash: fingerprint(call.arguments)!, outputHash: fingerprint(message.content)!, outcome: failed ? "tool-error" : "tool-ok",
      summary: bounded(text, 1024), truncated: text.length > 1024 };
  }
  function load(ctx: ExtensionContext, current: WorkflowHandoffIdentity) {
    const branch = ctx.sessionManager.getBranch();
    let memory = createTaskMemory(current);
    let found = false;
    let start = 0;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry.type !== "custom" || entry.customType !== TASK_MEMORY_ENTRY) continue;
      const raw = entry.data as Record<string, unknown> | undefined;
      if (!raw || !raw.identity || typeof raw.identity !== "object" || taskMemoryScope(raw.identity as WorkflowHandoffIdentity) !== taskMemoryScope(current)) continue;
      const parsed = parseTaskMemory(raw);
      if (!parsed) return taskMemoryError("TASK_MEMORY_SNAPSHOT_INVALID", "当前任务记忆快照损坏，不能跳过较新记录使用旧成果");
      for (const observation of parsed.observations) {
        const actual = sourceObservation(branch, observation.id, current);
        if (!actual || JSON.stringify(actual) !== JSON.stringify(observation)) return taskMemoryError("TASK_MEMORY_SOURCE_MISSING", "任务记忆来源不在当前branch或与原结果不一致");
      }
      memory = parsed; found = true;
      if (parsed.watermark) {
        const position = branch.findIndex(item => item.id === parsed.watermark);
        if (position < 0 || position >= index) return taskMemoryError("TASK_MEMORY_SOURCE_MISSING", "任务记忆来源水位不可核对");
        start = position + 1;
      }
      break;
    }
    const observations: TaskObservation[] = [];
    for (const entry of branch.slice(start)) {
      if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
      const observation = sourceObservation(branch, entry.id, current);
      if (observation) observations.push(observation);
    }
    const next = observations.length ? recordTaskObservations(memory, observations, observations.at(-1)!.id) : memory;
    return { memory: next, saved: memory, found };
  }
  function files(ctx: ExtensionContext, paths: string[]): TaskSourceVersion[] {
    if (paths.length > 16) return taskMemoryError("TASK_MEMORY_FILES_INVALID", "声明的相关文件不能超过16个");
    const root = realpathSync(ctx.cwd);
    return [...new Set(paths)].sort().map(path => {
      if (!path || isAbsolute(path)) return taskMemoryError("TASK_MEMORY_FILES_INVALID", "版本核对仅接受项目相对文件路径");
      const absolute = realpathSync(resolve(root, path));
      const local = relative(root, absolute);
      if (local === ".." || local.startsWith("../") || isAbsolute(local) || !statSync(absolute).isFile() || statSync(absolute).size > 4 * 1024 * 1024) return taskMemoryError("TASK_MEMORY_FILES_INVALID", "文件超出项目或核对边界，不能声称版本匹配");
      return { path: local, hash: createHash("sha256").update(readFileSync(absolute)).digest("hex") };
    });
  }
  function persist(ctx: ExtensionContext, memory: TaskMemory) {
    try { pi.appendEntry(TASK_MEMORY_ENTRY, memory); failures.delete(scope(ctx, memory.identity)); }
    catch {
      failures.add(scope(ctx, memory.identity));
      ctx.ui.notify("任务记忆保存失败；原工具结果保留，自动推进已停止，不会重跑。", "warning");
      suspend(ctx);
      return taskMemoryError("TASK_MEMORY_WRITE_FAILED", "任务记忆未保存，不能确认进展已持久化");
    }
  }
  function read(ctx: ExtensionContext, evidenceIds: string[] = []): TaskMemoryView {
    const current = identity(ctx);
    if (!current) return { status: "legacy" };
    try {
      if (failures.has(scope(ctx, current))) return { status: "unavailable", reason: "TASK_MEMORY_WRITE_FAILED" };
      const { memory, found } = load(ctx, current);
      let applicability: TaskMemoryView["applicability"] = "historical";
      if (memory.checkpoint?.files?.length) {
        try { applicability = JSON.stringify(files(ctx, memory.checkpoint.files.map(item => item.path))) === JSON.stringify(memory.checkpoint.files) ? "matches-checkpoint-files" : "changed"; }
        catch { applicability = "unverified"; }
      }
      if (evidenceIds.length > 8) return taskMemoryError("TASK_MEMORY_SOURCE_LIMIT", "一次最多读取8项来源");
      const evidence = evidenceIds.map(id => {
        if (!sourceObservation(ctx.sessionManager.getBranch(), id, current)) return taskMemoryError("TASK_MEMORY_SOURCE_MISSING", "只能读取当前任务在当前branch中的真实工具来源");
        const entry = ctx.sessionManager.getBranch().find(item => item.id === id);
        if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") return taskMemoryError("TASK_MEMORY_SOURCE_MISSING", "来源不可读取");
        const text = contentText(entry.message.content);
        return { id, text: bounded(text, 4096), truncated: text.length > 4096 };
      });
      return { status: found || memory.observations.length ? "available" : "legacy", memory, applicability, ...(evidence.length ? { evidence } : {}) };
    } catch (error) {
      return { status: "unavailable", reason: error && typeof error === "object" && "code" in error ? String(error.code) : "TASK_MEMORY_UNAVAILABLE" };
    }
  }
  function checkpoint(ctx: ExtensionContext, submitted: WorkflowHandoffIdentity, input: unknown, expectedRevision: number, paths: string[] = []) {
    const current = identity(ctx);
    const workflow = state.workflowState;
    const task = workflow?.tasks.find(item => item.id === current?.taskId);
    if (!current) return taskMemoryError("TASK_MEMORY_IDENTITY_INVALID", "任务记忆缺少当前可信身份");
    const blocked = !workflowHandoffMessageOnBranch(ctx, current) ? "branch-anchor"
      : !sameIdentity(current, submitted) ? "stale-identity"
      : workflow?.status !== "running" ? "workflow-not-running"
      : workflow.handoff?.phase !== "executing" ? "handoff-not-executing"
      : task?.status !== "in_progress" ? "task-not-executing"
      : workflow.workflowId !== current.workflowId || workflow.planVersion !== current.planVersion || workflow.recoveryGeneration !== current.recoveryGeneration ? "stale-workflow"
      : state.roleRecoveryPending || state.roleRecoveryPersistenceFailed || state.pendingWorkflowRecovery || state.workflowRestoreError ? "recovery-pending"
      : state.userStopRequested || state.runtimeDisposed || task.outcomeUnknown ? "execution-stopped"
      : state.activeRole?.role !== task.role ? "role-mismatch" : undefined;
    if (blocked) return taskMemoryError("TASK_MEMORY_IDENTITY_INVALID", "任务记忆只能由当前真实执行者登记，不能沿用旧身份或解除恢复门：" + blocked);
    const { memory } = load(ctx, current);
    if (expectedRevision !== memory.revision) return taskMemoryError("TASK_MEMORY_REVISION_STALE", "任务记忆已更新，先读取status中的最新revision，不覆盖较新进展");
    const parsed = parseTaskCheckpoint(input);
    if (!parsed) return taskMemoryError("TASK_MEMORY_CHECKPOINT_INVALID", "checkpoint缺少有效步骤、成果来源、剩余项或下一步");
    const ids = [...new Set(parsed.accomplished.flatMap(item => item.evidenceIds))];
    if (ids.length > 32) return taskMemoryError("TASK_MEMORY_CHECKPOINT_INVALID", "关键证据引用不能超过32项");
    const references = ids.map(id => memory.observations.find(item => item.id === id) ?? sourceObservation(ctx.sessionManager.getBranch(), id, current));
    if (references.some(item => !item)) return taskMemoryError("TASK_MEMORY_SOURCE_MISSING", "成果缺少当前branch的真实工具来源");
    const restored = references.some(item => !memory.observations.some(previous => previous.id === item!.id))
      ? { ...memory, observations: [...memory.observations.filter(item => !ids.includes(item.id)).slice(-16), ...references as TaskObservation[]] } : memory;
    const versions = paths.length ? files(ctx, paths) : memory.checkpoint?.files;
    const next = checkpointTaskMemory(restored, { ...parsed, files: versions });
    if (next !== memory) persist(ctx, { ...next, identity: current });
    return read(ctx);
  }
  pi.on("turn_end", (event: TurnEndEvent, ctx) => {
    if (!ctx.isProjectTrusted() || state.runtimeDisposed || state.userStopRequested) return;
    const current = identity(ctx);
    const bound = binding.source(event.message, ctx);
    if (!current || !bound || !sameIdentity(current, bound) || event.message.role !== "assistant" || event.toolResultEntryIds.length !== event.toolResults.length) return;
    try {
      const { memory, saved } = load(ctx, current);
      if (memory !== saved) persist(ctx, { ...memory, identity: current });
    } catch (error) {
      failures.add(scope(ctx, current));
      if (!(error && typeof error === "object" && "code" in error && error.code === "TASK_MEMORY_WRITE_FAILED")) suspend(ctx);
    }
  });
  function reset() { failures.clear(); stopped.clear(); }
  pi.on("session_start", reset); pi.on("session_tree", reset); pi.on("session_shutdown", reset);
  return { read, checkpoint, suspend };
}
export type TaskMemoryRuntime = ReturnType<typeof createTaskMemoryRuntime>;
export function taskMemoryText(view: TaskMemoryView) {
  if (view.status === "unavailable") return "[任务记忆不可用] " + view.reason + "；不能据此重跑副作用或声称成果已保存。";
  if (!view.memory || !view.memory.observations.length && !view.memory.checkpoint) return "";
  const memory = view.memory;
  return "[任务工作记忆；历史观察不是当前执行授权]\n" + JSON.stringify({ revision: memory.revision, progressRevision: memory.progressRevision, taskId: memory.identity.taskId,
    checkpoint: memory.checkpoint, observations: memory.observations, omittedObservations: memory.omittedObservations, applicability: view.applicability,
    evidence: view.evidence }) + "\n原结果可用 task_workflow(status, evidenceIds=[来源ID]) 定向读取，不必重跑。阶段完成后用checkpoint登记成果、剩余项和下一步；工具成功不等于测试或需求验收。matches-checkpoint-files仅表示声明文件与登记时一致，不证明完整依赖或测试当时版本。";
}
