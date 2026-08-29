import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  ROLE_MODES,
  ROLE_NAMES,
  roleLabel,
  roleModeLabel,
} from "../src/roles.js";
import type { ResolvedRoleConfig } from "./contracts.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import {
  workflowExecutorLabel,
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

export type ControlCenterDependencies = {
  state: ExtensionRuntimeState;
  roleRuntime: RoleRuntime;
  quickInit: (targetDir: string, ctx: ExtensionCommandContext) => Promise<void>;
  advancedInit: (targetDir: string, ctx: ExtensionCommandContext) => Promise<void>;
  getThinkingLevel: () => string;
  workflowCommand: (
    action: string | undefined,
    taskId: string | undefined,
    ctx: ExtensionCommandContext,
  ) => Promise<void>;
};

function roleMenuItems(config: ResolvedRoleConfig, mode: string, hasPendingChanges: boolean) {
  return [
    {
      value: "mode",
      label: `● 模式 · ${roleModeLabel(mode)}`,
      description: "只影响本次会话，不修改项目文件",
    },
    ...ROLE_NAMES.map((role) => ({
      value: role,
      label: `● ${roleLabel(role)} · ${shortModelName(config[role].model)}/${config[role].thinkingLevel}`,
      description: formatRoleModel(config[role]),
    })),
    {
      value: "save",
      label: hasPendingChanges ? "◆ 保存角色配置（有未保存变更）" : "◆ 保存角色配置",
      description: hasPendingChanges ? "将本次会话的暂存配置写入项目文件" : "当前没有待保存的配置变更",
    },
    { value: MENU_BACK, label: "← 返回上一级", description: "不修改其他设置" },
  ];
}

export function createControlCenter(deps: ControlCenterDependencies) {
  const { state, roleRuntime } = deps;

  async function setSessionMode(requested: string | undefined, ctx: ExtensionCommandContext) {
    const mode = requested || await showMenu(
      ctx,
      "角色切换模式",
      ROLE_MODES.map((value) => ({
        value,
        label: roleModeLabel(value),
        description:
          value === "auto" ? "按任务自动选择角色和模型"
          : value === "manual" ? "不自动换角，原生 /model 切换直接写回项目配置"
          : undefined,
      })),
    );
    if (!mode || isMenuBack(mode)) return undefined;
    if (!ROLE_MODES.includes(mode)) {
      ctx.ui.notify(`未知角色模式：${mode}；可用值：${ROLE_MODES.join(", ")}`, "error");
      return undefined;
    }
    state.sessionModeOverride = mode;
    roleRuntime.setRoleStatus(ctx, mode);
    ctx.ui.notify(`当前会话角色模式：${roleModeLabel(mode)}`, "info");
    return mode;
  }

  async function switchRole(requested: string | undefined, ctx: ExtensionCommandContext) {
    const role = requested || await showMenu(
      ctx,
      "切换角色",
      ROLE_NAMES.map((value) => ({ value, label: roleLabel(value) })),
    );
    if (!role || isMenuBack(role)) return;
    if (!ROLE_NAMES.includes(role)) {
      ctx.ui.notify(`未知角色：${role}；可用值：${ROLE_NAMES.join(", ")}`, "error");
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
        description: "所有合法的 1 至 12 个任务都创建并自动推进工作流",
      },
      {
        value: "auto",
        label: config.workflowMode === "auto" ? "保持自动策略" : "自动策略",
        description: "不超过 2 个任务时跳过编排，更多任务使用工作流",
      },
      { value: MENU_BACK, label: "← 返回上一级" },
    ], { selectedValue: config.workflowMode });
    if (!choice || isMenuBack(choice)) return;

    const executor = await showMenu(ctx, "工作流执行器", [
      {
        value: "local",
        label: config.workflowExecutor === "local" ? "保持主会话顺序执行" : "主会话顺序执行",
        description: "使用当前会话和现有角色切换逻辑",
      },
      {
        value: "subtask",
        label: config.workflowExecutor === "subtask" ? "保持 pi-subtask 对话 fork" : "pi-subtask 对话 fork",
        description: "需要已安装并启用 gary149/pi-subtask；主会话调用 subtask 工具顺序委派，结果消息回到会话后自动推进",
      },
      { value: MENU_BACK, label: "← 返回上一级" },
    ], { selectedValue: config.workflowExecutor });
    if (!executor || isMenuBack(executor)) return;

    if (choice !== config.workflowMode || executor !== config.workflowExecutor) {
      roleRuntime.stageRoleConfig({ workflowMode: choice, workflowExecutor: executor });
    }
    const next = await roleRuntime.readSessionRoleConfig(ctx);
    state.workflowModeStatus = next.workflowMode;
    state.workflowExecutorStatus = next.workflowExecutor;
    roleRuntime.refreshRoleStatus(ctx, state.roleModeStatus);
    ctx.ui.notify(
      next.workflowMode === "off"
        ? `当前会话工作流已关闭；执行器为${workflowExecutorLabel(next.workflowExecutor)}，新规划将被拒绝。保存角色配置后才会写入项目文件。`
        : next.workflowMode === "on"
          ? `当前会话工作流已设为始终编排，执行器为${workflowExecutorLabel(next.workflowExecutor)}。保存角色配置后才会写入项目文件。`
          : `当前会话工作流已设为自动，执行器为${workflowExecutorLabel(next.workflowExecutor)}；不超过 2 个任务的规划将跳过编排。保存角色配置后才会写入项目文件。`,
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
    const role = requested || await showMenu(
      ctx,
      "配置角色模型",
      ROLE_NAMES.map((value) => ({ value, label: roleLabel(value) })),
    );
    if (!role || isMenuBack(role)) return;
    if (!ROLE_NAMES.includes(role)) {
      ctx.ui.notify(`未知角色：${role}；可用值：${ROLE_NAMES.join(", ")}`, "error");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("/pi-init config 需要交互式 UI", "error");
      return;
    }

    try {
      const selection = await selectRoleModel(ctx, role);
      if (isMenuBack(selection)) return;
      if (!selection) {
        ctx.ui.notify("已取消角色配置，没有写入文件。", "warning");
        return;
      }
      roleRuntime.stageRoleConfig({ [role]: selection });
      const result = await roleRuntime.applyRole(role, ctx);
      ctx.ui.notify(
        `已暂存 ${roleLabel(result.role)}：${shortModelName(result.model)}/${result.thinkingLevel}；仅当前会话生效，执行 /pi-init save 才写入项目文件。`,
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
    while (true) {
      const mode = state.sessionModeOverride ?? config.mode;
      const action = await showMenu(ctx, "角色与模型", roleMenuItems(config, mode, roleRuntime.hasPendingRoleConfigChanges()));
      if (!action || isMenuBack(action)) return;
      if (action === "mode") {
        await setSessionMode(undefined, ctx);
        continue;
      }
      if (action === "save") {
        await roleRuntime.saveRoleConfig(ctx);
        config = await roleRuntime.readSessionRoleConfig(ctx);
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
    let selectedAction: string | undefined;
    while (true) {
      const config = await roleRuntime.readSessionRoleConfig(ctx);
      state.workflowModeStatus = config.workflowMode;
      state.workflowExecutorStatus = config.workflowExecutor;
      const mode = state.sessionModeOverride ?? config.mode;
      const role = roleRuntime.activeRoleFor(ctx);
      const modelLabel = ctx.model
        ? `${shortModelName(ctx.model.id)}/${deps.getThinkingLevel()}`
        : "未选择模型";
      const summary = [
        `模式  ${roleModeLabel(mode)}`,
        role
          ? `角色  ${roleLabel(role.role)}`
          : "角色  尚未切换（按任务自动选择）",
        `模型  ${modelLabel}`,
        `工作流策略  ${workflowModeLabel(config.workflowMode)}`,
        `工作流执行器  ${workflowExecutorLabel(config.workflowExecutor)}`,
        `工作流状态  ${roleRuntime.workflowStateLabel()}`,
      ];
      if (showGuide) summary.push("", "快速初始化适合大多数项目；高级初始化可修改全部配置。");
      const action = await showMenu(ctx, "Pi Init 控制中心", [
        { value: "quick", label: "◆ 初始化 · 快速初始化当前项目", description: "自动读取项目元数据，只确认一次" },
        { value: "advanced", label: "◆ 初始化 · 高级初始化", description: "编辑项目名称、语言、测试命令和 Skill" },
        { value: "config", label: "◆ 变更 · 角色与模型", description: "查看或暂存三个角色的模型配置" },
        { value: "workflow-config", label: `◆ 变更 · 工作流策略：${workflowModeLabel(config.workflowMode)}`, description: "配置当前会话的 task_workflow 编排策略" },
        { value: "role", label: "◆ 变更 · 切换角色", description: "立即应用某个角色的模型和推理强度" },
        { value: "mode", label: `◆ 变更 · 切换模式：${roleModeLabel(mode)}`, description: "只影响当前会话" },
        { value: "save", label: roleRuntime.hasPendingRoleConfigChanges() ? "◆ 保存 · 保存角色配置（有未保存变更）" : "◆ 保存 · 保存角色配置", description: roleRuntime.hasPendingRoleConfigChanges() ? "将暂存配置写入 .pi/role-models.json" : "当前没有待保存的配置变更" },
        { value: "workflow", label: "◆ 工作流 · 查看任务进度", description: "查看、恢复、重试或取消架构分配的任务" },
        { value: "exit", label: "← 返回" },
      ], { summary, selectedValue: selectedAction });
      if (!action || isMenuBack(action) || action === "exit") return;
      if (action === "quick") return deps.quickInit(".", ctx);
      if (action === "advanced") return deps.advancedInit(".", ctx);
      selectedAction = action;
      if (action === "config") {
        await configureRoleCenter(ctx);
        continue;
      }
      if (action === "save") {
        await roleRuntime.saveRoleConfig(ctx);
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
      if (action === "mode") {
        await setSessionMode(undefined, ctx);
      }
      if (action === "workflow") {
        await deps.workflowCommand("status", undefined, ctx);
      }
    }
  }

  return {
    setSessionMode,
    switchRole,
    configureWorkflow,
    configureRole,
    configureRoleCenter,
    showControlCenter,
  };
}

export type ControlCenter = ReturnType<typeof createControlCenter>;
