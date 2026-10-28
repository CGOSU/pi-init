import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { cloneState, getNextWorkflowTask, hydrateWorkflowState } from "./workflow.ts";
import type { WorkflowState } from "./workflow-types.ts";
import { parseTaskMemory } from "./task-memory.ts";

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
  if (!state || state.pendingRevision || state.currentTaskId || state.handoff
    || !(state.status === "running" || state.status === "paused" && state.pauseReason === SESSION_HANDOFF_REVIEW)
    || state.tasks.some(task => task.outcomeUnknown || !["completed", "pending", "superseded"].includes(task.status))
    || !state.tasks.some(task => task.status === "completed")) return false;
  return Boolean(getNextWorkflowTask({ ...state, status: "running" }));
}
export function handoffHash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function workflowContentHash(state: WorkflowState) {
  return handoffHash([state.workflowId, state.planVersion, state.plan, state.tasks, state.goals, state.revisions]);
}
export function buildSessionHandoff(state: WorkflowState, branch: readonly SessionEntry[], sourceFile = "") {
  if (!handoffBoundary(state)) throw new Error("只能在已完成交付物且没有活动或未知任务的边界换会话");
  const workflow = cloneState(state);
  workflow.status = "running";
  delete workflow.pauseReason;
  delete workflow.taskPauseReason;
  workflow.continuation = { kind: "schedule", phase: "pending", reason: "resume" };
  const checkpoints = [...branch].reverse().flatMap(entry => {
    if (entry.type !== "custom" || entry.customType !== "pi-init-task-memory") return [];
    const memory = parseTaskMemory(entry.data);
    if (!memory?.checkpoint || memory.identity.sessionId !== state.sessionId
      || memory.identity.workflowId !== state.workflowId || memory.identity.planVersion !== state.planVersion) return [];
    return [{ taskId: memory.identity.taskId, checkpoint: memory.checkpoint, historical: true }];
  }).filter((item, index, all) => all.findIndex(other => other.taskId === item.taskId) === index);
  const inherited = [...branch].reverse().find(entry => entry.type === "custom" && entry.customType === SESSION_HANDOFF_ENTRY && (entry.data as { kind?: string })?.kind === "incoming");
  const previous = inherited?.type === "custom" ? (inherited.data as { packet?: { sources?: Array<{ taskId: string; evidenceIds: string[]; sourceSessionId: string; sourceFile: string }> } })?.packet?.sources ?? [] : [];
  const sources = state.tasks.filter(task => task.status === "completed").flatMap(task => task.verificationEvidenceIds?.length
    ? [{ taskId: task.id, evidenceIds: task.verificationEvidenceIds, sourceSessionId: state.sessionId, sourceFile }]
    : previous.filter(source => source.taskId === task.id));
  const context = {
    goal: state.plan.summary, constraints: state.plan.constraints,
    completed: state.tasks.filter(task => task.status === "completed").map(task => ({ id: task.id, summary: task.completionSummary, rationale: task.implementationRationale, verification: task.verification })),
    remaining: state.tasks.filter(task => task.status === "pending").map(task => task.id), checkpoints,
  };
  const packet = { workflow, sources, context };
  if (Buffer.byteLength(JSON.stringify(packet), "utf8") > SESSION_HANDOFF_MAX_BYTES) throw new Error("交接信息超过32 KiB；保留当前会话，不截断目标、约束或验证来源");
  return packet;
}
export type SessionHandoffPacket = ReturnType<typeof buildSessionHandoff>;
export function importedWorkflow(packet: SessionHandoffPacket, sessionId: string) {
  if (!sessionId || sessionId === packet.workflow.sessionId) throw new Error("目标必须是新的session");
  const next = cloneState(packet.workflow);
  next.sessionId = sessionId;
  next.recoveryGeneration++;
  next.status = "paused";
  next.pauseReason = SESSION_HANDOFF_IMPORTED;
  next.taskPauseReason = "新会话交接待核对；执行 /pi-init workflow fresh 完成激活，不会再次创建session";
  for (const task of next.tasks) {
    delete task.verificationEvidenceIds;
    if (task.status === "completed") task.verification = task.verification?.map(check => check.startsWith("[历史验证") ? check : "[历史验证，源session " + packet.workflow.sessionId + "] " + check);
  }
  const parsed = hydrateWorkflowState(next);
  if (!parsed.ok) throw new Error(parsed.message);
  return next;
}
