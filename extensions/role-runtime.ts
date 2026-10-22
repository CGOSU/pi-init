import {
  THINKING_LEVELS,
  getRoleNames,
  normalizeModelReference,
  normalizeRoleId,
  resolveRoleConfig,
  resolveRoleModel,
  roleLabel,
  roleModeLabel,
  shouldCompactAfterWorkflowTask,
  unwrapRoleResult, mergeRoleConfigData } from "../src/roles.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  CONFIG_DIR_NAME,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createCurrentWorkflowStatusView } from "./workflow-status-view.ts";
import { formatWorkflowControlCenterLabel } from "./workflow-status-renderer.ts";
import type { RoleMode, WorkflowMode } from "../src/role-types.ts";
import type { MenuSaveResult, ResolvedRoleConfig, RoleModelConfig } from "./contracts.ts";
import {
  activeRoleMatches,
  textOf,
  type ExtensionRuntimeState,
  type WorkflowActionIdentity,
  type WorkflowHandoffIdentity,
  type WorkflowReplanIdentity,
  type WorkflowState,
  type PendingRoleCompaction,
} from "./runtime-state.ts";
import { isMenuBack, shortModelName, showMenu } from "./ui.ts";
import { createContextBudgetChecker } from "./context-budget-monitor.ts";
import { createWorkflowCompaction } from "./workflow-compaction.ts";
import type { ActivityStatusReporter } from "./activity-status.ts";

export type RoleRuntimeDependencies = {
  activityStatus: ActivityStatusReporter;
  getWorkflowState: () => WorkflowState | undefined;
  setWorkflowDispatchInFlight: (value: boolean) => void;
  requireRoleRecovery: (ctx: ExtensionContext, reason: string) => void;
  sendWorkflowTaskMessage: (ctx: ExtensionContext, taskId: string, note?: string, identity?: WorkflowHandoffIdentity) => void;
  scheduleWorkflow: (ctx: ExtensionContext, identity?: WorkflowActionIdentity, reason?: "context-budget") => Promise<void>;
  sendWorkflowReplanMessage: (ctx: ExtensionContext, identity?: WorkflowReplanIdentity) => void;
  acknowledgeRoleRecovery: (role: string) => void;
  finishWorkflowBoundary: (ctx: ExtensionContext, identity: WorkflowActionIdentity, failed?: boolean) => Promise<void>;
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
  let internalModelSelectionDepth = 0;
  const workflowCompaction = createWorkflowCompaction(pi, state, {
    ...deps,
    getActiveRole: activeRoleFor,
  });
  const checkContextBudget = createContextBudgetChecker(pi, state, {
    mode: async (ctx) => effectiveRoleMode(await readSessionRoleConfig(ctx)),
    activeRole: activeRoleFor,
    start: workflowCompaction.start,
  });
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

  async function shouldCompactForRole(ctx: ExtensionContext, role: string) {
    const usage = ctx.getContextUsage();
    if (shouldCompactAfterWorkflowTask({ mode: state.roleModeStatus, contextUsage: usage })) return true;
    if (state.roleModeStatus !== "auto" || usage?.tokens == null) return false;
    const config = await readSessionRoleConfig(ctx);
    const target = unwrapRoleResult(resolveRoleModel(config, role, sessionDefaultModel(ctx)));
    const model = ctx.modelRegistry.find(target.provider, target.model);
    return shouldCompactAfterWorkflowTask({ mode: state.roleModeStatus, contextUsage: usage, targetModel: model });
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

  function effectiveRoleMode(config: Pick<ResolvedRoleConfig, "mode">) { return state.sessionModeOverride ?? config.mode; }

  function isManualRoleMode(config: Pick<ResolvedRoleConfig, "mode">) { return effectiveRoleMode(config) === "manual"; }

  function stageRoleConfig(changes: Record<string, unknown>) {
    state.sessionRoleConfigOverrides = mergeRoleConfigData(state.sessionRoleConfigOverrides, changes);
  }

  function clearStagedRoleConfig(role: string) {
    const roleModels = state.sessionRoleConfigOverrides.roleModels;
    if (!roleModels || typeof roleModels !== "object" || Array.isArray(roleModels)) return;
    const remaining = { ...(roleModels as Record<string, unknown>) };
    delete remaining[role];
    const next = { ...state.sessionRoleConfigOverrides };
    if (Object.keys(remaining).length > 0) next.roleModels = remaining;
    else delete next.roleModels;
    state.sessionRoleConfigOverrides = next;
  }
  async function writeBackManualModelSelection(
    event: { model?: unknown },
    ctx: ExtensionContext,
    config: ResolvedRoleConfig,
  ) {
    if (internalModelSelectionDepth > 0) return; // Ignore pi.setModel()'s internal model_select event.
    const role = state.activeRole?.role;
    if (!role) {
      ctx.ui.notify("手动模式下模型已由宿主切换；当前无活动角色，未写入 .pi/role-models.json。", "info");
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(config.roleModels, role)) {
      ctx.ui.notify(`角色 ${roleLabel(role)} 使用会话默认模型；本次手动切换不会创建固定映射。`, "info");
      return;
    }
    if (!ctx.isProjectTrusted()) {
      ctx.ui.notify("手动模式写回仅允许在受信任项目中运行；本次切换未写入项目文件。", "info");
      return;
    }
    const referenceResult = normalizeModelReference(event.model, "手动切换模型");
    if (!referenceResult.ok) {
      ctx.ui.notify(`手动模式下忽略无法解析的模型切换：${referenceResult.message}`, "warning");
      return;
    }
    const reference = referenceResult.value;

    const current = config.roleModels[role];
    const thinkingNow = pi.getThinkingLevel();
    const thinkingLevel = (THINKING_LEVELS as readonly string[]).includes(thinkingNow)
      ? thinkingNow
      : current.thinkingLevel;
    if (current.provider === reference.provider && current.model === reference.model) {
      state.activeRole = { role, ...reference, thinkingLevel };
      state.roleTransitionGeneration += 1;
      return;
    }

    const changes: Record<string, unknown> = {
      roleModels: {
        [role]: { ...reference, thinkingLevel },
      },
    };
    const configPath = resolve(ctx.cwd, CONFIG_DIR_NAME, "role-models.json");
    try {
      await withFileMutationQueue(configPath, async () => {
        const persisted = unwrapRoleResult(await readRoleConfig(ctx));
        const persistedBase = persisted === undefined ? {} : persisted;
        const resolved = unwrapRoleResult(resolveRoleConfig(persistedBase, changes));
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, `${JSON.stringify(resolved, null, 2)}\n`, "utf8");
      });
      clearStagedRoleConfig(role);
      state.configuredRoleNames = unwrapRoleResult(getRoleNames(await readSessionRoleConfig(ctx)));
      state.activeRole = { role, ...reference, thinkingLevel };
      state.roleTransitionGeneration += 1;
      ctx.ui.notify(
        `手动模式写回：${roleLabel(role)} → ${reference.provider}/${reference.model} 已写入 .pi/role-models.json。`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(`手动模式写回失败：${textOf(error)}`, "error");
    }
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
        const canonical = persisted && typeof persisted === "object"
          && persisted.schemaVersion === resolved.schemaVersion
          && Object.prototype.hasOwnProperty.call(persisted, "roleModels");
        if (!hasPendingChanges && (!persisted || canonical)) {
          return { resolved, changed: false };
        }
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, `${JSON.stringify(resolved, null, 2)}\n`, "utf8");
        return { resolved, changed: true };
      });
      if (!outcome.changed) {
        return { ok: true as const, message: "角色配置已保存。" };
      }
      state.sessionRoleConfigOverrides = {};
      state.configuredRoleNames = unwrapRoleResult(getRoleNames(outcome.resolved));
      state.workflowModeStatus = outcome.resolved.workflowMode;
      refreshRoleStatus(ctx, state.sessionModeOverride ?? outcome.resolved.mode);
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

  function refreshRoleStatus(ctx: ExtensionContext, mode: RoleMode) {
    const role = activeRoleFor(ctx);
    const modeLabel = roleModeLabel(mode).split("（", 1)[0] ?? roleModeLabel(mode);
    const model = ctx.model
      ? `${shortModelName(ctx.model.id)}/${pi.getThinkingLevel()}`
      : undefined;
    deps.activityStatus.setRole(ctx, {
      mode: modeLabel,
      ...(role ? { role: roleLabel(role.role) } : {}),
      ...(model ? { model } : {}),
    });
  }

  function setRoleStatus(ctx: ExtensionContext, mode: RoleMode) {
    state.roleModeStatus = mode;
    refreshRoleStatus(ctx, mode);
  }
  function createPendingRoleCompaction(
    ctx: ExtensionContext,
    fromRole: string,
    toRole: string,
  ): PendingRoleCompaction {
    const targetRole = activeRoleFor(ctx);
    if (!targetRole || targetRole.role !== fromRole) {
      throw new Error(`无法为任务边界建立压缩交接：当前活动角色不是 ${fromRole}`);
    }
    return {
      fromRole,
      toRole,
      sessionId: ctx.sessionManager.getSessionId(),
      contextGeneration: state.roleContextGeneration,
      roleTransitionGeneration: state.roleTransitionGeneration,
      targetRole: { ...targetRole },
    };
  }

  function startPendingRoleCompaction(ctx: ExtensionContext) { workflowCompaction.start(ctx); }

  async function applyRole(role: string, ctx: ExtensionContext, resolvedConfig?: ResolvedRoleConfig) {
    const normalizedRole = unwrapRoleResult(normalizeRoleId(role));
    const config = resolvedConfig ?? await readSessionRoleConfig(ctx);
    state.workflowModeStatus = config.workflowMode;
    const target = unwrapRoleResult(resolveRoleModel(config, normalizedRole, sessionDefaultModel(ctx)));
    const hasExplicitModel = Object.prototype.hasOwnProperty.call(config.roleModels, normalizedRole);
    const model = hasExplicitModel ? ctx.modelRegistry.find(target.provider, target.model) : undefined;
    if (hasExplicitModel && !model) {
      const error = new Error(
        `角色 ${roleLabel(normalizedRole)} 显式配置的模型不存在：${target.provider}/${target.model}；请在 /pi-init config 中修改`,
      );
      Object.assign(error, { code: "ROLE_MODEL_NOT_AVAILABLE" });
      throw error;
    }
    const current = activeRoleFor(ctx);
    if (current?.role === normalizedRole && current.provider === target.provider && current.model === target.model
      && current.thinkingLevel === target.thinkingLevel && !state.roleRecoveryPending
      && !state.roleRecoveryPersistenceFailed && !state.pendingWorkflowRecovery) {
      const mode = state.sessionModeOverride ?? config.mode;
      if (state.roleModeStatus !== mode) setRoleStatus(ctx, mode);
      state.traceHandoff?.(ctx, "role.reused", { role: normalizedRole });
      return current;
    }
    if (model) {
      internalModelSelectionDepth += 1;
      try {
        if (!(await pi.setModel(model))) {
          const error = new Error(`角色 ${roleLabel(normalizedRole)} 无法使用模型 ${target.provider}/${target.model}：缺少可用凭据`);
          Object.assign(error, { code: "ROLE_MODEL_AUTH_UNAVAILABLE" });
          throw error;
        }
      } finally {
        internalModelSelectionDepth -= 1;
      }
      pi.setThinkingLevel(target.thinkingLevel as Parameters<typeof pi.setThinkingLevel>[0]);
    }
    const result = {
      role: normalizedRole,
      provider: target.provider,
      model: target.model,
      thinkingLevel: pi.getThinkingLevel(),
    };
    state.activeRole = result;
    state.roleTransitionGeneration += 1;
    setRoleStatus(ctx, state.sessionModeOverride ?? config.mode);
    deps.acknowledgeRoleRecovery(result.role);
    return result;
  }

  function currentRole(role: string, ctx: ExtensionContext) {
    const normalizedRole = unwrapRoleResult(normalizeRoleId(role));
    const result = ctx.model
      ? {
          role: normalizedRole,
          provider: ctx.model.provider,
          model: ctx.model.id,
          thinkingLevel: pi.getThinkingLevel(),
        }
      : undefined;
    if (
      !state.activeRole ||
      !result ||
      state.activeRole.role !== normalizedRole ||
      state.activeRole.provider !== result.provider ||
      state.activeRole.model !== result.model ||
      state.activeRole.thinkingLevel !== result.thinkingLevel
    ) {
      throw new Error(`当前为手动模式，请先执行 /pi-init role ${normalizedRole}`);
    }
    deps.acknowledgeRoleRecovery(result.role);
    return result;
  }

  async function automaticRole(role: string, ctx: ExtensionContext) {
    const normalizedRole = unwrapRoleResult(normalizeRoleId(role));
    const config = await readSessionRoleConfig(ctx);
    unwrapRoleResult(resolveRoleModel(config, normalizedRole, sessionDefaultModel(ctx)));
    const mode = state.sessionModeOverride ?? config.mode;
    if (mode === "auto") {
      const result = await applyRole(normalizedRole, ctx, config);
      return { mode, requestedRole: normalizedRole, result };
    }
    if (mode === "manual") {
      const result = currentRole(normalizedRole, ctx);
      return { mode, requestedRole: normalizedRole, result };
    }

    if (state.activeRole?.role === normalizedRole) {
      try {
        return { mode, requestedRole: normalizedRole, result: currentRole(normalizedRole, ctx) };
      } catch {
        // The user changed the model or thinking level; confirm the role again.
      }
    }
    if (!ctx.hasUI) {
      throw new Error(`角色切换模式为确认后切换，但当前环境无法确认；请先执行 /pi-init role ${normalizedRole} 或 /pi-init mode auto`);
    }

    const decision = await showMenu(ctx, `建议切换到「${roleLabel(normalizedRole)}」`, [
      {
        value: "accept",
        label: "采用建议",
        description: config.roleModels[normalizedRole] ? "切换到项目配置的模型" : "沿用当前 Pi 会话模型",
      },
      { value: "manual", label: "切换为手动模式", description: "本次会话不再自动换角" },
      { value: "cancel", label: "取消" },
    ]);
    if (decision === "accept") {
      return { mode, requestedRole: normalizedRole, result: await applyRole(normalizedRole, ctx, config) };
    }
    if (decision === "manual") {
      state.sessionModeOverride = "manual";
      setRoleStatus(ctx, "manual");
      const selected = await showMenu(
        ctx,
        "手动选择角色",
        state.configuredRoleNames.map((value) => ({ value, label: roleLabel(value) })),
      );
      if (!selected || isMenuBack(selected)) throw new Error("已取消手动角色选择");
      return {
        mode: "manual",
        requestedRole: normalizedRole,
        result: await applyRole(selected, ctx, config),
      };
    }
    throw new Error("已取消角色切换");
  }
  return {
    activeRoleFor,
    checkContextBudget,
    shouldCompactForRole,
    readSessionRoleConfig,
    hasPendingRoleConfigChanges,
    isRoleModelConfigPersisted,
    clearStagedRoleConfig,
    effectiveRoleMode,
    isManualRoleMode,
    stageRoleConfig,
    writeBackManualModelSelection,
    saveRoleConfig,
    refreshRoleStatus,
    setRoleStatus,
    createPendingRoleCompaction,
    startPendingRoleCompaction,
    retireWorkflowContinuation: workflowCompaction.retireWorkflowContinuation,
    disposeWorkflowCompaction: workflowCompaction.dispose,
    applyRole,
    automaticRole,
    currentRole,
    workflowStateLabel,
  };
}

export type RoleRuntime = ReturnType<typeof createRoleRuntime>;
