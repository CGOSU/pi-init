import { readFile } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeRoleId, roleLabel } from "../src/roles.js";
import type { AgentProfile } from "./collaboration-types.ts";

type RoleConfigReader = {
  readSessionRoleConfig(ctx: ExtensionContext): Promise<{ roleModels: Record<string, { provider: string; model: string; thinkingLevel: string }> }>;
};

const COMMON_RULES = [
  "遵循公共 pi-init-role-routing Skill 的职责边界。",
  "当前子 Agent 只负责当前任务；不要调用 task_workflow、switch_role 或启动另一个工作流。",
  "在共享工作区编辑前使用 agent_message reserve；不要 commit、push、删除或重置他人的修改。",
  "只报告真实完成内容、失败原因和实际执行的验证。",
].join("\n");

const ROLE_TOOLS: Record<string, string[]> = {
  architect: ["read", "agent_message"],
  "developer-test": ["read", "write", "edit", "bash", "agent_message"],
  "docs-commit": ["read", "write", "edit", "bash", "agent_message"],
};

async function rolePrompt(role: string): Promise<string> {
  const known = ["architect", "developer-test", "docs-commit"].includes(role);
  if (!known) return `${COMMON_RULES}\n当前职责：${roleLabel(role)}（${role}）。`;
  try {
    const content = await readFile(new URL(`../skills/pi-init-role-routing/roles/${role}.md`, import.meta.url), "utf8");
    return `${content.trim()}\n\n${COMMON_RULES}`;
  } catch (error) {
    throw new Error(`角色 ${role} 的公共 Skill 不可用：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createCollaborationRoleResolver(reader: RoleConfigReader) {
  return async function resolveCollaborationRole(role: string, ctx: ExtensionContext): Promise<AgentProfile> {
    const normalized = normalizeRoleId(role);
    const config = await reader.readSessionRoleConfig(ctx);
    const target = config.roleModels[normalized];
    if (!target) throw new Error(`角色 ${normalized} 未配置模型；请先执行 /pi-init config ${normalized}`);
    const model = ctx.modelRegistry.find(target.provider, target.model);
    if (!model) throw new Error(`角色 ${roleLabel(normalized)} 配置的模型不存在：${target.provider}/${target.model}`);
    return {
      role: normalized,
      provider: target.provider,
      model: target.model,
      thinkingLevel: target.thinkingLevel,
      systemPrompt: await rolePrompt(normalized),
      allowedTools: [...(ROLE_TOOLS[normalized] ?? ROLE_TOOLS["developer-test"]!)],
    };
  };
}
