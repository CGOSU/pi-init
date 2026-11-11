import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  roleLabel,
} from "../src/roles.ts";
import type { ResolvedRoleConfig, RoleModelConfig } from "./contracts.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import {
  workflowModeLabel,
  type RoleRuntime,
} from "./role-runtime.ts";
import {
  formatRoleModel,
  isMenuBack,
  MENU_BACK,
  selectRoleModel,
  shortModelName,
  showMenu,
} from "./ui.ts";
import type { WorkflowCommandResult } from "./workflow-panel-actions.ts";
import { configureAutoModel, configureModelStrategy, stageAutoModel } from "./model-strategy-menu.ts";

export type ControlCenterDependencies = {
  state: ExtensionRuntimeState;
  roleRuntime: RoleRuntime;
  quickInit: (targetDir: string, ctx: ExtensionCommandContext) => Promise<void>;
  advancedInit: (targetDir: string, ctx: ExtensionCommandContext) => Promise<void | typeof MENU_BACK>;
  getThinkingLevel: () => string;
  diagnosticsCommand?: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  workflowCommand: (
    action: string | undefined,
    taskId: string | undefined,
    ctx: ExtensionCommandContext,
  ) => Promise<WorkflowCommandResult>;
};

function roleMenuItems(config: ResolvedRoleConfig, roleNames: string[]) {
  return [
    {
      value: "strategy",
      label: config.modelStrategy === "auto" ? "● 模型策略 · Auto（固定模型）" : "● 模型策略 · 按职责配置",
      description: "选择后返回此页，再配置模型和推理强度",
    },
    ...(config.requiresAutomaticMigration ? [{
      value: "enable-automatic",
      label: "启用全自动并迁移旧配置",
      description: "旧配置限制自动切换；仅明确启用后生效，显式保存才写入文件",
    }] : []),
    ...(config.modelStrategy === "auto" ? [
      {
        value: "auto-model",
        label: `● 模型 ${config.autoModel ? shortModelName(config.autoModel.model) : "未配置"}`,
        description: config.autoModel ? `${config.autoModel.provider}/${config.autoModel.model}` : "先选择固定模型，再调整默认强度和范围",
      },
      { value: "auto-initial", label: `● 默认强度：${config.autoModel?.initialThinkingLevel ?? "未配置"}` },
      { value: "auto-range", label: `● 强度范围：${config.autoModel ? `${config.autoModel.minThinkingLevel}=>${config.autoModel.maxThinkingLevel}` : "未配置"}` },
      ...(config.autoModel ? [{ value: "resume-auto", label: "恢复 Auto 强度控制", description: "手动接管后重新允许 Auto 调整推理强度" }] : []),
    ] : roleNames.map((role) => {
      const model = config.roleModels[role];
      return {
        value: role,
        label: model
          ? `● ${roleLabel(role)} · ${shortModelName(model.model)}/${model.thinkingLevel}`
          : `● ${roleLabel(role)} · 会话默认模型`,
        description: model ? formatRoleModel(model) : "未单独配置模型时，沿用当前 Pi 会话模型和推理强度",
      };
    })),
    { value: MENU_BACK, label: "← 返回上一级", description: "不修改其他设置" },
  ];
}

export function createControlCenter(deps: ControlCenterDependencies) {
  const { state, roleRuntime } = deps;

  function saveMenuOptions(ctx: ExtensionCommandContext) {
    return {
      onSave: async () => {
        const result = await roleRuntime.saveRoleConfig(ctx);
        ctx.ui.notify(result.message, result.ok ? "info" : "error");
        return result;
      },
    };
  }

  async function switchRole(requested: string | undefined, ctx: ExtensionCommandContext) {
    const roleNames = state.configuredRoleNames;
    const role = requested || await showMenu(
      ctx,
      "切换角色",
      roleNames.map((value) => ({ value, label: roleLabel(value) })),
      saveMenuOptions(ctx),
    );
    if (!role || isMenuBack(role)) return;
    if (!roleNames.includes(role)) {
      ctx.ui.notify(`角色 ${role} 未启用；可用值：${roleNames.join(", ")}`, "error");
      return;
    }
    try {
      const result = await roleRuntime.applyRole(role, ctx);
      ctx.ui.notify(
        `已切换到 ${roleLabel(result.role)}：${shortModelName(result.model)}/${result.thinkingLevel}`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(String(error instanceof Error ? error.message : error), "error");
    }
  }

  async function configureWorkflow(ctx: ExtensionCommandContext) {
    if (!ctx.isProjectTrusted()) {
      ctx.ui.notify("/pi-init config 仅允许在受信任项目中运行；请先信任当前项目", "error");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("/pi-init config workflow 需要交互式 UI", "error");
      return;
    }

    const config = await roleRuntime.readSessionRoleConfig(ctx);
    const choice = await showMenu(ctx, "任务工作流策略", [
      {
        value: "off",
        label: config.workflowMode === "off" ? "保持关闭" : "关闭工作流",
        description: "阻止新规划，已开始的工作流仍可查看和收尾",
      },
      {
        value: "on",
        label: config.workflowMode === "on" ? "保持始终编排" : "始终编排",
        description: "所有合法的任务计划都创建并自动推进工作流",
      },
      {
        value: "auto",
        label: config.workflowMode === "auto" ? "保持自动策略" : "自动策略",
        description: "不超过 2 个任务时跳过编排，更多任务使用工作流",
      },
      { value: MENU_BACK, label: "← 返回上一级" },
    ], { selectedValue: config.workflowMode, ...saveMenuOptions(ctx) });
    if (!choice || isMenuBack(choice)) return;

    if (choice !== config.workflowMode) {
      roleRuntime.stageRoleConfig({ workflowMode: choice });
    }
    const next = await roleRuntime.readSessionRoleConfig(ctx);
    state.workflowModeStatus = next.workflowMode;
    roleRuntime.refreshRoleStatus(ctx);
    ctx.ui.notify(
      next.workflowMode === "off"
        ? "当前会话工作流已关闭，新规划将被拒绝。保存角色配置后才会写入项目文件。"
        : next.workflowMode === "on"
          ? "当前会话工作流已设为始终编排。保存角色配置后才会写入项目文件。"
          : "当前会话工作流已设为自动；不超过 2 个任务的规划将跳过编排。保存角色配置后才会写入项目文件。",
      "info",
    );
  }

  async function configureRole(requested: string | undefined, ctx: ExtensionCommandContext) {
    if (requested === "workflow") {
      await configureWorkflow(ctx);
      return;
    }
    if (!ctx.isProjectTrusted()) {
      ctx.ui.notify("/pi-init config 仅允许在受信任项目中运行；请先信任当前项目", "error");
      return;
    }
    const config = await roleRuntime.readSessionRoleConfig(ctx);
    const roleNames = state.configuredRoleNames;
    const role = requested || await showMenu(
      ctx,
      "配置角色模型",
      roleNames.map((value) => ({ value, label: roleLabel(value) })),
      saveMenuOptions(ctx),
    );
    if (!role || isMenuBack(role)) return;
    if (!roleNames.includes(role)) {
      ctx.ui.notify(`角色 ${role} 未启用；可用值：${roleNames.join(", ")}`, "error");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("/pi-init config 需要交互式 UI", "error");
      return;
    }

    try {
      let savedSelection: RoleModelConfig | undefined;
      const selection = await selectRoleModel(ctx, role, config.roleModels[role], {
        onSave: async (draft) => {
          if (!draft || typeof draft === "string") {
            return { ok: false as const, message: "请先选择模型和推理强度，再保存角色配置。" };
          }
          roleRuntime.stageRoleConfig({ roleModels: { [role]: draft } });
          const saveResult = await roleRuntime.saveRoleConfig(ctx);
          if (saveResult.ok) savedSelection = draft;
          return saveResult;
        },
      });
      if (isMenuBack(selection)) return;
      if (!selection) {
        ctx.ui.notify("已取消角色配置，没有写入文件。", "warning");
        return;
      }
      const alreadySavedInMenu = savedSelection !== undefined
        && savedSelection.provider === selection.provider
        && savedSelection.model === selection.model
        && savedSelection.thinkingLevel === selection.thinkingLevel;
      const alreadySaved = alreadySavedInMenu
        || await roleRuntime.isRoleModelConfigPersisted(role, selection, ctx);
      if (alreadySaved) roleRuntime.clearStagedRoleConfig(role);
      else roleRuntime.stageRoleConfig({ roleModels: { [role]: selection } });
      if (config.modelStrategy === "auto") {
        ctx.ui.notify("职责模型映射已保留；Auto 下暂不使用，不改变当前固定模型或强度。", "info");
        return;
      }
      const result = await roleRuntime.applyRole(role, ctx);
      ctx.ui.notify(
        alreadySaved
          ? `角色配置已保存并应用：${roleLabel(result.role)} · ${shortModelName(result.model)}/${result.thinkingLevel}。`
          : `角色配置已修改，尚未保存。已暂存 ${roleLabel(result.role)}：${shortModelName(result.model)}/${result.thinkingLevel}；仅当前会话生效，执行 /pi-init save 才写入项目文件。`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(String(error instanceof Error ? error.message : error), "error");
    }
  }

  async function configureRoleCenter(ctx: ExtensionCommandContext) {
    if (!ctx.isProjectTrusted()) {
      ctx.ui.notify("/pi-init config 仅允许在受信任项目中运行；请先信任当前项目", "error");
      return;
    }

    let config = await roleRuntime.readSessionRoleConfig(ctx);
    let selectedStrategy = config.modelStrategy;
    const saveOptions = {
      onSave: async () => {
        if (selectedStrategy === "auto" && !config.autoModel) {
          return { ok: false, message: "请先配置 Auto 固定模型，再保存策略" };
        }
        return saveMenuOptions(ctx).onSave();
      },
    };
    while (true) {
      const displayConfig = { ...config, modelStrategy: selectedStrategy };
      const action = await showMenu(ctx, "角色与模型", roleMenuItems(displayConfig, state.configuredRoleNames), saveOptions);
      if (!action || isMenuBack(action)) return;
      if (action === "strategy") {
        try {
          const strategy = await configureModelStrategy(ctx, displayConfig);
          if (strategy === "roles") roleRuntime.stageRoleConfig({ modelStrategy: "roles" });
          if (strategy === "auto" && config.autoModel) await stageAutoModel(ctx, config.autoModel, roleRuntime);
          if (strategy) selectedStrategy = strategy;
        } catch (error) {
          ctx.ui.notify(String(error instanceof Error ? error.message : error), "error");
        }
        config = await roleRuntime.readSessionRoleConfig(ctx);
        continue;
      }
      if (action === "auto-model" || action === "auto-initial" || action === "auto-range") {
        try { await configureAutoModel(ctx, config, action, roleRuntime); }
        catch (error) { ctx.ui.notify(String(error instanceof Error ? error.message : error), "error"); }
        config = await roleRuntime.readSessionRoleConfig(ctx);
        continue;
      }
      if (action === "resume-auto") {
        await roleRuntime.resumeAutoThinking(ctx);
        ctx.ui.notify("Auto 自动强度已恢复；当前强度未改变，下次任务评估生效。", "info");
        continue;
      }
      if (action === "enable-automatic") {
        await roleRuntime.enableAutomaticSwitching(ctx);
        config = await roleRuntime.readSessionRoleConfig(ctx);
        ctx.ui.notify("已为当前会话启用全自动；显式保存才迁移项目配置。", "info");
        continue;
      }
      if (action === "workflow") {
        await configureWorkflow(ctx);
        config = await roleRuntime.readSessionRoleConfig(ctx);
        continue;
      }
      await configureRole(action, ctx);
      config = await roleRuntime.readSessionRoleConfig(ctx);
    }
  }

  async function showControlCenter(ctx: ExtensionCommandContext) {
    if (ctx.mode !== "tui") {
      await deps.quickInit(".", ctx);
      return;
    }

    const showGuide = !state.controlCenterGuideShown;
    state.controlCenterGuideShown = true;
    let selectedSection: string | undefined;
    let selectedInitializationAction: string | undefined;
    let selectedChangeAction: string | undefined;
    while (true) {
      const config = await roleRuntime.readSessionRoleConfig(ctx);
      state.workflowModeStatus = config.workflowMode;
      const role = roleRuntime.activeRoleFor(ctx);
      const modelLabel = ctx.model
        ? `${shortModelName(ctx.model.id)}/${deps.getThinkingLevel()}`
        : "未选择模型";
      const summary = [
        config.requiresAutomaticMigration ? "自动执行  等待显式启用旧配置迁移" : "自动执行  已启用",
        `模型策略  ${config.modelStrategy === "auto" ? "Auto · 固定模型，自适应强度" : "按职责配置"}`,
        role
          ? `角色  ${roleLabel(role.role)}`
          : "角色  尚未切换（按任务自动选择）",
        `模型  ${modelLabel}`,
        `工作流策略  ${workflowModeLabel(config.workflowMode)}`,
        `工作流状态  ${roleRuntime.workflowStateLabel()}`,
      ];
      if (showGuide) summary.push("", "快速初始化适合大多数项目；高级初始化可修改全部配置。");
      const section = await showMenu(ctx, "Pi Init 控制中心", [
        { value: "init", label: "初始化", description: "快速初始化或高级初始化当前项目" },
        { value: "change", label: "变更", description: "模型策略、角色映射与工作流策略" },
        { value: "workflow", label: "工作流", description: "查看、留在本会话继续、新会话交接、重试或取消任务" },
        ...(deps.diagnosticsCommand ? [{ value: "diagnostics", label: "运行诊断", description: "项目与全局状态、脱敏导出、确认清理（仅本机）" }] : []),
        { value: "exit", label: "← 返回" },
      ], { summary, selectedValue: selectedSection, ...saveMenuOptions(ctx) });
      if (!section || isMenuBack(section) || section === "exit") return;
      selectedSection = section;

      if (section === "init") {
        while (true) {
          const action = await showMenu(ctx, "初始化", [
            { value: "quick", label: "快速初始化当前项目", description: "自动读取项目元数据，只确认一次" },
            { value: "advanced", label: "高级初始化", description: "编辑项目名称、语言、测试命令和角色模型" },
            { value: MENU_BACK, label: "← 返回上一级", description: "返回控制中心" },
          ], { selectedValue: selectedInitializationAction, ...saveMenuOptions(ctx) });
          if (!action || isMenuBack(action)) break;
          selectedInitializationAction = action;
          if (action === "quick") return deps.quickInit(".", ctx);
          if (action === "advanced") {
            const result = await deps.advancedInit(".", ctx);
            if (isMenuBack(result)) continue;
            return;
          }
        }
        continue;
      }

      if (section === "change") {
        while (true) {
          const currentConfig = await roleRuntime.readSessionRoleConfig(ctx);
          const action = await showMenu(ctx, "变更", [
            { value: "config", label: "角色与模型", description: "查看或暂存已配置角色的模型" },
            { value: "workflow-config", label: `工作流策略：${workflowModeLabel(currentConfig.workflowMode)}`, description: "配置当前会话的 task_workflow 编排策略" },
            { value: "role", label: "切换角色", description: "立即应用某个角色的模型和推理强度" },
            { value: MENU_BACK, label: "← 返回上一级", description: "返回控制中心" },
          ], { selectedValue: selectedChangeAction, ...saveMenuOptions(ctx) });
          if (!action || isMenuBack(action)) break;
          selectedChangeAction = action;
          if (action === "config") {
            await configureRoleCenter(ctx);
            continue;
          }
          if (action === "workflow-config") {
            await configureWorkflow(ctx);
            continue;
          }
          if (action === "role") {
            await switchRole(undefined, ctx);
            continue;
          }
        }
        continue;
      }

      if (section === "diagnostics") await deps.diagnosticsCommand?.("menu", ctx);
      if (section === "workflow") {
                  if (await deps.workflowCommand("status", undefined, ctx) === "close-panel") return;
      }
    }
  }

  return {
    switchRole,
    configureWorkflow,
    configureRole,
    configureRoleCenter,
    showControlCenter,
  };
}

export type ControlCenter = ReturnType<typeof createControlCenter>;
