import type {
  DefaultRoleName,
  ModelReference,
  RoleConfigResult,
  RoleMode,
  RoleModelConfig,
  RoleModelOption,
  ResolvedRoleConfig,
  ThinkingLevel,
  WorkflowExecutor,
  WorkflowMode,
} from "./role-types.ts";

export const ROLE_MODES = ["auto", "confirm", "manual"] as const satisfies readonly RoleMode[];
export const DEFAULT_ROLE_MODE: RoleMode = "auto";
export const WORKFLOW_MODES = ["off", "on", "auto"] as const satisfies readonly WorkflowMode[];
export const DEFAULT_WORKFLOW_MODE: WorkflowMode = "auto";
export const WORKFLOW_EXECUTORS = ["local"] as const satisfies readonly WorkflowExecutor[];
export const DEFAULT_WORKFLOW_EXECUTOR: WorkflowExecutor = "local";
export const WORKFLOW_AUTO_TASK_LIMIT = 2;
export const ROLE_SWITCH_COMPACTION_THRESHOLD = 50;
export const ROLE_CONFIG_SCHEMA_VERSION = 2;
export const ROLE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const ROLE_LABELS: Record<string, string> = {
  architect: "架构设计",
  "developer-test": "开发测试",
  "docs-commit": "文档收尾",
};

export const ROLE_MODE_LABELS: Record<string, string> = {
  auto: "自动（推荐）",
  confirm: "确认后切换",
  manual: "手动（直连宿主）",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

export function roleModeLabel(mode: string): string {
  return ROLE_MODE_LABELS[mode] ?? mode;
}

function hasOwn(value: unknown, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readProperty(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" && typeof value !== "function") return undefined;
  return Reflect.get(value, key);
}

function isOneOf<const Values extends readonly string[]>(values: Values, value: unknown): value is Values[number] {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

export function isRoleMode(value: unknown): value is RoleMode {
  return isOneOf(ROLE_MODES, value);
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

export function shouldCompactOnRoleSwitch({
  mode,
  previousRole,
  nextRole,
  contextUsage,
}: {
  mode: RoleMode;
  previousRole?: string;
  nextRole: string;
  contextUsage?: { percent?: number | null } | null;
}): boolean {
  return (
    mode === "auto" &&
    typeof previousRole === "string" &&
    previousRole !== nextRole &&
    contextUsage?.percent != null &&
    contextUsage.percent >= ROLE_SWITCH_COMPACTION_THRESHOLD
  );
}

export function shouldCompactAfterWorkflowTask({
  mode,
  contextUsage,
}: {
  mode: RoleMode;
  contextUsage?: { percent?: number | null } | null;
}): boolean {
  return (
    mode === "auto" &&
    contextUsage?.percent != null &&
    contextUsage.percent >= ROLE_SWITCH_COMPACTION_THRESHOLD
  );
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
  mode: DEFAULT_ROLE_MODE,
  workflowMode: DEFAULT_WORKFLOW_MODE,
  workflowExecutor: DEFAULT_WORKFLOW_EXECUTOR,
  roleModels: {},
};

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];
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
  return failure(errorCode, error instanceof Error ? error.message : String(error));
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
  if (version !== undefined && version !== 1 && version !== ROLE_CONFIG_SCHEMA_VERSION) {
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

export function isRoleAvailable(config: unknown, role: unknown): RoleConfigResult<boolean> {
  const resolved = resolveRoleConfig(config);
  if (!resolved.ok) return resolved;
  const normalizedRole = normalizeRoleId(role);
  if (!normalizedRole.ok) return normalizedRole;
  return {
    ok: true,
    value: DEFAULT_ROLE_NAME_SET.has(normalizedRole.value) || hasOwn(resolved.value.roleModels, normalizedRole.value),
  };
}

export function resolveRoleMode(config: unknown): RoleConfigResult<RoleMode> {
  const mode = readProperty(config, "mode") ?? DEFAULT_ROLE_MODE;
  if (!isOneOf(ROLE_MODES, mode)) {
    return failure("ROLE_MODE_INVALID", `职责切换模式无效：${mode}`);
  }
  return { ok: true, value: mode };
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

export function shouldOrchestrateWorkflow({ mode, taskCount }: { mode: WorkflowMode; taskCount: number }): boolean {
  if (!isOneOf(WORKFLOW_MODES, mode)) {
    throw new Error(`工作流模式 workflowMode 无效：${mode}`);
  }
  if (!Number.isInteger(taskCount) || taskCount < 1) {
    throw new Error(`工作流任务数无效：${taskCount}`);
  }

  return mode === "on" || (mode === "auto" && taskCount > WORKFLOW_AUTO_TASK_LIMIT);
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
  if (configured) return { ok: true, value: configured };
  if (!DEFAULT_ROLE_NAME_SET.has(roleName)) {
    return failure("ROLE_NOT_ENABLED", `角色 ${roleName} 未启用；请先配置该角色及职责说明`);
  }
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

function mergeRoleConfigData(base: unknown, changes: unknown): Record<string, unknown> {
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

function parseRoleConfig(source: Record<string, unknown>): ResolvedRoleConfig {
  if (hasOwn(source, "runtime")) {
    throw configError("RUNTIME_CONFIG_RETIRED", "runtime 配置已退役；当前仅支持 local 工作流");
  }
  const roleModels = normalizeRoleModels(source);
  const workflowExecutor = resolveWorkflowExecutor(source);
  if (!workflowExecutor.ok) throw configError(workflowExecutor.code, workflowExecutor.message);
  const resolved = {
    schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
    mode: unwrapRoleResult(resolveRoleMode(source)),
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
