export const ROLE_MODES = ["auto", "confirm", "manual"];
export const DEFAULT_ROLE_MODE = "auto";
export const WORKFLOW_MODES = ["off", "on", "auto"];
export const DEFAULT_WORKFLOW_MODE = "auto";
export const WORKFLOW_EXECUTORS = ["local", "runtime"];
export const DEFAULT_WORKFLOW_EXECUTOR = "local";
export const WORKFLOW_AUTO_TASK_LIMIT = 2;
export const ROLE_SWITCH_COMPACTION_THRESHOLD = 50;
export const ROLE_CONFIG_SCHEMA_VERSION = 3;
export const ROLE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const ROLE_LABELS = {
  architect: "架构设计",
  "developer-test": "开发测试",
  "docs-commit": "文档收尾",
};

export const ROLE_MODE_LABELS = {
  auto: "自动（推荐）",
  confirm: "确认后切换",
  manual: "手动（直连宿主）",
};

export function roleLabel(role) {
  return ROLE_LABELS[role] ?? role;
}

export function roleModeLabel(mode) {
  return ROLE_MODE_LABELS[mode] ?? mode;
}

export function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isValidRoleId(value) {
  return typeof value === "string" && ROLE_ID_PATTERN.test(value);
}

export function normalizeRoleId(value, label = "角色") {
  if (typeof value !== "string") {
    throw new Error(`${label}必须是文本`);
  }
  const normalized = value.trim();
  if (!isValidRoleId(normalized)) {
    throw new Error(`${label}无效：${value}`);
  }
  return normalized;
}

export function normalizeProviderName(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} 必须是文本`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.includes("/")) {
    throw new Error(`${label} 无效：${value}`);
  }
  return normalized;
}

function resolveModelReference(value, label = "模型") {
  if (typeof value === "string") {
    const normalized = value.trim();
    const separator = normalized.indexOf("/");
    const model = normalized.slice(separator + 1).trim();
    if (separator <= 0 || !model) {
      throw new Error(`${label} 必须显式指定 provider/model：${value}`);
    }
    return {
      provider: normalizeProviderName(normalized.slice(0, separator), `${label} provider`),
      model,
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是 provider/model 文本或模型对象`);
  }
  const provider = normalizeProviderName(value.provider, `${label} provider`);
  const model = value.model ?? value.id;
  if (typeof model !== "string" || !model.trim()) {
    throw new Error(`${label} model 无效`);
  }
  return { provider, model: model.trim() };
}

/**
 * Normalize a fully qualified model argument or a Pi Model object.
 */
export function normalizeModelReference(value, label = "模型") {
  return resolveModelReference(value, label);
}

export const DEFAULT_ROLE_MODELS = {
  architect: {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinkingLevel: "max",
  },
  "developer-test": {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinkingLevel: "max",
  },
  "docs-commit": {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinkingLevel: "medium",
  },
};

export const DEFAULT_ROLE_NAMES = Object.keys(DEFAULT_ROLE_MODELS);

// Keep the flat default as a v2 input for callers that still build legacy roleModels configs.
export const DEFAULT_ROLE_CONFIG = {
  schemaVersion: 2,
  mode: DEFAULT_ROLE_MODE,
  workflowMode: DEFAULT_WORKFLOW_MODE,
  workflowExecutor: DEFAULT_WORKFLOW_EXECUTOR,
  roleModels: Object.fromEntries(
    DEFAULT_ROLE_NAMES.map((role) => [role, { ...DEFAULT_ROLE_MODELS[role] }]),
  ),
};

export const DEFAULT_ROLE_TIER_CONFIG = {
  schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
  mode: DEFAULT_ROLE_MODE,
  workflowMode: DEFAULT_WORKFLOW_MODE,
  workflowExecutor: DEFAULT_WORKFLOW_EXECUTOR,
  roleTiers: {
    architect: "reasoning",
    "developer-test": "coding",
    "docs-commit": "documentation",
  },
  tiers: {
    reasoning: { modelRef: "model-sol", thinkingLevel: "max" },
    coding: { modelRef: "model-luna", thinkingLevel: "max" },
    documentation: { modelRef: "model-luna", thinkingLevel: "medium" },
  },
  models: {
    "model-sol": { provider: "openai-codex", model: "gpt-5.6-sol" },
    "model-luna": { provider: "openai-codex", model: "gpt-5.6-luna" },
  },
};

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const THINKING_LEVEL_SET = new Set(THINKING_LEVELS);
export const ROLE_CONFIG_VERSIONS = new Set([1, 2, ROLE_CONFIG_SCHEMA_VERSION]);
export const CONFIG_METADATA_KEYS = new Set([
  "schemaVersion",
  "mode",
  "workflowMode",
  "workflowEnabled",
  "workflowExecutor",
  "roleModels",
  "roleTiers",
  "tiers",
  "models",
  "providerPolicy",
  "runtime",
]);
