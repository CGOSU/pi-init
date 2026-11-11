import { isRecord } from "./value-guards.ts";
import type { WorkflowVerification, WorkflowVerificationRecord } from "./workflow-types.ts";

type VerificationResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
const fail = (code: string, message: string): VerificationResult<never> => ({ ok: false, code: "WORKFLOW_VERIFICATION_" + code, message });

function parseRecord(value: unknown, stored: boolean): VerificationResult<WorkflowVerification> {
  if (!isRecord(value)) return fail("RECORD_TYPE", "验证项必须是包含 check、status、details 的对象");
  const fields = stored ? ["check", "status", "details", "sourceSessionId"] : ["check", "status", "details"];
  if (Object.keys(value).some(key => !fields.includes(key))) return fail("FIELD", "验证项包含不支持的字段");
  if (value.status === undefined) return fail("STATUS_MISSING", "验证项缺少 status");
  if (typeof value.status !== "string") return fail("STATUS_TYPE", "验证状态必须是字符串");
  if (!["passed", "failed", "not-run"].includes(value.status)) return fail("STATUS_INVALID", "验证状态仅支持 passed、failed、not-run");
  for (const field of ["check", "details", ...(value.sourceSessionId !== undefined ? ["sourceSessionId"] : [])]) {
    if (value[field] === undefined) return fail("MISSING", "验证项缺少 " + field);
    if (typeof value[field] !== "string") return fail("TYPE", "验证项 " + field + " 必须是字符串");
    if (!value[field].trim()) return fail("EMPTY", "验证项 " + field + " 不能为空");
  }
  return {
    ok: true, value: {
      check: (value.check as string).trim(),
      status: value.status as WorkflowVerification["status"],
      details: (value.details as string).trim(),
      ...(value.sourceSessionId !== undefined ? { sourceSessionId: (value.sourceSessionId as string).trim() } : {}),
    }
  };
}

function parseRecords(value: unknown, stored: boolean): VerificationResult<WorkflowVerificationRecord[]> {
  if (value === undefined) return fail("MISSING", "必须提供实际验证记录");
  if (!Array.isArray(value)) return fail("TYPE", "验证结果必须是结构化记录数组");
  if (!stored && !value.length) return fail("EMPTY", "必须提供至少一项实际检查或明确未执行的记录");
  const checks: WorkflowVerificationRecord[] = [];
  for (const item of value) {
    if (stored && typeof item === "string") { checks.push(item); continue; }
    const parsed = parseRecord(item, stored);
    if (!parsed.ok) return parsed;
    checks.push(parsed.value);
  }
  return { ok: true, value: checks };
}

export function parseWorkflowVerification(value: unknown): VerificationResult<WorkflowVerification[]> {
  const result = parseRecords(value, false);
  return result.ok ? { ok: true, value: result.value as WorkflowVerification[] } : result;
}

export function restoreWorkflowVerification(value: unknown) {
  return parseRecords(value, true);
}

export function formatWorkflowVerification(check: WorkflowVerificationRecord) {
  if (typeof check === "string") return "[历史文字：未结构化／未判定] " + check;
  const status = { passed: "通过", failed: "失败", "not-run": "未执行" }[check.status];
  const source = check.sourceSessionId ? "[历史验证，源session " + check.sourceSessionId + "；非当前验证] " : "";
  return source + "[" + status + "] " + check.check + "：" + check.details;
}

export function hasCurrentWorkflowVerification(checks: WorkflowVerificationRecord[] | undefined) {
  return Boolean(checks?.some(check => typeof check !== "string" && !check.sourceSessionId && check.status !== "not-run"));
}
