import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  CONFIG_DIR_NAME,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  ROLE_NAMES,
  THINKING_LEVELS,
  normalizeModelReference,
  resolveRoleConfig,
  roleLabel,
  roleModeLabel,
  shouldCompactOnRoleSwitch,
} from "../src/roles.js";
import {
  workflowProgress,
} from "../src/workflow.js";
import type { ResolvedRoleConfig } from "./contracts.ts";
import { activeRoleMatches, textOf, type ExtensionRuntimeState, type WorkflowState } from "./runtime-state.ts";
import { isMenuBack, shortModelName, showMenu } from "./ui.ts";

const ROLE_SWITCH_COMPACTION_INSTRUCTIONS = [
  "这是自动角色切换触发的上下文压缩。",
  "请保留后续角色继续工作所需的完整信息：用户目标与约束、关键决策及原因、已完成/进行中/阻塞事项、读取和修改的文件、实际执行的验证命令与结果、下一步。",
  "不要把未完成事项写成已完成；保持项目路径、错误信息和待处理问题的准确性。",
].join("\n");
const ROLE_SWITCH_CONTINUATION_TYPE = "pi-init-role-transition";

export type RoleRuntimeDependencies = {
  getWorkflowState: () => WorkflowState | undefined;
  setWorkflowDispatchInFlight: (value: boolean) => void;
  setInternalContinuationPending: (value: boolean) => void;
  sendWorkflowTaskMessage: (ctx: ExtensionContext, taskId: string, note?: string) => void;
  scheduleWorkflow: (ctx: ExtensionContext) => Promise<void>;
  sendWorkflowReplanMessage: (ctx: ExtensionContext) => void;
};

export function workflowModeLabel(mode: string) {
  if (mode === "off") return "关闭";
  if (mode === "on") return "始终编排";
  if (mode === "auto") return "自动（不超过 2 个任务时跳过）";
  return mode;
}

export function workflowExecutorLabel(executor: string) {
  if (executor === "local") return "主会话顺序执行";
  if (executor === "subtask") return "pi-subtask 对话 fork";
  return executor;
}

export function createRoleRuntime(
  pi: ExtensionAPI,
  state: ExtensionRuntimeState,
  deps: RoleRuntimeDependencies,
) {
  async function readRoleConfig(ctx: ExtensionContext) {
    if (!ctx.isProjectTrusted()) return undefined;

    const configPath = join(ctx.cwd, CONFIG_DIR_NAME, "role-models.json");
    try {
      return JSON.parse(await readFile(configPath, "utf8"));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw new Error(`无法读取角色模型配置 ${configPath}：${textOf(error)}`);
    }
  }

  async function readSessionRoleConfig(ctx: ExtensionContext) {
    const persisted = await readRoleConfig(ctx);
    return resolveRoleConfig({
      ...(persisted && typeof persisted === "object" ? persisted : {}),
      ...state.sessionRoleConfigOverrides,
    }) as ResolvedRoleConfig;
  }

  function activeRoleFor(ctx: ExtensionContext) {
    return activeRoleMatches(state, ctx, pi.getThinkingLevel()) ? state.activeRole : undefined;
  }

  function hasPendingRoleConfigChanges() {
    return Object.keys(state.sessionRoleConfigOverrides).length > 0;
  }

  function effectiveRoleMode(config: Pick<ResolvedRoleConfig, "mode">) {
    return state.sessionModeOverride ?? config.mode;
  }

  function isManualRoleMode(config: Pick<ResolvedRoleConfig, "mode">) {
    return effectiveRoleMode(config) === "manual";
  }

  function stageRoleConfig(changes: Record<string, unknown>) {
    state.sessionRoleConfigOverrides = { ...state.sessionRoleConfigOverrides, ...changes };
  }

  async function writeBackManualModelSelection(
    event: { model?: unknown },
    ctx: ExtensionContext,
    config: ResolvedRoleConfig,
  ) {
    const role = state.activeRole?.role;
    if (!role || !ROLE_NAMES.includes(role)) {
      ctx.ui.notify(
        "手动模式下模型已由宿主切换；当前无活动角色，未写入 .pi/role-models.json。",
        "info",
      );
      return;
    }
    if (!ctx.isProjectTrusted()) {
      ctx.ui.notify("手动模式写回仅允许在受信任项目中运行；本次切换未写入项目文件。", "info");
      return;
    }

    let reference: { provider: string; model: string };
    try {
      reference = normalizeModelReference(event.model, "手动切换模型");
    } catch (error) {
      ctx.ui.notify(`手动模式下忽略无法解析的模型切换：${textOf(error)}`, "warning");
      return;
    }

    const current = config[role as keyof Pick<ResolvedRoleConfig, "architect" | "developer-test" | "docs-commit">];
    const thinkingNow = pi.getThinkingLevel();
    const thinkingLevel = (THINKING_LEVELS as readonly string[]).includes(thinkingNow)
      ? thinkingNow
      : current.thinkingLevel;
    if (current.provider === reference.provider && current.model === reference.model) {
      state.activeRole = { role, ...reference, thinkingLevel };
      return;
    }

    const changes: Record<string, unknown> = {
      [role]: { ...reference, thinkingLevel },
    };
    const configPath = resolve(ctx.cwd, CONFIG_DIR_NAME, "role-models.json");
    try {
      await withFileMutationQueue(configPath, async () => {
        const persisted = await readRoleConfig(ctx);
        const persistedBase = persisted && typeof persisted === "object" ? persisted : {};
        const resolved = resolveRoleConfig({ ...persistedBase, ...changes });
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, `${JSON.stringify(resolved, null, 2)}\n`, "utf8");
      });
      delete state.sessionRoleConfigOverrides[role];
      state.activeRole = { role, ...reference, thinkingLevel };
      ctx.ui.notify(
        `手动模式写回：${roleLabel(role)} → ${reference.provider}/${reference.model} 已写入 .pi/role-models.json。`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(`手动模式写回失败：${textOf(error)}`, "error");
    }
  }

  async function saveRoleConfig(ctx: ExtensionCommandContext) {
    if (!ctx.isProjectTrusted()) {
      ctx.ui.notify("保存角色配置仅允许在受信任项目中运行；请先信任当前项目", "error");
      return;
    }
    if (!hasPendingRoleConfigChanges()) {
      ctx.ui.notify("当前没有未保存的角色配置变更。", "info");
      return;
    }

    const changes = { ...state.sessionRoleConfigOverrides };
    const configPath = resolve(ctx.cwd, CONFIG_DIR_NAME, "role-models.json");
    try {
      const next = await withFileMutationQueue(configPath, async () => {
        const persisted = await readRoleConfig(ctx);
        const current = persisted && typeof persisted === "object" ? persisted : {};
        const resolved = resolveRoleConfig({ ...current, ...changes });
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, `${JSON.stringify(resolved, null, 2)}\n`, "utf8");
        return resolved as ResolvedRoleConfig;
      });
      state.sessionRoleConfigOverrides = {};
      state.workflowModeStatus = next.workflowMode;
      state.workflowExecutorStatus = next.workflowExecutor;
      refreshRoleStatus(ctx, state.sessionModeOverride ?? next.mode);
      ctx.ui.notify("已保存角色配置到 .pi/role-models.json。", "info");
    } catch (error) {
      ctx.ui.notify(`保存角色配置失败：${textOf(error)}`, "error");
    }
  }

  function inactiveWorkflowStateLabel() {
    return `策略 ${workflowModeLabel(state.workflowModeStatus)} · 执行器 ${workflowExecutorLabel(state.workflowExecutorStatus)} · 无活动工作流`;
  }

  function workflowStateLabel(workflowState = deps.getWorkflowState()) {
    if (!workflowState) return inactiveWorkflowStateLabel();

    const progress = workflowProgress(workflowState);
    const current = progress.currentTaskId ? ` · 当前 ${progress.currentTaskId}` : "";
    const executor = ` · ${workflowExecutorLabel(workflowState.executor)}`;
    if (workflowState.status === "paused") return `已暂停 ${progress.completed}/${progress.total}${executor}${current}`;
    if (workflowState.status === "replanning") return `等待重规划 ${progress.completed}/${progress.total}${executor}`;
    if (workflowState.status === "completed") return `已完成 ${progress.completed}/${progress.total}${executor}`;
    if (workflowState.status === "cancelled") return `已取消 ${progress.completed}/${progress.total}${executor}`;
    return `运行 ${progress.completed}/${progress.total}${executor}${current || " · 待调度"}`;
  }

  function workflowStatusLabel(workflowState = deps.getWorkflowState()) {
    if (!workflowState || ["completed", "cancelled"].includes(workflowState.status)) {
      return inactiveWorkflowStateLabel();
    }
    return workflowStateLabel(workflowState);
  }

  function refreshRoleStatus(ctx: ExtensionContext, mode: string) {
    const role = activeRoleFor(ctx);
    const model = ctx.model
      ? `${shortModelName(ctx.model.id)}/${pi.getThinkingLevel()}`
      : "未选择模型";
    ctx.ui.setStatus(
      "pi-init",
      `● ${roleModeLabel(mode)} · ${role ? `${roleLabel(role.role)} · ` : ""}${model} · 工作流 · ${workflowStatusLabel()}`,
    );
  }

  function setRoleStatus(ctx: ExtensionContext, mode: string) {
    state.roleModeStatus = mode;
    refreshRoleStatus(ctx, mode);
  }

  function startPendingRoleCompaction(ctx: ExtensionContext) {
    if (!state.pendingRoleCompaction || state.roleCompactionInFlight) return;

    const transition = state.pendingRoleCompaction;
    state.pendingRoleCompaction = undefined;
    state.roleCompactionInFlight = true;
    ctx.ui.setStatus("pi-init-compaction", "● 角色切换 · 正在压缩上下文");

    const continueAfterTransition = (warning?: string) => {
      if (warning) ctx.ui.notify(warning, "warning");
      if (transition.continuation?.kind === "workflow-task") {
        deps.sendWorkflowTaskMessage(ctx, transition.continuation.taskId, warning);
        return;
      }
      if (transition.continuation?.kind === "workflow-schedule") {
        deps.setWorkflowDispatchInFlight(false);
        void deps.scheduleWorkflow(ctx).catch((error) => ctx.ui.notify(`工作流自动续跑失败：${textOf(error)}`, "error"));
        return;
      }
      if (transition.continuation?.kind === "workflow-review") {
        deps.setWorkflowDispatchInFlight(false);
        return;
      }
      if (transition.continuation?.kind === "workflow-replan") {
        deps.setWorkflowDispatchInFlight(false);
        deps.sendWorkflowReplanMessage(ctx);
        return;
      }

      try {
        deps.setInternalContinuationPending(true);
        pi.sendMessage(
          {
            customType: ROLE_SWITCH_CONTINUATION_TYPE,
            content: `已完成从${roleLabel(transition.fromRole)}到${roleLabel(transition.toRole)}的自动角色切换和上下文压缩。请继续当前任务。`,
            display: false,
            details: transition,
          },
          { triggerTurn: true },
        );
      } catch (error) {
        deps.setInternalContinuationPending(false);
        ctx.ui.notify(`上下文压缩已完成，但无法自动继续：${textOf(error)}`, "warning");
      }
    };

    // Pi may have auto-compacted immediately before agent_settled. Calling the
    // manual API again in that state only produces "Already compacted".
    if (ctx.sessionManager.getBranch().at(-1)?.type === "compaction") {
      state.roleCompactionInFlight = false;
      ctx.ui.setStatus("pi-init-compaction", undefined);
      continueAfterTransition();
      return;
    }

    ctx.compact({
      customInstructions: ROLE_SWITCH_COMPACTION_INSTRUCTIONS,
      onComplete: () => {
        state.roleCompactionInFlight = false;
        ctx.ui.setStatus("pi-init-compaction", undefined);
        continueAfterTransition();
      },
      onError: (error) => {
        state.roleCompactionInFlight = false;
        ctx.ui.setStatus("pi-init-compaction", undefined);
        continueAfterTransition(`角色切换后的上下文压缩失败，仍将继续当前任务：${error.message}`);
      },
    });
  }

  async function applyRole(role: string, ctx: ExtensionContext) {
    const config = await readSessionRoleConfig(ctx);
    state.workflowModeStatus = config.workflowMode;
    state.workflowExecutorStatus = config.workflowExecutor;
    const target = config[role as keyof Pick<ResolvedRoleConfig, "architect" | "developer-test" | "docs-commit">];
    if (!target) throw new Error(`未知角色：${role}`);
    const model = ctx.modelRegistry.find(target.provider, target.model);
    if (!model) {
      throw new Error(
        `角色 ${roleLabel(role)} 配置的模型不存在：${target.provider}/${target.model}；请在 /pi-init config 中修改`,
      );
    }
    if (!(await pi.setModel(model))) {
      throw new Error(`角色 ${roleLabel(role)} 无法使用模型 ${target.provider}/${target.model}：缺少可用凭据`);
    }

    pi.setThinkingLevel(target.thinkingLevel as Parameters<typeof pi.setThinkingLevel>[0]);
    const result = {
      role,
      provider: target.provider,
      model: target.model,
      thinkingLevel: pi.getThinkingLevel(),
    };
    state.activeRole = result;
    setRoleStatus(ctx, state.sessionModeOverride ?? config.mode);
    return result;
  }

  function currentRole(role: string, ctx: ExtensionContext) {
    const result = ctx.model
      ? {
          role,
          provider: ctx.model.provider,
          model: ctx.model.id,
          thinkingLevel: pi.getThinkingLevel(),
        }
      : undefined;
    if (
      !state.activeRole ||
      !result ||
      state.activeRole.role !== role ||
      state.activeRole.provider !== result.provider ||
      state.activeRole.model !== result.model ||
      state.activeRole.thinkingLevel !== result.thinkingLevel
    ) {
      throw new Error(`当前为手动模式，请先执行 /pi-init role ${role}`);
    }
    return result;
  }

  async function automaticRole(role: string, ctx: ExtensionContext) {
    const configuredMode = (await readSessionRoleConfig(ctx)).mode;
    const mode = state.sessionModeOverride ?? configuredMode;
    if (mode === "auto") {
      const previousRole = activeRoleFor(ctx)?.role;
      const compactAfterSwitch = shouldCompactOnRoleSwitch({
        mode,
        previousRole,
        nextRole: role,
        contextUsage: ctx.getContextUsage(),
      });
      const result = await applyRole(role, ctx);
      const transition = compactAfterSwitch && previousRole
        ? { fromRole: previousRole, toRole: result.role }
        : undefined;
      if (transition) state.pendingRoleCompaction = transition;
      return { mode, requestedRole: role, result, transition };
    }
    if (mode === "manual") {
      return { mode, requestedRole: role, result: currentRole(role, ctx) };
    }

    if (state.activeRole?.role === role) {
      try {
        return { mode, requestedRole: role, result: currentRole(role, ctx) };
      } catch {
        // The user changed the model or thinking level; confirm the role again.
      }
    }
    if (!ctx.hasUI) {
      throw new Error(`角色切换模式为确认后切换，但当前环境无法确认；请先执行 /pi-init role ${role} 或 /pi-init mode auto`);
    }

    const decision = await showMenu(ctx, `建议切换到「${roleLabel(role)}」`, [
      { value: "accept", label: "采用建议", description: "切换到项目配置的模型" },
      { value: "manual", label: "切换为手动模式", description: "本次会话不再自动换角" },
      { value: "cancel", label: "取消" },
    ]);
    if (decision === "accept") {
      return { mode, requestedRole: role, result: await applyRole(role, ctx) };
    }
    if (decision === "manual") {
      state.sessionModeOverride = "manual";
      setRoleStatus(ctx, "manual");
      const selected = await showMenu(
        ctx,
        "手动选择角色",
        ROLE_NAMES.map((value) => ({ value, label: roleLabel(value) })),
      );
      if (!selected || isMenuBack(selected)) throw new Error("已取消手动角色选择");
      return {
        mode: "manual",
        requestedRole: role,
        result: await applyRole(selected, ctx),
      };
    }
    throw new Error("已取消角色切换");
  }

  return {
    activeRoleFor,
    readSessionRoleConfig,
    hasPendingRoleConfigChanges,
    effectiveRoleMode,
    isManualRoleMode,
    stageRoleConfig,
    writeBackManualModelSelection,
    saveRoleConfig,
    refreshRoleStatus,
    setRoleStatus,
    startPendingRoleCompaction,
    applyRole,
    automaticRole,
    currentRole,
    workflowStateLabel,
    workflowStatusLabel,
  };
}

export type RoleRuntime = ReturnType<typeof createRoleRuntime>;
