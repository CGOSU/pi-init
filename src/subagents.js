export const SUBAGENT_RESULT_PROTOCOL = "pi-init/task-result@1";
export const SUBAGENT_RESULT_MAX_BYTES = 16 * 1024;
export const SUBAGENT_RESULT_MAX_TEXT = 4 * 1024;
export const SUBAGENT_RESULT_MAX_VERIFICATION_ITEMS = 32;
export const SUBAGENT_RESULT_MAX_VERIFICATION_TEXT = 2 * 1024;

const RESULT_FIELDS = new Set([
  "protocol",
  "outcome",
  "completionSummary",
  "verification",
  "reason",
]);

function requireText(value, label, maxLength = SUBAGENT_RESULT_MAX_TEXT) {
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
    throw new Error("子代理结果必须是 JSON 字符串");
  }
  if (raw.length > SUBAGENT_RESULT_MAX_BYTES) {
    throw new Error(`子代理结果过大，最多 ${SUBAGENT_RESULT_MAX_BYTES} 个字符`);
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`子代理结果不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  assertPlainObject(value, "子代理结果");
  return value;
}

export function parseSubagentResult(raw) {
  const value = parseJsonResult(raw);
  if (value.protocol !== SUBAGENT_RESULT_PROTOCOL) {
    throw new Error(`子代理结果协议无效：${value.protocol ?? "（缺失）"}`);
  }
  if (value.outcome === "complete") {
    assertExactFields(value, ["protocol", "outcome", "completionSummary", "verification"], "complete 结果");
    if (!Array.isArray(value.verification) || value.verification.length === 0) {
      throw new Error("complete 结果的 verification 必须是非空数组");
    }
    if (value.verification.length > SUBAGENT_RESULT_MAX_VERIFICATION_ITEMS) {
      throw new Error(`verification 最多包含 ${SUBAGENT_RESULT_MAX_VERIFICATION_ITEMS} 项`);
    }
    const verification = value.verification.map((item, index) =>
      requireText(item, `verification[${index}]`, SUBAGENT_RESULT_MAX_VERIFICATION_TEXT),
    );
    return {
      outcome: "complete",
      completionSummary: requireText(value.completionSummary, "completionSummary"),
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

  throw new Error(`子代理结果 outcome 无效：${value.outcome ?? "（缺失）"}`);
}

export function parseSubagentSpawnReply(raw) {
  assertPlainObject(raw, "子代理 spawn 回复");
  if (raw.success !== true) {
    throw new Error(requireText(raw.error, "子代理 spawn 错误", 2 * 1024));
  }
  assertPlainObject(raw.data, "子代理 spawn 回复 data");
  return {
    id: requireText(raw.data.id, "子代理 ID", 256),
  };
}

export function matchesSubagentEvent(event, { agentId, type } = {}) {
  if (!event || typeof event !== "object") return false;
  if (typeof agentId !== "string" || event.id !== agentId) return false;
  return type === undefined || event.type === type;
}

export function subagentFailureReason(event) {
  const source = event?.error ?? event?.result ?? event?.status ?? "子代理执行失败";
  const text = typeof source === "string" ? source.trim() : JSON.stringify(source);
  if (!text) return "子代理执行失败";
  return text.length > 2 * 1024 ? `${text.slice(0, 2 * 1024 - 1)}…` : text;
}
