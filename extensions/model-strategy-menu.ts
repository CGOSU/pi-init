import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutoModelConfig, ResolvedRoleConfig, ThinkingLevel } from "../src/role-types.ts";
import { parseAutoModel, validateAutoModelCapabilities } from "../src/auto-model.ts";
import { unwrapRoleResult } from "../src/roles.ts";
import type { RoleRuntime } from "./role-runtime.ts";
import { isMenuBack, MENU_BACK, selectRoleModel, showMenu } from "./ui.ts";

export async function configureModelStrategy(ctx: ExtensionCommandContext, config: ResolvedRoleConfig, runtime: RoleRuntime) {
  if (!ctx.hasUI) { ctx.ui.notify("模型策略配置需要交互式 UI", "error"); return; }
  const choice = await showMenu(ctx, "模型策略（与切换确认方式独立）", [
    { value: "roles", label: "按职责配置", description: "使用原职责模型和强度映射" },
    { value: "auto", label: "Auto · 固定模型，自适应强度", description: "职责映射保留但暂不使用，格式化、验证和文档提交共用原流程" },
    ...(config.modelStrategy === "auto" ? [{ value: "resume", label: "恢复 Auto 自动强度", description: "解除手动强度覆盖，不解除任务暂停或恢复保护" }] : []),
    { value: MENU_BACK, label: "← 返回" },
  ], { selectedValue: config.modelStrategy ?? "roles" });
  if (!choice || isMenuBack(choice)) return;
  if (choice === "resume") {
    await runtime.resumeAutoThinking(ctx);
    ctx.ui.notify("Auto 自动强度已恢复；当前强度未改变，下次任务评估生效。", "info");
    return;
  }
  if (choice === "roles") {
    runtime.stageRoleConfig({ modelStrategy: "roles" });
    ctx.ui.notify("已暂存按职责配置策略；后续职责切换恢复原映射。仅显式保存才写入项目文件。", "info");
    return;
  }
  const previous = config.autoModel;
  const selected = await selectRoleModel(
    ctx,
    "Auto 固定模型",
    previous ? { provider: previous.provider, model: previous.model, thinkingLevel: previous.initialThinkingLevel } : undefined,
    { thinkingLabel: "Auto 起始推理强度（1/3）", thinkingDescription: "任务开始时的默认强度；随后可在最低和最高强度之间自动升降" },
  );
  if (!selected || isMenuBack(selected)) return;
  const model = ctx.modelRegistry.find(selected.provider, selected.model);
  if (!model) throw new Error("选择的 Auto 固定模型不可用");
  const supported = getSupportedThinkingLevels(model) as ThinkingLevel[];
  const initialIndex = supported.indexOf(selected.thinkingLevel);
  const min = await showMenu(ctx, "Auto 最小强度（2/3 · 自动调整下限）", supported.slice(0, initialIndex + 1).map((value) => ({ value, label: value })));
  if (!min || isMenuBack(min)) return;
  const max = await showMenu(ctx, "Auto 最大强度（3/3 · 自动调整上限）", supported.slice(initialIndex).map((value) => ({ value, label: value })));
  if (!max || isMenuBack(max)) return;
  const fixed: AutoModelConfig = unwrapRoleResult(parseAutoModel({ provider: selected.provider, model: selected.model, initialThinkingLevel: selected.thinkingLevel, minThinkingLevel: min, maxThinkingLevel: max }));
  unwrapRoleResult(validateAutoModelCapabilities(fixed, supported));
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error("Auto 固定模型缺少可用凭据，未修改策略");
  runtime.stageRoleConfig({ modelStrategy: "auto", autoModel: fixed });
  ctx.ui.notify("Auto 已暂存，后续请求应用固定模型；职责映射已保留但暂不使用。仅显式保存才写入项目文件。手动切换方式下须手动应用模型，且不自动调整强度。", "info");
}
