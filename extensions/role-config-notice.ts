import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedRoleConfig } from "./contracts.ts";
import { roleLabel } from "../src/roles.ts";

const ROLE_CONFIG_WIDGET = "pi-init-role-config";

function roleConfigSections(config: ResolvedRoleConfig): string[] {
  if (config.modelStrategy === "auto" && config.autoModel) {
    const model = config.autoModel;
    return [`◆ Auto · 固定模型\n  模型：${model.provider}/${model.model}\n  起始强度：${model.initialThinkingLevel}\n  允许范围：${model.minThinkingLevel}–${model.maxThinkingLevel}\n  原职责映射保留但暂不使用，职责和共享流程不变。`];
  }
  return Object.entries(config.roleModels).map(([role, model]) =>
    `◆ ${roleLabel(role)}\n  模型：${model.provider}/${model.model}\n  推理强度：${model.thinkingLevel}`,
  );
}

export function showRoleConfigNotice(ctx: ExtensionContext, config: ResolvedRoleConfig) {
  if (ctx.mode !== "tui") return;
  const sections = roleConfigSections(config);
  // Info notifications share one slot in Pi; other startup notices can replace them.
  ctx.ui.setWidget(
    ROLE_CONFIG_WIDGET,
    sections.length > 0
      ? `📌 Pi Init · 角色模型配置\n\n${sections.join("\n\n")}`.split("\n")
      : undefined,
  );
}

export function clearRoleConfigNotice(ctx: ExtensionContext) {
  ctx.ui.setWidget(ROLE_CONFIG_WIDGET, undefined);
}
