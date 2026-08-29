import { mkdir, readFile } from "node:fs/promises";
import { resolve, basename, join } from "node:path";
import {
  withFileMutationQueue,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_ROLE_NAMES } from "../src/roles.js";
import { createScaffold } from "../src/scaffold.js";
import type { RoleModelConfig } from "./contracts.ts";
import { input, isMenuBack, MENU_BACK, selectRoleModel, showMenu } from "./ui.ts";

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
export type ScaffoldOutcome = ScaffoldResult & { cancelled?: boolean; backedOut?: boolean };

type AdvancedOptions = {
  projectName: string;
  language: string;
  description?: string;
  testCommand?: string;
  roleConfiguration: "default" | "custom";
  roleModels?: Record<string, RoleModelConfig>;
};

async function collectRoleModelsForInit(
  ctx: ExtensionCommandContext,
  initialRoleModels: Record<string, RoleModelConfig> = {},
) {
  const roleModels = { ...initialRoleModels };
  let roleIndex = 0;
  while (roleIndex < DEFAULT_ROLE_NAMES.length) {
    const role = DEFAULT_ROLE_NAMES[roleIndex];
    const selection = await selectRoleModel(ctx, role, roleModels[role]);
    if (isMenuBack(selection)) {
      if (roleIndex === 0) return MENU_BACK;
      roleIndex -= 1;
      continue;
    }
    if (!selection) return undefined;
    roleModels[role] = selection;
    roleIndex += 1;
  }
  return roleModels;
}

async function confirmScaffold(
  ctx: ExtensionCommandContext,
  message: string,
  allowBack: boolean,
) {
  if (!allowBack || ctx.mode !== "tui") {
    return (await ctx.ui.confirm("确认初始化项目？", message)) ? "confirm" as const : "cancel" as const;
  }

  const result = await showMenu(ctx, "确认初始化项目？", [
    { value: "confirm", label: "确认生成" },
    { value: "cancel", label: "取消初始化" },
  ], { summary: message.split("\n") });
  if (isMenuBack(result)) return MENU_BACK;
  return result === "confirm" ? "confirm" as const : "cancel" as const;
}

export async function runScaffold(
  ctx: ExtensionContext,
  targetDir: string,
  options: Record<string, unknown>,
  confirmation: "always" | "conflicts" | "never",
  allowBack = false,
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
        `语言：${preview.language}`,
        ...(typeof options.testCommand === "string" && options.testCommand
          ? [`测试：${options.testCommand}`]
          : []),
        `目录：${preview.targetDir}`,
        `将生成 ${preview.files.length} 个文件。`,
        ...(preview.conflicts.length > 0
          ? [`已有文件将被覆盖：${preview.conflicts.join(", ")}`]
          : ["无文件冲突"]),
      ].join("\n");
      const decision = await confirmScaffold(ctx, message, allowBack);
      if (decision === MENU_BACK) {
        return { ...preview, backedOut: true };
      }
      if (decision !== "confirm") {
        return { ...preview, cancelled: true };
      }
    }

    return createScaffold(absoluteTarget, options);
  });
}

async function collectOptions(
  ctx: ExtensionCommandContext,
  targetDir: string,
  initial?: AdvancedOptions,
  initialStep = 0,
) {
  const metadata = await readProjectMetadata(ctx, targetDir);
  let projectName = initial?.projectName;
  let language = initial?.language;
  let description = initial?.description;
  let testCommand = initial?.testCommand;
  let roleConfiguration: AdvancedOptions["roleConfiguration"] | undefined = initial?.roleConfiguration;
  let roleModels = initial?.roleModels;
  let step = initialStep;

  while (step <= 4) {
    if (step === 0) {
      const value = await input(ctx, "项目名称", metadata.projectName, projectName);
      if (isMenuBack(value)) return MENU_BACK;
      if (value === undefined) return undefined;
      projectName = value;
      step = 1;
      continue;
    }

    if (step === 1) {
      const value = await showMenu(ctx, "模板语言", [
        { value: "zh-CN", label: "简体中文", description: "生成中文协作文档" },
        { value: "en", label: "English", description: "Generate English collaboration docs" },
        { value: "cancel", label: "取消" },
      ], { selectedValue: language });
      if (isMenuBack(value)) {
        step = 0;
        continue;
      }
      if (!value || value === "cancel") return undefined;
      language = value;
      step = 2;
      continue;
    }

    if (step === 2) {
      const value = await input(
        ctx,
        "项目定位（可留空）",
        metadata.description ?? "例如：客户账户管理门户",
        description,
      );
      if (isMenuBack(value)) {
        step = 1;
        continue;
      }
      if (value === undefined) return undefined;
      description = value;
      step = 3;
      continue;
    }

    if (step === 3) {
      const value = await input(ctx, "测试命令（可留空）", metadata.testCommand ?? "例如：npm test", testCommand);
      if (isMenuBack(value)) {
        step = 2;
        continue;
      }
      if (value === undefined) return undefined;
      testCommand = value;
      step = 4;
      continue;
    }

    const value = await showMenu(ctx, "角色模型", [
      { value: "default", label: "使用默认配置", description: "推荐，后续可在 /pi-init config 中修改" },
      { value: "custom", label: "逐个配置", description: "为默认角色逐个选择模型和推理强度" },
      { value: "cancel", label: "取消" },
    ], { selectedValue: roleConfiguration });
    if (isMenuBack(value)) {
      step = 3;
      continue;
    }
    if (!value || value === "cancel") return undefined;
    if (value !== "default" && value !== "custom") return undefined;
    roleConfiguration = value;
    if (roleConfiguration === "custom") {
      const selectedModels = await collectRoleModelsForInit(ctx, roleModels);
      if (isMenuBack(selectedModels)) continue;
      if (!selectedModels) return undefined;
      roleModels = selectedModels;
    } else {
      roleModels = undefined;
    }
    break;
  }

  return {
    projectName: projectName || metadata.projectName,
    language: language ?? "zh-CN",
    description: description || undefined,
    testCommand: testCommand || undefined,
    roleConfiguration: roleConfiguration === "custom" ? "custom" : "default",
    ...(roleModels ? { roleModels } : {}),
  } satisfies AdvancedOptions;
}

function scaffoldOptions(options: AdvancedOptions) {
  const { roleConfiguration: _roleConfiguration, ...result } = options;
  return result;
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

  let draft: AdvancedOptions | undefined;
  while (true) {
    const options = await collectOptions(ctx, targetDir, draft, draft ? 4 : 0);
    if (isMenuBack(options)) return MENU_BACK;
    if (!options) {
      ctx.ui.notify("已取消项目初始化。", "warning");
      return;
    }

    const result = await runScaffold(
      ctx,
      targetDir,
      scaffoldOptions(options),
      "always",
      true,
    );
    if (result.backedOut) {
      draft = options;
      continue;
    }
    await finishScaffold(ctx, result);
    return;
  }
}
