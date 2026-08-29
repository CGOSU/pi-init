export const SUBTASK_RESULT_PROTOCOL = "pi-init/task-result@1";
export const SUBTASK_RESULT_MAX_BYTES = 16 * 1024;
export const SUBTASK_RESULT_MAX_TEXT = 4 * 1024;
export const SUBTASK_RESULT_MAX_VERIFICATION_ITEMS = 32;
export const SUBTASK_RESULT_MAX_VERIFICATION_TEXT = 2 * 1024;

const RESULT_FIELDS = new Set([
  "protocol",
  "outcome",
  "completionSummary",
  "implementationRationale",
  "verification",
  "reason",
]);

function requireText(value, label, maxLength = SUBTASK_RESULT_MAX_TEXT) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}必须是非空字符串`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new Error(`${label}过长，最多 ${maxLength} 个字符`);
  }
  return text;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`);
  }
}

function assertExactFields(value, required, label) {
  for (const key of Object.keys(value)) {
    if (!RESULT_FIELDS.has(key)) {
      throw new Error(`${label}包含不支持的字段：${key}`);
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      throw new Error(`${label}缺少字段：${key}`);
    }
  }
}

function parseJsonResult(raw) {
  if (typeof raw !== "string") {
    throw new Error("subtask 结果必须是 JSON 字符串");
  }
  if (raw.length > SUBTASK_RESULT_MAX_BYTES) {
    throw new Error(`subtask 结果过大，最多 ${SUBTASK_RESULT_MAX_BYTES} 个字符`);
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`subtask 结果不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  assertPlainObject(value, "subtask 结果");
  return value;
}

/**
 * Strip Markdown fences a fork may wrap around its single JSON result before
 * strict validation. Non-fenced text is passed through unchanged so malformed
 * noise still fails in parseSubtaskResult.
 */
export function extractSubtaskResultJson(text) {
  if (typeof text !== "string") return text;
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseSubtaskResult(raw) {
  const value = parseJsonResult(extractSubtaskResultJson(raw));
  if (value.protocol !== SUBTASK_RESULT_PROTOCOL) {
    throw new Error(`subtask 结果协议无效：${value.protocol ?? "（缺失）"}`);
  }
  if (value.outcome === "complete") {
    assertExactFields(value, ["protocol", "outcome", "completionSummary", "implementationRationale", "verification"], "complete 结果");
    if (!Array.isArray(value.verification) || value.verification.length === 0) {
      throw new Error("complete 结果的 verification 必须是非空数组");
    }
    if (value.verification.length > SUBTASK_RESULT_MAX_VERIFICATION_ITEMS) {
      throw new Error(`verification 最多包含 ${SUBTASK_RESULT_MAX_VERIFICATION_ITEMS} 项`);
    }
    const verification = value.verification.map((item, index) =>
      requireText(item, `verification[${index}]`, SUBTASK_RESULT_MAX_VERIFICATION_TEXT),
    );
    return {
      outcome: "complete",
      completionSummary: requireText(value.completionSummary, "completionSummary"),
      implementationRationale: requireText(value.implementationRationale, "implementationRationale"),
      verification: [...new Set(verification)],
    };
  }

  if (value.outcome === "blocked") {
    assertExactFields(value, ["protocol", "outcome", "reason"], "blocked 结果");
    return {
      outcome: "blocked",
      reason: requireText(value.reason, "reason"),
    };
  }

  throw new Error(`subtask 结果 outcome 无效：${value.outcome ?? "（缺失）"}`);
}