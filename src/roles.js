export const ROLE_NAMES = ["architect", "developer-test", "docs-commit"];
export const ROLE_MODES = ["auto", "confirm", "manual"];
export const DEFAULT_ROLE_MODE = "auto";
export const WORKFLOW_MODES = ["off", "on", "auto"];
export const DEFAULT_WORKFLOW_MODE = "auto";
export const WORKFLOW_EXECUTORS = ["local", "subagents"];
export const DEFAULT_WORKFLOW_EXECUTOR = "local";
export const WORKFLOW_AUTO_TASK_LIMIT = 2;
export const ROLE_SWITCH_COMPACTION_THRESHOLD = 50;
export const PROVIDER_POLICY_MODES = ["locked"];
export const DEFAULT_PROVIDER_POLICY = Object.freeze({
  mode: "locked",
  allowedProviders: Object.freeze(["openai-codex"]),
});

export const ROLE_LABELS = {
  architect: "架构设计",
  "developer-test": "开发测试",
  "docs-commit": "文档收尾",
};

export const ROLE_MODE_LABELS = {
  auto: "自动（推荐）",
  confirm: "确认后切换",
  manual: "手动控制",
};

export function roleLabel(role) {
  return ROLE_LABELS[role] ?? role;
}

export function roleModeLabel(mode) {
  return ROLE_MODE_LABELS[mode] ?? mode;
}

function normalizeProviderName(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} 必须是文本`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.includes("/")) {
    throw new Error(`${label} 无效：${value}`);
  }
  return normalized;
}

/**
 * Resolve the project-level provider policy. A missing policy is deliberately
 * fail-closed so legacy projects cannot start using a newly available provider.
 */
export function resolveProviderPolicy(config) {
  if (config === undefined) {
    return {
      mode: DEFAULT_PROVIDER_POLICY.mode,
      allowedProviders: [...DEFAULT_PROVIDER_POLICY.allowedProviders],
    };
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("providerPolicy 必须是对象");
  }

  const mode = config.mode ?? DEFAULT_PROVIDER_POLICY.mode;
  if (!PROVIDER_POLICY_MODES.includes(mode)) {
    throw new Error(`providerPolicy.mode 无效：${mode}`);
  }
  if (!Array.isArray(config.allowedProviders) || config.allowedProviders.length === 0) {
    throw new Error("providerPolicy.allowedProviders 必须是非空数组");
  }

  const allowedProviders = config.allowedProviders.map((provider, index) =>
    normalizeProviderName(provider, `providerPolicy.allowedProviders[${index}]`),
  );
  if (new Set(allowedProviders).size !== allowedProviders.length) {
    throw new Error("providerPolicy.allowedProviders 不能包含重复 provider");
  }

  return { mode, allowedProviders };
}

export function isProviderAllowed(provider, policy = DEFAULT_PROVIDER_POLICY) {
  if (typeof provider !== "string" || !provider.trim()) return false;
  try {
    const resolvedPolicy = resolveProviderPolicy(policy);
    return resolvedPolicy.allowedProviders.includes(provider.trim());
  } catch {
    return false;
  }
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
 * Normalize an explicit Agent model argument or a Pi Model object.
 * Unqualified aliases (for example `haiku` or `sonnet`) are rejected because
 * their provider is selected by the host and can silently resolve elsewhere.
 */
export function normalizeModelReference(value, label = "模型") {
  return resolveModelReference(value, label);
}

export function isModelAllowed(value, policy = DEFAULT_PROVIDER_POLICY) {
  try {
    const reference = resolveModelReference(value);
    return isProviderAllowed(reference.provider, policy);
  } catch {
    return false;
  }
}

export function assertProviderAllowed(provider, policy, label = "provider") {
  if (!isProviderAllowed(provider, policy)) {
    const resolvedPolicy = resolveProviderPolicy(policy);
    throw new Error(
      `${label} ${provider ?? "<missing>"} 不在允许列表中：${resolvedPolicy.allowedProviders.join(", ")}`,
    );
  }
  return provider.trim();
}

export function assertModelAllowed(value, policy, label = "模型") {
  const reference = resolveModelReference(value, label);
  assertProviderAllowed(reference.provider, policy, `${label} provider`);
  return reference;
}

export function shouldCompactOnRoleSwitch({ mode, previousRole, nextRole, contextUsage }) {
  return (
    mode === "auto" &&
    typeof previousRole === "string" &&
    previousRole !== nextRole &&
    contextUsage?.percent != null &&
    contextUsage.percent >= ROLE_SWITCH_COMPACTION_THRESHOLD
  );
}

export function findMatchingRole(config, model, thinkingLevel) {
  if (!model) return undefined;

  const matches = ROLE_NAMES.filter((role) => {
    const value = config?.[role];
    return (
      value?.provider === model.provider &&
      value?.model === model.id &&
      value?.thinkingLevel === thinkingLevel
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
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

export const DEFAULT_ROLE_CONFIG = {
  providerPolicy: DEFAULT_PROVIDER_POLICY,
  mode: DEFAULT_ROLE_MODE,
  workflowMode: DEFAULT_WORKFLOW_MODE,
  workflowExecutor: DEFAULT_WORKFLOW_EXECUTOR,
  ...DEFAULT_ROLE_MODELS,
};

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_LEVEL_SET = new Set(THINKING_LEVELS);

export function resolveRoleMode(config) {
  const mode = config?.mode ?? DEFAULT_ROLE_MODE;
  if (!ROLE_MODES.includes(mode)) {
    throw new Error(`职责切换模式无效：${mode}`);
  }
  return mode;
}

export function resolveWorkflowMode(config) {
  const configuredMode = config?.workflowMode;
  if (configuredMode !== undefined) {
    if (!WORKFLOW_MODES.includes(configuredMode)) {
      throw new Error(`工作流模式 workflowMode 无效：${configuredMode}`);
    }
    return configuredMode;
  }

  const legacyEnabled = config?.workflowEnabled;
  if (legacyEnabled === undefined) return DEFAULT_WORKFLOW_MODE;
  if (typeof legacyEnabled !== "boolean") {
    throw new Error(`工作流开关 workflowEnabled 必须是布尔值：${legacyEnabled}`);
  }
  return legacyEnabled ? "on" : "off";
}

export function resolveWorkflowExecutor(config) {
  const executor = config?.workflowExecutor ?? DEFAULT_WORKFLOW_EXECUTOR;
  if (!WORKFLOW_EXECUTORS.includes(executor)) {
    throw new Error(`工作流执行器 workflowExecutor 无效：${executor}`);
  }
  return executor;
}

export function shouldOrchestrateWorkflow({ mode, taskCount }) {
  if (!WORKFLOW_MODES.includes(mode)) {
    throw new Error(`工作流模式 workflowMode 无效：${mode}`);
  }
  if (!Number.isInteger(taskCount) || taskCount < 1) {
    throw new Error(`工作流任务数无效：${taskCount}`);
  }

  return mode === "on" || (mode === "auto" && taskCount > WORKFLOW_AUTO_TASK_LIMIT);
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
  if (!THINKING_LEVEL_SET.has(thinkingLevel)) {
    throw new Error(`职责 ${role} 的 thinkingLevel 无效：${thinkingLevel}`);
  }

  return { provider: provider.trim(), model: model.trim(), thinkingLevel };
}

export function filterRoleModels(models, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return models;

  return models.filter((model) =>
    `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase().includes(normalizedQuery),
  );
}

export function resolveRoleConfig(config) {
  const providerPolicy = resolveProviderPolicy(config?.providerPolicy);
  const resolved = {
    providerPolicy,
    mode: resolveRoleMode(config),
    workflowMode: resolveWorkflowMode(config),
    workflowExecutor: resolveWorkflowExecutor(config),
  };
  for (const role of ROLE_NAMES) {
    const model = resolveRoleModel(config, role);
    assertProviderAllowed(model.provider, providerPolicy, `职责 ${role} provider`);
    resolved[role] = model;
  }
  return resolved;
}
