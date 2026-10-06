export const ROLE_MODES = ["auto", "confirm", "manual"];
export const DEFAULT_ROLE_MODE = "auto";
export const WORKFLOW_MODES = ["off", "on", "auto"];
export const DEFAULT_WORKFLOW_MODE = "auto";
export const WORKFLOW_EXECUTORS = ["local"];
export const DEFAULT_WORKFLOW_EXECUTOR = "local";
export const WORKFLOW_AUTO_TASK_LIMIT = 2;
export const ROLE_SWITCH_COMPACTION_THRESHOLD = 50;
export const ROLE_CONFIG_SCHEMA_VERSION = 2;
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

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value) {
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

export function shouldCompactOnRoleSwitch({ mode, previousRole, nextRole, contextUsage }) {
  return (
    mode === "auto" &&
    typeof previousRole === "string" &&
    previousRole !== nextRole &&
    contextUsage?.percent != null &&
    contextUsage.percent >= ROLE_SWITCH_COMPACTION_THRESHOLD
  );
}

export function shouldCompactAfterWorkflowTask({ mode, contextUsage }) {
  return (
    mode === "auto" &&
    contextUsage?.percent != null &&
    contextUsage.percent >= ROLE_SWITCH_COMPACTION_THRESHOLD
  );
}

export function findMatchingRole(config, model, thinkingLevel) {
  if (!model) return undefined;

  const roleModels = normalizeRoleModels(config);
  const matches = Object.keys(roleModels).filter((role) => {
    const value = roleModels[role];
    return (
      value.provider === model.provider &&
      value.model === model.id &&
      value.thinkingLevel === thinkingLevel
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export const DEFAULT_ROLE_NAMES = ["architect", "developer-test", "docs-commit"];

export const DEFAULT_ROLE_CONFIG = {
  schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
  mode: DEFAULT_ROLE_MODE,
  workflowMode: DEFAULT_WORKFLOW_MODE,
  workflowExecutor: DEFAULT_WORKFLOW_EXECUTOR,
  roleModels: {},
};

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_LEVEL_SET = new Set(THINKING_LEVELS);
const CONFIG_METADATA_KEYS = new Set([
  "schemaVersion",
  "mode",
  "workflowMode",
  "workflowEnabled",
  "workflowExecutor",
  "roleModels",
  "providerPolicy",
  "runtime",
]);

function configError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function failure(code, message) {
  return { ok: false, code, message };
}

function resultFromError(error, fallbackCode = "ROLE_CONFIG_INVALID") {
  return failure(
    error && typeof error.code === "string" ? error.code : fallbackCode,
    error instanceof Error ? error.message : String(error),
  );
}

export function unwrapRoleResult(result) {
  if (result.ok) return result.value;
  throw configError(result.code, result.message);
}

function configObject(config) {
  if (config === undefined) return {};
  if (!isRecord(config)) throw configError("ROLE_CONFIG_INVALID_TYPE", "角色模型配置必须是对象");
  return config;
}

function validateConfigVersion(config) {
  const version = config.schemaVersion;
  if (version !== undefined && version !== 1 && version !== ROLE_CONFIG_SCHEMA_VERSION) {
    throw configError("ROLE_CONFIG_UNSUPPORTED_VERSION", `不支持的角色模型配置版本：${version}`);
  }
}

function roleModelLike(value) {
  return isRecord(value) && (hasOwn(value, "provider") || hasOwn(value, "model") || hasOwn(value, "thinkingLevel"));
}

function rawRoleModelEntries(config) {
  const source = configObject(config);
  validateConfigVersion(source);
  if (hasOwn(source, "roleModels")) {
    if (!isRecord(source.roleModels)) {
      throw configError("ROLE_MODELS_INVALID_TYPE", "角色模型 roleModels 必须是对象");
    }
    return Object.entries(source.roleModels);
  }

  const legacy = {};
  for (const role of DEFAULT_ROLE_NAMES) {
    if (hasOwn(source, role)) legacy[role] = source[role];
  }
  for (const [role, value] of Object.entries(source)) {
    if (!CONFIG_METADATA_KEYS.has(role) && !hasOwn(legacy, role) && roleModelLike(value)) {
      legacy[role] = value;
    }
  }
  return Object.entries(legacy);
}

function normalizeRoleModel(value, role) {
  if (!isRecord(value)) {
    throw configError("ROLE_MODEL_INVALID_TYPE", `角色 ${role} 的模型配置必须是对象`);
  }

  const { provider, model, thinkingLevel } = value;
  if (typeof provider !== "string" || !provider.trim()) {
    throw configError("ROLE_MODEL_PROVIDER_INVALID", `角色 ${role} 的 provider 无效`);
  }
  if (typeof model !== "string" || !model.trim()) {
    throw configError("ROLE_MODEL_ID_INVALID", `角色 ${role} 的 model 无效`);
  }
  if (!THINKING_LEVEL_SET.has(thinkingLevel)) {
    throw configError("ROLE_MODEL_THINKING_LEVEL_INVALID", `角色 ${role} 的 thinkingLevel 无效：${thinkingLevel}`);
  }

  return { provider: provider.trim(), model: model.trim(), thinkingLevel };
}

function normalizeRoleModels(config) {
  const roleModels = {};
  for (const [rawRole, value] of rawRoleModelEntries(config)) {
    let role;
    try {
      role = normalizeRoleId(rawRole, "角色");
    } catch (error) {
      throw configError("ROLE_ID_INVALID", error instanceof Error ? error.message : String(error));
    }
    if (hasOwn(roleModels, role)) {
      throw configError("ROLE_ID_DUPLICATE", `角色 ID 重复：${role}`);
    }
    roleModels[role] = normalizeRoleModel(value, role);
  }
  return roleModels;
}

export function getRoleNames(config) {
  const resolved = resolveRoleConfig(config);
  if (!resolved.ok) return resolved;
  return { ok: true, value: [...new Set([...DEFAULT_ROLE_NAMES, ...Object.keys(resolved.value.roleModels)])] };
}

export function isRoleAvailable(config, role) {
  const resolved = resolveRoleConfig(config);
  if (!resolved.ok) return resolved;
  let normalizedRole;
  try {
    normalizedRole = normalizeRoleId(role);
  } catch (error) {
    return resultFromError(error, "ROLE_ID_INVALID");
  }
  return {
    ok: true,
    value: DEFAULT_ROLE_NAMES.includes(normalizedRole) || hasOwn(resolved.value.roleModels, normalizedRole),
  };
}

export function resolveRoleMode(config) {
  const mode = config?.mode ?? DEFAULT_ROLE_MODE;
  if (!ROLE_MODES.includes(mode)) {
    throw configError("ROLE_MODE_INVALID", `职责切换模式无效：${mode}`);
  }
  return mode;
}

export function resolveWorkflowMode(config) {
  const configuredMode = config?.workflowMode;
  if (configuredMode !== undefined) {
    if (!WORKFLOW_MODES.includes(configuredMode)) {
      throw configError("WORKFLOW_MODE_INVALID", `工作流模式 workflowMode 无效：${configuredMode}`);
    }
    return configuredMode;
  }

  const legacyEnabled = config?.workflowEnabled;
  if (legacyEnabled === undefined) return DEFAULT_WORKFLOW_MODE;
  if (typeof legacyEnabled !== "boolean") {
    throw configError("WORKFLOW_ENABLED_INVALID", `工作流开关 workflowEnabled 必须是布尔值：${legacyEnabled}`);
  }
  return legacyEnabled ? "on" : "off";
}

function resolveWorkflowExecutorValue(config) {
  const executor = hasOwn(config ?? {}, "workflowExecutor")
    ? config.workflowExecutor
    : DEFAULT_WORKFLOW_EXECUTOR;
  if (executor === "runtime") {
    throw configError("WORKFLOW_EXECUTOR_RETIRED", "workflowExecutor=runtime 已退役；当前仅支持 local 工作流");
  }
  if (!WORKFLOW_EXECUTORS.includes(executor)) {
    throw configError("WORKFLOW_EXECUTOR_INVALID", `工作流执行器 workflowExecutor 无效：${executor}`);
  }
  return executor;
}

export function resolveWorkflowExecutor(config) {
  try {
    return { ok: true, value: resolveWorkflowExecutorValue(config) };
  } catch (error) {
    return resultFromError(error, "WORKFLOW_EXECUTOR_INVALID");
  }
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

export function resolveRoleModel(config, role, sessionDefault) {
  const resolved = resolveRoleConfig(config);
  if (!resolved.ok) return resolved;

  let normalizedRole;
  try {
    normalizedRole = normalizeRoleId(role);
  } catch (error) {
    return resultFromError(error, "ROLE_ID_INVALID");
  }
  const configured = resolved.value.roleModels[normalizedRole];
  if (configured) return { ok: true, value: configured };
  if (!DEFAULT_ROLE_NAMES.includes(normalizedRole)) {
    return failure("ROLE_NOT_ENABLED", `角色 ${normalizedRole} 未启用；请先配置该角色及职责说明`);
  }
  if (!sessionDefault) {
    return failure("SESSION_MODEL_UNAVAILABLE", `角色 ${normalizedRole} 未配置模型，且当前 Pi 会话没有可用的默认模型`);
  }

  try {
    const fallback = normalizeRoleModel({
      provider: sessionDefault.provider,
      model: sessionDefault.model ?? sessionDefault.id,
      thinkingLevel: sessionDefault.thinkingLevel,
    }, normalizedRole);
    return { ok: true, value: fallback };
  } catch (error) {
    return resultFromError(error, "SESSION_MODEL_INVALID");
  }
}

export function filterRoleModels(models, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return models;

  return models.filter((model) =>
    `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase().includes(normalizedQuery),
  );
}

function stagedRoleModels(changes) {
  const result = {};
  if (hasOwn(changes, "roleModels")) {
    if (!isRecord(changes.roleModels)) {
      throw configError("ROLE_MODELS_INVALID_TYPE", "暂存的 roleModels 必须是对象");
    }
    Object.assign(result, changes.roleModels);
  }
  for (const [role, value] of Object.entries(changes)) {
    if (!CONFIG_METADATA_KEYS.has(role) && roleModelLike(value)) result[role] = value;
  }
  return result;
}

function mergeRoleConfigData(base, changes) {
  const baseConfig = configObject(base);
  const changeConfig = configObject(changes);
  const merged = { ...baseConfig, ...changeConfig };
  const roleChanges = stagedRoleModels(changeConfig);
  if (hasOwn(baseConfig, "roleModels") || hasOwn(changeConfig, "roleModels") || Object.keys(roleChanges).length > 0) {
    merged.roleModels = {
      ...normalizeRoleModels(baseConfig),
      ...roleChanges,
    };
  }
  return merged;
}

function parseRoleConfig(source) {
  if (hasOwn(source, "runtime")) {
    throw configError("RUNTIME_CONFIG_RETIRED", "runtime 配置已退役；当前仅支持 local 工作流");
  }
  const roleModels = normalizeRoleModels(source);
  const workflowExecutor = resolveWorkflowExecutor(source);
  if (!workflowExecutor.ok) throw configError(workflowExecutor.code, workflowExecutor.message);
  const resolved = {
    schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
    mode: resolveRoleMode(source),
    workflowMode: resolveWorkflowMode(source),
    workflowExecutor: workflowExecutor.value,
    roleModels,
  };
  for (const [role, model] of Object.entries(roleModels)) {
    Object.defineProperty(resolved, role, { value: model, enumerable: false });
  }
  return resolved;
}

export function resolveRoleConfig(config, changes) {
  try {
    const source = changes === undefined ? configObject(config) : mergeRoleConfigData(config, changes);
    return { ok: true, value: parseRoleConfig(source) };
  } catch (error) {
    return resultFromError(error);
  }
}
