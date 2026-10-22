import type { WorkflowHandoffIdentity } from "./workflow-types.ts";

export type TaskObservation = {
  id: string; messageEntryId: string; toolCallId: string; toolName: string;
  inputHash: string; outputHash: string; outcome: "tool-ok" | "tool-error" | "unknown";
  summary: string; truncated: boolean;
};
export type TaskSourceVersion = { path: string; hash: string };
export type TaskCheckpoint = {
  step: string; accomplished: { summary: string; evidenceIds: string[] }[];
  remaining: string[]; blockers: string[]; nextStep: string; files?: TaskSourceVersion[];
};
export type TaskMemory = {
  version: 1; identity: WorkflowHandoffIdentity; revision: number; progressRevision: number; watermark?: string;
  observations: TaskObservation[]; omittedObservations: number; checkpoint?: TaskCheckpoint;
};
export function taskMemoryError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
export function taskMemoryScope(identity: WorkflowHandoffIdentity) {
  return JSON.stringify([identity.sessionId, identity.workflowId, identity.planVersion, identity.taskId]);
}
export function createTaskMemory(identity: WorkflowHandoffIdentity): TaskMemory {
  return { version: 1, identity: { ...identity }, revision: 0, progressRevision: 0, observations: [], omittedObservations: 0 };
}
function text(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
function texts(value: unknown, maximum = 32, length = 512): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every(item => text(item, length));
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validIdentity(value: unknown): value is WorkflowHandoffIdentity {
  return record(value) && ["sessionId", "workflowId", "taskId", "attemptId", "handoffId"].every(key => text(value[key], 256))
    && ["planVersion", "recoveryGeneration"].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0);
}
function validObservation(value: unknown): value is TaskObservation {
  return record(value) && ["id", "messageEntryId", "toolCallId", "toolName", "inputHash", "outputHash"].every(key => text(value[key], 256))
    && ["tool-ok", "tool-error", "unknown"].includes(String(value.outcome))
    && typeof value.summary === "string" && value.summary.length <= 1024 && typeof value.truncated === "boolean";
}
export function parseTaskCheckpoint(value: unknown): TaskCheckpoint | undefined {
  if (!record(value) || !text(value.step, 200) || !text(value.nextStep, 512) || !texts(value.remaining) || !texts(value.blockers, 16)
    || !Array.isArray(value.accomplished) || value.accomplished.length > 16
    || !value.accomplished.every(item => record(item) && text(item.summary, 512) && texts(item.evidenceIds, 8, 256) && item.evidenceIds.length > 0)) return undefined;
  if (value.files !== undefined && (!Array.isArray(value.files) || value.files.length > 16 || !value.files.every(item => record(item) && text(item.path, 512) && typeof item.hash === "string" && /^[a-f0-9]{64}$/.test(item.hash)))) return undefined;
  return structuredClone({ step: value.step, nextStep: value.nextStep, remaining: value.remaining, blockers: value.blockers,
    accomplished: value.accomplished.map(item => ({ summary: item.summary, evidenceIds: item.evidenceIds })),
    ...(value.files ? { files: value.files } : {}) }) as TaskCheckpoint;
}
export function parseTaskMemory(value: unknown): TaskMemory | undefined {
  if (!record(value) || value.version !== 1 || !validIdentity(value.identity) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || !Number.isSafeInteger(value.omittedObservations) || Number(value.omittedObservations) < 0
    || value.watermark !== undefined && !text(value.watermark, 256)
    || !Array.isArray(value.observations) || value.observations.length > 48 || !value.observations.every(validObservation)) return undefined;
  if (!Number.isSafeInteger(value.progressRevision) || Number(value.progressRevision) < 0) return undefined;
  if (new Set(value.observations.map(item => item.id)).size !== value.observations.length) return undefined;
  const observations = value.observations;
  const checkpoint = value.checkpoint === undefined ? undefined : parseTaskCheckpoint(value.checkpoint);
  if (value.checkpoint !== undefined && !checkpoint) return undefined;
  if (checkpoint?.accomplished.some(item => item.evidenceIds.some(id => !observations.some(observation => observation.id === id)))) return undefined;
  return structuredClone({ version: 1, identity: parseTaskMemoryIdentity(value.identity)!, revision: value.revision, progressRevision: value.progressRevision, observations: value.observations.map(item => ({ id: item.id, messageEntryId: item.messageEntryId, toolCallId: item.toolCallId, toolName: item.toolName, inputHash: item.inputHash, outputHash: item.outputHash, outcome: item.outcome, summary: item.summary, truncated: item.truncated })),
    omittedObservations: value.omittedObservations, ...(value.watermark ? { watermark: value.watermark } : {}), ...(checkpoint ? { checkpoint } : {}) }) as TaskMemory;
}
export function recordTaskObservations(memory: TaskMemory, observations: TaskObservation[], watermark: string): TaskMemory {
  const known = new Set(memory.observations.map(item => item.id));
  const added = observations.filter(item => !known.has(item.id) && (known.add(item.id), true));
  if (!added.length) return memory;
  const pinned = new Set(memory.checkpoint?.accomplished.flatMap(item => item.evidenceIds) ?? []);
  const combined = [...memory.observations, ...added];
  const distinct = new Map<string, TaskObservation>();
  for (const item of [...combined].reverse()) {
    if (pinned.has(item.id)) continue;
    const key = ["read", "grep", "find", "ls"].includes(item.toolName)
      ? JSON.stringify([item.toolName, item.inputHash, item.outputHash, item.outcome]) : item.id;
    if (!distinct.has(key)) distinct.set(key, item);
    if (distinct.size === 16) break;
  }
  const recent = new Set([...distinct.values()].map(item => item.id));
  const retained = combined.filter(item => pinned.has(item.id) || recent.has(item.id));
  return { ...memory, watermark, observations: retained, omittedObservations: memory.omittedObservations + combined.length - retained.length };
}
export function checkpointTaskMemory(memory: TaskMemory, input: TaskCheckpoint): TaskMemory {
  const checkpoint = parseTaskCheckpoint(input);
  if (!checkpoint) return taskMemoryError("TASK_MEMORY_CHECKPOINT_INVALID", "任务记忆内容无效或超出边界");
  const evidence = new Set(checkpoint.accomplished.flatMap(item => item.evidenceIds));
  if (evidence.size > 32) return taskMemoryError("TASK_MEMORY_CHECKPOINT_INVALID", "关键证据引用不能超过32项");
  if ([...evidence].some(id => !memory.observations.some(item => item.id === id))) return taskMemoryError("TASK_MEMORY_SOURCE_MISSING", "成果引用缺少真实工具结果，不能保存为已有进展");
  if (JSON.stringify(memory.checkpoint) === JSON.stringify(checkpoint)) return memory;
  const previousFacts = new Set(memory.checkpoint?.accomplished.flatMap(item => item.evidenceIds).map(id => memory.observations.find(item => item.id === id)).filter(Boolean).map(item => JSON.stringify([item!.inputHash, item!.outputHash, item!.outcome])) ?? []);
  const newFacts = [...evidence].map(id => memory.observations.find(item => item.id === id)!).some(item => !previousFacts.has(JSON.stringify([item.inputHash, item.outputHash, item.outcome])));
  const changedFiles = JSON.stringify(memory.checkpoint?.files ?? []) !== JSON.stringify(checkpoint.files ?? []);
  return { ...memory, checkpoint, revision: memory.revision + 1, progressRevision: memory.progressRevision + (newFacts || changedFiles ? 1 : 0) };
}
export function parseTaskMemoryIdentity(value: unknown): WorkflowHandoffIdentity | undefined {
  if (!validIdentity(value)) return undefined;
  return { sessionId: value.sessionId, workflowId: value.workflowId, planVersion: value.planVersion, taskId: value.taskId, attemptId: value.attemptId, handoffId: value.handoffId, recoveryGeneration: value.recoveryGeneration };
}
