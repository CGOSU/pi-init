import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutoModelConfig, ResolvedRoleConfig, ThinkingLevel } from "../src/role-types.ts";
import { parseAutoModel, validateAutoModelCapabilities } from "../src/auto-model.ts";
import { unwrapRoleResult } from "../src/roles.ts";
import type { RoleRuntime } from "./role-runtime.ts";
import { getAvailableRoleModels, isMenuBack, MENU_BACK, selectModelWithSearch, showMenu } from "./ui.ts";

export async function configureModelStrategy(ctx: ExtensionCommandContext, config: ResolvedRoleConfig) {
  if (!ctx.hasUI) {
    ctx.ui.notify("模型策略配置需要交互式 UI", "error");
    return;
  }
  const choice = await showMenu(ctx, "模型策略", [
    { value: "roles", label: "按职责配置", description: "每个职责使用独立模型与推理强度" },
    { value: "auto", label: "Auto（固定模型）", description: "固定一个模型，在配置范围内自动调整推理强度；职责分工不变" },
    { value: MENU_BACK, label: "← 返回上一级" },
  ], { selectedValue: config.modelStrategy });
  if (!choice || isMenuBack(choice)) return;
  return choice as "roles" | "auto";
}

export async function stageAutoModel(ctx: ExtensionCommandContext, autoModel: AutoModelConfig, runtime: RoleRuntime) {
  const parsed = unwrapRoleResult(parseAutoModel(autoModel));
  const model = ctx.modelRegistry.find(parsed.provider, parsed.model);
  if (!model) throw new Error("Auto 固定模型不在当前目录中");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error("Auto 固定模型缺少可用凭据，未修改策略");
  unwrapRoleResult(validateAutoModelCapabilities(parsed, getSupportedThinkingLevels(model)));
  runtime.stageRoleConfig({ modelStrategy: "auto", autoModel: parsed });
}

export async function configureAutoModel(
  ctx: ExtensionCommandContext,
  config: ResolvedRoleConfig,
  field: "auto-model" | "auto-initial" | "auto-range",
  runtime: RoleRuntime,
) {
  const previous = config.autoModel;
  let autoModel: AutoModelConfig;
  if (field === "auto-model") {
    const models = getAvailableRoleModels(ctx);
    const current = previous && models.find((model) => model.provider === previous.provider && model.id === previous.model);
    const selected = await selectModelWithSearch(ctx, "Auto 固定模型", models, current);
    if (!selected || isMenuBack(selected)) return;
    const supported = getSupportedThinkingLevels(selected);
    const initial = previous && supported.includes(previous.initialThinkingLevel)
      ? previous.initialThinkingLevel
      : supported.includes("medium") ? "medium" : supported[0];
    const initialIndex = supported.indexOf(initial);
    const lower = supported.slice(0, initialIndex + 1);
    const upper = supported.slice(initialIndex);
    autoModel = {
      provider: selected.provider,
      model: selected.id,
      initialThinkingLevel: initial,
      minThinkingLevel: previous && lower.includes(previous.minThinkingLevel)
        ? previous.minThinkingLevel : lower.includes("low") ? "low" : lower[0],
      maxThinkingLevel: previous && upper.includes(previous.maxThinkingLevel)
        ? previous.maxThinkingLevel : upper[upper.length - 1],
    };
  } else {
    if (!previous) {
      ctx.ui.notify("请先配置 Auto 固定模型", "info");
      return;
    }
    const model = ctx.modelRegistry.find(previous.provider, previous.model);
    if (!model) throw new Error("Auto 固定模型不在当前目录中");
    const supported = getSupportedThinkingLevels(model);
    const pick = (title: string, levels: readonly ThinkingLevel[], selectedValue: ThinkingLevel) => showMenu(
      ctx,
      title,
      [...levels.map((value) => ({ value, label: value })), { value: MENU_BACK, label: "← 返回上一级" }],
      { selectedValue },
    );
    if (field === "auto-initial") {
      const levels = supported.slice(supported.indexOf(previous.minThinkingLevel), supported.indexOf(previous.maxThinkingLevel) + 1);
      const initial = await pick("Auto 默认强度", levels, previous.initialThinkingLevel);
      if (!initial || isMenuBack(initial)) return;
      autoModel = { ...previous, initialThinkingLevel: initial as ThinkingLevel };
    } else {
      const initialIndex = supported.indexOf(previous.initialThinkingLevel);
      const min = await pick("Auto 最低强度", supported.slice(0, initialIndex + 1), previous.minThinkingLevel);
      if (!min || isMenuBack(min)) return;
      const max = await pick("Auto 最高强度", supported.slice(initialIndex), previous.maxThinkingLevel);
      if (!max || isMenuBack(max)) return;
      autoModel = { ...previous, minThinkingLevel: min as ThinkingLevel, maxThinkingLevel: max as ThinkingLevel };
    }
  }
  await stageAutoModel(ctx, autoModel, runtime);
}
