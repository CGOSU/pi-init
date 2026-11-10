import { textOf } from "./error-utils.ts";
import { parseAutoModel } from "./auto-model.ts";
import { hasOwn, isRecord, isStringMember as isOneOf } from "./value-guards.ts";
import type {
  DefaultRoleName,
  ModelReference,
  RoleConfigResult,
  RoleModelConfig,
  RoleModelOption,
  ResolvedRoleConfig,
  ThinkingLevel,
  WorkflowExecutor,
  WorkflowMode,
} from "./role-types.ts";

export const WORKFLOW_MODES = ["off", "on", "auto"] as const satisfies readonly WorkflowMode[];
export const DEFAULT_WORKFLOW_MODE: WorkflowMode = "auto";
export const WORKFLOW_EXECUTORS = ["local"] as const satisfies readonly WorkflowExecutor[];
export const DEFAULT_WORKFLOW_EXECUTOR: WorkflowExecutor = "local";
export const WORKFLOW_AUTO_TASK_LIMIT = 2;
export const ROLE_CONFIG_SCHEMA_VERSION = 3;
export const ROLE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const ROLE_LABELS: Record<string, string> = {
  architect: "架构设计",
  "developer-test": "开发测试",
  "docs-commit": "文档收尾",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

function readProperty(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" && typeof value !== "function") return undefined;
  return Reflect.get(value, key);
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return isOneOf(THINKING_LEVELS, value);
}

export function isValidRoleId(value: unknown): value is string {
  return typeof value === "string" && ROLE_ID_PATTERN.test(value);
}

export function normalizeRoleId(value: unknown, label = "角色"): RoleConfigResult<string> {
  if (typeof value !== "string") {
    return failure("ROLE_ID_TYPE_INVALID", `${label}必须是文本`);
  }
  const normalized = value.trim();
  if (!isValidRoleId(normalized)) {
    return failure("ROLE_ID_INVALID", `${label}无效：${value}`);
  }
  return { ok: true, value: normalized };
}

function normalizeProviderName(value: unknown, label: string): RoleConfigResult<string> {
  if (typeof value !== "string") {
    return failure("MODEL_PROVIDER_TYPE_INVALID", `${label} 必须是文本`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.includes("/")) {
    return failure("MODEL_PROVIDER_INVALID", `${label} 无效：${value}`);
  }
  return { ok: true, value: normalized };
}

function resolveModelReference(value: unknown, label = "模型"): RoleConfigResult<ModelReference> {
  if (typeof value === "string") {
    const normalized = value.trim();
    const separator = normalized.indexOf("/");
    const model = normalized.slice(separator + 1).trim();
    if (separator <= 0 || !model) {
      return failure("MODEL_REFERENCE_FORMAT_INVALID", `${label} 必须显式指定 provider/model：${value}`);
    }
    const provider = normalizeProviderName(normalized.slice(0, separator), `${label} provider`);
    if (!provider.ok) return provider;
    return { ok: true, value: { provider: provider.value, model } };
  }

  if (!isRecord(value)) {
    return failure("MODEL_REFERENCE_TYPE_INVALID", `${label} 必须是 provider/model 文本或模型对象`);
  }
  const provider = normalizeProviderName(value.provider, `${label} provider`);
  if (!provider.ok) return provider;
  const model = value.model ?? value.id;
  if (typeof model !== "string" || !model.trim()) {
    return failure("MODEL_REFERENCE_MODEL_INVALID", `${label} model 无效`);
  }
  return { ok: true, value: { provider: provider.value, model: model.trim() } };
}

/** Normalize a fully qualified model argument or a Pi Model object. */
export function normalizeModelReference(value: unknown, label = "模型"): RoleConfigResult<ModelReference> {
  return resolveModelReference(value, label);
}

export function findMatchingRole(
  config: unknown,
  model: { provider: string; id: string } | undefined,
  thinkingLevel: ThinkingLevel,
): string | undefined {
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

export const DEFAULT_ROLE_NAMES = ["architect", "developer-test", "docs-commit"] as const satisfies readonly DefaultRoleName[];
const DEFAULT_ROLE_NAME_SET: ReadonlySet<string> = new Set(DEFAULT_ROLE_NAMES);

export const DEFAULT_ROLE_CONFIG: ResolvedRoleConfig = {
  schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
  workflowMode: DEFAULT_WORKFLOW_MODE,
  workflowExecutor: DEFAULT_WORKFLOW_EXECUTOR,
  roleModels: {},
};

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];
const CONFIG_METADATA_KEYS = new Set([
  "schemaVersion",
  "mode",
  "requiresAutomaticMigration",
  "workflowMode",
  "workflowEnabled",
  "workflowExecutor",
  "roleModels",
  "modelStrategy",
  "autoModel",
  "providerPolicy",
  "runtime",
]);

class RoleConfigError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "Error";
    this.code = code;
  }
}

function configError(code: string, message: string): RoleConfigError {
  return new RoleConfigError(code, message);
}

function failure(code: string, message: string): RoleConfigResult<never> {
  return { ok: false, code, message };
}

function resultFromError(error: unknown, fallbackCode = "ROLE_CONFIG_INVALID"): RoleConfigResult<never> {
  const errorCode = isRecord(error) && typeof error.code === "string" ? error.code : fallbackCode;
  return failure(errorCode, textOf(error));
}

export function unwrapRoleResult<T>(result: RoleConfigResult<T>): T {
  if (result.ok) return result.value;
  throw configError(result.code, result.message);
}

function configObject(config: unknown): Record<string, unknown> {
  if (config === undefined) return {};
  if (!isRecord(config)) throw configError("ROLE_CONFIG_INVALID_TYPE", "角色模型配置必须是对象");
  return config;
}

function validateConfigVersion(config: Record<string, unknown>): void {
  const version = config.schemaVersion;
  if (version !== undefined && version !== 1 && version !== 2 && version !== ROLE_CONFIG_SCHEMA_VERSION) {
    throw configError("ROLE_CONFIG_UNSUPPORTED_VERSION", `不支持的角色模型配置版本：${version}`);
  }
}

function roleModelLike(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (hasOwn(value, "provider") || hasOwn(value, "model") || hasOwn(value, "thinkingLevel"));
}

function rawRoleModelEntries(config: unknown): [string, unknown][] {
  const source = configObject(config);
  validateConfigVersion(source);
  if (hasOwn(source, "roleModels")) {
    if (!isRecord(source.roleModels)) {
      throw configError("ROLE_MODELS_INVALID_TYPE", "角色模型 roleModels 必须是对象");
    }
    return Object.entries(source.roleModels);
  }

  const legacy: Record<string, unknown> = {};
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

function normalizeRoleModel(value: unknown, role: string): RoleModelConfig {
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
  if (!isOneOf(THINKING_LEVELS, thinkingLevel)) {
    throw configError("ROLE_MODEL_THINKING_LEVEL_INVALID", `角色 ${role} 的 thinkingLevel 无效：${thinkingLevel}`);
  }

  return { provider: provider.trim(), model: model.trim(), thinkingLevel };
}

function normalizeRoleModels(config: unknown): Record<string, RoleModelConfig> {
  const roleModels: Record<string, RoleModelConfig> = {};
  for (const [rawRole, value] of rawRoleModelEntries(config)) {
    const normalizedRole = normalizeRoleId(rawRole, "角色");
    if (!normalizedRole.ok) throw configError("ROLE_ID_INVALID", normalizedRole.message);
    const role = normalizedRole.value;
    if (hasOwn(roleModels, role)) {
      throw configError("ROLE_ID_DUPLICATE", `角色 ID 重复：${role}`);
    }
    roleModels[role] = normalizeRoleModel(value, role);
  }
  return roleModels;
}

export function getRoleNames(config: unknown): RoleConfigResult<string[]> {
  const resolved = resolveRoleConfig(config);
  if (!resolved.ok) return resolved;
  return { ok: true, value: [...new Set([...DEFAULT_ROLE_NAMES, ...Object.keys(resolved.value.roleModels)])] };
}

export function validateAutomaticSwitching(config: ResolvedRoleConfig): RoleConfigResult<ResolvedRoleConfig> {
  if (config.requiresAutomaticMigration) {
    return failure("AUTOMATIC_MIGRATION_REQUIRED", "旧配置限制自动切换；请在 /pi-init config 的角色与模型中显式启用全自动。加载或保存不会自动提升授权。");
  }
  return { ok: true, value: config };
}

export function resolveWorkflowMode(config: unknown): RoleConfigResult<WorkflowMode> {
  const configuredMode = readProperty(config, "workflowMode");
  if (configuredMode !== undefined) {
    if (!isOneOf(WORKFLOW_MODES, configuredMode)) {
      return failure("WORKFLOW_MODE_INVALID", `工作流模式 workflowMode 无效：${configuredMode}`);
    }
    return { ok: true, value: configuredMode };
  }

  const legacyEnabled = readProperty(config, "workflowEnabled");
  if (legacyEnabled === undefined) return { ok: true, value: DEFAULT_WORKFLOW_MODE };
  if (typeof legacyEnabled !== "boolean") {
    return failure("WORKFLOW_ENABLED_INVALID", `工作流开关 workflowEnabled 必须是布尔值：${legacyEnabled}`);
  }
  return { ok: true, value: legacyEnabled ? "on" : "off" };
}

function resolveWorkflowExecutorValue(config: unknown): WorkflowExecutor {
  const source = config ?? {};
  const executor = hasOwn(source, "workflowExecutor")
    ? readProperty(source, "workflowExecutor")
    : DEFAULT_WORKFLOW_EXECUTOR;
  if (executor === "runtime") {
    throw configError("WORKFLOW_EXECUTOR_RETIRED", "workflowExecutor=runtime 已退役；当前仅支持 local 工作流");
  }
  if (!isOneOf(WORKFLOW_EXECUTORS, executor)) {
    throw configError("WORKFLOW_EXECUTOR_INVALID", `工作流执行器 workflowExecutor 无效：${executor}`);
  }
  return executor;
}

export function resolveWorkflowExecutor(config: unknown): RoleConfigResult<WorkflowExecutor> {
  try {
    return { ok: true, value: resolveWorkflowExecutorValue(config) };
  } catch (error) {
    return resultFromError(error, "WORKFLOW_EXECUTOR_INVALID");
  }
}

export function shouldOrchestrateWorkflow({ mode, taskCount, orchestration }: { mode: WorkflowMode; taskCount: number; orchestration?: unknown }): boolean {
  if (!isOneOf(WORKFLOW_MODES, mode)) {
    throw new Error(`工作流模式 workflowMode 无效：${mode}`);
  }
  if (!Number.isInteger(taskCount) || taskCount < 1) {
    throw new Error(`工作流任务数无效：${taskCount}`);
  }
  if (orchestration !== undefined && orchestration !== "required") {
    throw new Error(`工作流编排要求 orchestration 无效：${orchestration}`);
  }

  return mode === "on" || (mode === "auto" && (orchestration === "required" || taskCount > WORKFLOW_AUTO_TASK_LIMIT));
}

export function resolveRoleModel(
  config: unknown,
  role: unknown,
  sessionDefault: unknown,
): RoleConfigResult<RoleModelConfig> {
  const resolved = resolveRoleConfig(config);
  if (!resolved.ok) return resolved;

  const normalizedRole = normalizeRoleId(role);
  if (!normalizedRole.ok) return normalizedRole;
  const roleName = normalizedRole.value;
  const configured = resolved.value.roleModels[roleName];
  if (!configured && !DEFAULT_ROLE_NAME_SET.has(roleName)) {
    return failure("ROLE_NOT_ENABLED", `角色 ${roleName} 未启用；请先配置该角色及职责说明`);
  }
  if (resolved.value.modelStrategy === "auto" && resolved.value.autoModel) {
    const fixed = resolved.value.autoModel;
    return { ok: true, value: { provider: fixed.provider, model: fixed.model, thinkingLevel: fixed.initialThinkingLevel } };
  }
  if (configured) return { ok: true, value: configured };
  if (!sessionDefault) {
    return failure("SESSION_MODEL_UNAVAILABLE", `角色 ${roleName} 未配置模型，且当前 Pi 会话没有可用的默认模型`);
  }

  try {
    const fallback = normalizeRoleModel({
      provider: readProperty(sessionDefault, "provider"),
      model: readProperty(sessionDefault, "model") ?? readProperty(sessionDefault, "id"),
      thinkingLevel: readProperty(sessionDefault, "thinkingLevel"),
    }, roleName);
    return { ok: true, value: fallback };
  } catch (error) {
    return resultFromError(error, "SESSION_MODEL_INVALID");
  }
}

export function filterRoleModels<T extends RoleModelOption>(models: T[], query: string): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return models;

  return models.filter((model) =>
    `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase().includes(normalizedQuery),
  );
}

function stagedRoleModels(changes: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
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

export function mergeRoleConfigData(base: unknown, changes: unknown): Record<string, unknown> {
  const baseConfig = configObject(base);
  const changeConfig = configObject(changes);
  const merged = { ...baseConfig, ...changeConfig };
  if (isRecord(baseConfig.autoModel) && isRecord(changeConfig.autoModel)) {
    merged.autoModel = { ...baseConfig.autoModel, ...changeConfig.autoModel };
  }
  // Schema 3 is staged only by an explicit activation or canonical save.
  if (changeConfig.schemaVersion === ROLE_CONFIG_SCHEMA_VERSION) {
    delete merged.mode;
    delete merged.requiresAutomaticMigration;
  }
  const roleChanges = stagedRoleModels(changeConfig);
  if (hasOwn(baseConfig, "roleModels") || hasOwn(changeConfig, "roleModels") || Object.keys(roleChanges).length > 0) {
    merged.roleModels = {
      ...normalizeRoleModels(baseConfig),
      ...roleChanges,
    };
    const models = merged.roleModels as Record<string, unknown>;
    for (const [rawRole, rawModel] of rawRoleModelEntries(baseConfig)) {
      const role = unwrapRoleResult(normalizeRoleId(rawRole));
      if (isRecord(rawModel) && isRecord(models[role])) models[role] = { ...rawModel, ...models[role] };
    }
    for (const role of Object.keys(models)) {
      if (!CONFIG_METADATA_KEYS.has(role)) delete merged[role];
    }
  }
  return merged;
}

function parseRoleConfig(source: Record<string, unknown>): ResolvedRoleConfig {
  if (hasOwn(source, "runtime")) {
    throw configError("RUNTIME_CONFIG_RETIRED", "runtime 配置已退役；当前仅支持 local 工作流");
  }
  if (source.mode !== undefined && !["auto", "confirm", "manual"].includes(source.mode as string)) {
    throw configError("ROLE_MODE_INVALID", `旧版职责切换配置无效：${source.mode}`);
  }
  const requiresAutomaticMigration = source.requiresAutomaticMigration === true || source.mode === "confirm" || source.mode === "manual";
  const roleModels = normalizeRoleModels(source);
  const workflowExecutor = resolveWorkflowExecutor(source);
  if (!workflowExecutor.ok) throw configError(workflowExecutor.code, workflowExecutor.message);
  if (source.modelStrategy !== undefined && source.modelStrategy !== "roles" && source.modelStrategy !== "auto") {
    throw configError("MODEL_STRATEGY_INVALID", "模型策略必须是 roles 或 auto");
  }
  const autoModel = source.autoModel === undefined ? undefined : unwrapRoleResult(parseAutoModel(source.autoModel));
  if (source.modelStrategy === "auto" && !autoModel) throw configError("AUTO_MODEL_MISSING", "Auto 策略需要配置固定模型");
  const resolved: ResolvedRoleConfig = {
    ...(source.modelStrategy !== undefined ? { modelStrategy: source.modelStrategy } : {}),
    ...(autoModel ? { autoModel } : {}),
    schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
    ...(requiresAutomaticMigration ? { requiresAutomaticMigration: true as const } : {}),
    workflowMode: unwrapRoleResult(resolveWorkflowMode(source)),
    workflowExecutor: workflowExecutor.value,
    roleModels,
  };
  for (const [role, model] of Object.entries(roleModels)) {
    Object.defineProperty(resolved, role, { value: model, enumerable: false });
  }
  return resolved;
}

export function resolveRoleConfig(config: unknown, changes?: unknown): RoleConfigResult<ResolvedRoleConfig> {
  try {
    const source = changes === undefined ? configObject(config) : mergeRoleConfigData(config, changes);
    return { ok: true, value: parseRoleConfig(source) };
  } catch (error) {
    return resultFromError(error);
  }
}
