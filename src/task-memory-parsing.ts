import { TASK_MEMORY_LIMITS } from "./task-memory-protocol.ts";
import { isRecord } from "./value-guards.ts";
import type { TaskCheckpoint, TaskMemory, TaskObservation, TaskSourceVersion } from "./task-memory-types.ts";
import type { WorkflowHandoffIdentity } from "./workflow-types.ts";

export type TaskMemoryParseCode =
  | "TASK_MEMORY_INPUT_MISSING" | "TASK_MEMORY_INPUT_TYPE" | "TASK_MEMORY_INPUT_RANGE"
  | "TASK_MEMORY_INPUT_FORMAT" | "TASK_MEMORY_VERSION_UNSUPPORTED"
  | "TASK_MEMORY_SOURCE_DUPLICATE" | "TASK_MEMORY_SOURCE_MISSING";
export type TaskMemoryParseFailure = { ok: false; code: TaskMemoryParseCode; message: string; field: string };
export type TaskMemoryParseResult<T> = { ok: true; value: T } | TaskMemoryParseFailure;

function failure(code: TaskMemoryParseCode, field: string, message: string): TaskMemoryParseFailure {
  return { ok: false, code, field, message: field + "：" + message };
}
function required(value: unknown, field: string): TaskMemoryParseResult<unknown> {
  return value === undefined || value === null
    ? failure("TASK_MEMORY_INPUT_MISSING", field, "缺少必填值")
    : { ok: true, value };
}
function parseRecord(value: unknown, field: string): TaskMemoryParseResult<Record<string, unknown>> {
  const present = required(value, field);
  if (!present.ok) return present;
  return isRecord(value) ? { ok: true, value } : failure("TASK_MEMORY_INPUT_TYPE", field, "必须是对象");
}
function parseText(value: unknown, field: string, maximum: number, minimum = 1): TaskMemoryParseResult<string> {
  const present = required(value, field);
  if (!present.ok) return present;
  if (typeof value !== "string") return failure("TASK_MEMORY_INPUT_TYPE", field, "必须是字符串");
  if (value.length < minimum || value.length > maximum) return failure("TASK_MEMORY_INPUT_RANGE", field, `长度必须为${minimum}至${maximum}`);
  return { ok: true, value };
}
function parseInteger(value: unknown, field: string): TaskMemoryParseResult<number> {
  const present = required(value, field);
  if (!present.ok) return present;
  if (typeof value !== "number") return failure("TASK_MEMORY_INPUT_TYPE", field, "必须是数字");
  if (!Number.isFinite(value)) return failure("TASK_MEMORY_INPUT_RANGE", field, "必须是有限的非负安全整数");
  if (!Number.isInteger(value)) return failure("TASK_MEMORY_INPUT_FORMAT", field, "必须是整数");
  if (!Number.isSafeInteger(value) || value < 0) return failure("TASK_MEMORY_INPUT_RANGE", field, "必须是非负安全整数");
  return { ok: true, value };
}
function parseList<T>(value: unknown, field: string, maximum: number, parseItem: (item: unknown, field: string) => TaskMemoryParseResult<T>, minimum = 0): TaskMemoryParseResult<T[]> {
  const present = required(value, field);
  if (!present.ok) return present;
  if (!Array.isArray(value)) return failure("TASK_MEMORY_INPUT_TYPE", field, "必须是数组");
  if (value.length < minimum || value.length > maximum) return failure("TASK_MEMORY_INPUT_RANGE", field, `项数必须为${minimum}至${maximum}`);
  const items: T[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = parseItem(value[index], `${field}[${index}]`);
    if (!item.ok) return item;
    items.push(item.value);
  }
  return { ok: true, value: items };
}
function parseIdentity(value: unknown, field: string): TaskMemoryParseResult<WorkflowHandoffIdentity> {
  const object = parseRecord(value, field);
  if (!object.ok) return object;
  const data = object.value;
  const fields = {} as Pick<WorkflowHandoffIdentity, "sessionId" | "workflowId" | "taskId" | "attemptId" | "handoffId">;
  for (const key of ["sessionId", "workflowId", "taskId", "attemptId", "handoffId"] as const) {
    const parsed = parseText(data[key], field + "." + key, TASK_MEMORY_LIMITS.evidenceIdLength);
    if (!parsed.ok) return parsed;
    fields[key] = parsed.value;
  }
  const planVersion = parseInteger(data.planVersion, field + ".planVersion");
  if (!planVersion.ok) return planVersion;
  const recoveryGeneration = parseInteger(data.recoveryGeneration, field + ".recoveryGeneration");
  if (!recoveryGeneration.ok) return recoveryGeneration;
  return { ok: true, value: { sessionId: fields.sessionId, workflowId: fields.workflowId, planVersion: planVersion.value,
    taskId: fields.taskId, attemptId: fields.attemptId, handoffId: fields.handoffId, recoveryGeneration: recoveryGeneration.value } };
}
export function parseTaskMemoryIdentity(value: unknown): TaskMemoryParseResult<WorkflowHandoffIdentity> {
  return parseIdentity(value, "identity");
}
function parseAccomplishment(value: unknown, field: string): TaskMemoryParseResult<TaskCheckpoint["accomplished"][number]> {
  const object = parseRecord(value, field);
  if (!object.ok) return object;
  const summary = parseText(object.value.summary, field + ".summary", TASK_MEMORY_LIMITS.textLength);
  if (!summary.ok) return summary;
  const evidenceIds = parseList(object.value.evidenceIds, field + ".evidenceIds", TASK_MEMORY_LIMITS.evidencePerAccomplishment,
    (id, path) => parseText(id, path, TASK_MEMORY_LIMITS.evidenceIdLength), 1);
  if (!evidenceIds.ok) return evidenceIds;
  return { ok: true, value: { summary: summary.value, evidenceIds: evidenceIds.value } };
}
function parseFile(value: unknown, field: string): TaskMemoryParseResult<TaskSourceVersion> {
  const object = parseRecord(value, field);
  if (!object.ok) return object;
  const path = parseText(object.value.path, field + ".path", TASK_MEMORY_LIMITS.textLength);
  if (!path.ok) return path;
  const hash = parseText(object.value.hash, field + ".hash", TASK_MEMORY_LIMITS.evidenceIdLength);
  if (!hash.ok) return hash;
  if (!/^[a-f0-9]{64}$/.test(hash.value)) return failure("TASK_MEMORY_INPUT_FORMAT", field + ".hash", "必须是64位小写十六进制文件哈希");
  return { ok: true, value: { path: path.value, hash: hash.value } };
}
function parseCheckpoint(value: unknown, field: string): TaskMemoryParseResult<TaskCheckpoint> {
  const object = parseRecord(value, field);
  if (!object.ok) return object;
  const data = object.value;
  const step = parseText(data.step, field + ".step", TASK_MEMORY_LIMITS.stepLength);
  if (!step.ok) return step;
  const nextStep = parseText(data.nextStep, field + ".nextStep", TASK_MEMORY_LIMITS.textLength);
  if (!nextStep.ok) return nextStep;
  const parseItem = (item: unknown, path: string) => parseText(item, path, TASK_MEMORY_LIMITS.textLength);
  const remaining = parseList(data.remaining, field + ".remaining", TASK_MEMORY_LIMITS.remaining, parseItem);
  if (!remaining.ok) return remaining;
  const blockers = parseList(data.blockers, field + ".blockers", TASK_MEMORY_LIMITS.blockers, parseItem);
  if (!blockers.ok) return blockers;
  const accomplished = parseList(data.accomplished, field + ".accomplished", TASK_MEMORY_LIMITS.accomplishments, parseAccomplishment);
  if (!accomplished.ok) return accomplished;
  const checkpoint: TaskCheckpoint = { step: step.value, nextStep: nextStep.value, remaining: remaining.value, blockers: blockers.value, accomplished: accomplished.value };
  if (data.files !== undefined) {
    const files = parseList(data.files, field + ".files", TASK_MEMORY_LIMITS.files, parseFile);
    if (!files.ok) return files;
    checkpoint.files = files.value;
  }
  return { ok: true, value: checkpoint };
}
export function parseTaskCheckpoint(value: unknown): TaskMemoryParseResult<TaskCheckpoint> {
  return parseCheckpoint(value, "checkpoint");
}
function parseObservation(value: unknown, field: string): TaskMemoryParseResult<TaskObservation> {
  const object = parseRecord(value, field);
  if (!object.ok) return object;
  const data = object.value;
  const fields = {} as Pick<TaskObservation, "id" | "messageEntryId" | "toolCallId" | "toolName" | "inputHash" | "outputHash">;
  for (const key of ["id", "messageEntryId", "toolCallId", "toolName", "inputHash", "outputHash"] as const) {
    const parsed = parseText(data[key], field + "." + key, TASK_MEMORY_LIMITS.evidenceIdLength);
    if (!parsed.ok) return parsed;
    fields[key] = parsed.value;
  }
  const outcome = parseText(data.outcome, field + ".outcome", TASK_MEMORY_LIMITS.evidenceIdLength);
  if (!outcome.ok) return outcome;
  if (outcome.value !== "tool-ok" && outcome.value !== "tool-error" && outcome.value !== "unknown") return failure("TASK_MEMORY_INPUT_FORMAT", field + ".outcome", "未知的工具结果状态");
  // Snapshots from older derivations may hold up to 1024 characters; loading re-derives them.
  const summary = parseText(data.summary, field + ".summary", 1024, 0);
  if (!summary.ok) return summary;
  const truncated = required(data.truncated, field + ".truncated");
  if (!truncated.ok) return truncated;
  if (typeof data.truncated !== "boolean") return failure("TASK_MEMORY_INPUT_TYPE", field + ".truncated", "必须是布尔值");
  return { ok: true, value: { ...fields, outcome: outcome.value, summary: summary.value, truncated: data.truncated } };
}
export function parseTaskMemory(value: unknown): TaskMemoryParseResult<TaskMemory> {
  const object = parseRecord(value, "memory");
  if (!object.ok) return object;
  const data = object.value;
  const version = parseInteger(data.version, "memory.version");
  if (!version.ok) return version;
  if (version.value !== 1) return failure("TASK_MEMORY_VERSION_UNSUPPORTED", "memory.version", "不支持此任务记忆版本");
  const identity = parseIdentity(data.identity, "memory.identity");
  if (!identity.ok) return identity;
  const revision = parseInteger(data.revision, "memory.revision");
  if (!revision.ok) return revision;
  const progressRevision = parseInteger(data.progressRevision, "memory.progressRevision");
  if (!progressRevision.ok) return progressRevision;
  const omittedObservations = parseInteger(data.omittedObservations, "memory.omittedObservations");
  if (!omittedObservations.ok) return omittedObservations;
  const observations = parseList(data.observations, "memory.observations", TASK_MEMORY_LIMITS.observations, parseObservation);
  if (!observations.ok) return observations;
  const ids = new Set<string>();
  for (let index = 0; index < observations.value.length; index++) {
    const id = observations.value[index].id;
    if (ids.has(id)) return failure("TASK_MEMORY_SOURCE_DUPLICATE", `memory.observations[${index}].id`, "来源ID重复");
    ids.add(id);
  }
  const memory: TaskMemory = { version: 1, identity: identity.value, revision: revision.value, progressRevision: progressRevision.value, observations: observations.value, omittedObservations: omittedObservations.value };
  if (data.watermark !== undefined) {
    const watermark = parseText(data.watermark, "memory.watermark", TASK_MEMORY_LIMITS.evidenceIdLength);
    if (!watermark.ok) return watermark;
    memory.watermark = watermark.value;
  }
  if (data.derivation !== undefined) {
    const derivation = parseInteger(data.derivation, "memory.derivation");
    if (!derivation.ok) return derivation;
    if (derivation.value < 1) return failure("TASK_MEMORY_INPUT_RANGE", "memory.derivation", "必须是正整数");
    memory.derivation = derivation.value;
  }
  if (data.checkpoint !== undefined) {
    const checkpoint = parseCheckpoint(data.checkpoint, "memory.checkpoint");
    if (!checkpoint.ok) return checkpoint;
    const evidence = new Set(checkpoint.value.accomplished.flatMap(item => item.evidenceIds));
    if (evidence.size > TASK_MEMORY_LIMITS.pinnedObservations) return failure("TASK_MEMORY_INPUT_RANGE", "memory.checkpoint.accomplished", "关键证据引用不能超过32项");
    for (let index = 0; index < checkpoint.value.accomplished.length; index++) {
      if (checkpoint.value.accomplished[index].evidenceIds.some(id => !ids.has(id))) return failure("TASK_MEMORY_SOURCE_MISSING", `memory.checkpoint.accomplished[${index}].evidenceIds`, "成果引用缺少真实观察记录");
    }
    memory.checkpoint = checkpoint.value;
  }
  return { ok: true, value: memory };
}
