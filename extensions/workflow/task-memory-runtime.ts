import { workflowHandoffMessageOnBranch } from "./workflow-session-adapter.ts";
import { WORKFLOW_TASK_MESSAGE_TYPE } from "../../src/workflow-protocol.ts";
import { isRecord, recordOrEmpty } from "../../src/value-guards.ts";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { applyParsedTaskCheckpoint, createTaskMemory, recordTaskObservations, parseTaskMemory, parseTaskCheckpoint, taskMemoryScope, taskMemoryError, type TaskMemory, type TaskObservation, type TaskSourceVersion, parseTaskMemoryIdentity } from "../../src/task-memory.ts";
import { workflowHandoffIdentity } from "../../src/workflow-handoff.ts";
import type { WorkflowHandoffIdentity } from "../../src/workflow-types.ts";
import { firstPolicyMatch, hasRecoveryGate, onEvents, type RuntimeStateView } from "../runtime-state.ts";
import { fingerprint } from "../diagnostics/handoff-tool-diagnostics.ts";
import { TASK_MEMORY_ENTRY, TASK_MEMORY_MESSAGE, TASK_MEMORY_LIMITS, TASK_OBSERVATION_DERIVATION } from "../../src/task-memory-protocol.ts";
import type { TaskMemoryParseResult } from "../../src/task-memory-parsing.ts";

type Entry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];
type MemoryBinding = { source: (message: object, ctx: ExtensionContext) => WorkflowHandoffIdentity | undefined };
export type TaskMemoryView = { status: "available" | "legacy" | "unavailable"; memory?: TaskMemory; reason?: string; applicability?: "historical" | "matches-checkpoint-files" | "changed" | "unverified"; evidence?: TaskEvidence[] };
function bounded(text: string, maximum: number) {
  if (text.length <= maximum) return text;
  const marker = "\n[中间省略；可按来源读取]\n";
  const head = Math.floor((maximum - marker.length) / 2);
  return text.slice(0, head) + marker + text.slice(-(maximum - marker.length - head));
}
export function contentText(content: unknown) {
  return Array.isArray(content) ? content.filter(item => item && typeof item === "object" && item.type === "text" && typeof item.text === "string").map(item => item.text).join("\n") : "";
}
function taskMemoryIdentityMatches(left: WorkflowHandoffIdentity, right: WorkflowHandoffIdentity) {
  return Object.keys(left).every(key => left[key as keyof WorkflowHandoffIdentity] === right[key as keyof WorkflowHandoffIdentity]);
}
function failedReceipt(value: unknown) {
  if (!isRecord(value)) return false;
  return value.status === "error" || value.status === "unfinished" || value.isError === true || value.ok === false
    || ["exitCode", "exit_code"].some(key => typeof value[key] === "number" && value[key] !== 0);
}
/** The one failure rule for observation outcome, checkpoint progress and verification sources. */
export function toolResultFailed(message: { isError?: unknown; details?: unknown; nestedCalls?: unknown }) {
  const details = recordOrEmpty(message.details);
  const nestedCalls = message.nestedCalls;
  const calls = [...(isRecord(nestedCalls) && Array.isArray(nestedCalls.calls) ? nestedCalls.calls : []), ...(Array.isArray(details.calls) ? details.calls : [])];
  return message.isError === true || failedReceipt(details) || calls.some(failedReceipt);
}
function excludedProgressSources(branch: Entry[]) {
  const excluded = new Set<string>();
  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "toolResult" && toolResultFailed(entry.message)) excluded.add(entry.id);
  }
  return excluded;
}
// SDK-assigned identity of a source; stable across plugin versions, unlike derived summaries and fingerprints.
const OBSERVATION_SOURCE_FIELDS = ["id", "messageEntryId", "toolCallId", "toolName"] as const;
function sameObservationSource(actual: TaskObservation, expected: TaskObservation) {
  return OBSERVATION_SOURCE_FIELDS.every(key => actual[key] === expected[key]);
}
export function createTaskMemoryRuntime(pi: ExtensionAPI, state: RuntimeStateView, binding: MemoryBinding, onFailure?: (ctx: ExtensionContext) => void, historicalEvidence?: (ctx: ExtensionContext, id: string, dependencies: string[]) => TaskEvidence | undefined, onProgress?: (ctx: ExtensionContext) => void) {
  const failures = new Set<string>();
  const stopped = new Set<string>();
  function suspend(ctx: ExtensionContext) {
    const resolved = identity(ctx);
    const key = resolved.ok ? resolved.value && scope(ctx, resolved.value)
      : JSON.stringify([ctx.cwd, ctx.sessionManager.getSessionId(), state.workflowState?.workflowId, state.workflowState?.planVersion, state.workflowState?.recoveryGeneration, state.workflowState?.currentTaskId]);
    if (!key || stopped.has(key)) return;
    stopped.add(key);
    onFailure?.(ctx);
  }
  function identity(ctx: ExtensionContext): TaskMemoryParseResult<WorkflowHandoffIdentity | undefined> {
    const workflow = ctx.isProjectTrusted() ? state.workflowState : undefined;
    if (!workflow || workflow.sessionId !== ctx.sessionManager.getSessionId()) return { ok: true, value: undefined };
    const current = workflowHandoffIdentity(workflow);
    if (current) return { ok: true, value: current };
    const taskId = workflow.currentTaskId ?? workflow.tasks.find(item => item.status === "in_progress" || item.status === "blocked")?.id;
    if (!taskId) return { ok: true, value: undefined };
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type !== "custom" || entry.customType !== TASK_MEMORY_ENTRY) continue;
      const raw = isRecord(entry.data) && isRecord(entry.data.identity) ? entry.data.identity : undefined;
      if (!raw || raw.sessionId !== workflow.sessionId || raw.workflowId !== workflow.workflowId
        || raw.planVersion !== workflow.planVersion || raw.taskId !== taskId) continue;
      return parseTaskMemoryIdentity(raw);
    }
    return { ok: true, value: undefined };
  }
  function scope(ctx: ExtensionContext, current: WorkflowHandoffIdentity) { return JSON.stringify([ctx.cwd, current]); }
  const sourceObservation = readTaskSourceObservation;
  // Same derivation: compare exactly, so an edited summary or outcome is rejected.
  // Older/unknown derivation: match the SDK identity only and return the re-derived observation,
  // so a plugin upgrade never turns a live task's memory into "source missing".
  function verifyObservations(branch: Entry[], items: Array<{ id: string; expected: TaskObservation | undefined }>, current: WorkflowHandoffIdentity, errorMessage: string, derivation: number | undefined, cache = new Map<string, TaskObservation | undefined>()): TaskObservation[] {
    const exact = derivation === TASK_OBSERVATION_DERIVATION;
    return items.map(({ id, expected }) => {
      if (!cache.has(id)) cache.set(id, sourceObservation(branch, id, current));
      const actual = cache.get(id);
      if (!actual || !expected || !(exact ? JSON.stringify(actual) === JSON.stringify(expected) : sameObservationSource(actual, expected))) {
        return taskMemoryError("TASK_MEMORY_SOURCE_MISSING", errorMessage);
      }
      return actual;
    });
  }
  function load(ctx: ExtensionContext, current: WorkflowHandoffIdentity) {
    const branch = ctx.sessionManager.getBranch();
    let memory = createTaskMemory(current);
    let found = false;
    let start = 0;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      const raw = entry.type === "custom" && entry.customType === TASK_MEMORY_ENTRY ? entry.data as Record<string, unknown> | undefined : undefined;
      if (!raw?.identity || typeof raw.identity !== "object" || taskMemoryScope(raw.identity as WorkflowHandoffIdentity) !== taskMemoryScope(current)) continue;
      const parsed = parseTaskMemory(raw);
      if (!parsed.ok) return taskMemoryError("TASK_MEMORY_SNAPSHOT_INVALID", "当前任务记忆快照损坏，不能跳过较新记录使用旧成果；" + parsed.code + "：" + parsed.message);
      const verified = verifyObservations(branch, parsed.value.observations.map(item => ({ id: item.id, expected: item })), current, "任务记忆来源不在当前branch或与原结果不一致", parsed.value.derivation);
      memory = { ...parsed.value, observations: verified }; found = true;
      if (memory.watermark) {
        const position = branch.findIndex(item => item.id === memory.watermark);
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
    return { memory: next, saved: memory, found, unsaved: observations.length };
  }
  function files(ctx: ExtensionContext, paths: string[]): TaskSourceVersion[] {
    if (paths.length > TASK_MEMORY_LIMITS.files) return taskMemoryError("TASK_MEMORY_FILES_INVALID", "声明的相关文件不能超过16个");
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
    try { pi.appendEntry(TASK_MEMORY_ENTRY, { ...memory, derivation: TASK_OBSERVATION_DERIVATION }); failures.delete(scope(ctx, memory.identity)); }
    catch {
      failures.add(scope(ctx, memory.identity));
      ctx.ui.notify("任务记忆保存失败；原工具结果保留，自动推进已停止，不会重跑。", "warning");
      suspend(ctx);
      return taskMemoryError("TASK_MEMORY_WRITE_FAILED", "任务记忆未保存，不能确认进展已持久化");
    }
  }
  function fileApplicability(ctx: ExtensionContext, memory: TaskMemory): TaskMemoryView["applicability"] {
    if (!memory.checkpoint?.files?.length) return "historical";
    try { return JSON.stringify(files(ctx, memory.checkpoint.files.map(item => item.path))) === JSON.stringify(memory.checkpoint.files) ? "matches-checkpoint-files" : "changed"; }
    catch { return "unverified"; }
  }
  function read(ctx: ExtensionContext, evidenceIds: string[] = []): TaskMemoryView {
    const resolved = identity(ctx);
    if (!resolved.ok) return { status: "unavailable", reason: "TASK_MEMORY_SNAPSHOT_INVALID" };
    const current = resolved.value;
    if (!current) return { status: "legacy" };
    try {
      if (failures.has(scope(ctx, current))) return { status: "unavailable", reason: "TASK_MEMORY_WRITE_FAILED" };
      const { memory, found } = load(ctx, current);
      const applicability = fileApplicability(ctx, memory);
      if (evidenceIds.length > TASK_MEMORY_LIMITS.evidencePerRequest) return taskMemoryError("TASK_MEMORY_SOURCE_LIMIT", "一次最多读取8项来源");
      const branch = ctx.sessionManager.getBranch();
      const task = state.workflowState?.tasks.find(item => item.id === current.taskId);
      const evidence = evidenceIds.map(id => {
        const dependency = state.workflowState?.tasks.find(source => source.status === "completed" && task?.dependsOn?.includes(source.id) && source.verificationEvidenceIds?.includes(id));
        const own = sourceObservation(branch, id, current);
        const source = own ?? (dependency ? sourceObservation(branch, id, { ...current, taskId: dependency.id }, true) : undefined);
        if (!source) {
          const historical = historicalEvidence?.(ctx, id, task?.dependsOn ?? []);
          if (historical) return historical;
          return taskMemoryError("TASK_MEMORY_SOURCE_MISSING", "只能读取当前任务或已完成直接依赖声明的真实验证来源；旧结果不构成当前执行授权");
        }
        const entry = branch.find(item => item.id === id);
        if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") return taskMemoryError("TASK_MEMORY_SOURCE_MISSING", "来源不可读取");
        const text = contentText(entry.message.content);
        return { id, text: bounded(text, 4096), truncated: text.length > 4096, sourceTaskId: own ? current.taskId : dependency!.id, historical: true as const };
      });
      return { status: found || memory.observations.length ? "available" : "legacy", memory, applicability, ...(evidence.length ? { evidence } : {}) };
    } catch (error) {
      return { status: "unavailable", reason: error && typeof error === "object" && "code" in error ? String(error.code) : "TASK_MEMORY_UNAVAILABLE" };
    }
  }
  function checkpointHistory(ctx: ExtensionContext, current: WorkflowHandoffIdentity) {
    const branch = ctx.sessionManager.getBranch();
    const history: TaskMemory[] = [];
    const sources = new Map<string, TaskObservation | undefined>();
    for (const entry of branch) {
      const raw = entry.type === "custom" && entry.customType === TASK_MEMORY_ENTRY ? entry.data as Record<string, unknown> | undefined : undefined;
      if (!raw?.identity || typeof raw.identity !== "object" || taskMemoryScope(raw.identity as WorkflowHandoffIdentity) !== taskMemoryScope(current)) continue;
      const parsed = parseTaskMemory(raw);
      if (!parsed.ok) return taskMemoryError("TASK_MEMORY_SNAPSHOT_INVALID", "当前任务的历史记忆快照损坏，无法核对已登记进展；" + parsed.code + "：" + parsed.message);
      const memory = parsed.value;
      if (!memory.checkpoint) continue;
      const verified = new Map(verifyObservations(
        branch,
        memory.checkpoint.accomplished.flatMap(item => item.evidenceIds).map(id => ({ id, expected: memory.observations.find(item => item.id === id) })),
        current,
        "历史进展来源不在当前branch或与原结果不一致",
        memory.derivation,
        sources,
      ).map(item => [item.id, item]));
      // Compare progress against re-derived sources: a fingerprint change must not look like a new fact.
      history.push({ ...memory, observations: memory.observations.map(item => verified.get(item.id) ?? item) });
    }
    return history;
  }
  function checkpoint(ctx: ExtensionContext, submitted: WorkflowHandoffIdentity, input: unknown, expectedRevision: number | undefined, paths: string[] = []) {
    const resolved = identity(ctx);
    if (!resolved.ok) return taskMemoryError(resolved.code, resolved.message);
    const current = resolved.value;
    const workflow = state.workflowState;
    const task = workflow?.tasks.find(item => item.id === current?.taskId);
    if (!current) return taskMemoryError("TASK_MEMORY_IDENTITY_INVALID", "任务记忆缺少当前可信身份");
    const blocked = firstPolicyMatch([
      [!workflowHandoffMessageOnBranch(ctx, current), "branch-anchor"],
      [!taskMemoryIdentityMatches(current, submitted), "stale-identity"],
      [workflow?.status !== "running", "workflow-not-running"],
      [workflow?.handoff?.phase !== "executing", "handoff-not-executing"],
      [task?.status !== "in_progress", "task-not-executing"],
      [workflow?.workflowId !== current.workflowId || workflow?.planVersion !== current.planVersion || workflow?.recoveryGeneration !== current.recoveryGeneration, "stale-workflow"],
      [hasRecoveryGate(state), "recovery-pending"],
      [state.userStopRequested || state.runtimeDisposed || task?.outcomeUnknown, "execution-stopped"],
      [state.activeRole?.role !== task?.role, "role-mismatch"],
    ]);
    if (blocked) return taskMemoryError("TASK_MEMORY_IDENTITY_INVALID", "任务记忆只能由当前真实执行者登记，不能沿用旧身份或解除恢复门：" + blocked);
    const { memory, found } = load(ctx, current);
    const revisionError = firstPolicyMatch([
      [expectedRevision === undefined, ["TASK_MEMORY_REVISION_REQUIRED", "checkpoint缺少expectedMemoryRevision；当前可用expectedMemoryRevision=" + memory.revision + "。提交时仍会校验版本，不必为缺失字段重复查询status。"] as const],
      [!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0, ["TASK_MEMORY_REVISION_INVALID", "expectedMemoryRevision必须是非负整数"] as const],
      [expectedRevision !== memory.revision, ["TASK_MEMORY_REVISION_STALE", "任务记忆已更新，checkpoint未保存；按需一次task_workflow(action=\"status\", detail=\"full\")核对最新checkpoint、剩余工作与revision，合并仍有效的进展后再提交，不只替换revision覆盖较新进展。"] as const],
    ]);
    if (revisionError) return taskMemoryError(revisionError[0], revisionError[1]);
    const parsed = parseTaskCheckpoint(input);
    if (!parsed.ok) return taskMemoryError(parsed.code, parsed.message);
    const ids = [...new Set(parsed.value.accomplished.flatMap(item => item.evidenceIds))];
    if (ids.length > TASK_MEMORY_LIMITS.pinnedObservations) return taskMemoryError("TASK_MEMORY_CHECKPOINT_INVALID", "关键证据引用不能超过32项");
    const references = ids.map(id => memory.observations.find(item => item.id === id) ?? sourceObservation(ctx.sessionManager.getBranch(), id, current));
    if (references.some(item => !item)) return taskMemoryError("TASK_MEMORY_SOURCE_MISSING", "成果缺少当前branch中本任务的真实工具来源，checkpoint未保存；缺少有效ID时按需一次task_workflow(action=\"status\", detail=\"full\")，从任务记忆observations取id并核对outcome与revision；勿猜造或用toolCallId、messageEntryId、obs_recall ID替代。已有可核验来源可复用，不为补来源重放工具；checkpoint不是complete、block或交接的新增前置条件。");
    const restored = references.some(item => !memory.observations.some(previous => previous.id === item!.id))
      ? { ...memory, observations: [...memory.observations.filter(item => !ids.includes(item.id)).slice(-TASK_MEMORY_LIMITS.recentObservations), ...references as TaskObservation[]] } : memory;
    const versions = paths.length ? files(ctx, paths) : memory.checkpoint?.files;
    const checkpointData = versions ? { ...parsed.value, files: versions } : (() => { const { files: _omitted, ...rest } = parsed.value; return rest; })();
    const next = applyParsedTaskCheckpoint(restored, checkpointData, checkpointHistory(ctx, current), excludedProgressSources(ctx.sessionManager.getBranch()));
    if (next !== memory) {
      persist(ctx, { ...next, identity: current });
      if (next.progressRevision > memory.progressRevision) onProgress?.(ctx);
    }
    const applicability: TaskMemoryView["applicability"] = !next.checkpoint?.files?.length
      ? "historical"
      : paths.length
        ? "matches-checkpoint-files"
        : fileApplicability(ctx, next);
    const status: TaskMemoryView["status"] = found || next !== memory || next.observations.length ? "available" : "legacy";
    return { status, memory: next, applicability };
  }
  pi.on("turn_end", (event: TurnEndEvent, ctx) => {
    if (!ctx.isProjectTrusted() || state.runtimeDisposed || state.userStopRequested) return;
    const resolved = identity(ctx);
    if (!resolved.ok) { suspend(ctx); return; }
    const current = resolved.value;
    const bound = binding.source(event.message, ctx);
    if (!current || !bound || !taskMemoryIdentityMatches(current, bound) || event.message.role !== "assistant" || event.toolResultEntryIds.length !== event.toolResults.length) return;
    try {
      const { memory, saved, found, unsaved } = load(ctx, current);
      // load() re-derives every result after the saved watermark, and batching them yields the same
      // memory as saving each turn; a snapshot only bounds that scan. Save the first one at once.
      if (memory !== saved && (!found || unsaved >= TASK_MEMORY_LIMITS.snapshotEveryResults)) persist(ctx, { ...memory, identity: current });
    } catch (error) {
      failures.add(scope(ctx, current));
      if (!(error && typeof error === "object" && "code" in error && error.code === "TASK_MEMORY_WRITE_FAILED")) suspend(ctx);
    }
  });
  function verificationSources(ctx: ExtensionContext, ids: string[]) {
    const resolved = identity(ctx);
    if (!resolved.ok) return taskMemoryError(resolved.code, resolved.message);
    const current = resolved.value;
    if (!current || !Array.isArray(ids) || ids.length < 1 || ids.length > TASK_MEMORY_LIMITS.evidencePerRequest || ids.some(id => typeof id !== "string" || !id.trim())) return taskMemoryError("TASK_MEMORY_VERIFICATION_INVALID", "验证来源须为1至8个真实工具结果ID");
    const branch = ctx.sessionManager.getBranch();
    for (const id of ids) {
      const source = sourceObservation(branch, id, current);
      if (!source || source.outcome !== "tool-ok") return taskMemoryError("TASK_MEMORY_VERIFICATION_INVALID", "验证来源不存在、不属于当前任务或工具报告失败；不能将其记录为本任务成功验证");
    }
    return [...new Set(ids)];
  }
  let lastBoundary: string | undefined;
  function boundarySummary(ctx: ExtensionContext, compacted = false) {
    const workflow = state.workflowState;
    if (!workflow || !ctx.isProjectTrusted()) return;
    const current = workflowHandoffIdentity(workflow);
    const boundary = JSON.stringify([ctx.sessionManager.getSessionId(), current ?? [workflow.workflowId, workflow.planVersion, workflow.currentTaskId, workflow.recoveryGeneration]]);
    if (!compacted && boundary === lastBoundary) return;
    lastBoundary = boundary;
    // A newly dispatched task message is not on the branch until before_agent_start finishes.
    // It has no prior task observations to restore; do not treat that SDK ordering as corruption.
    if (current && !workflowHandoffMessageOnBranch(ctx, current)) return;
    const memory = read(ctx);
    if (memory.status === "unavailable") suspend(ctx);
    const content = taskMemoryText(memory);
    if (content) return { customType: TASK_MEMORY_MESSAGE, content, display: false,
      details: { summarizedToolCallIds: memory.status === "available" ? memory.memory?.observations.map(item => item.toolCallId) ?? [] : [] } };
  }
  pi.on("before_agent_start", (_event, ctx) => {
    const message = boundarySummary(ctx);
    if (message) return { message };
  });
  pi.on("session_compact", (_event, ctx) => {
    const message = boundarySummary(ctx, true);
    // The SDK appends safely after a running turn's tool results, without starting another turn.
    if (message) pi.sendMessage(message, { triggerTurn: false });
  });
  function reset() { failures.clear(); stopped.clear(); lastBoundary = undefined; }
  onEvents(pi, ["session_start", "session_tree", "session_shutdown"], reset);
  return { read, checkpoint, verificationSources, suspend };
}
export type TaskMemoryRuntime = ReturnType<typeof createTaskMemoryRuntime>;
export function taskMemoryText(view: TaskMemoryView) {
  if (view.status === "unavailable") return "[任务记忆不可用] " + view.reason + "；不能据此重跑副作用或声称成果已保存。";
  if (!view.memory || !view.memory.observations.length && !view.memory.checkpoint) return "";
  const memory = view.memory;
  return "[任务工作记忆；历史观察不是当前执行授权]\n" + JSON.stringify({ revision: memory.revision, progressRevision: memory.progressRevision, taskId: memory.identity.taskId,
    checkpoint: memory.checkpoint, observations: memory.observations, omittedObservations: memory.omittedObservations, applicability: view.applicability,
    evidence: view.evidence }) + "\n来源ID取observations[].id（工具结果的session entry ID），不使用toolCallId或messageEntryId；已有可核验来源可复用。原结果可用 task_workflow(status, evidenceIds=[来源ID]) 定向读取，不必重跑。需要保留阶段进展时按需checkpoint，提交expectedMemoryRevision=" + memory.revision + "，不是complete、block或交接的新增前置条件；工具成功不等于测试或需求验收。matches-checkpoint-files仅表示声明文件与登记时一致，不证明完整依赖或测试当时版本。";
}
export function readTaskSourceObservation(branch: Entry[], id: string, current: WorkflowHandoffIdentity, dependency = false): TaskObservation | undefined {
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
    const anchor = branch.slice(0, ownerIndex).findLast(entry => entry.type === "custom_message" && entry.customType === WORKFLOW_TASK_MESSAGE_TYPE);
    const parsed = parseTaskMemoryIdentity(anchor?.type === "custom_message" ? anchor.details : undefined);
    if (!parsed.ok) return undefined;
    const details = parsed.value;
    if (taskMemoryScope(details) !== taskMemoryScope(current) && !(dependency
      && details.sessionId === current.sessionId && details.workflowId === current.workflowId && details.taskId === current.taskId
      && details.planVersion <= current.planVersion)) return undefined;
    const owner = branch[ownerIndex];
    const call = owner?.type === "message" && owner.message.role === "assistant"
      ? owner.message.content.find(part => part.type === "toolCall" && part.id === message.toolCallId) : undefined;
    if (!call || call.type !== "toolCall" || call.name === "task_workflow" || call.name === "switch_role") return undefined;
    const text = contentText(message.content);
    const failed = toolResultFailed(message);
    return { id, messageEntryId: owner.id, toolCallId: message.toolCallId, toolName: message.toolName,
      inputHash: fingerprint(call.arguments)!, outputHash: fingerprint(message.content)!, outcome: failed ? "tool-error" : "tool-ok",
      summary: bounded(text, TASK_MEMORY_LIMITS.observationSummary), truncated: text.length > TASK_MEMORY_LIMITS.observationSummary };
  }
export type TaskEvidence = { id: string; text: string; truncated: boolean; sourceTaskId: string; historical: true; sourceSessionId?: string };
