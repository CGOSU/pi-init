import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { handoffHash, SESSION_HANDOFF_MAX_BYTES } from "./session-handoff.ts";

export const GENERAL_HANDOFF_ENTRY = "pi-init-general-handoff";
export const GENERAL_HANDOFF_INVALIDATED = "pi-init-general-handoff-invalidated";
export const GENERAL_HANDOFF_TOOL = "session_handoff";
export type HandoffResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
export type HandoffSource = { kind: "session-entry" | "file"; location: string; description: string };
export type GeneralHandoffContext = {
  goal: string; constraints: string[]; completed: string[]; remaining: string[];
  verification: { summary: string; sources: HandoffSource[] }[];
  unknowns: string[]; nextStep: string; sources: HandoffSource[];
};
export type GeneralHandoffSnapshot = {
  version: 1; historical: true; context: GeneralHandoffContext;
  source: { sessionId: string; projectRoot: string; sessionFile: string; branchLeafId: string; branchHash: string; toolCallId: string };
};
const fail = (code: string, message: string): HandoffResult<never> => ({ ok: false, code, message });
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Reject the whole input; these byte limits are storage bounds, not token estimates. */
export function parseGeneralHandoff(input: unknown): HandoffResult<GeneralHandoffContext> {
  if (input === undefined || input === null) return fail("MISSING", "缺少交接正文");
  if (!record(input)) return fail("TYPE", "交接正文必须是对象");
  const fields = ["goal", "constraints", "completed", "remaining", "verification", "unknowns", "nextStep", "sources"];
  if (fields.some(key => !(key in input))) return fail("MISSING", "交接正文缺少必填字段（无内容请显式使用空数组）");
  if (Object.keys(input).some(key => !fields.includes(key))) return fail("FIELD", "交接正文含未知字段，不能提交来源身份或执行授权");
  for (const key of ["goal", "nextStep"]) {
    if (typeof input[key] !== "string") return fail("TYPE", `${key}必须是字符串`);
    if (!nonempty(input[key])) return fail("EMPTY", `${key}不能为空`);
  }
  for (const key of ["constraints", "completed", "remaining", "unknowns"]) {
    if (!Array.isArray(input[key])) return fail("TYPE", `${key}必须是数组`);
    if (!(input[key] as unknown[]).every(item => typeof item === "string")) return fail("TYPE", `${key}项目必须是字符串`);
    if (!(input[key] as unknown[]).every(nonempty)) return fail("EMPTY", `${key}项目不能为空`);
  }
  const sources = (value: unknown): HandoffResult<HandoffSource[]> => {
    if (!Array.isArray(value)) return fail("TYPE", "sources必须是数组");
    for (const source of value) {
      if (!record(source) || Object.keys(source).some(key => !["kind", "location", "description"].includes(key))) return fail("TYPE", "来源必须包含kind/location/description");
      if (source.kind !== "session-entry" && source.kind !== "file") return fail("SOURCE_KIND", "来源只支持当前session条目ID或文件位置；不支持obs_recall ID");
      if (!nonempty(source.location) || !nonempty(source.description)) return fail("SOURCE_MISSING", "来源位置与说明不能为空");
    }
    return { ok: true, value: value as HandoffSource[] };
  };
  const parsedSources = sources(input.sources);
  if (!parsedSources.ok) return parsedSources;
  if (!Array.isArray(input.verification)) return fail("TYPE", "verification必须是数组；未验证使用空数组");
  for (const check of input.verification) {
    if (!record(check) || Object.keys(check).some(key => !["summary", "sources"].includes(key)) || !nonempty(check.summary)) return fail("VERIFICATION", "验证需有非空summary及sources");
    const parsed = sources(check.sources);
    if (!parsed.ok) return parsed;
    if (!parsed.value.length) return fail("SOURCE_MISSING", "历史验证必须声明来源；没有来源请记录为unknowns");
  }
  const context = structuredClone(input) as GeneralHandoffContext;
  if (Buffer.byteLength(JSON.stringify(context), "utf8") > SESSION_HANDOFF_MAX_BYTES) return fail("TOO_LARGE", "交接正文超过32 KiB，完整拒绝，不截断");
  context.goal = context.goal.trim();
  context.nextStep = context.nextStep.trim();
  for (const key of ["constraints", "completed", "remaining", "unknowns"] as const) context[key] = context[key].map(item => item.trim());
  for (const check of context.verification) check.summary = check.summary.trim();
  for (const source of [...context.sources, ...context.verification.flatMap(check => check.sources)]) {
    source.location = source.location.trim();
    source.description = source.description.trim();
  }
  return { ok: true, value: context };
}

// These records describe timing only; unknown custom entries still invalidate the snapshot.
const HANDOFF_TIMING_ENTRIES = new Set(["pi-token-speed", "pi-init-session-work-time", "pi-init-run-timing"]);

/** Normal completion, known timing and omissions of empty post-snapshot failures are non-business activity. */
export function generalHandoffBranchHash(branch: readonly SessionEntry[], toolCallId: string) {
  const snapshotIndex = branch.findLastIndex(entry => entry.type === "custom" && entry.customType === GENERAL_HANDOFF_ENTRY
    && record(entry.data) && record(entry.data.source) && entry.data.source.toolCallId === toolCallId);
  const emptyFailures = new Set<string>();
  return handoffHash(branch.filter((entry, index) => {
    if (entry.type === "custom" && (entry.customType === GENERAL_HANDOFF_ENTRY || HANDOFF_TIMING_ENTRIES.has(entry.customType))) return false;
    // Only a null edit of an earlier empty error after this snapshot is safe. Replacements and older targets remain significant.
    if (entry.type === "context_edit") return entry.replacement !== null || !emptyFailures.has(entry.targetId);
    if (entry.type !== "message") return true;
    const m = entry.message;
    if (snapshotIndex >= 0 && index > snapshotIndex && m.role === "assistant" && m.stopReason === "error" && m.content.length === 0) emptyFailures.add(entry.id);
    if (m.role === "toolResult") return m.toolCallId !== toolCallId;
    if (m.role === "assistant") return m.content.some(block => block.type === "toolCall" && (block.id !== toolCallId || block.name !== GENERAL_HANDOFF_TOOL));
    return true;
  }).map(entry => entry.id));
}

export function readGeneralHandoff(branch: readonly SessionEntry[], identity: { sessionId: string; projectRoot: string; sessionFile: string }): HandoffResult<GeneralHandoffSnapshot> {
  const entry = branch.findLast(e => e.type === "custom" && e.customType === GENERAL_HANDOFF_ENTRY);
  if (entry?.type !== "custom") return fail("MISSING", "尚未准备普通会话交接快照");
  const data = entry.data;
  if (!record(data) || data.version !== 1 || data.historical !== true || !record(data.source)) return fail("INVALID", "交接快照结构无效");
  const parsed = parseGeneralHandoff(data.context);
  if (!parsed.ok) return parsed;
  const s = data.source;
  if (![s.sessionId, s.projectRoot, s.sessionFile, s.branchLeafId, s.branchHash, s.toolCallId].every(nonempty)) return fail("IDENTITY", "交接来源身份不完整");
  if (s.sessionId !== identity.sessionId || s.projectRoot !== identity.projectRoot || s.sessionFile !== identity.sessionFile) return fail("IDENTITY", "交接来源session或项目不匹配");
  if (!branch.some(e => e.id === s.branchLeafId) || generalHandoffBranchHash(branch, s.toolCallId as string) !== s.branchHash) return fail("STALE", "交接后现场已变化，请重新准备并核对快照");
  const allSources = [...parsed.value.sources, ...parsed.value.verification.flatMap(check => check.sources)];
  if (allSources.some(source => source.kind === "session-entry" && !branch.some(e => e.id === source.location))) return fail("SOURCE_IDENTITY", "来源条目不属于当前branch");
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > SESSION_HANDOFF_MAX_BYTES) return fail("TOO_LARGE", "交接快照超过32 KiB");
  return { ok: true, value: structuredClone(data) as GeneralHandoffSnapshot };
}
