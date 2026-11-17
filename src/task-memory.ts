import { TASK_MEMORY_LIMITS } from "./task-memory-protocol.ts";
import { isCoreReadOnlyTool } from "./tool-classification.ts";
import { throwCodedError } from "./error-utils.ts";
import { parseTaskCheckpoint } from "./task-memory-parsing.ts";
import type { TaskCheckpoint, TaskMemory, TaskObservation } from "./task-memory-types.ts";
import type { WorkflowHandoffIdentity } from "./workflow-types.ts";

export type { TaskCheckpoint, TaskMemory, TaskObservation, TaskSourceVersion } from "./task-memory-types.ts";
export { parseTaskCheckpoint, parseTaskMemory, parseTaskMemoryIdentity } from "./task-memory-parsing.ts";
export type { TaskMemoryParseCode, TaskMemoryParseFailure, TaskMemoryParseResult } from "./task-memory-parsing.ts";

export function taskMemoryError(code: string, message: string): never {
  return throwCodedError(code, message);
}
export function taskMemoryScope(identity: WorkflowHandoffIdentity) {
  return JSON.stringify([identity.sessionId, identity.workflowId, identity.planVersion, identity.taskId]);
}
export function createTaskMemory(identity: WorkflowHandoffIdentity): TaskMemory {
  return { version: 1, identity: { ...identity }, revision: 0, progressRevision: 0, observations: [], omittedObservations: 0 };
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
    const key = isCoreReadOnlyTool(item.toolName)
      ? JSON.stringify([item.toolName, item.inputHash, item.outputHash, item.outcome]) : item.id;
    if (!distinct.has(key)) distinct.set(key, item);
    if (distinct.size === TASK_MEMORY_LIMITS.recentObservations) break;
  }
  const recent = new Set([...distinct.values()].map(item => item.id));
  const retained = combined.filter(item => pinned.has(item.id) || recent.has(item.id));
  return { ...memory, watermark, observations: retained, omittedObservations: memory.omittedObservations + combined.length - retained.length };
}
function progressSourceKey(observation: TaskObservation) {
  return JSON.stringify([observation.toolName, observation.inputHash,
    isCoreReadOnlyTool(observation.toolName) ? observation.outputHash : null]);
}
function checkpointHasProgress(memory: TaskMemory, checkpoint: TaskCheckpoint, history: readonly TaskMemory[], excludedSources: ReadonlySet<string>) {
  const scope = taskMemoryScope(memory.identity);
  const prior = [...history, memory].filter(item => taskMemoryScope(item.identity) === scope);
  const previousSources = prior.flatMap(item => item.checkpoint?.accomplished.flatMap(result => result.evidenceIds)
    .map(id => item.observations.find(observation => observation.id === id)!) ?? []);
  const previousIds = new Set(previousSources.map(item => item.id));
  const previousFacts = new Set(previousSources.filter(item => item.outcome === "tool-ok" && !excludedSources.has(item.id)).map(progressSourceKey));
  const newFact = checkpoint.accomplished.flatMap(item => item.evidenceIds)
    .map(id => memory.observations.find(item => item.id === id)!)
    .some(item => item.outcome === "tool-ok" && !excludedSources.has(item.id) && !previousIds.has(item.id) && !previousFacts.has(progressSourceKey(item)));
  const fileVersions = new Map<string, Set<string>>();
  for (const file of prior.flatMap(item => item.checkpoint?.files ?? [])) {
    const hashes = fileVersions.get(file.path) ?? new Set<string>();
    hashes.add(file.hash);
    fileVersions.set(file.path, hashes);
  }
  const changedFile = checkpoint.files?.some(file => {
    const hashes = fileVersions.get(file.path);
    return hashes !== undefined && !hashes.has(file.hash);
  });
  return newFact || changedFile;
}
export function applyParsedTaskCheckpoint(
  memory: TaskMemory,
  checkpoint: TaskCheckpoint,
  history: readonly TaskMemory[] = [],
  excludedSources: ReadonlySet<string> = new Set(),
): TaskMemory {
  const evidence = new Set(checkpoint.accomplished.flatMap(item => item.evidenceIds));
  if (evidence.size > TASK_MEMORY_LIMITS.pinnedObservations) return taskMemoryError("TASK_MEMORY_CHECKPOINT_INVALID", "关键证据引用不能超过32项");
  if ([...evidence].some(id => !memory.observations.some(item => item.id === id))) return taskMemoryError("TASK_MEMORY_SOURCE_MISSING", "成果引用缺少真实工具结果，不能保存为已有进展");
  if (JSON.stringify(memory.checkpoint) === JSON.stringify(checkpoint)) return memory;
  const progressed = checkpointHasProgress(memory, checkpoint, history, excludedSources);
  return { ...memory, checkpoint, revision: memory.revision + 1, progressRevision: memory.progressRevision + (progressed ? 1 : 0) };
}
export function checkpointTaskMemory(memory: TaskMemory, input: TaskCheckpoint, history: readonly TaskMemory[] = [], excludedSources: ReadonlySet<string> = new Set()): TaskMemory {
  const checkpoint = parseTaskCheckpoint(input);
  if (!checkpoint.ok) return taskMemoryError(checkpoint.code, checkpoint.message);
  return applyParsedTaskCheckpoint(memory, checkpoint.value, history, excludedSources);
}
