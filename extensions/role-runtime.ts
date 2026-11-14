import { isRecord, hasOwn } from "../src/value-guards.ts";
import { createAutoModelRuntime } from "./auto-model-runtime.ts";
import {
    CONFIG_DIR_NAME,
    withFileMutationQueue,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { WorkflowMode } from "../src/role-types.ts";
import {
  validateAutomaticSwitching,
  ROLE_CONFIG_SCHEMA_VERSION,
    getRoleNames,
    mergeRoleConfigData,
    normalizeRoleId,
    resolveRoleConfig,
    resolveRoleModel,
    roleLabel,
    unwrapRoleResult
} from "../src/roles.ts";
import type { ActivityStatusReporter } from "./activity-status.ts";
import type { MenuSaveResult, ResolvedRoleConfig, RoleModelConfig } from "./contracts.ts";
import {
    activeRoleMatches,
    textOf,
    type ExtensionRuntimeState,
    type WorkflowState
} from "./runtime-state.ts";
import { formatWorkflowControlCenterLabel } from "./workflow-status-renderer.ts";
import { createCurrentWorkflowStatusView } from "./workflow-status-view.ts";

export type RoleRuntimeDependencies = {
  activityStatus: ActivityStatusReporter;
  getWorkflowState: () => WorkflowState | undefined;
  acknowledgeRoleRecovery: (role: string) => void;
};

export function workflowModeLabel(mode: WorkflowMode) {
  if (mode === "off") return "关闭";
  if (mode === "on") return "始终编排";
  if (mode === "auto") return "自动（不超过 2 个任务时跳过）";
  return mode;
}

export function createRoleRuntime(
  pi: ExtensionAPI,
  state: ExtensionRuntimeState,
  deps: RoleRuntimeDependencies,
) {
  const autoModel = createAutoModelRuntime(pi, state, readSessionRoleConfig, (ctx) => refreshRoleStatus(ctx));

  async function readRoleConfig(ctx: ExtensionContext) {
    if (!ctx.isProjectTrusted()) return { ok: true as const, value: undefined };

    const configPath = join(ctx.cwd, CONFIG_DIR_NAME, "role-models.json");
    let source: string;
    try {
      source = await readFile(configPath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { ok: true as const, value: undefined };
      }
      return {
        ok: false as const,
        code: "ROLE_CONFIG_READ_FAILED",
        message: `无法读取角色模型配置 ${configPath}：${textOf(error)}`,
      };
    }
    try {
      return { ok: true as const, value: JSON.parse(source) };
    } catch (error) {
      return {
        ok: false as const,
        code: "ROLE_CONFIG_INVALID_JSON",
        message: `角色模型配置不是有效 JSON：${configPath}：${textOf(error)}`,
      };
    }
  }

  async function readSessionRoleConfig(ctx: ExtensionContext) {
    const persisted = unwrapRoleResult(await readRoleConfig(ctx));
    const resolved = unwrapRoleResult(resolveRoleConfig(persisted, state.sessionRoleConfigOverrides)) as ResolvedRoleConfig;
    state.configuredRoleNames = unwrapRoleResult(getRoleNames(resolved));
    return resolved;
  }

  function sessionDefaultModel(ctx: ExtensionContext) {
    const model = ctx.model;
    return model
      ? { provider: model.provider, model: model.id, thinkingLevel: pi.getThinkingLevel() }
      : undefined;
  }

  function activeRoleFor(ctx: ExtensionContext) {
    return activeRoleMatches(state, ctx, pi.getThinkingLevel()) ? state.activeRole : undefined;
  }

  function hasPendingRoleConfigChanges() { return Object.keys(state.sessionRoleConfigOverrides).length > 0; }

  async function isRoleModelConfigPersisted(role: string, expected: RoleModelConfig, ctx: ExtensionContext) {
    const persisted = unwrapRoleResult(await readRoleConfig(ctx));
    if (persisted === undefined) return false;
    const config = unwrapRoleResult(resolveRoleConfig(persisted)) as ResolvedRoleConfig;
    const saved = config.roleModels[unwrapRoleResult(normalizeRoleId(role))];
    return saved?.provider === expected.provider
      && saved.model === expected.model
      && saved.thinkingLevel === expected.thinkingLevel;
  }

  function stageRoleConfig(changes: Record<string, unknown>) {
    state.sessionRoleConfigOverrides = mergeRoleConfigData(state.sessionRoleConfigOverrides, changes);
  }

  function clearStagedRoleConfig(role: string) {
    const roleModels = state.sessionRoleConfigOverrides.roleModels;
    if (!isRecord(roleModels)) return;
    const remaining = { ...(roleModels as Record<string, unknown>) };
    delete remaining[role];
    const next = { ...state.sessionRoleConfigOverrides };
    if (Object.keys(remaining).length > 0) next.roleModels = remaining;
    else delete next.roleModels;
    state.sessionRoleConfigOverrides = next;
  }
  async function saveRoleConfig(ctx: ExtensionCommandContext): Promise<MenuSaveResult> {
    if (!ctx.isProjectTrusted()) {
      return {
        ok: false as const,
        message: "保存角色配置仅允许在受信任项目中运行；请先信任当前项目",
      };
    }

    const hasPendingChanges = hasPendingRoleConfigChanges();
    const changes = { ...state.sessionRoleConfigOverrides };
    const configPath = resolve(ctx.cwd, CONFIG_DIR_NAME, "role-models.json");
    try {
      const outcome = await withFileMutationQueue(configPath, async () => {
        const persisted = unwrapRoleResult(await readRoleConfig(ctx));
        const current = persisted === undefined ? {} : persisted;
        const resolved = unwrapRoleResult(resolveRoleConfig(current, changes)) as ResolvedRoleConfig;
        unwrapRoleResult(validateAutomaticSwitching(resolved));
        const canonical = persisted && typeof persisted === "object"
          && persisted.schemaVersion === resolved.schemaVersion
          && hasOwn(persisted, "roleModels")
          && !hasOwn(persisted, "mode")
          && !hasOwn(persisted, "requiresAutomaticMigration");
        if (!hasPendingChanges && (!persisted || canonical)) {
          return { resolved, changed: false };
        }
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, `${JSON.stringify(mergeRoleConfigData(current, resolved), null, 2)}\n`, "utf8");
        return { resolved, changed: true };
      });
      if (!outcome.changed) {
        return { ok: true as const, message: "角色配置已保存。" };
      }
      state.sessionRoleConfigOverrides = {};
      state.configuredRoleNames = unwrapRoleResult(getRoleNames(outcome.resolved));
      state.workflowModeStatus = outcome.resolved.workflowMode;
      refreshRoleStatus(ctx);
      return {
        ok: true as const,
        message: hasPendingChanges
          ? "角色配置已保存。"
          : "角色配置已保存（旧版配置已迁移为 roleModels 结构）。",
      };
    } catch (error) {
      return { ok: false as const, message: `保存角色配置失败：${textOf(error)}` };
    }
  }

  function inactiveWorkflowStateLabel() {
    const restoreError = state.workflowRestoreError;
    if (restoreError) return `工作流恢复失败（${restoreError.code}）`;
    return `策略 ${workflowModeLabel(state.workflowModeStatus)} · 无活动工作流`;
  }

  function workflowStateLabel(workflowState = deps.getWorkflowState()) {
    if (!workflowState || state.workflowRestoreError) return inactiveWorkflowStateLabel();
    return formatWorkflowControlCenterLabel(createCurrentWorkflowStatusView(state, workflowState));
  }

  function refreshRoleStatus(ctx: ExtensionContext) {
    const role = activeRoleFor(ctx);
    deps.activityStatus.setRole(ctx, role ? { role: roleLabel(role.role) } : {});
  }

  async function enableAutomaticSwitching(ctx: ExtensionCommandContext) {
    if (!ctx.isProjectTrusted()) throw new Error("启用全自动仅允许在受信任项目中运行");
    stageRoleConfig({ schemaVersion: ROLE_CONFIG_SCHEMA_VERSION });
    await readSessionRoleConfig(ctx);
    refreshRoleStatus(ctx);
  }

  async function applyRole(role: string, ctx: ExtensionContext, resolvedConfig?: ResolvedRoleConfig, signal?: AbortSignal) {
    try { return await applyRoleModel(role, ctx, resolvedConfig, signal); }
    catch (error) { state.traceHandoff?.(ctx, "pi-init.role_failed"); throw error; }
  }
  async function applyRoleModel(role: string, ctx: ExtensionContext, resolvedConfig?: ResolvedRoleConfig, signal?: AbortSignal) {
    const normalizedRole = unwrapRoleResult(normalizeRoleId(role));
    const generation = state.roleContextGeneration;
    const checkExecution = () => {
      if (state.userStopRequested || ctx.signal?.aborted || signal?.aborted || state.roleContextGeneration !== generation) {
        throw Object.assign(new Error("职责应用期间执行已停止或上下文已变化，未继续切换"), { code: "ROLE_EXECUTION_PROTECTED" });
      }
    };
    checkExecution();
    const config = resolvedConfig ?? await readSessionRoleConfig(ctx);
    unwrapRoleResult(validateAutomaticSwitching(config));
    state.workflowModeStatus = config.workflowMode;
    let target: RoleModelConfig;
    let model: ReturnType<ExtensionContext["modelRegistry"]["find"]>;
    const verifiedDuringEnsure = config.modelStrategy === "auto";
    if (verifiedDuringEnsure) {
      await autoModel.ensure(ctx, config, true, signal);
      const fixed = config.autoModel!;
      target = { provider: fixed.provider, model: fixed.model, thinkingLevel: pi.getThinkingLevel() };
    } else {
      target = unwrapRoleResult(resolveRoleModel(config, normalizedRole, sessionDefaultModel(ctx)));
      const hasExplicitModel = hasOwn(config.roleModels, normalizedRole);
      model = hasExplicitModel ? ctx.modelRegistry.find(target.provider, target.model) : undefined;
      if (hasExplicitModel && !model) {
        const error = new Error(
          `角色 ${roleLabel(normalizedRole)} 显式配置的模型不存在：${target.provider}/${target.model}；请在 /pi-init config 中修改`,
        );
        Object.assign(error, { code: "ROLE_MODEL_NOT_AVAILABLE" });
        throw error;
      }
    }
    checkExecution();
    const current = activeRoleFor(ctx);
    if (current?.role === normalizedRole && current.provider === target.provider && current.model === target.model
      && current.thinkingLevel === target.thinkingLevel && !state.roleRecoveryPending
      && !state.roleRecoveryPersistenceFailed && !state.pendingWorkflowRecovery) {
      refreshRoleStatus(ctx);
      state.traceHandoff?.(ctx, "role.reused", { role: normalizedRole });
      return current;
    }
    if (!verifiedDuringEnsure) {
      const sameModel = ctx.model?.provider === target.provider && ctx.model?.id === target.model;
      if (model && sameModel) {
        const thinkingBeforeAuth = pi.getThinkingLevel();
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        checkExecution();
        if (ctx.model?.provider !== target.provider || ctx.model?.id !== target.model || pi.getThinkingLevel() !== thinkingBeforeAuth) {
          throw Object.assign(new Error("等待凭据期间用户已改变模型或强度，未覆盖宿主选择"), { code: "ROLE_CONTEXT_CHANGED" });
        }
        if (!auth.ok) {
          const error = new Error(`角色 ${roleLabel(normalizedRole)} 无法使用模型 ${target.provider}/${target.model}：缺少可用凭据`);
          Object.assign(error, { code: "ROLE_MODEL_AUTH_UNAVAILABLE" });
          throw error;
        }
      }
      if (model && !sameModel && !(await pi.setModel(model))) {
        const error = new Error(`角色 ${roleLabel(normalizedRole)} 无法使用模型 ${target.provider}/${target.model}：缺少可用凭据`);
        Object.assign(error, { code: "ROLE_MODEL_AUTH_UNAVAILABLE" });
        throw error;
      }
      checkExecution();
      if (model && pi.getThinkingLevel() !== target.thinkingLevel) {
        pi.setThinkingLevel(target.thinkingLevel as Parameters<typeof pi.setThinkingLevel>[0]);
      }
      checkExecution();
    }
    if ((verifiedDuringEnsure || model) && (ctx.model?.provider !== target.provider || ctx.model?.id !== target.model || pi.getThinkingLevel() !== target.thinkingLevel)) {
      throw Object.assign(new Error("角色模型或推理强度未按配置生效，未确认职责"), { code: "ROLE_MODEL_NOT_APPLIED" });
    }
    const result = {
      role: normalizedRole,
      provider: target.provider,
      model: target.model,
      thinkingLevel: pi.getThinkingLevel(),
    };
    state.activeRole = result;
    state.roleTransitionGeneration += 1;
    refreshRoleStatus(ctx);
    deps.acknowledgeRoleRecovery(result.role);
    return result;
  }

  function currentRole(role: string, ctx: ExtensionContext) {
    const normalizedRole = unwrapRoleResult(normalizeRoleId(role));
    const current = activeRoleFor(ctx);
    if (!current || current.role !== normalizedRole) {
      throw new Error(`当前职责与真实模型不匹配，请先调用 switch_role(role="${normalizedRole}") 并等待成功`);
    }
    deps.acknowledgeRoleRecovery(current.role);
    return current;
  }

  async function automaticRole(role: string, ctx: ExtensionContext, signal?: AbortSignal) {
    const normalizedRole = unwrapRoleResult(normalizeRoleId(role));
    const config = await readSessionRoleConfig(ctx);
    unwrapRoleResult(validateAutomaticSwitching(config));
    const result = await applyRole(normalizedRole, ctx, config, signal);
    return { requestedRole: normalizedRole, result };
  }
  return {
    activeRoleFor,
    suggestThinking: autoModel.suggest,
    resumeAutoThinking: autoModel.resume,

    readSessionRoleConfig,
    hasPendingRoleConfigChanges,
    isRoleModelConfigPersisted,
    clearStagedRoleConfig,
    enableAutomaticSwitching,
    stageRoleConfig,
    saveRoleConfig,
    refreshRoleStatus,

    applyRole,
    automaticRole,
    currentRole,
    workflowStateLabel,
  };
}

export type RoleRuntime = ReturnType<typeof createRoleRuntime>;
