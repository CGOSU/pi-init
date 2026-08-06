export const ROLE_NAMES = ["architect", "developer-test", "docs-commit"];
export const ROLE_MODES = ["auto", "confirm", "manual"];
export const DEFAULT_ROLE_MODE = "auto";

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

export const DEFAULT_ROLE_CONFIG = {
  mode: DEFAULT_ROLE_MODE,
  ...DEFAULT_ROLE_MODELS,
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function resolveRoleMode(config) {
  const mode = config?.mode ?? DEFAULT_ROLE_MODE;
  if (!ROLE_MODES.includes(mode)) {
    throw new Error(`职责切换模式无效：${mode}`);
  }
  return mode;
}

export function resolveRoleModel(config, role) {
  if (!ROLE_NAMES.includes(role)) {
    throw new Error(`未知职责：${role}`);
  }

  const value = config?.[role] ?? DEFAULT_ROLE_MODELS[role];
  if (!value || typeof value !== "object") {
    throw new Error(`职责 ${role} 缺少模型配置`);
  }

  const { provider, model, thinkingLevel } = value;
  if (typeof provider !== "string" || !provider.trim()) {
    throw new Error(`职责 ${role} 的 provider 无效`);
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new Error(`职责 ${role} 的 model 无效`);
  }
  if (!THINKING_LEVELS.has(thinkingLevel)) {
    throw new Error(`职责 ${role} 的 thinkingLevel 无效：${thinkingLevel}`);
  }

  return { provider: provider.trim(), model: model.trim(), thinkingLevel };
}
