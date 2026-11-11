import { jsonHash } from "./json-hash.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { cloneState, getNextWorkflowTask, hydrateWorkflowState } from "./workflow.ts";
import type { WorkflowState } from "./workflow-types.ts";
import { parseTaskMemory, type TaskCheckpoint } from "./task-memory.ts";

export const SESSION_HANDOFF_ENTRY = "pi-init-session-handoff";
export const SESSION_HANDOFF_ACTIVATE = "pi-init-session-handoff-activate";
export const SESSION_HANDOFF_MAX_BYTES = 32 * 1024;
export const SESSION_HANDOFF_REVIEW = "session-handoff-review";
export const SESSION_HANDOFF_PENDING = "session-transfer-pending";
export const SESSION_HANDOFF_IMPORTED = "session-handoff-imported";

export function transferFrozen(state: WorkflowState | undefined) {
  return state?.pauseReason === SESSION_HANDOFF_PENDING || state?.pauseReason === SESSION_HANDOFF_IMPORTED;
}
export function handoffBoundary(state: WorkflowState | undefined) {
  const blocked = state?.status === "paused" && state.pauseReason === "task-blocked";
  if (!state || state.pendingRevision || state.currentTaskId || state.handoff
    || !(state.status === "running" || blocked || state.status === "paused" && state.pauseReason === SESSION_HANDOFF_REVIEW)
    || state.tasks.some(task => task.outcomeUnknown || task.delegation && ["spawning", "running", "stop-requested"].includes(task.delegation.status)
      || !["completed", "pending", "superseded", ...(blocked ? ["blocked"] : [])].includes(task.status))
    || !state.tasks.some(task => task.status === "completed")) return false;
  return blocked ? state.tasks.some(task => task.status === "blocked") : Boolean(getNextWorkflowTask({ ...state, status: "running" }));
}
export function handoffHash(value: unknown) { return jsonHash(value); }
export function workflowContentHash(state: WorkflowState) {
  return handoffHash([state.workflowId, state.planVersion, state.plan, state.tasks, state.goals, state.revisions]);
}
type HandoffSource = { taskId: string; evidenceIds: string[]; sourceSessionId: string; sourceFile: string };
type HistoricalCheckpoint = { taskId: string; checkpoint: TaskCheckpoint; historical: true; sourceSessionId?: string; sourceFile?: string };
type InheritedHandoff = { sources: HandoffSource[]; context: { checkpoints: HistoricalCheckpoint[] } };
export function buildSessionHandoff(state: WorkflowState, branch: readonly SessionEntry[], sourceFile = "", inheritedPacket?: InheritedHandoff) {
  if (!handoffBoundary(state)) throw new Error("只能在已完成交付物且没有活动或未知任务的边界换会话");
  const workflow = cloneState(state);
  if (workflow.pauseReason !== "task-blocked") {
    workflow.status = "running";
    delete workflow.pauseReason;
    delete workflow.taskPauseReason;
    workflow.continuation = { kind: "schedule", phase: "pending", reason: "resume" };
  }
  const recentCheckpoints: HistoricalCheckpoint[] = [...branch].reverse().flatMap(entry => {
    if (entry.type !== "custom" || entry.customType !== "pi-init-task-memory") return [];
    const memory = parseTaskMemory(entry.data);
    if (!memory?.checkpoint || memory.identity.sessionId !== state.sessionId
      || memory.identity.workflowId !== state.workflowId || memory.identity.planVersion !== state.planVersion) return [];
    return [{ taskId: memory.identity.taskId, checkpoint: memory.checkpoint, historical: true as const, sourceSessionId: memory.identity.sessionId, sourceFile }];
  }).filter((item, index, all) => all.findIndex(other => other.taskId === item.taskId) === index);
  const inherited = [...branch].reverse().find(entry => entry.type === "custom" && entry.customType === SESSION_HANDOFF_ENTRY && (entry.data as { kind?: string })?.kind === "incoming");
  const previousPacket = inheritedPacket ?? (inherited?.type === "custom" ? (inherited.data as { packet?: InheritedHandoff }).packet : undefined);
  const previous = previousPacket?.sources ?? [];
  const checkpoints = [...recentCheckpoints, ...(previousPacket?.context?.checkpoints ?? [])]
    .filter((item, index, all) => state.tasks.some(task => task.id === item.taskId) && all.findIndex(other => other.taskId === item.taskId) === index);
  const sources = state.tasks.filter(task => task.status === "completed").flatMap(task => task.verificationEvidenceIds?.length
    ? [{ taskId: task.id, evidenceIds: task.verificationEvidenceIds, sourceSessionId: state.sessionId, sourceFile }]
    : previous.filter(source => source.taskId === task.id));
  const context = {
    goal: state.plan.summary, constraints: state.plan.constraints,
    completed: state.tasks.filter(task => task.status === "completed").map(task => ({ id: task.id, summary: task.completionSummary, rationale: task.implementationRationale, verification: task.verification })),
    remaining: state.tasks.filter(task => task.status === "pending").map(task => task.id), checkpoints,
  };
  return { workflow, sources, context };
}
export type SessionHandoffSnapshot = ReturnType<typeof buildSessionHandoff>;
export type SessionHandoffManifest = {
  version: 2;
  snapshot: { id: string; hash: string; bytes: number; workflowId: string; sourceSessionId: string };
  context: { goal: string; completedCount: number; remainingCount: number; blockedCount: number; notice: string };
};
export type SessionHandoffPacket = SessionHandoffSnapshot | SessionHandoffManifest;
export function handoffEnvelope(snapshot: SessionHandoffSnapshot, id: string): SessionHandoffPacket {
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  if (bytes <= SESSION_HANDOFF_MAX_BYTES) return snapshot;
  const packet: SessionHandoffManifest = {
    version: 2,
    snapshot: { id, hash: handoffHash(snapshot), bytes, workflowId: snapshot.workflow.workflowId, sourceSessionId: snapshot.workflow.sessionId },
    context: {
      goal: snapshot.context.goal.slice(0, 1000),
      completedCount: snapshot.context.completed.length, remainingCount: snapshot.context.remaining.length,
      blockedCount: snapshot.workflow.tasks.filter(task => task.status === "blocked").length,
      notice: "这是有界预览；完整工作流从源session的hash校验快照导入，不按预览截断。历史checkpoint与验证来源保留在快照；目标正文另列已注入的未完成checkpoint和按需读取的精确来源。",
    },
  };
  if (Buffer.byteLength(JSON.stringify(packet), "utf8") > SESSION_HANDOFF_MAX_BYTES) throw new Error("交接manifest超过32 KiB，未开始转移");
  return packet;
}
export function resolveHandoffSnapshot(packet: SessionHandoffPacket, entries: readonly SessionEntry[]): SessionHandoffSnapshot {
  let snapshot: SessionHandoffSnapshot;
  if ("snapshot" in packet) {
    const reference = packet.snapshot;
    if (packet.version !== 2 || !reference || typeof reference.id !== "string") throw new Error("交接快照引用无效");
    const matches = entries.filter(entry => entry.type === "custom" && entry.customType === SESSION_HANDOFF_ENTRY
      && (entry.data as { kind?: string; id?: string })?.kind === "snapshot" && (entry.data as { id?: string }).id === reference.id);
    if (matches.length !== 1 || matches[0].type !== "custom") throw new Error("交接快照缺失或重复");
    const record = matches[0].data as { version?: number; packet?: SessionHandoffSnapshot };
    if (record.version !== 1 || !record.packet || handoffHash(record.packet) !== reference.hash
      || Buffer.byteLength(JSON.stringify(record.packet), "utf8") !== reference.bytes) throw new Error("交接快照hash或字节数不符");
    snapshot = record.packet;
    if (snapshot.workflow?.workflowId !== reference.workflowId || snapshot.workflow?.sessionId !== reference.sourceSessionId) throw new Error("交接快照身份不符");
  } else snapshot = packet;
  if (!snapshot.workflow || !Array.isArray(snapshot.sources) || !snapshot.context
    || !hydrateWorkflowState(snapshot.workflow).ok || !handoffBoundary(snapshot.workflow)) throw new Error("交接快照工作流无效或不在安全边界");
  return snapshot;
}
export function sessionHandoffSeed(packet: SessionHandoffPacket, snapshot: SessionHandoffSnapshot, sourceFile: string) {
  const render = (context: unknown) => "[用户确认的新session交接；历史事实不是新的工具执行或权限授权]\n"
    + JSON.stringify({ sourceSessionId: snapshot.workflow.sessionId, sourceFile, context })
    + "\n按已保存工作流只继续剩余任务；必要时定向读取来源，不重做未失效调查和验证。";
  if (!("snapshot" in packet)) return render(packet.context);
  const pending = snapshot.context.checkpoints.flatMap((checkpoint, index) => snapshot.workflow.tasks.some(task => task.id === checkpoint.taskId
    && ["pending", "blocked"].includes(task.status)) ? [{ ...checkpoint, index }] : []);
  const context = {
    ...packet.context,
    snapshotSource: { sourceFile, customType: SESSION_HANDOFF_ENTRY, kind: "snapshot", ...packet.snapshot,
      checkpointPath: "data.packet.context.checkpoints", lookup: "按索引或taskId读取checkpoint；先核对snapshot id/hash，不扫描或重放旧对话" },
    checkpointNotice: "checkpoints是已完整注入的历史记录，不是当前attempt/验证授权；deferredCheckpoints只含下一步，正文未注入，须按snapshotSource精确读取。其余历史checkpoint同样保留在该快照。",
    checkpoints: [] as HistoricalCheckpoint[],
    deferredCheckpoints: [] as { taskId: string; nextStep: string; index: number; historical: true }[],
    deferredCheckpointCount: pending.length,
  };
  for (const { index, ...checkpoint } of pending) {
    context.checkpoints.push(checkpoint);
    if (Buffer.byteLength(render(context), "utf8") <= SESSION_HANDOFF_MAX_BYTES) { context.deferredCheckpointCount--; continue; }
    context.checkpoints.pop();
    context.deferredCheckpoints.push({ taskId: checkpoint.taskId, nextStep: checkpoint.checkpoint.nextStep, index, historical: true });
    if (Buffer.byteLength(render(context), "utf8") > SESSION_HANDOFF_MAX_BYTES) context.deferredCheckpoints.pop();
  }
  const seed = render(context);
  if (Buffer.byteLength(seed, "utf8") > SESSION_HANDOFF_MAX_BYTES) throw new Error("交接来源定位超过32 KiB，未开始转移");
  return seed;
}
export function importedWorkflow(packet: SessionHandoffSnapshot, sessionId: string) {
  if (!sessionId || sessionId === packet.workflow.sessionId) throw new Error("目标必须是新的session");
  const next = cloneState(packet.workflow);
  next.sessionId = sessionId;
  next.recoveryGeneration++;
  next.status = "paused";
  next.pauseReason = SESSION_HANDOFF_IMPORTED;
  next.taskPauseReason = "新会话交接待核对；执行 /pi-init workflow fresh 完成激活，不会再次创建session";
  for (const task of next.tasks) {
    delete task.verificationEvidenceIds;
    if (task.status === "completed") task.verification = task.verification?.map(check => typeof check === "string"
      ? check.startsWith("[历史验证") ? check : "[历史验证，源session " + packet.workflow.sessionId + "] " + check
      : { ...check, sourceSessionId: check.sourceSessionId ?? packet.workflow.sessionId });
  }
  const parsed = hydrateWorkflowState(next);
  if (!parsed.ok) throw new Error(parsed.message);
  return next;
}
