import { resolve, basename } from "node:path";
import { Type } from "typebox";
import {
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createScaffold } from "../src/scaffold.js";

const initProjectParameters = Type.Object({
  targetDir: Type.Optional(Type.String({ description: "目标项目目录，默认是当前工作目录" })),
  projectName: Type.Optional(Type.String({ description: "项目显示名称" })),
  slug: Type.Optional(Type.String({ description: "Pi Skill 名称" })),
  description: Type.Optional(Type.String({ description: "项目定位" })),
  language: Type.Optional(Type.String({ description: "模板语言：zh-CN 或 en" })),
  testCommand: Type.Optional(Type.String({ description: "项目测试命令" })),
  dryRun: Type.Optional(Type.Boolean({ description: "只预览，不写入文件" })),
});

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
  pi.registerCommand("init-project", {
    description: "初始化项目的 AI Coding 协作文件和 Pi Skill",
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
      "Generate AGENTS.md, four docs memory files, and .pi/skills/<slug>/SKILL.md in a project. Existing generated files may be overwritten after confirmation.",
    promptSnippet: "Initialize a project's AI Coding context files and Pi Skill",
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
}
