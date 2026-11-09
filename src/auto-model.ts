import { isRecord } from "./value-guards.ts";
import type { AutoModelConfig, RoleConfigResult, ThinkingLevel } from "./role-types.ts";

export const AUTO_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function parseAutoModel(value: unknown): RoleConfigResult<AutoModelConfig> {
  if (!isRecord(value)) return { ok: false, code: "AUTO_MODEL_TYPE_INVALID", message: "Auto 固定模型配置必须是对象" };
  for (const field of ["provider", "model"] as const) {
    if (typeof value[field] !== "string" || !value[field].trim()) {
      return { ok: false, code: `AUTO_${field.toUpperCase()}_MISSING`, message: `Auto ${field} 必须是非空字符串` };
    }
  }
  for (const field of ["initialThinkingLevel", "minThinkingLevel", "maxThinkingLevel"] as const) {
    if (!AUTO_THINKING_LEVELS.includes(value[field] as ThinkingLevel)) {
      return { ok: false, code: "AUTO_THINKING_LEVEL_INVALID", message: `Auto ${field} 不是合法的推理强度` };
    }
  }
  const config = value as unknown as AutoModelConfig;
  const initial = AUTO_THINKING_LEVELS.indexOf(config.initialThinkingLevel);
  if (AUTO_THINKING_LEVELS.indexOf(config.minThinkingLevel) > initial || initial > AUTO_THINKING_LEVELS.indexOf(config.maxThinkingLevel)) {
    return { ok: false, code: "AUTO_THINKING_RANGE_INVALID", message: "Auto 起始强度必须在最小和最大强度之间" };
  }
  return { ok: true, value: { provider: config.provider.trim(), model: config.model.trim(), initialThinkingLevel: config.initialThinkingLevel, minThinkingLevel: config.minThinkingLevel, maxThinkingLevel: config.maxThinkingLevel } };
}

export function validateAutoModelCapabilities(config: AutoModelConfig, supported: readonly string[]): RoleConfigResult<AutoModelConfig> {
  for (const level of [config.initialThinkingLevel, config.minThinkingLevel, config.maxThinkingLevel]) {
    if (!supported.includes(level)) return { ok: false, code: "AUTO_THINKING_UNSUPPORTED", message: `Auto 固定模型不支持推理强度 ${level}` };
  }
  return { ok: true, value: config };
}

export function validateAutoSuggestion(config: AutoModelConfig, supported: readonly string[], level: unknown, current: ThinkingLevel, allowLower: boolean): RoleConfigResult<ThinkingLevel> {
  const index = AUTO_THINKING_LEVELS.indexOf(level as ThinkingLevel);
  if (index < 0) return { ok: false, code: "AUTO_THINKING_LEVEL_INVALID", message: "建议的推理强度不合法" };
  if (index < AUTO_THINKING_LEVELS.indexOf(config.minThinkingLevel) || index > AUTO_THINKING_LEVELS.indexOf(config.maxThinkingLevel)) {
    return { ok: false, code: "AUTO_THINKING_OUT_OF_RANGE", message: "建议的推理强度超出 Auto 允许范围" };
  }
  if (!supported.includes(level as string)) return { ok: false, code: "AUTO_THINKING_UNSUPPORTED", message: "固定模型不支持建议的推理强度" };
  if (!allowLower && index < AUTO_THINKING_LEVELS.indexOf(current)) return { ok: false, code: "AUTO_TASK_DOWNGRADE_DENIED", message: "同一任务内仅允许保持或提高强度；请在新任务边界重新评估" };
  return { ok: true, value: level as ThinkingLevel };
}
