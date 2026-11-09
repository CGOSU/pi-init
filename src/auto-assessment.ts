import { AUTO_THINKING_LEVELS } from "./auto-model.ts";
import type { RoleConfigResult, ThinkingLevel } from "./role-types.ts";
import { isRecord } from "./value-guards.ts";

export const AUTO_REASON_LIMIT = 1000;

export type AutoTaskScope =
  | { kind: "workflow"; workflowId: string; taskId: string }
  | { kind: "ordinary"; task: number };

export type AutoAssessment = {
  scope: AutoTaskScope;
  from: ThinkingLevel;
  to: ThinkingLevel;
  decision: "keep" | "change";
  reason: string;
};

export function parseAutoAssessmentReason(value: unknown): RoleConfigResult<string> {
  if (value === undefined || value === null) return { ok: false, code: "AUTO_REASON_MISSING", message: "请提供基于任务复杂度或风险的评估理由，保持当前强度也需要理由" };
  if (typeof value !== "string") return { ok: false, code: "AUTO_REASON_TYPE_INVALID", message: "Auto 评估理由必须是字符串" };
  const reason = value.trim();
  if (!reason) return { ok: false, code: "AUTO_REASON_MISSING", message: "请提供基于任务复杂度或风险的评估理由，保持当前强度也需要理由" };
  if (reason.length > AUTO_REASON_LIMIT) return { ok: false, code: "AUTO_REASON_TOO_LONG", message: `Auto 评估理由不能超过 ${AUTO_REASON_LIMIT} 个字符；不要包含凭据或敏感数据` };
  return { ok: true, value: reason };
}

export function parseAutoTaskScope(value: unknown, expected: AutoTaskScope): RoleConfigResult<AutoTaskScope> {
  if (!isRecord(value) || value.kind !== expected.kind
    || (expected.kind === "workflow" ? value.workflowId !== expected.workflowId || value.taskId !== expected.taskId : value.task !== expected.task)) {
    return { ok: false, code: "AUTO_ASSESSMENT_SCOPE_MISMATCH", message: "Auto 评估不属于当前任务范围" };
  }
  return { ok: true, value: expected };
}

export function parseAutoAssessment(value: unknown, expected: AutoTaskScope): RoleConfigResult<AutoAssessment> {
  if (!isRecord(value)) return { ok: false, code: "AUTO_ASSESSMENT_MISSING", message: "当前任务尚无完整的 Auto 评估记录" };
  const scope = parseAutoTaskScope(value.scope, expected);
  if (!scope.ok) return scope;
  const reason = parseAutoAssessmentReason(value.reason);
  if (!reason.ok) return reason;
  if (!AUTO_THINKING_LEVELS.includes(value.from as ThinkingLevel) || !AUTO_THINKING_LEVELS.includes(value.to as ThinkingLevel)) {
    return { ok: false, code: "AUTO_ASSESSMENT_LEVEL_INVALID", message: "Auto 评估记录中的强度不合法" };
  }
  const from = value.from as ThinkingLevel;
  const to = value.to as ThinkingLevel;
  return { ok: true, value: { scope: scope.value, from, to, reason: reason.value, decision: from === to ? "keep" : "change" } };
}
