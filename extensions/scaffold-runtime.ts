import { mkdir, readFile } from "node:fs/promises";
import { resolve, basename, join } from "node:path";
import {
  withFileMutationQueue,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createScaffold } from "../src/scaffold.js";
import { collectRoleModels, input, isMenuBack, MENU_BACK, showMenu } from "./ui.ts";

function normalizeTargetDir(value: string) {
  const target = value.trim();
  return target.startsWith("@") ? target.slice(1) : target;
}

async function readProjectMetadata(ctx: ExtensionContext, targetDir: string) {
  const absoluteTarget = resolve(ctx.cwd, normalizeTargetDir(targetDir) || ".");
  let packageJson: {
    name?: unknown;
    description?: unknown;
    packageManager?: unknown;
    scripts?: Record<string, unknown>;
  } = {};
  try {
    const parsed = JSON.parse(await readFile(join(absoluteTarget, "package.json"), "utf8"));
    if (parsed && typeof parsed === "object") packageJson = parsed;
  } catch {
    // package.json is optional; directory-name defaults still make quick init useful.
  }

  let packageManager = "npm";
  if (typeof packageJson.packageManager === "string") {
    packageManager = packageJson.packageManager.split("@")[0] || packageManager;
  } else {
    for (const [lockfile, manager] of [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lockb", "bun"],
      ["bun.lock", "bun"],
    ] as const) {
      try {
        await readFile(join(absoluteTarget, lockfile));
        packageManager = manager;
        break;
      } catch {
        // Try the next package manager marker.
      }
    }
  }

  const scripts = packageJson.scripts ?? {};
  const scriptName = ["test", "check", "lint"].find((name) => typeof scripts[name] === "string");
  const inferredName = basename(absoluteTarget);
  return {
    projectName: typeof packageJson.name === "string" && packageJson.name.trim()
      ? packageJson.name.trim()
      : inferredName,
    description:
      typeof packageJson.description === "string" && packageJson.description.trim()
        ? packageJson.description.trim()
        : undefined,
    testCommand: scriptName ? `${packageManager} ${scriptName}` : undefined,
  };
}

export function formatResult(result: {
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

function formatCompactResult(result: ScaffoldOutcome) {
  if (result.cancelled) return "已取消初始化";
  const prefix = result.dryRun ? "预览" : "✓ 已生成";
  const conflicts = result.conflicts.length > 0 ? ` · 覆盖 ${result.conflicts.length} 个文件` : " · 无文件冲突";
  return `${prefix} ${result.files.length} 个文件${conflicts}\n${result.targetDir}`;
}

type ScaffoldResult = Awaited<ReturnType<typeof createScaffold>>;
export type ScaffoldOutcome = ScaffoldResult & { cancelled?: boolean };

export async function runScaffold(
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
        `项目：${preview.projectName}`,
        `语言：${preview.language} · Skill：${preview.projectSlug}`,
        ...(typeof options.testCommand === "string" && options.testCommand
          ? [`测试：${options.testCommand}`]
          : []),
        `目录：${preview.targetDir}`,
        `将生成 ${preview.files.length} 个文件。`,
        ...(preview.conflicts.length > 0
          ? [`已有文件将被覆盖：${preview.conflicts.join(", ")}`]
          : ["无文件冲突"]),
      ].join("\n");
      if (!(await ctx.ui.confirm("确认初始化项目？", message))) {
        return { ...preview, cancelled: true };
      }
    }

    return createScaffold(absoluteTarget, options);
  });
}

async function collectOptions(ctx: ExtensionCommandContext, targetDir: string) {
  const metadata = await readProjectMetadata(ctx, targetDir);
  const projectName = await input(ctx, "项目名称", metadata.projectName);
  if (isMenuBack(projectName)) return MENU_BACK;
  if (projectName === undefined) return undefined;

  const language = await showMenu(ctx, "模板语言", [
    { value: "zh-CN", label: "简体中文", description: "生成中文协作文档" },
    { value: "en", label: "English", description: "Generate English collaboration docs" },
    { value: "cancel", label: "取消" },
  ]);
  if (!language || isMenuBack(language) || language === "cancel") return undefined;

  const description = await input(
    ctx,
    "项目定位（可留空）",
    metadata.description ?? "例如：客户账户管理门户",
  );
  if (isMenuBack(description)) return MENU_BACK;
  if (description === undefined) return undefined;

  const testCommand = await input(ctx, "测试命令（可留空）", metadata.testCommand ?? "例如：npm test");
  if (isMenuBack(testCommand)) return MENU_BACK;
  if (testCommand === undefined) return undefined;

  const slug = await input(ctx, "Skill 名称（可留空自动生成）", metadata.projectName);
  if (isMenuBack(slug)) return MENU_BACK;
  if (slug === undefined) return undefined;

  const roleConfiguration = await showMenu(ctx, "角色模型", [
    { value: "default", label: "使用默认配置", description: "推荐，后续可在 /pi-init config 中修改" },
    { value: "custom", label: "逐个配置", description: "为三个角色选择模型和推理强度" },
    { value: "cancel", label: "取消" },
  ]);
  if (!roleConfiguration || isMenuBack(roleConfiguration) || roleConfiguration === "cancel") return undefined;
  const roleModels = roleConfiguration === "custom"
    ? await collectRoleModels(ctx)
    : undefined;
  if (roleConfiguration === "custom" && !roleModels) return undefined;

  return {
    projectName: projectName || metadata.projectName,
    language,
    description: description || undefined,
    testCommand: testCommand || undefined,
    slug: slug || undefined,
    ...(roleModels ? { roleModels } : {}),
  };
}

function notifyResult(ctx: ExtensionContext, result: ScaffoldOutcome) {
  ctx.ui.notify(formatCompactResult(result), result.cancelled ? "warning" : "info");
}

export async function finishScaffold(ctx: ExtensionCommandContext, result: ScaffoldOutcome) {
  notifyResult(ctx, result);
  const isCurrentProject = result.targetDir === resolve(ctx.cwd, ".");
  if (isCurrentProject && !result.dryRun && !result.cancelled) {
    ctx.ui.notify("当前项目已更新，正在重新加载 Skill。", "info");
    await ctx.reload();
  }
}

export async function quickInit(targetDir: string, ctx: ExtensionCommandContext) {
  const metadata = await readProjectMetadata(ctx, targetDir);
  const result = await runScaffold(
    ctx,
    targetDir,
    { ...metadata, language: "zh-CN" },
    ctx.hasUI ? "always" : "conflicts",
  );
  await finishScaffold(ctx, result);
}

export async function advancedInit(targetDir: string, ctx: ExtensionCommandContext) {
  if (!ctx.hasUI) {
    throw new Error("高级初始化需要交互式 UI；无 UI 环境请使用 /pi-init init <目录>");
  }
  const options = await collectOptions(ctx, targetDir);
  if (isMenuBack(options)) return;
  if (!options) {
    ctx.ui.notify("已取消项目初始化。", "warning");
    return;
  }
  const result = await runScaffold(ctx, targetDir, options, "always");
  await finishScaffold(ctx, result);
}
