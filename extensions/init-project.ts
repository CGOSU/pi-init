import { readFile } from "node:fs/promises";
import { resolve, basename, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  CONFIG_DIR_NAME,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createScaffold } from "../src/scaffold.js";
import { ROLE_NAMES, resolveRoleModel } from "../src/roles.js";

const initProjectParameters = Type.Object({
  targetDir: Type.Optional(Type.String({ description: "目标项目目录，默认是当前工作目录" })),
  projectName: Type.Optional(Type.String({ description: "项目显示名称" })),
  slug: Type.Optional(Type.String({ description: "Pi Skill 名称" })),
  description: Type.Optional(Type.String({ description: "项目定位" })),
  language: Type.Optional(Type.String({ description: "模板语言：zh-CN 或 en" })),
  testCommand: Type.Optional(Type.String({ description: "项目测试命令" })),
  dryRun: Type.Optional(Type.Boolean({ description: "只预览，不写入文件" })),
});

const roleNameSchema = StringEnum(ROLE_NAMES, {
  description: "要切换的职责：architect、developer-test 或 docs-commit",
});
const switchRoleParameters = Type.Object({ role: roleNameSchema });

async function readRoleConfig(ctx: ExtensionContext) {
  if (!ctx.isProjectTrusted()) return undefined;

  const configPath = join(ctx.cwd, CONFIG_DIR_NAME, "role-models.json");
  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error(`无法读取职责模型配置 ${configPath}：${textOf(error)}`);
  }
}

function textOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeTargetDir(value: string) {
  const target = value.trim();
  return target.startsWith("@") ? target.slice(1) : target;
}

function formatResult(result: {
  targetDir: string;
  projectName: string;
  files: string[];
  conflicts: string[];
  dryRun: boolean;
  cancelled?: boolean;
}) {
  if (result.cancelled) {
    return "已取消，没有写入文件。";
  }

  const lines = [
    result.dryRun
      ? `项目 ${result.projectName} 的脚手架预览：`
      : `已为项目 ${result.projectName} 生成 AI Coding 脚手架：`,
    `目标目录：${result.targetDir}`,
    ...result.files.map((file) => `- ${file}`),
  ];

  if (result.conflicts.length > 0) {
    lines.push("将覆盖已有文件：", ...result.conflicts.map((file) => `- ${file}`));
  }

  return lines.join("\n");
}

type ScaffoldResult = Awaited<ReturnType<typeof createScaffold>>;
type ScaffoldOutcome = ScaffoldResult & { cancelled?: boolean };

async function runScaffold(
  ctx: ExtensionContext,
  targetDir: string,
  options: Record<string, unknown>,
  confirmation: "always" | "conflicts" | "never",
): Promise<ScaffoldOutcome> {
  const absoluteTarget = resolve(ctx.cwd, normalizeTargetDir(targetDir) || ".");

  return withFileMutationQueue(absoluteTarget, async () => {
    const preview = await createScaffold(absoluteTarget, { ...options, dryRun: true });

    if (options.dryRun === true) {
      return preview;
    }

    const needsConfirmation =
      confirmation === "always" || (confirmation === "conflicts" && preview.conflicts.length > 0);
    if (needsConfirmation) {
      if (!ctx.hasUI) {
        return { ...preview, cancelled: true };
      }
      const message = [
        `将在 ${preview.targetDir} 生成 ${preview.files.length} 个文件。`,
        ...(preview.conflicts.length > 0
          ? [`已有文件将被覆盖：${preview.conflicts.join(", ")}`]
          : []),
      ].join("\n");
      if (!(await ctx.ui.confirm("确认初始化项目？", message))) {
        return { ...preview, cancelled: true };
      }
    }

    return createScaffold(absoluteTarget, options);
  });
}

async function input(ctx: ExtensionCommandContext, title: string, placeholder: string) {
  const value = await ctx.ui.input(title, placeholder);
  return value === undefined ? undefined : value.trim();
}

async function collectOptions(ctx: ExtensionCommandContext, targetDir: string) {
  const inferredName = basename(resolve(ctx.cwd, normalizeTargetDir(targetDir) || "."));
  const projectName = await input(ctx, "项目名称", inferredName);
  if (projectName === undefined) return undefined;

  const language = await ctx.ui.select("模板语言", ["zh-CN", "en"]);
  if (language === undefined) return undefined;

  const description = await input(ctx, "项目定位（可留空）", "例如：客户账户管理门户");
  if (description === undefined) return undefined;

  const testCommand = await input(ctx, "测试命令（可留空）", "例如：npm test");
  if (testCommand === undefined) return undefined;

  const slug = await input(ctx, "Skill 名称（可留空自动生成）", "例如：my-project");
  if (slug === undefined) return undefined;

  return {
    projectName: projectName || inferredName,
    language,
    description: description || undefined,
    testCommand: testCommand || undefined,
    slug: slug || undefined,
  };
}

function notifyResult(ctx: ExtensionContext, result: ScaffoldOutcome) {
  const isCurrentProject = result.targetDir === resolve(ctx.cwd, ".");
  const suffix = isCurrentProject && !result.dryRun && !result.cancelled
    ? "\n如需立即加载新 Skill，请执行 /reload。"
    : "";
  ctx.ui.notify(formatResult(result) + suffix, result.cancelled ? "warning" : "info");
}

export default function initProjectExtension(pi: ExtensionAPI) {
  async function applyRole(role: string, ctx: ExtensionContext) {
    const target = resolveRoleModel(await readRoleConfig(ctx), role);
    const model = ctx.modelRegistry.find(target.provider, target.model);
    if (!model) {
      throw new Error(
        `职责 ${role} 配置的模型不存在：${target.provider}/${target.model}；请修改 ${CONFIG_DIR_NAME}/role-models.json`,
      );
    }
    if (!(await pi.setModel(model))) {
      throw new Error(`职责 ${role} 无法使用模型 ${target.provider}/${target.model}：缺少可用凭据`);
    }

    pi.setThinkingLevel(
      target.thinkingLevel as Parameters<typeof pi.setThinkingLevel>[0],
    );
    const result = {
      role,
      provider: target.provider,
      model: target.model,
      thinkingLevel: pi.getThinkingLevel(),
    };
    ctx.ui.setStatus(
      "pi-init-role",
      `${role}: ${target.provider}/${target.model} · ${result.thinkingLevel}`,
    );
    return result;
  }

  pi.registerCommand("role", {
    description: "切换职责对应的模型与推理强度",
    getArgumentCompletions: (prefix) => {
      const matches = ROLE_NAMES.filter((role) => role.startsWith(prefix));
      return matches.length > 0 ? matches.map((role) => ({ value: role, label: role })) : null;
    },
    handler: async (args, ctx) => {
      const requested = args.trim();
      const role = requested || (ctx.hasUI ? await ctx.ui.select("选择职责", ROLE_NAMES) : undefined);
      if (!role) return;
      if (!ROLE_NAMES.includes(role)) {
        ctx.ui.notify(`未知职责：${role}；可用值：${ROLE_NAMES.join(", ")}`, "error");
        return;
      }
      try {
        const result = await applyRole(role, ctx);
        ctx.ui.notify(
          `已切换到 ${result.role}：${result.provider}/${result.model}，推理强度 ${result.thinkingLevel}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(textOf(error), "error");
      }
    },
  });

  pi.registerCommand("init-project", {
    description: "初始化项目的 AI Coding 协作文件和智能职责 Skill",
    handler: async (args, ctx) => {
      const targetDir = args.trim() || ".";
      if (!ctx.hasUI) {
        try {
          const result = await runScaffold(ctx, targetDir, {}, "conflicts");
          notifyResult(ctx, result);
        } catch (error) {
          ctx.ui.notify(textOf(error), "error");
        }
        return;
      }

      const options = await collectOptions(ctx, targetDir);
      if (!options) {
        ctx.ui.notify("已取消项目初始化。", "warning");
        return;
      }

      try {
        const result = await runScaffold(ctx, targetDir, options, "always");
        notifyResult(ctx, result);
      } catch (error) {
        ctx.ui.notify(textOf(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "init_project",
    label: "Initialize Project",
    description:
      "Generate AGENTS.md, four docs memory files, .pi/role-models.json, and a role-routing .pi/skills/<slug>/SKILL.md in a project. The Skill defines technical level, model type, and Pi reasoning level for architecture, development/testing, and documentation/commit work. Existing generated files may be overwritten after confirmation.",
    promptSnippet: "Initialize project context files and an intelligent responsibility-routing Skill",
    promptGuidelines: [
      "Use init_project when the user asks to initialize a project with AI Coding collaboration context.",
      "Before calling init_project, inspect available project metadata and provide description and testCommand when known.",
      "Use init_project with dryRun=true first when the target project may already contain generated files.",
    ],
    parameters: initProjectParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "已取消，没有写入文件。" }], details: {} };
      }

      const targetDir = params.targetDir ?? ".";
      const options = {
        projectName: params.projectName,
        slug: params.slug,
        description: params.description,
        language: params.language,
        testCommand: params.testCommand,
        dryRun: params.dryRun,
      };
      const result = await runScaffold(ctx, targetDir, options, "conflicts");
      const text = formatResult(result);

      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "switch_role",
    label: "Switch Role",
    description:
      "Switch the active Pi model and reasoning level for a responsibility. Reads trusted project overrides from .pi/role-models.json; defaults are architect=openai-codex/gpt-5.6-sol:max, developer-test=openai-codex/gpt-5.6-terra:high, docs-commit=openai-codex/gpt-5.6-luna:medium.",
    promptSnippet: "Switch model and reasoning level for architect, developer-test, or docs-commit work",
    promptGuidelines: [
      "Call switch_role before starting a responsibility selected by the project's role-routing Skill and again at every role boundary.",
      "Use switch_role role=architect for architecture, role=developer-test for implementation and testing, and role=docs-commit for documentation or authorized Git operations.",
    ],
    parameters: switchRoleParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "职责切换已取消。" }], details: {} };
      }
      const result = await applyRole(params.role, ctx);
      return {
        content: [
          {
            type: "text",
            text: `已切换到 ${result.role}：${result.provider}/${result.model}，推理强度 ${result.thinkingLevel}`,
          },
        ],
        details: result,
      };
    },
  });
}
