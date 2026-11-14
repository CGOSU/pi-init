import { resolve } from "node:path";
import { readProjectMetadata as readMetadata } from "../src/project-metadata.ts";
import {
  withFileMutationQueue,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_ROLE_NAMES } from "../src/roles.ts";
import { createScaffold } from "../src/scaffold.ts";
import type { ScaffoldOptions, ScaffoldOperationResult, ScaffoldResult, TemplateLanguage } from "../src/scaffold-types.ts";
import type { RoleModelConfig } from "./contracts.ts";
import { input, isMenuBack, MENU_BACK, selectRoleModel, showMenu } from "./ui.ts";

function normalizeTargetDir(value: string): string {
  const target = value.trim();
  return target.startsWith("@") ? target.slice(1) : target;
}

async function readProjectMetadata(ctx: ExtensionContext, targetDir: string) {
  return readMetadata(resolve(ctx.cwd, normalizeTargetDir(targetDir) || "."));
}

export function formatResult(outcome: ScaffoldOutcome) {
  if (!outcome.ok) return `初始化失败（${outcome.code}）：${outcome.message}`;
  const result = outcome.value;
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
    lines.push("冲突路径（未覆盖）：", ...result.conflicts.map((file) => `- ${file}`));
  }

  if (result.preserved?.length) lines.push("保留维护者已有文件：", ...result.preserved.map(file => `- ${file}`));
  return lines.join("\n");
}

function formatCompactResult(outcome: ScaffoldOutcome) {
  if (!outcome.ok) return formatResult(outcome);
  const result = outcome.value;
  if (result.cancelled) return "已取消初始化";
  const prefix = result.dryRun ? "预览" : "✓ 已生成";
  const conflicts = ` · 保留 ${result.preserved.length} 个已有文件`;
  return `${prefix} ${result.files.length} 个文件${conflicts}\n${result.targetDir}`;
}

export type ScaffoldOutcome = ScaffoldOperationResult<ScaffoldResult & { cancelled?: boolean; backedOut?: boolean }>;
type AdvancedOptions = {
  projectName: string;
  language: TemplateLanguage;
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
  ctx: ExtensionContext,
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
  options: ScaffoldOptions,
  confirmation: "always" | "conflicts" | "never",
  allowBack = false,
): Promise<ScaffoldOutcome> {
  const absoluteTarget = resolve(ctx.cwd, normalizeTargetDir(targetDir) || ".");

  return withFileMutationQueue(absoluteTarget, async () => {
    if (options.dryRun !== undefined && typeof options.dryRun !== "boolean") {
      return { ok: false, code: "SCAFFOLD_DRY_RUN_TYPE", message: "dryRun 必须是布尔值" };
    }
    if (options.dryRun === true || confirmation !== "always") {
      return createScaffold(absoluteTarget, options);
    }
    const previewResult = await createScaffold(absoluteTarget, { ...options, dryRun: true });
    if (!previewResult.ok) return previewResult;
    const preview = previewResult.value;
    if (preview.files.length === 0) return { ok: true, value: { ...preview, dryRun: false } };
    if (!ctx.hasUI) {
      return { ok: true, value: { ...preview, cancelled: true } };
    }
    const message = [
      `项目：${preview.projectName}`,
      `语言：${preview.language}`,
      ...(typeof options.testCommand === "string" && options.testCommand
        ? [`测试：${options.testCommand}`]
        : []),
      `目录：${preview.targetDir}`,
      `将生成 ${preview.files.length} 个文件。`,
      ...(preview.preserved.length > 0
        ? [`已有文件将保留：${preview.preserved.join(", ")}`]
        : ["只创建缺失文件"]),
    ].join("\n");
    const decision = await confirmScaffold(ctx, message, allowBack);
    if (decision === MENU_BACK) {
      return { ok: true, value: { ...preview, backedOut: true } };
    }
    if (decision !== "confirm") {
      return { ok: true, value: { ...preview, cancelled: true } };
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
      if (value !== "zh-CN" && value !== "en") return undefined;
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
      const value = await input(ctx, "测试命令（可留空）", metadata.testCommand ?? "例如：pnpm test", testCommand);
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
      { value: "default", label: "沿用会话默认模型", description: "不写入固定角色模型映射；后续可在 /pi-init config 中单独配置角色" },
      { value: "custom", label: "逐个配置", description: "为标准角色逐个选择独立模型和推理强度" },
      { value: "cancel", label: "取消" },
    ], { selectedValue: roleConfiguration });
    if (isMenuBack(value)) {
      step = 3;
      continue;
    }
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
  ctx.ui.notify(formatCompactResult(result), !result.ok ? "error" : result.value.cancelled ? "warning" : "info");
}

export async function finishScaffold(ctx: ExtensionCommandContext, outcome: ScaffoldOutcome) {
  notifyResult(ctx, outcome);
  if (!outcome.ok) return;
  const result = outcome.value;
  const isCurrentProject = result.targetDir === resolve(ctx.cwd, ".");
  if (isCurrentProject && !result.dryRun && !result.cancelled && result.files.length > 0) {
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
    if (result.ok && result.value.backedOut) {
      draft = options;
      continue;
    }
    await finishScaffold(ctx, result);
    return;
  }
}
