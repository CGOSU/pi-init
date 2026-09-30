import {
  CONFIG_METADATA_KEYS,
  DEFAULT_ROLE_MODE,
  DEFAULT_ROLE_MODELS,
  DEFAULT_ROLE_NAMES,
  DEFAULT_ROLE_TIER_CONFIG,
  DEFAULT_WORKFLOW_EXECUTOR,
  DEFAULT_WORKFLOW_MODE,
  ROLE_CONFIG_SCHEMA_VERSION,
  ROLE_CONFIG_VERSIONS,
  ROLE_ID_PATTERN,
  ROLE_MODES,
  THINKING_LEVEL_SET,
  WORKFLOW_EXECUTORS,
  WORKFLOW_MODES,
  hasOwn,
  isRecord,
  normalizeProviderName,
  normalizeRoleId,
} from "./role-config-definitions.js";

function configObject(config) {
  if (config === undefined || config === null) return {};
  if (!isRecord(config)) throw new Error("角色模型配置格式无效");
  return config;
}

function hasTierLayers(config) {
  return hasOwn(config, "roleTiers") || hasOwn(config, "tiers") || hasOwn(config, "models");
}

function validateConfigVersion(config) {
  const version = config.schemaVersion;
  if (version !== undefined && !ROLE_CONFIG_VERSIONS.has(version)) {
    throw new Error(`不支持的角色模型配置版本：${version}`);
  }
  if (version === ROLE_CONFIG_SCHEMA_VERSION) {
    for (const field of ["roleTiers", "tiers", "models"]) {
      if (!hasOwn(config, field)) throw new Error(`角色模型配置缺少 ${field}`);
    }
  } else if (hasTierLayers(config)) {
    throw new Error("角色分层配置必须使用 schemaVersion 3");
  } else if (version === 2 && !hasOwn(config, "roleModels")) {
    throw new Error("schemaVersion 2 角色模型配置缺少 roleModels 映射");
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
      throw new Error("角色模型 roleModels 必须是对象");
    }
    return Object.entries(source.roleModels);
  }

  const legacy = {};
  for (const role of DEFAULT_ROLE_NAMES) {
    legacy[role] = source[role] ?? DEFAULT_ROLE_MODELS[role];
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
    throw new Error(`角色 ${role} 缺少模型配置`);
  }

  const { provider, model, thinkingLevel } = value;
  if (typeof provider !== "string" || !provider.trim()) {
    throw new Error(`角色 ${role} 的 provider 无效`);
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new Error(`角色 ${role} 的 model 无效`);
  }
  if (!THINKING_LEVEL_SET.has(thinkingLevel)) {
    throw new Error(`角色 ${role} 的 thinkingLevel 无效：${thinkingLevel}`);
  }

  return { provider: provider.trim(), model: model.trim(), thinkingLevel };
}

function normalizeConfigId(value, label) {
  if (typeof value !== "string") throw new Error(`${label}必须是文本`);
  const normalized = value.trim();
  if (!ROLE_ID_PATTERN.test(normalized)) throw new Error(`${label}无效：${value}`);
  return normalized;
}

function normalizeModelEntry(value, modelRef) {
  if (!isRecord(value)) throw new Error(`模型 ${modelRef} 配置格式无效`);
  const provider = normalizeProviderName(value.provider, `模型 ${modelRef} provider`);
  if (typeof value.model !== "string" || !value.model.trim()) {
    throw new Error(`模型 ${modelRef} 的 model 无效`);
  }
  return { provider, model: value.model.trim() };
}

function normalizeModelTable(source) {
  if (!isRecord(source.models)) throw new Error("角色模型 models 必须是对象");
  const models = {};
  const modelIdentities = new Map();
  for (const [rawModelRef, value] of Object.entries(source.models)) {
    const modelRef = normalizeConfigId(rawModelRef, "modelRef");
    if (hasOwn(models, modelRef)) throw new Error(`modelRef 重复：${modelRef}`);
    const model = normalizeModelEntry(value, modelRef);
    const identity = JSON.stringify([model.provider, model.model]);
    const duplicate = modelIdentities.get(identity);
    if (duplicate) throw new Error(`models 中 provider/model 重复：${duplicate} 与 ${modelRef}`);
    modelIdentities.set(identity, modelRef);
    models[modelRef] = model;
  }
  return models;
}

function normalizeTierTable(source, models) {
  if (!isRecord(source.tiers)) throw new Error("角色模型 tiers 必须是对象");
  const tiers = {};
  for (const [rawTierRef, value] of Object.entries(source.tiers)) {
    const tierRef = normalizeConfigId(rawTierRef, "tier");
    if (hasOwn(tiers, tierRef)) throw new Error(`tier ID 重复：${tierRef}`);
    if (!isRecord(value)) throw new Error(`档位 ${tierRef} 配置格式无效`);
    const modelRef = normalizeConfigId(value.modelRef, `档位 ${tierRef} modelRef`);
    if (!hasOwn(models, modelRef)) throw new Error(`档位 ${tierRef} 引用了未配置的模型：${modelRef}`);
    if (!THINKING_LEVEL_SET.has(value.thinkingLevel)) {
      throw new Error(`档位 ${tierRef} 的 thinkingLevel 无效：${value.thinkingLevel}`);
    }
    tiers[tierRef] = { modelRef, thinkingLevel: value.thinkingLevel };
  }
  return tiers;
}

function resolveRoleTierAssignments(source, tiers, models) {
  if (!isRecord(source.roleTiers)) throw new Error("角色模型 roleTiers 必须是对象");
  const roleTiers = {};
  const roleModels = {};
  for (const [rawRole, rawTierRef] of Object.entries(source.roleTiers)) {
    const role = normalizeRoleId(rawRole, "角色");
    if (hasOwn(roleTiers, role)) throw new Error(`角色 ID 重复：${role}`);
    const tierRef = normalizeConfigId(rawTierRef, `角色 ${role} tier`);
    const tier = tiers[tierRef];
    if (!tier) throw new Error(`角色 ${role} 引用了未配置的档位：${tierRef}`);
    roleTiers[role] = tierRef;
    roleModels[role] = { ...models[tier.modelRef], thinkingLevel: tier.thinkingLevel };
  }
  return { roleTiers, roleModels };
}

function assertRoleModelProjection(config, roleModels) {
  if (!hasOwn(config, "roleModels")) return;
  if (!isRecord(config.roleModels)) throw new Error("角色模型 roleModels 必须是对象");
  const declared = {};
  for (const [rawRole, value] of Object.entries(config.roleModels)) {
    const role = normalizeRoleId(rawRole, "角色");
    if (hasOwn(declared, role)) throw new Error(`角色 ID 重复：${role}`);
    declared[role] = normalizeRoleModel(value, role);
  }
  const names = Object.keys(roleModels).sort();
  if (JSON.stringify(Object.keys(declared).sort()) !== JSON.stringify(names)
    || names.some((role) => JSON.stringify(declared[role]) !== JSON.stringify(roleModels[role]))) {
    throw new Error("roleModels 与 roleTiers/tier/model 解析结果不一致");
  }
}

function flatRoleModelsFromLayers(config) {
  for (const field of ["roleTiers", "tiers", "models"]) {
    if (!isRecord(config[field])) throw new Error(`角色模型 ${field} 必须是对象`);
  }
  const models = normalizeModelTable(config);
  const tiers = normalizeTierTable(config, models);
  const { roleTiers, roleModels } = resolveRoleTierAssignments(config, tiers, models);
  assertRoleModelProjection(config, roleModels);
  return { roleTiers, tiers, models, roleModels };
}

function legacyRoleModels(config) {
  const roleModels = {};
  for (const [rawRole, value] of rawRoleModelEntries(config)) {
    const role = normalizeRoleId(rawRole, "角色");
    if (hasOwn(roleModels, role)) throw new Error(`角色 ID 重复：${role}`);
    roleModels[role] = normalizeRoleModel(value, role);
  }
  return roleModels;
}

function migrateRoleModelsToLayers(roleModels) {
  const roleTiers = {};
  const tiers = {};
  const models = {};
  const modelRefs = new Map();
  const tierRefs = new Map();

  for (const [role, model] of Object.entries(roleModels)) {
    const modelIdentity = JSON.stringify([model.provider, model.model]);
    let modelRef = modelRefs.get(modelIdentity);
    if (!modelRef) {
      modelRef = `model-${modelRefs.size + 1}`;
      modelRefs.set(modelIdentity, modelRef);
      models[modelRef] = { provider: model.provider, model: model.model };
    }

    const tierIdentity = JSON.stringify([modelRef, model.thinkingLevel]);
    let tierRef = tierRefs.get(tierIdentity);
    if (!tierRef) {
      tierRef = `tier-${tierRefs.size + 1}`;
      tierRefs.set(tierIdentity, tierRef);
      tiers[tierRef] = { modelRef, thinkingLevel: model.thinkingLevel };
    }
    roleTiers[role] = tierRef;
  }

  return flatRoleModelsFromLayers({ roleTiers, tiers, models });
}

function hasLegacyRoleEntries(config) {
  return hasOwn(config, "roleModels") || Object.entries(config).some(
    ([key, value]) => !CONFIG_METADATA_KEYS.has(key) && roleModelLike(value),
  );
}

function normalizeRoleLayers(config) {
  const source = configObject(config);
  validateConfigVersion(source);
  if (source.schemaVersion === ROLE_CONFIG_SCHEMA_VERSION || hasTierLayers(source)) {
    return flatRoleModelsFromLayers(source);
  }
  if (hasLegacyRoleEntries(source)) return migrateRoleModelsToLayers(legacyRoleModels(source));
  return flatRoleModelsFromLayers(DEFAULT_ROLE_TIER_CONFIG);
}

export function normalizeRoleModels(config) {
  return normalizeRoleLayers(config).roleModels;
}

export function getRoleNames(config) {
  return Object.keys(normalizeRoleModels(config));
}

export function isRoleConfigured(config, role) {
  const normalizedRole = normalizeRoleId(role);
  return hasOwn(normalizeRoleModels(config), normalizedRole);
}

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

export function resolveRuntimeConfig(config) {
  const runtime = config?.runtime;
  if (runtime === undefined) return undefined;
  if (!isRecord(runtime)) throw new Error("runtime 配置必须是对象");
  const allowed = new Set(["endpoint", "agentBackend", "permissionProfile", "timeoutMs", "retries", "maxFrameBytes"]);
  for (const key of Object.keys(runtime)) {
    if (!allowed.has(key)) throw new Error(`runtime 配置包含未知字段：${key}`);
  }
  for (const [field, label] of [["endpoint", "endpoint"], ["agentBackend", "agentBackend"], ["permissionProfile", "permissionProfile"]]) {
    if (typeof runtime[field] !== "string" || !runtime[field].trim()) {
      throw new Error(`runtime.${label} 必须是非空字符串`);
    }
  }
  for (const field of ["timeoutMs", "retries", "maxFrameBytes"]) {
    if (runtime[field] !== undefined && (!Number.isInteger(runtime[field]) || runtime[field] < 0)) {
      throw new Error(`runtime.${field} 必须是非负整数`);
    }
  }
  if (runtime.timeoutMs !== undefined && runtime.timeoutMs === 0) throw new Error("runtime.timeoutMs 必须大于 0");
  if (runtime.maxFrameBytes !== undefined && runtime.maxFrameBytes === 0) throw new Error("runtime.maxFrameBytes 必须大于 0");
  const normalized = {
    endpoint: runtime.endpoint.trim(),
    agentBackend: runtime.agentBackend.trim(),
    permissionProfile: runtime.permissionProfile.trim(),
  };
  if (runtime.timeoutMs !== undefined) normalized.timeoutMs = runtime.timeoutMs;
  if (runtime.retries !== undefined) normalized.retries = runtime.retries;
  if (runtime.maxFrameBytes !== undefined) normalized.maxFrameBytes = runtime.maxFrameBytes;
  return normalized;
}

export function resolveRoleModel(config, role) {
  const normalizedRole = normalizeRoleId(role);
  const roleModels = normalizeRoleModels(config);
  if (!hasOwn(roleModels, normalizedRole)) {
    throw new Error(`角色 ${normalizedRole} 未配置模型；请先执行 /pi-init config ${normalizedRole}`);
  }
  return roleModels[normalizedRole];
}

function stagedRoleModels(changes) {
  const result = {};
  if (hasOwn(changes, "roleModels")) {
    if (!isRecord(changes.roleModels)) {
      throw new Error("暂存的 roleModels 必须是对象");
    }
    Object.assign(result, changes.roleModels);
  }
  for (const [role, value] of Object.entries(changes)) {
    if (!CONFIG_METADATA_KEYS.has(role) && roleModelLike(value)) result[role] = value;
  }
  return result;
}

function nextConfigId(prefix, records) {
  let suffix = 1;
  let id = `${prefix}-${suffix}`;
  while (hasOwn(records, id)) {
    suffix += 1;
    id = `${prefix}-${suffix}`;
  }
  return id;
}

function applyRoleModelOverride(layers, rawRole, value) {
  const role = normalizeRoleId(rawRole, "角色");
  const model = normalizeRoleModel(value, role);
  let modelRef = Object.keys(layers.models).find((candidate) =>
    layers.models[candidate].provider === model.provider && layers.models[candidate].model === model.model,
  );
  if (!modelRef) {
    modelRef = nextConfigId("model", layers.models);
    layers.models[modelRef] = { provider: model.provider, model: model.model };
  }

  const currentTierRef = layers.roleTiers[role];
  const tierIsShared = currentTierRef && Object.entries(layers.roleTiers).some(
    ([otherRole, tierRef]) => otherRole !== role && tierRef === currentTierRef,
  );
  const tierRef = currentTierRef && !tierIsShared
    ? currentTierRef
    : nextConfigId(`override-${role}`, layers.tiers);
  layers.tiers[tierRef] = { modelRef, thinkingLevel: model.thinkingLevel };
  layers.roleTiers[role] = tierRef;
}

function mergeTierLayers(baseLayers, changes) {
  const layers = {
    roleTiers: { ...baseLayers.roleTiers },
    tiers: { ...baseLayers.tiers },
    models: { ...baseLayers.models },
  };
  for (const field of ["roleTiers", "tiers", "models"]) {
    if (!hasOwn(changes, field)) continue;
    if (!isRecord(changes[field])) throw new Error(`角色模型 ${field} 必须是对象`);
    layers[field] = { ...layers[field], ...changes[field] };
  }
  const normalized = flatRoleModelsFromLayers(layers);
  return {
    roleTiers: normalized.roleTiers,
    tiers: normalized.tiers,
    models: normalized.models,
  };
}

function withoutLegacyRoleEntries(config) {
  const result = { ...config };
  for (const field of ["roleModels", "roleTiers", "tiers", "models"]) delete result[field];
  for (const [key, value] of Object.entries(result)) {
    if (!CONFIG_METADATA_KEYS.has(key) && roleModelLike(value)) delete result[key];
  }
  return result;
}

export function mergeRoleConfig(base, changes) {
  const baseConfig = configObject(base);
  const changeConfig = configObject(changes);
  const merged = { ...baseConfig, ...changeConfig };
  const roleChanges = stagedRoleModels(changeConfig);
  const hasRoleConfig = hasTierLayers(baseConfig) || hasTierLayers(changeConfig)
    || hasOwn(baseConfig, "roleModels") || hasOwn(changeConfig, "roleModels")
    || Object.keys(roleChanges).length > 0;
  if (!hasRoleConfig) return merged;

  const layers = mergeTierLayers(normalizeRoleLayers(baseConfig), changeConfig);
  for (const [role, model] of Object.entries(roleChanges)) {
    applyRoleModelOverride(layers, role, model);
  }
  const normalizedLayers = flatRoleModelsFromLayers(layers);
  return {
    ...withoutLegacyRoleEntries(merged),
    schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
    roleTiers: normalizedLayers.roleTiers,
    tiers: normalizedLayers.tiers,
    models: normalizedLayers.models,
  };
}

export function resolveRoleConfig(config) {
  const source = configObject(config);
  const layers = normalizeRoleLayers(source);
  const runtime = resolveRuntimeConfig(source);
  const resolved = {
    schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
    mode: resolveRoleMode(source),
    workflowMode: resolveWorkflowMode(source),
    workflowExecutor: resolveWorkflowExecutor(source),
    roleTiers: layers.roleTiers,
    tiers: layers.tiers,
    models: layers.models,
    roleModels: layers.roleModels,
  };
  if (runtime) resolved.runtime = runtime;
  for (const [role, model] of Object.entries(layers.roleModels)) {
    Object.defineProperty(resolved, role, { value: model, enumerable: false });
  }
  return resolved;
}

export function serializeRoleConfig(config) {
  const persisted = { ...resolveRoleConfig(config) };
  delete persisted.roleModels;
  return persisted;
}
