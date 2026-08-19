import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, basename, dirname, join } from "node:path";
import { getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  CONFIG_DIR_NAME,
  DynamicBorder,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createScaffold } from "../src/scaffold.js";
import {
  ROLE_MODES,
  ROLE_NAMES,
  THINKING_LEVELS,
  WORKFLOW_EXECUTORS,
  WORKFLOW_MODES,
  filterRoleModels,
  findMatchingRole,
  normalizeModelReference,
  resolveRoleConfig,
  roleLabel,
  roleModeLabel,
  shouldCompactOnRoleSwitch,
  shouldOrchestrateWorkflow,
} from "../src/roles.js";
import {
  WORKFLOW_MAX_TASKS,
  blockWorkflowTask,
  beginWorkflowDelegation,
  cancelWorkflow,
  completeWorkflowTask,
  createWorkflowState,
  getNextWorkflowTask,
  getWorkflowTask,
  getWorkflowTaskDuration,
  getWorkflowExecutionBounds,
  getWorkflowExecutionDuration,
  hydrateWorkflowState,
  isWorkflowActive,
  markWorkflowTaskStarted,
  recordWorkflowNudge,
  resumeWorkflow,
  retryWorkflowTask,
  startWorkflowTask,
  validateWorkflowPlan,
  workflowProgress,
} from "../src/workflow.js";
import {
  completeRunTiming,
  createRunTiming,
  getRunTimingDuration,
  isExternalRunSource,
} from "../src/run-timing.js";
import {
  parseSubtaskResult,
  SUBTASK_RESULT_PROTOCOL,
} from "../src/subtask.js";
import { Box, Container, Input, Key, matchesKey, SelectList, Spacer, Text, type SelectItem } from "@earendil-works/pi-tui";

const roleModelSchema = Type.Object({
  provider: Type.String({ description: "模型提供商 ID" }),
  model: Type.String({ description: "模型 ID" }),
  thinkingLevel: StringEnum(THINKING_LEVELS, {
    description: "Pi 推理强度",
  }),
});
const roleModelsSchema = Type.Object({
  workflowMode: Type.Optional(StringEnum(WORKFLOW_MODES, {
    description: "任务工作流策略：off、on 或 auto（auto 在不超过 2 个任务时跳过编排）",
  })),
  workflowEnabled: Type.Optional(Type.Boolean({
    description: "兼容旧配置；未设置 workflowMode 时 true 映射 on、false 映射 off",
  })),
  workflowExecutor: Type.Optional(StringEnum(WORKFLOW_EXECUTORS, {
    description: "工作流执行器：local 或 subtask；默认 local",
  })),
  architect: Type.Optional(roleModelSchema),
  "developer-test": Type.Optional(roleModelSchema),
  "docs-commit": Type.Optional(roleModelSchema),
});

const ROLE_SWITCH_COMPACTION_INSTRUCTIONS = [
  "这是自动角色切换触发的上下文压缩。",
  "请保留后续角色继续工作所需的完整信息：用户目标与约束、关键决策及原因、已完成/进行中/阻塞事项、读取和修改的文件、实际执行的验证命令与结果、下一步。",
  "不要把未完成事项写成已完成；保持项目路径、错误信息和待处理问题的准确性。",
].join("\n");
const ROLE_SWITCH_CONTINUATION_TYPE = "pi-init-role-transition";
const RUN_TIMING_ENTRY_TYPE = "pi-init-run-timing";

const initProjectParameters = Type.Object({
  targetDir: Type.Optional(Type.String({ description: "目标项目目录，默认是当前工作目录" })),
  projectName: Type.Optional(Type.String({ description: "项目显示名称" })),
  slug: Type.Optional(Type.String({ description: "Pi Skill 名称" })),
  description: Type.Optional(Type.String({ description: "项目定位" })),
  language: Type.Optional(Type.String({ description: "模板语言：zh-CN 或 en" })),
  testCommand: Type.Optional(Type.String({ description: "项目测试命令" })),
  dryRun: Type.Optional(Type.Boolean({ description: "只预览，不写入文件" })),
  roleModels: Type.Optional(roleModelsSchema),
});

const roleNameSchema = StringEnum(ROLE_NAMES, {
  description: "要切换的角色：architect、developer-test 或 docs-commit",
});
const switchRoleParameters = Type.Object({ role: roleNameSchema });
const workflowTaskRoleSchema = StringEnum(["developer-test", "docs-commit"] as const, {
  description: "任务执行角色；默认使用 developer-test",
});
const workflowTaskSchema = Type.Object({
  id: Type.String({ description: "唯一任务 ID，小写字母、数字、点、下划线或连字符" }),
  task: Type.String({ description: "任务目标和实现范围" }),
  files: Type.Array(Type.String(), {
    minItems: 1,
    description: "任务允许涉及的文件或目录，用于约束实现范围",
  }),
  acceptanceCriteria: Type.Array(Type.String(), {
    minItems: 1,
    description: "任务完成前必须满足的验收标准",
  }),
  role: Type.Optional(workflowTaskRoleSchema),
  dependsOn: Type.Optional(Type.Array(Type.String(), { description: "必须先完成的任务 ID" })),
});
const taskWorkflowParameters = Type.Object({
  action: StringEnum(["plan", "status", "complete", "block", "resume", "retry", "cancel"] as const, {
    description: "工作流动作",
  }),
  summary: Type.Optional(Type.String({ description: "架构规划摘要（plan 必填）" })),
  constraints: Type.Optional(Type.Array(Type.String(), { description: "架构约束和不可改变的决定" })),
  tasks: Type.Optional(Type.Array(workflowTaskSchema, {
    minItems: 1,
    maxItems: WORKFLOW_MAX_TASKS,
    description: `按顺序拆分的开发测试任务，最多 ${WORKFLOW_MAX_TASKS} 个`,
  })),
  reviewRequired: Type.Optional(Type.Boolean({
    description: "只有用户一开始明确要求先审阅架构时才设为 true；默认 false 自动推进",
  })),
  taskId: Type.Optional(Type.String({ description: "当前任务或要重试的任务 ID" })),
  completionSummary: Type.Optional(Type.String({ description: "完成任务的实现摘要" })),
  verification: Type.Optional(Type.Array(Type.String(), { description: "实际执行过的验证命令和结果" })),
  reason: Type.Optional(Type.String({ description: "阻塞原因（block 必填）" })),
});

async function readRoleConfig(ctx: ExtensionContext) {
  if (!ctx.isProjectTrusted()) return undefined;

  const configPath = join(ctx.cwd, CONFIG_DIR_NAME, "role-models.json");
  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error(`无法读取角色模型配置 ${configPath}：${textOf(error)}`);
  }
}

function textOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatRoleModel(config: RoleModelConfig) {
  return `${config.provider}/${config.model} · ${config.thinkingLevel}`;
}

function availableThinkingLevels(model: any) {
  return getSupportedThinkingLevels(model).filter((level) =>
    (THINKING_LEVELS as readonly string[]).includes(level),
  );
}

function supportedThinkingText(model: any) {
  const levels = availableThinkingLevels(model);
  return levels.length > 0 ? `推理：${levels.join("/")}` : "";
}

function shortModelName(model: string) {
  const parts = model.split(/[\\/]/);
  return parts.at(-1) ?? model;
}

type MenuItem = SelectItem;
type MenuOptions = {
  summary?: string[];
  maxVisible?: number;
  selectedValue?: string;
};

async function showMenu(ctx: ExtensionContext, title: string, items: MenuItem[], options: MenuOptions = {}) {
  if (!ctx.hasUI) return undefined;
  if (ctx.mode !== "tui") {
    const selected = await ctx.ui.select(title, items.map((item) => item.label));
    return items.find((item) => item.label === selected)?.value;
  }

  const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    const list = new SelectList(items, Math.min(items.length, options.maxVisible ?? 10), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    const selectedIndex = options.selectedValue === undefined
      ? -1
      : items.findIndex((item) => item.value === options.selectedValue);
    if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);

    const content = new Box(2, 0);
    content.addChild(new Text(theme.fg("accent", theme.bold(title)), 0, 0));
    content.addChild(new Spacer(1));
    if (options.summary?.length) {
      const summaryText = options.summary.map((line) => ` ${line} `).join("\n");
      content.addChild(
        new Text(theme.fg("text", summaryText), 0, 1, (line) => theme.bg("selectedBg", line)),
      );
    }
    content.addChild(new Text(theme.fg("dim", "↑↓ 选择 · Enter 确认 · Esc 返回"), 0, 0));
    content.addChild(list);

    container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));
    container.addChild(content);
    container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });

  return result ?? undefined;
}

type RoleModelConfig = {
  provider: string;
  model: string;
  thinkingLevel: string;
};

type RunTimingEntryData = {
  source?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
};

type ReportTheme = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

type ResolvedRoleConfig = {
  mode: string;
  workflowMode: string;
  workflowExecutor: string;
  architect: RoleModelConfig;
  "developer-test": RoleModelConfig;
  "docs-commit": RoleModelConfig;
};

function getAvailableRoleModels(ctx: ExtensionContext) {
  const source =
    ctx.scopedModels.length > 0
      ? ctx.scopedModels.map(({ model }) => model)
      : ctx.modelRegistry.getAvailable();
  const unique = new Map<string, (typeof source)[number]>();
  for (const model of source) {
    unique.set(`${model.provider}/${model.id}`, model);
  }
  return [...unique.values()].sort((a, b) =>
    `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
  );
}

/*
 * The role picker lists the full host registry. Model safety comes from exact
 * references instead of an allowlist: every spawn and role apply must use a
 * fully qualified provider/model that exists in the registry.
 */
async function selectModelWithSearch(ctx: ExtensionContext, role: string, models: any[]) {
  if (ctx.mode !== "tui") {
    const query = await ctx.ui.input(
      `搜索 ${roleLabel(role)} 的模型（可留空显示全部）`,
      "provider/model 或模型名称",
    );
    if (query === undefined) return undefined;
    const filtered = filterRoleModels(models, query);
    if (filtered.length === 0) {
      throw new Error(`没有匹配“${query.trim()}”的模型，请重新执行配置并调整搜索条件`);
    }
    const labels = filtered.map((model) => {
      const support = supportedThinkingText(model);
      return `${model.provider}/${model.id}${support ? ` · ${support}` : ""}`;
    });
    const selected = await ctx.ui.select(`选择 ${roleLabel(role)} 模型`, labels);
    const index = selected === undefined ? -1 : labels.indexOf(selected);
    return index >= 0 ? filtered[index] : undefined;
  }

  const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    let filteredModels = models;
    let list: SelectList;
    const search = new Input();

    const createList = (items: any[]) => {
      const next = new SelectList(
        items.map((model) => ({
          value: `${model.provider}/${model.id}`,
          label: `${model.id} [${model.provider}]`,
          description: [model.name, supportedThinkingText(model)].filter(Boolean).join(" · "),
        })),
        Math.min(items.length, 10),
        {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      );
      next.onSelect = (item) => done(item.value);
      next.onCancel = () => done(null);
      return next;
    };

    list = createList(filteredModels);
    search.onSubmit = () => {
      const selected = list.getSelectedItem();
      done(selected?.value ?? null);
    };
    search.onEscape = () => done(null);

    const render = (width: number) => {
      const innerWidth = Math.max(1, width - 2);
      return [
        ...new DynamicBorder((text: string) => theme.fg("borderAccent", text)).render(width),
        ...new Text(theme.fg("accent", theme.bold(`选择 ${roleLabel(role)} 模型`)), 1, 0).render(width),
        new Text(theme.fg("dim", "输入关键词即时筛选 · ↑↓ 选择 · Enter 确认 · Esc 返回"), 1, 0).render(width)[0] ?? "",
        ...search.render(innerWidth).map((line) => ` ${line}`),
        ...list.render(innerWidth).map((line) => ` ${line}`),
        ...new DynamicBorder((text: string) => theme.fg("borderAccent", text)).render(width),
      ];
    };

    let focused = false;
    return {
      get focused() {
        return focused;
      },
      set focused(value: boolean) {
        focused = value;
        search.focused = value;
      },
      render,
      invalidate: () => {
        search.invalidate();
        list.invalidate();
      },
      handleInput: (data: string) => {
        if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
          list.handleInput(data);
        } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          done(null);
        } else {
          search.handleInput(data);
          filteredModels = filterRoleModels(models, search.getValue());
          list = createList(filteredModels);
        }
        tui.requestRender();
      },
    };
  });

  if (!result) return undefined;
  return models.find((model) => `${model.provider}/${model.id}` === result);
}

async function selectRoleModel(ctx: ExtensionContext, role: string) {
  const models = getAvailableRoleModels(ctx);
  if (models.length === 0) {
    throw new Error("当前没有可用模型；请先配置模型凭据或调整模型范围");
  }

  const model = await selectModelWithSearch(ctx, role, models);
  if (!model) return undefined;
  const selectedModelLabel = `${model.provider}/${model.id}`;
  const supportedThinkingLevels = availableThinkingLevels(model);
  if (supportedThinkingLevels.length === 0) {
    throw new Error(`模型 ${selectedModelLabel} 不支持任何可用的 Pi 推理强度`);
  }

  const thinkingLevel = await showMenu(
    ctx,
    `推理强度 · ${shortModelName(model.id)}`,
    supportedThinkingLevels.map((level) => ({
      value: level,
      label: level,
      description: level === "max" ? "最高推理强度，耗时和成本也最高" : undefined,
    })),
  );
  if (thinkingLevel === undefined) return undefined;
  if (!supportedThinkingLevels.includes(thinkingLevel as (typeof supportedThinkingLevels)[number])) {
    throw new Error(`模型 ${selectedModelLabel} 不支持推理强度：${thinkingLevel}`);
  }

  return {
    provider: model.provider,
    model: model.id,
    thinkingLevel,
  } satisfies RoleModelConfig;
}

async function collectRoleModels(ctx: ExtensionContext) {
  const roleModels: Record<string, RoleModelConfig> = {};
  for (const role of ROLE_NAMES) {
    const selection = await selectRoleModel(ctx, role);
    if (!selection) return undefined;
    roleModels[role] = selection;
  }
  return roleModels;
}

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

function workflowModeLabel(mode: string) {
  if (mode === "off") return "关闭";
  if (mode === "on") return "始终编排";
  if (mode === "auto") return "自动（不超过 2 个任务时跳过）";
  return mode;
}

function workflowExecutorLabel(executor: string) {
  if (executor === "local") return "主会话顺序执行";
  if (executor === "subtask") return "pi-subtask 对话 fork";
  return executor;
}

function shouldOrchestrateConfiguredWorkflow(mode: string, taskCount: number) {
  if (typeof shouldOrchestrateWorkflow !== "function") {
    throw new Error(
      "检测到 pi-init 运行时版本不一致：扩展与 src/roles.js 不是同一版本，缺少 shouldOrchestrateWorkflow。请先执行 pi update --extensions，然后在 Pi 中执行 /reload；本地开发请重启 Pi，并确保使用同一份扩展和 src/roles.js。",
    );
  }
  return shouldOrchestrateWorkflow({ mode, taskCount });
}

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
    { value: "back", label: "← 返回上一级", description: "不修改其他设置" },
  ];
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

function formatCompactResult(result: ScaffoldOutcome) {
  if (result.cancelled) return "已取消初始化";
  const prefix = result.dryRun ? "预览" : "✓ 已生成";
  const conflicts = result.conflicts.length > 0 ? ` · 覆盖 ${result.conflicts.length} 个文件` : " · 无文件冲突";
  return `${prefix} ${result.files.length} 个文件${conflicts}\n${result.targetDir}`;
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

async function input(ctx: ExtensionCommandContext, title: string, placeholder: string) {
  const value = await ctx.ui.input(title, placeholder);
  return value === undefined ? undefined : value.trim();
}

async function collectOptions(ctx: ExtensionCommandContext, targetDir: string) {
  const metadata = await readProjectMetadata(ctx, targetDir);
  const projectName = await input(ctx, "项目名称", metadata.projectName);
  if (projectName === undefined) return undefined;

  const language = await showMenu(ctx, "模板语言", [
    { value: "zh-CN", label: "简体中文", description: "生成中文协作文档" },
    { value: "en", label: "English", description: "Generate English collaboration docs" },
    { value: "cancel", label: "取消" },
  ]);
  if (!language || language === "cancel") return undefined;

  const description = await input(
    ctx,
    "项目定位（可留空）",
    metadata.description ?? "例如：客户账户管理门户",
  );
  if (description === undefined) return undefined;

  const testCommand = await input(ctx, "测试命令（可留空）", metadata.testCommand ?? "例如：npm test");
  if (testCommand === undefined) return undefined;

  const slug = await input(ctx, "Skill 名称（可留空自动生成）", metadata.projectName);
  if (slug === undefined) return undefined;

  const roleConfiguration = await showMenu(ctx, "角色模型", [
    { value: "default", label: "使用默认配置", description: "推荐，后续可在 /pi-init config 中修改" },
    { value: "custom", label: "逐个配置", description: "为三个角色选择模型和推理强度" },
    { value: "cancel", label: "取消" },
  ]);
  if (!roleConfiguration || roleConfiguration === "cancel") return undefined;
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

async function finishScaffold(ctx: ExtensionCommandContext, result: ScaffoldOutcome) {
  notifyResult(ctx, result);
  const isCurrentProject = result.targetDir === resolve(ctx.cwd, ".");
  if (isCurrentProject && !result.dryRun && !result.cancelled) {
    ctx.ui.notify("当前项目已更新，正在重新加载 Skill。", "info");
    await ctx.reload();
  }
}

export default function initProjectExtension(pi: ExtensionAPI) {
  let activeRole: {
    role: string;
    provider: string;
    model: string;
    thinkingLevel: string;
  } | undefined;
  let sessionModeOverride: string | undefined;
  let sessionRoleConfigOverrides: Record<string, unknown> = {};
  let controlCenterGuideShown = false;
  let roleModeStatus = "auto";
  let workflowModeStatus = "auto";
  let workflowExecutorStatus = "local";
  let workflowState: ReturnType<typeof createWorkflowState> | undefined;
  let workflowDispatchInFlight = false;
  let pendingExternalRunSource: string | undefined;
  let acceptedExternalRunSource: string | undefined;
  let externalRunTiming: ReturnType<typeof createRunTiming>;
  let internalContinuationPending = false;
  let currentContext: ExtensionContext | undefined;
  let runtimeDisposed = false;
  let pendingRoleCompaction:
    | {
        fromRole: string;
        toRole: string;
        continuation?:
          | { kind: "workflow-task"; taskId: string }
          | { kind: "workflow-schedule" }
          | { kind: "workflow-review" };
      }
    | undefined;
  let roleCompactionInFlight = false;

  function activeRoleFor(ctx: ExtensionContext) {
    if (
      !activeRole ||
      !ctx.model ||
      activeRole.provider !== ctx.model.provider ||
      activeRole.model !== ctx.model.id ||
      activeRole.thinkingLevel !== pi.getThinkingLevel()
    ) {
      return undefined;
    }
    return activeRole;
  }

  async function readSessionRoleConfig(ctx: ExtensionContext) {
    const persisted = await readRoleConfig(ctx);
    return resolveRoleConfig({
      ...(persisted && typeof persisted === "object" ? persisted : {}),
      ...sessionRoleConfigOverrides,
    }) as ResolvedRoleConfig;
  }

  function hasPendingRoleConfigChanges() {
    return Object.keys(sessionRoleConfigOverrides).length > 0;
  }

  function effectiveRoleMode(config: Pick<ResolvedRoleConfig, "mode">) {
    return sessionModeOverride ?? config.mode;
  }

  function isManualRoleMode(config: Pick<ResolvedRoleConfig, "mode">) {
    return effectiveRoleMode(config) === "manual";
  }

  function stageRoleConfig(changes: Record<string, unknown>) {
    sessionRoleConfigOverrides = { ...sessionRoleConfigOverrides, ...changes };
  }

  /**
   * Manual mode faces the host directly: a native /model switch is the user's
   * explicit choice, so instead of rolling it back we write it back to the
   * project config for the active role, extending the provider allowlist to
   * keep the file valid for auto/confirm sessions.
   */
  async function writeBackManualModelSelection(
    event: { model?: unknown },
    ctx: ExtensionContext,
    config: ResolvedRoleConfig,
  ) {
    const role = activeRole?.role;
    if (!role || !ROLE_NAMES.includes(role)) {
      ctx.ui.notify(
        "手动模式下模型已由宿主切换；当前无活动角色，未写入 .pi/role-models.json。",
        "info",
      );
      return;
    }
    if (!ctx.isProjectTrusted()) {
      ctx.ui.notify("手动模式写回仅允许在受信任项目中运行；本次切换未写入项目文件。", "info");
      return;
    }

    let reference: { provider: string; model: string };
    try {
      reference = normalizeModelReference(event.model, "手动切换模型");
    } catch (error) {
      ctx.ui.notify(`手动模式下忽略无法解析的模型切换：${textOf(error)}`, "warning");
      return;
    }

    const current = config[role as keyof Pick<ResolvedRoleConfig, "architect" | "developer-test" | "docs-commit">];
    const thinkingNow = pi.getThinkingLevel();
    const thinkingLevel = (THINKING_LEVELS as readonly string[]).includes(thinkingNow)
      ? thinkingNow
      : current.thinkingLevel;
    if (current.provider === reference.provider && current.model === reference.model) {
      activeRole = { role, ...reference, thinkingLevel };
      return;
    }

    const changes: Record<string, unknown> = {
      [role]: { ...reference, thinkingLevel },
    };

    const configPath = resolve(ctx.cwd, CONFIG_DIR_NAME, "role-models.json");
    try {
      await withFileMutationQueue(configPath, async () => {
        const persisted = await readRoleConfig(ctx);
        const persistedBase = persisted && typeof persisted === "object" ? persisted : {};
        const resolved = resolveRoleConfig({ ...persistedBase, ...changes });
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, `${JSON.stringify(resolved, null, 2)}\n`, "utf8");
      });
      delete sessionRoleConfigOverrides[role];
      activeRole = { role, ...reference, thinkingLevel };
      ctx.ui.notify(
        `手动模式写回：${roleLabel(role)} → ${reference.provider}/${reference.model} 已写入 .pi/role-models.json。`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(`手动模式写回失败：${textOf(error)}`, "error");
    }
  }

  async function saveRoleConfig(ctx: ExtensionCommandContext) {
    if (!ctx.isProjectTrusted()) {
      ctx.ui.notify("保存角色配置仅允许在受信任项目中运行；请先信任当前项目", "error");
      return;
    }
    if (!hasPendingRoleConfigChanges()) {
      ctx.ui.notify("当前没有未保存的角色配置变更。", "info");
      return;
    }

    const changes = { ...sessionRoleConfigOverrides };
    const configPath = resolve(ctx.cwd, CONFIG_DIR_NAME, "role-models.json");
    try {
      const next = await withFileMutationQueue(configPath, async () => {
        const persisted = await readRoleConfig(ctx);
        const current = persisted && typeof persisted === "object" ? persisted : {};
        const resolved = resolveRoleConfig({ ...current, ...changes });
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, `${JSON.stringify(resolved, null, 2)}\n`, "utf8");
        return resolved as ResolvedRoleConfig;
      });
      sessionRoleConfigOverrides = {};
      workflowModeStatus = next.workflowMode;
      workflowExecutorStatus = next.workflowExecutor;
      refreshRoleStatus(ctx, sessionModeOverride ?? next.mode);
      ctx.ui.notify("已保存角色配置到 .pi/role-models.json。", "info");
    } catch (error) {
      ctx.ui.notify(`保存角色配置失败：${textOf(error)}`, "error");
    }
  }

  function inactiveWorkflowStateLabel() {
    return `策略 ${workflowModeLabel(workflowModeStatus)} · 执行器 ${workflowExecutorLabel(workflowExecutorStatus)} · 无活动工作流`;
  }

  function workflowStateLabel(state = workflowState) {
    if (!state) return inactiveWorkflowStateLabel();

    const progress = workflowProgress(state);
    const current = progress.currentTaskId ? ` · 当前 ${progress.currentTaskId}` : "";
    const executor = ` · ${workflowExecutorLabel(state.executor)}`;
    if (state.status === "paused") return `已暂停 ${progress.completed}/${progress.total}${executor}${current}`;
    if (state.status === "completed") return `已完成 ${progress.completed}/${progress.total}${executor}`;
    if (state.status === "cancelled") return `已取消 ${progress.completed}/${progress.total}${executor}`;
    return `运行 ${progress.completed}/${progress.total}${executor}${current || " · 待调度"}`;
  }

  function workflowStatusLabel(state = workflowState) {
    if (!state || ["completed", "cancelled"].includes(state.status)) return inactiveWorkflowStateLabel();
    return workflowStateLabel(state);
  }

  function refreshRoleStatus(ctx: ExtensionContext, mode: string) {
    const role = activeRoleFor(ctx);
    const model = ctx.model
      ? `${shortModelName(ctx.model.id)}/${pi.getThinkingLevel()}`
      : "未选择模型";
    ctx.ui.setStatus(
      "pi-init",
      `● ${roleModeLabel(mode)} · ${role ? `${roleLabel(role.role)} · ` : ""}${model} · 工作流 · ${workflowStatusLabel()}`,
    );
  }

  function setRoleStatus(ctx: ExtensionContext, mode: string) {
    roleModeStatus = mode;
    refreshRoleStatus(ctx, mode);
  }

  function startPendingRoleCompaction(ctx: ExtensionContext) {
    if (!pendingRoleCompaction || roleCompactionInFlight) return;

    const transition = pendingRoleCompaction;
    pendingRoleCompaction = undefined;
    roleCompactionInFlight = true;
    ctx.ui.setStatus("pi-init-compaction", "● 角色切换 · 正在压缩上下文");

    const continueAfterTransition = (warning?: string) => {
      if (warning) ctx.ui.notify(warning, "warning");
      if (transition.continuation?.kind === "workflow-task") {
        sendWorkflowTaskMessage(ctx, transition.continuation.taskId, warning);
        return;
      }
      if (transition.continuation?.kind === "workflow-schedule") {
        workflowDispatchInFlight = false;
        void scheduleWorkflow(ctx).catch((error) => ctx.ui.notify(`工作流自动续跑失败：${textOf(error)}`, "error"));
        return;
      }
      if (transition.continuation?.kind === "workflow-review") {
        workflowDispatchInFlight = false;
        return;
      }

      try {
        internalContinuationPending = true;
        pi.sendMessage(
          {
            customType: ROLE_SWITCH_CONTINUATION_TYPE,
            content: `已完成从${roleLabel(transition.fromRole)}到${roleLabel(transition.toRole)}的自动角色切换和上下文压缩。请继续当前任务。`,
            display: false,
            details: transition,
          },
          { triggerTurn: true },
        );
      } catch (error) {
        internalContinuationPending = false;
        ctx.ui.notify(`上下文压缩已完成，但无法自动继续：${textOf(error)}`, "warning");
      }
    };

    // Pi may have auto-compacted immediately before agent_settled. Calling the
    // manual API again in that state only produces "Already compacted".
    if (ctx.sessionManager.getBranch().at(-1)?.type === "compaction") {
      roleCompactionInFlight = false;
      ctx.ui.setStatus("pi-init-compaction", undefined);
      continueAfterTransition();
      return;
    }

    ctx.compact({
      customInstructions: ROLE_SWITCH_COMPACTION_INSTRUCTIONS,
      onComplete: () => {
        roleCompactionInFlight = false;
        ctx.ui.setStatus("pi-init-compaction", undefined);
        continueAfterTransition();
      },
      onError: (error) => {
        roleCompactionInFlight = false;
        ctx.ui.setStatus("pi-init-compaction", undefined);
        continueAfterTransition(`角色切换后的上下文压缩失败，仍将继续当前任务：${error.message}`);
      },
    });
  }

  async function applyRole(role: string, ctx: ExtensionContext) {
    const config = await readSessionRoleConfig(ctx);
    workflowModeStatus = config.workflowMode;
    workflowExecutorStatus = config.workflowExecutor;
    const target = config[role as keyof Pick<ResolvedRoleConfig, "architect" | "developer-test" | "docs-commit">];
    if (!target) throw new Error(`未知角色：${role}`);
    const model = ctx.modelRegistry.find(target.provider, target.model);
    if (!model) {
      throw new Error(
        `角色 ${roleLabel(role)} 配置的模型不存在：${target.provider}/${target.model}；请在 /pi-init config 中修改`,
      );
    }
    if (!(await pi.setModel(model))) {
      throw new Error(`角色 ${roleLabel(role)} 无法使用模型 ${target.provider}/${target.model}：缺少可用凭据`);
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
    activeRole = result;
    setRoleStatus(ctx, sessionModeOverride ?? config.mode);
    return result;
  }

  function currentRole(role: string, ctx: ExtensionContext) {
    const result = ctx.model
      ? {
          role,
          provider: ctx.model.provider,
          model: ctx.model.id,
          thinkingLevel: pi.getThinkingLevel(),
        }
      : undefined;
    if (
      !activeRole ||
      !result ||
      activeRole.role !== role ||
      activeRole.provider !== result.provider ||
      activeRole.model !== result.model ||
      activeRole.thinkingLevel !== result.thinkingLevel
    ) {
      throw new Error(`当前为手动模式，请先执行 /pi-init role ${role}`);
    }
    return result;
  }

  async function automaticRole(role: string, ctx: ExtensionContext) {
    const configuredMode = (await readSessionRoleConfig(ctx)).mode;
    const mode = sessionModeOverride ?? configuredMode;
    if (mode === "auto") {
      const previousRole = activeRoleFor(ctx)?.role;
      const compactAfterSwitch = shouldCompactOnRoleSwitch({
        mode,
        previousRole,
        nextRole: role,
        contextUsage: ctx.getContextUsage(),
      });
      const result = await applyRole(role, ctx);
      const transition = compactAfterSwitch && previousRole
        ? { fromRole: previousRole, toRole: result.role }
        : undefined;
      if (transition) pendingRoleCompaction = transition;
      return { mode, requestedRole: role, result, transition };
    }
    if (mode === "manual") {
      return { mode, requestedRole: role, result: currentRole(role, ctx) };
    }

    if (activeRole?.role === role) {
      try {
        return { mode, requestedRole: role, result: currentRole(role, ctx) };
      } catch {
        // The user changed the model or thinking level; confirm the role again.
      }
    }
    if (!ctx.hasUI) {
      throw new Error(`角色切换模式为确认后切换，但当前环境无法确认；请先执行 /pi-init role ${role} 或 /pi-init mode auto`);
    }

    const decision = await showMenu(ctx, `建议切换到「${roleLabel(role)}」`, [
      { value: "accept", label: "采用建议", description: "切换到项目配置的模型" },
      { value: "manual", label: "切换为手动模式", description: "本次会话不再自动换角" },
      { value: "cancel", label: "取消" },
    ]);
    if (decision === "accept") {
      return { mode, requestedRole: role, result: await applyRole(role, ctx) };
    }
    if (decision === "manual") {
      sessionModeOverride = "manual";
      setRoleStatus(ctx, "manual");
      const selected = await showMenu(
        ctx,
        "手动选择角色",
        ROLE_NAMES.map((value) => ({ value, label: roleLabel(value) })),
      );
      if (!selected) throw new Error("已取消手动角色选择");
      return {
        mode: "manual",
        requestedRole: role,
        result: await applyRole(selected, ctx),
      };
    }
    throw new Error("已取消角色切换");
  }

  function updateWorkflowStatus(ctx: ExtensionContext) {
    refreshRoleStatus(ctx, roleModeStatus);
    ctx.ui.setStatus("pi-init-workflow", undefined);
  }

  function persistWorkflowState(next: ReturnType<typeof createWorkflowState>, ctx: ExtensionContext) {
    workflowState = next;
    pi.appendEntry("pi-init-workflow", next);
    updateWorkflowStatus(ctx);
    return next;
  }

  function formatWorkflowState(state = workflowState) {
    if (!state) return "当前没有活动工作流。";
    const progress = workflowProgress(state);
    const lines = [
      `状态：${state.status}`,
      `进度：${progress.completed}/${progress.total}`,
      `执行器：${workflowExecutorLabel(state.executor)}`,
      `规划：${state.plan.summary}`,
    ];
    if (state.currentTaskId) lines.push(`当前任务：${state.currentTaskId}`);
    if (state.pauseReason) lines.push(`暂停原因：${state.pauseReason}${state.taskPauseReason ? ` · ${state.taskPauseReason}` : ""}`);
    lines.push(
      ...state.tasks.map((task) =>
        `- [${task.status}] ${task.id} · ${task.role} · ${task.task}` +
        (task.completionSummary ? ` · ${task.completionSummary}` : ""),
      ),
    );
    return lines.join("\n");
  }

  async function showWorkflowProgress(ctx: ExtensionCommandContext) {
    if (!ctx.hasUI || ctx.mode !== "tui") {
      ctx.ui.notify(formatWorkflowState(), "info");
      return;
    }

    const state = workflowState;
    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      const statusLabel = state?.status === "running"
        ? "运行中"
        : state?.status === "paused"
          ? "已暂停"
          : state?.status === "completed"
            ? "已完成"
            : state?.status === "cancelled"
              ? "已取消"
              : "无活动";
      const progress = state ? workflowProgress(state) : undefined;
      const taskItems: SelectItem[] = state?.tasks.map((task) => {
        const taskStatus = task.status === "completed"
          ? "✓ 已完成"
          : task.status === "in_progress"
            ? "● 进行中"
            : task.status === "blocked"
              ? "! 已阻塞"
              : "○ 待处理";
        return {
          value: task.id,
          label: `${taskStatus} · ${task.id}`,
          description: `${roleLabel(task.role)} · ${task.task}${task.completionSummary ? ` · ${task.completionSummary}` : ""}`,
        };
      }) ?? [];
      if (taskItems.length === 0) {
        taskItems.push({ value: "close", label: "当前没有活动工作流", description: "按 Enter 或 Esc 关闭" });
      }

      const list = new SelectList(taskItems, Math.min(taskItems.length, 5), {
        selectedPrefix: (text) => theme.bg("selectedBg", theme.fg("accent", text)),
        selectedText: (text) => theme.bg("selectedBg", theme.fg("text", text)),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      list.onSelect = () => done();
      list.onCancel = () => done();

      const content = new Box(2, 1, (text) => theme.bg("customMessageBg", text));
      content.addChild(new Text(theme.bg("selectedBg", theme.fg("text", theme.bold(" 工作流任务进度 "))), 0, 0));
      content.addChild(new Spacer(1));
      content.addChild(new Text(theme.fg("text", state
        ? [
            `状态  ${statusLabel}`,
            `进度  ${progress?.completed ?? 0}/${progress?.total ?? 0}`,
            `执行器  ${workflowExecutorLabel(state.executor)}`,
            `规划  ${state.plan.summary}`,
            ...(state.currentTaskId ? [`当前任务  ${state.currentTaskId}`] : []),
            ...(state.pauseReason ? [`暂停原因  ${state.pauseReason}${state.taskPauseReason ? ` · ${state.taskPauseReason}` : ""}`] : []),
          ].join("\n")
        : "当前没有活动工作流。"), 0, 0));
      content.addChild(new Spacer(1));
      content.addChild(new Text(theme.fg("accent", theme.bold("任务列表")), 0, 0));
      content.addChild(list);
      content.addChild(new Spacer(1));
      content.addChild(new Text(theme.fg("muted", "↑↓ 浏览 · Enter 或 Esc 关闭"), 0, 0));

      const panelBorder = (left: string, right: string) => ({
        render: (width: number) => [
          theme.fg("borderAccent", `${left}${"─".repeat(Math.max(0, width - 2))}${right}`),
        ],
        invalidate: () => {},
      });
      const panelFrame = {
        render: (width: number) => {
          const innerWidth = Math.max(1, width - 2);
          const side = theme.fg("borderAccent", "│");
          return content.render(innerWidth).map((line) => `${side}${line}${side}`);
        },
        invalidate: () => content.invalidate(),
      };
      const container = new Container();
      container.addChild(panelBorder("┌", "┐"));
      container.addChild(panelFrame);
      container.addChild(panelBorder("└", "┘"));

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    }, {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "80%",
        minWidth: 50,
        maxHeight: "90%",
        margin: 1,
      },
    });
  }

  function formatWorkflowTimestamp(value: unknown, unavailableText: string) {
    if (typeof value !== "number" || !Number.isFinite(value)) return unavailableText;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return unavailableText;
    const pad = (part: number) => String(part).padStart(2, "0");
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absoluteOffset = Math.abs(offsetMinutes);
    const offset = `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
  }

  function formatWorkflowDuration(milliseconds: number | undefined) {
    if (milliseconds === undefined) return "不可用（历史任务未记录有效的开始时间）";
    if (milliseconds < 1000) return `${milliseconds} 毫秒`;

    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (hours > 0) parts.push(`${hours} 小时`);
    if (minutes > 0) parts.push(`${minutes} 分钟`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds} 秒`);
    const remainingMilliseconds = milliseconds % 1000;
    if (remainingMilliseconds > 0) parts.push(`${remainingMilliseconds} 毫秒`);
    return parts.join(" ");
  }

  function formatRunTimingDuration(milliseconds: number | undefined) {
    return milliseconds === undefined
      ? "不可用（无效或不完整的时间戳）"
      : formatWorkflowDuration(milliseconds);
  }

  function runTimingSourceLabel(source: unknown) {
    if (source === "interactive") return "交互式输入";
    if (source === "rpc") return "RPC 输入";
    return "未知来源";
  }

  function formatRunTimingReport(data: RunTimingEntryData = {}) {
    return [
      "普通执行时间报告",
      `来源：${runTimingSourceLabel(data.source)}`,
      `开始时间：${formatWorkflowTimestamp(data.startedAt, "不可用（无效的开始时间）")}`,
      `结束时间：${formatWorkflowTimestamp(data.completedAt, "不可用（无效的结束时间）")}`,
      `总耗时：${formatRunTimingDuration(getRunTimingDuration(data))}`,
      "计时口径：从本次外部输入触发的首次 agent_start 到最终 agent_settled；仅表示本次 Agent 执行，不代表工作流任务或业务任务已完成。",
    ].join("\n");
  }

  function styleReportText(report: string, theme: ReportTheme) {
    return report.split("\n").map((line, index) => {
      if (index === 0) return theme.fg("accent", theme.bold(`◆ ${line}`));
      if (line.startsWith("总耗时：") || line.startsWith("整体总耗时：")) return theme.fg("warning", theme.bold(line));
      if (
        line.startsWith("摘要：") ||
        line.startsWith("目标：") ||
        line.startsWith("进度：") ||
        line.startsWith("任务摘要：") ||
        line.startsWith("验证：")
      ) return theme.fg("success", theme.bold(line));
      if (line.startsWith("验证结果：") || line.startsWith("汇总验证：")) {
        return theme.fg("success", theme.bold(line));
      }
      if (
        line.startsWith("冻结时间：") ||
        line.startsWith("开始时间：") ||
        line.startsWith("结束时间：") ||
        line.startsWith("实际开始时间：")
      ) return theme.fg("accent", line);
      if (line.startsWith("计时口径：")) return theme.fg("dim", line);
      if (line.startsWith("- ")) return theme.fg("muted", line);
      return theme.fg("text", line);
    }).join("\n");
  }

  function settleExternalRunTiming() {
    const timing = externalRunTiming;
    externalRunTiming = undefined;
    pendingExternalRunSource = undefined;
    acceptedExternalRunSource = undefined;
    if (!timing || (workflowState && isWorkflowActive(workflowState))) return;

    const completed = completeRunTiming(timing);
    if (completed) pi.appendEntry(RUN_TIMING_ENTRY_TYPE, completed);
  }

  pi.registerEntryRenderer<RunTimingEntryData>(RUN_TIMING_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data && typeof entry.data === "object"
      ? entry.data as RunTimingEntryData
      : {};
    return new Text(styleReportText(formatRunTimingReport(data), theme), 0, 0);
  });

  function formatWorkflowTaskCompletion(task: ReturnType<typeof getWorkflowTask>) {
    if (!task) throw new Error("无法生成不存在的工作流任务完成报告");
    const verification = task.verification?.map((item) => `- ${item}`).join("\n") ?? "- 无";
    return [
      "任务完成报告",
      `任务：${task.id} · ${task.task}`,
      `角色：${roleLabel(task.role)}`,
      `开始时间：${formatWorkflowTimestamp(task.startedAt, "不可用（历史任务未记录开始时间）")}`,
      `结束时间：${formatWorkflowTimestamp(task.completedAt, "不可用（任务未记录结束时间）")}`,
      `总耗时：${formatWorkflowDuration(getWorkflowTaskDuration(task))}`,
      `摘要：${task.completionSummary ?? "无"}`,
      `验证：\n${verification}`,
    ].join("\n");
  }

  function formatWorkflowExecutionDuration(state: ReturnType<typeof createWorkflowState>) {
    const duration = getWorkflowExecutionDuration(state);
    return duration === undefined
      ? "不可用（工作流缺少有效的整体开始或结束时间）"
      : formatWorkflowDuration(duration);
  }

  function formatWorkflowCompletion(state: ReturnType<typeof createWorkflowState>) {
    const progress = workflowProgress(state);
    const bounds = getWorkflowExecutionBounds(state);
    const taskSummaries = state.tasks
      .map((task) => `- ${task.id}：${task.completionSummary ?? "无"}`)
      .join("\n") || "- 无";
    const verification = state.tasks
      .flatMap((task) => (task.verification ?? []).map((item) => `- ${task.id}：${item}`))
      .join("\n") || "- 无";

    return [
      "工作流完成报告",
      `目标：${state.plan.summary}`,
      `进度：${progress.completed}/${progress.total}`,
      "任务摘要：",
      taskSummaries,
      `开始时间：${formatWorkflowTimestamp(bounds.startedAt, "不可用（工作流未记录有效的开始时间）")}`,
      `结束时间：${formatWorkflowTimestamp(bounds.completedAt, "不可用（工作流未记录有效的结束时间）")}`,
      `总耗时：${formatWorkflowExecutionDuration(state)}`,
      "验证：",
      verification,
    ].join("\n");
  }

  function workflowTaskPrompt(state: ReturnType<typeof createWorkflowState>, taskId: string, note?: string) {
    const task = getWorkflowTask(state, taskId);
    if (!task) throw new Error(`工作流任务不存在：${taskId}`);
    const completed = state.tasks
      .filter((item) => item.status === "completed")
      .map((item) => `- ${item.id}: ${item.completionSummary ?? "已完成"}`);

    return [
      "[PI-INIT 自动任务工作流]",
      `工作流目标：${state.plan.summary}`,
      state.plan.constraints.length > 0 ? `架构约束：\n${state.plan.constraints.map((item) => `- ${item}`).join("\n")}` : "",
      completed.length > 0 ? `已完成任务：\n${completed.join("\n")}` : "",
      `当前任务（${task.id}，角色 ${task.role}）：${task.task}`,
      `允许涉及的文件或目录：${task.files.join(", ")}`,
      `验收标准：\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
      note ? `调度提示：${note}` : "",
      "除非遇到真正阻塞的需求、权限、凭据、破坏性操作或必须由用户决定的产品取舍，不要询问用户；做合理假设并记录。",
      `完成并实际验证后，必须调用 task_workflow(action=\"complete\", taskId=\"${task.id}\", completionSummary=..., verification=[...])。verification 只能填写实际执行过的命令和真实结果。若无法继续，调用 task_workflow(action=\"block\", taskId=\"${task.id}\", reason=...)，不要伪造完成。`,
    ].filter(Boolean).join("\n\n");
  }

  function sendWorkflowTaskMessage(ctx: ExtensionContext, taskId: string, note?: string) {
    if (!workflowState || workflowState.currentTaskId !== taskId) return;
    workflowDispatchInFlight = false;
    try {
      internalContinuationPending = true;
      pi.sendMessage(
        {
          customType: "pi-init-workflow-task",
          content: workflowTaskPrompt(workflowState, taskId, note),
          display: false,
          details: { taskId },
        },
        { triggerTurn: true },
      );
    } catch (error) {
      internalContinuationPending = false;
      ctx.ui.notify(`无法自动进入任务 ${taskId}：${textOf(error)}`, "error");
    }
  }

  function restoreWorkflowState(ctx: ExtensionContext) {
    currentContext = ctx;
    const entry = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((item) => item.type === "custom" && item.customType === "pi-init-workflow");
    const data = entry && "data" in entry ? entry.data : undefined;
    try {
      workflowState = data && typeof data === "object" && Array.isArray((data as { tasks?: unknown }).tasks)
        ? hydrateWorkflowState(data) as ReturnType<typeof createWorkflowState>
        : undefined;
      if (workflowState) workflowExecutorStatus = workflowState.executor;
    } catch (error) {
      workflowState = undefined;
      ctx.ui.notify(`无法恢复工作流状态：${textOf(error)}`, "error");
    }
    updateWorkflowStatus(ctx);
  }

function nextSubtaskRequestId(taskId: string) {
    return `pi-init-${taskId}-${Date.now()}`;
  }

  function workflowSubtaskPrompt(state: ReturnType<typeof createWorkflowState>, taskId: string) {
    const task = getWorkflowTask(state, taskId);
    if (!task) throw new Error(`工作流任务不存在：${taskId}`);
    const completed = state.tasks
      .filter((item) => item.status === "completed")
      .map((item) => `- ${item.id}: ${item.completionSummary ?? "已完成"}`);

    return [
      "[PI-INIT SUBTASK WORKFLOW]",
      `Workflow goal: ${state.plan.summary}`,
      state.plan.constraints.length > 0 ? `Architecture constraints:\n${state.plan.constraints.map((item) => `- ${item}`).join("\n")}` : "",
      completed.length > 0 ? `Completed tasks:\n${completed.join("\n")}` : "",
      `Current task (${task.id}, role ${task.role}): ${task.task}`,
      `Allowed files or directories: ${task.files.join(", ")}`,
      `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
      "Work in the current shared checkout. Do not create worktrees, merge branches, commit, or push.",
      "Do not call pi-init task_workflow tools. The parent session owns workflow state.",
      `When finished, output only one JSON object using protocol ${SUBTASK_RESULT_PROTOCOL}. For success use {"protocol":"${SUBTASK_RESULT_PROTOCOL}","outcome":"complete","completionSummary":"...","verification":["actual command and result"]}. If genuinely blocked use {"protocol":"${SUBTASK_RESULT_PROTOCOL}","outcome":"blocked","reason":"..."}. Do not wrap it in Markdown fences or add other text.`,
    ].filter(Boolean).join("\n\n");
  }

  function sendSubtaskDispatchMessage(ctx: ExtensionContext, taskId: string) {
    if (!workflowState || workflowState.currentTaskId !== taskId) return;
    workflowDispatchInFlight = false;
    try {
      internalContinuationPending = true;
      pi.sendMessage(
        {
          customType: "pi-init-subtask-dispatch",
          content: [
            "请调用 subtask 工具派发当前工作流任务。",
            "subtask 工具的 task 参数必须原样使用下面整段文本（逐字不变，不要改写、截断或概括）：",
            "",
            workflowSubtaskPrompt(workflowState, taskId),
            "",
            "调用 subtask 工具后立即结束当前回合：不要自行执行该任务，不要等待或轮询结果，不要调用 task_workflow。subtask 完成后其结果会自动回到本会话，工作流会自动推进到下一步。",
          ].join("\n"),
          display: false,
          details: { taskId },
        },
        { triggerTurn: true },
      );
    } catch (error) {
      internalContinuationPending = false;
      ctx.ui.notify(`无法派发 subtask 任务 ${taskId}：${textOf(error)}`, "error");
    }
  }

  function blockDelegatedTask(ctx: ExtensionContext, taskId: string, reason: string) {
    if (runtimeDisposed || !workflowState || workflowState.currentTaskId !== taskId || !isWorkflowActive(workflowState)) return;
    try {
      const blocked = blockWorkflowTask(workflowState, { taskId, reason });
      persistWorkflowState(blocked, ctx);
      workflowDispatchInFlight = false;
      ctx.ui.notify(`工作流已暂停：委派任务 ${taskId}：${reason}`, "warning");
    } catch (error) {
      workflowDispatchInFlight = false;
      ctx.ui.notify(`无法记录委派任务 ${taskId} 的失败：${textOf(error)}`, "error");
    }
  }

  async function dispatchSubtaskTask(ctx: ExtensionContext, taskId: string) {
    if (!workflowState || workflowState.currentTaskId !== taskId || !isWorkflowActive(workflowState)) return;
    const task = getWorkflowTask(workflowState, taskId);
    if (!task) return;
    const activeTools = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
    if (!activeTools.includes("subtask")) {
      blockDelegatedTask(ctx, taskId, "未检测到 subtask 工具；请先安装并启用 gary149/pi-subtask 扩展");
      return;
    }
    try {
      const spawning = beginWorkflowDelegation(workflowState, {
        taskId,
        requestId: nextSubtaskRequestId(task.id),
        type: "subtask",
      });
      const started = markWorkflowTaskStarted(spawning, taskId);
      persistWorkflowState(started, ctx);
      sendSubtaskDispatchMessage(ctx, taskId);
    } catch (error) {
      blockDelegatedTask(ctx, taskId, `无法派发 subtask：${textOf(error)}`);
    }
  }

  function latestSubtaskResult(ctx: ExtensionContext) {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (entry.type === "custom_message" && entry.customType === "subtask-result") return entry;
    }
    return undefined;
  }

  async function consumeSubtaskResult(ctx: ExtensionContext) {
    if (!workflowState || workflowState.executor !== "subtask" || !isWorkflowActive(workflowState)) return;
    const taskId = workflowState.currentTaskId;
    if (!taskId) return;
    const task = getWorkflowTask(workflowState, taskId);
    const delegation = task?.delegation;
    if (!delegation || !["spawning", "running"].includes(delegation.status)) return;

    const details = latestSubtaskResult(ctx)?.details as
      | { name?: string; task?: string; status?: string; resultText?: string }
      | undefined;
    if (!details || typeof details.task !== "string" || typeof details.resultText !== "string") return;

    // The fork echoes the exact task string back, so match on it deterministically.
    if (details.task !== workflowSubtaskPrompt(workflowState, taskId)) return;

    if (details.status !== "done") {
      blockDelegatedTask(ctx, taskId, `subtask 未成功完成（${details.status ?? "未知"}）`);
      return;
    }

    try {
      const result = parseSubtaskResult(details.resultText);
      if (result.outcome === "blocked") {
        blockDelegatedTask(ctx, taskId, result.reason);
        return;
      }
      const next = completeWorkflowTask(workflowState, {
        taskId,
        completionSummary: result.completionSummary,
        verification: result.verification,
      });
      const completedTask = getWorkflowTask(next, taskId);
      const taskCompletionReport = formatWorkflowTaskCompletion(completedTask);
      const completionReport = next.status === "completed"
        ? formatWorkflowCompletion(next)
        : taskCompletionReport;
      persistWorkflowState(next, ctx);
      workflowDispatchInFlight = false;
      ctx.ui.notify(completionReport, "info");
    } catch (error) {
      blockDelegatedTask(ctx, taskId, `subtask 结果无效：${textOf(error)}`);
    }
  }

  async function scheduleWorkflow(ctx: ExtensionContext) {
    if (
      workflowDispatchInFlight ||
      roleCompactionInFlight ||
      pendingRoleCompaction ||
      !workflowState ||
      !isWorkflowActive(workflowState)
    ) {
      return;
    }

    if (workflowState.currentTaskId) {
      const currentTask = getWorkflowTask(workflowState, workflowState.currentTaskId);
      if (workflowState.executor === "subtask") {
        // A restored delegated task stays attached to its fork; never respawn it
        // automatically after reload or on a parent agent_settled. Consume the
        // delivered subtask-result when the fork reports back instead.
        if (currentTask?.delegation) {
          await consumeSubtaskResult(ctx);
          if (!workflowState || !isWorkflowActive(workflowState) || workflowState.currentTaskId) return;
        } else {
          workflowDispatchInFlight = true;
          void dispatchSubtaskTask(ctx, workflowState.currentTaskId);
          return;
        }
      } else {
        const nudged = recordWorkflowNudge(workflowState);
        if (nudged === workflowState) return;
        persistWorkflowState(nudged, ctx);
        if (nudged.status === "paused") {
          ctx.ui.notify(
            `工作流已暂停：任务未提交 complete/block。请检查当前任务后使用 /pi-init workflow retry 或重新规划。`,
            "warning",
          );
          return;
        }
        sendWorkflowTaskMessage(ctx, nudged.currentTaskId!, `上一回合尚未收到任务完成或阻塞结果；请继续当前任务并在结束时调用 task_workflow。`);
        return;
      }
    }

    const next = getNextWorkflowTask(workflowState);
    if (!next) return;

    workflowDispatchInFlight = true;
    const started = startWorkflowTask(workflowState, next.id);
    persistWorkflowState(started, ctx);
    if (started.executor === "subtask") {
      void dispatchSubtaskTask(ctx, next.id);
      return;
    }

    try {
      const selection = await automaticRole(next.role, ctx);
      if (selection.result.role !== next.role) {
        const paused = blockWorkflowTask(workflowState, {
          taskId: next.id,
          reason: `角色模式选择了 ${selection.result.role}，而任务要求 ${next.role}`,
        });
        persistWorkflowState(paused, ctx);
        workflowDispatchInFlight = false;
        ctx.ui.notify(`任务 ${next.id} 已暂停：未能应用要求的角色 ${roleLabel(next.role)}。`, "warning");
        return;
      }

      if (selection.transition && pendingRoleCompaction) {
        pendingRoleCompaction.continuation = { kind: "workflow-task", taskId: next.id };
        startPendingRoleCompaction(ctx);
        return;
      }
      sendWorkflowTaskMessage(ctx, next.id);
    } catch (error) {
      const paused = blockWorkflowTask(workflowState, {
        taskId: next.id,
        reason: `无法切换到 ${roleLabel(next.role)}：${textOf(error)}`,
      });
      persistWorkflowState(paused, ctx);
      workflowDispatchInFlight = false;
      ctx.ui.notify(`工作流已暂停：${textOf(error)}`, "error");
    }
  }

  async function workflowCommand(action: string | undefined, taskId: string | undefined, ctx: ExtensionCommandContext) {
    if (action === undefined || action === "status") {
      await showWorkflowProgress(ctx);
      return;
    }
    if (!workflowState) {
      ctx.ui.notify("当前没有工作流。请先让架构角色调用 task_workflow(action=plan)。", "warning");
      return;
    }

    try {
      if (action === "resume") {
        persistWorkflowState(resumeWorkflow(workflowState), ctx);
        await scheduleWorkflow(ctx);
        return;
      }
      if (action === "retry") {
        persistWorkflowState(retryWorkflowTask(workflowState, taskId), ctx);
        await scheduleWorkflow(ctx);
        return;
      }
      if (action === "cancel") {
        const cancelled = cancelWorkflow(workflowState);
        persistWorkflowState(cancelled, ctx);
        workflowDispatchInFlight = false;
        ctx.ui.notify("工作流已取消。subtask 运行中的 fork 由 pi-subtask 面板管理，可在其中停止或查看。", "info");
        return;
      }
      ctx.ui.notify("用法：/pi-init workflow [status|resume|retry <taskId>|cancel]", "error");
    } catch (error) {
      ctx.ui.notify(textOf(error), "error");
    }
  }

  async function runTaskWorkflowAction(params: any, signal: AbortSignal | undefined, ctx: ExtensionContext) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "工作流操作已取消。" }], details: {} };
    }
    if (params.action !== "status" && !ctx.isProjectTrusted()) {
      throw new Error("task_workflow 仅允许在受信任项目中运行；请先信任当前项目");
    }

    switch (params.action) {
      case "plan": {
        if (activeRoleFor(ctx)?.role !== "architect") {
          throw new Error("只有架构角色可以创建工作流；请先调用 switch_role(role=architect)");
        }
        if (workflowState && ["running", "paused"].includes(workflowState.status)) {
          throw new Error("当前已有未结束的工作流，请先完成、取消或处理它");
        }

        const config = await readSessionRoleConfig(ctx);
        workflowModeStatus = config.workflowMode;
        workflowExecutorStatus = config.workflowExecutor;
        const plan = validateWorkflowPlan({
          summary: params.summary,
          constraints: params.constraints,
          tasks: params.tasks,
          reviewRequired: params.reviewRequired,
        });
        if (config.workflowMode === "off") {
          throw new Error(
            "task_workflow 当前策略为 off；请先执行 /pi-init config workflow 选择 on 或 auto，或在 .pi/role-models.json 中将 workflowMode 设为 on/auto",
          );
        }
        if (!shouldOrchestrateConfiguredWorkflow(config.workflowMode, plan.tasks.length)) {
          return {
            content: [{
              type: "text",
              text: `当前工作流策略为 auto，规划包含 ${plan.tasks.length} 个任务（不超过 2 个），已跳过工作流编排；请由当前架构角色按顺序直接执行这些任务。`,
            }],
            details: { workflowMode: config.workflowMode, taskCount: plan.tasks.length, orchestrated: false },
          };
        }

        const next = createWorkflowState({ ...plan, executor: config.workflowExecutor });
        persistWorkflowState(next, ctx);
        if (next.status === "paused") {
          ctx.ui.notify("架构规划已保存，等待用户审阅。审阅后执行 /pi-init workflow resume。", "info");
          if (pendingRoleCompaction) pendingRoleCompaction.continuation = { kind: "workflow-review" };
        } else if (pendingRoleCompaction) {
          pendingRoleCompaction.continuation = { kind: "workflow-schedule" };
        }
        return {
          content: [{ type: "text", text: `已保存架构规划。\n${formatWorkflowState(next)}${next.status === "paused" ? "\n\n当前按用户要求暂停，审阅后再执行。" : "\n\n将自动切换到第一个任务。"}` }],
          details: next,
          terminate: true,
        };
      }
      case "status":
        return { content: [{ type: "text", text: formatWorkflowState() }], details: workflowState ?? {} };
      case "complete": {
        if (!workflowState) throw new Error("当前没有活动工作流");
        const taskId = params.taskId ?? workflowState.currentTaskId;
        const task = getWorkflowTask(workflowState, taskId);
        if (!task) throw new Error(`工作流任务不存在：${taskId ?? "（未指定）"}`);
        if (activeRoleFor(ctx)?.role !== task.role) {
          throw new Error(`任务 ${task.id} 要求角色 ${task.role}，当前角色不匹配；请先调用 switch_role`);
        }
        const next = completeWorkflowTask(workflowState, {
          taskId,
          completionSummary: params.completionSummary,
          verification: params.verification,
        });
        const completedTask = getWorkflowTask(next, task.id);
        const taskCompletionReport = formatWorkflowTaskCompletion(completedTask);
        const completionReport = next.status === "completed"
          ? formatWorkflowCompletion(next)
          : taskCompletionReport;
        persistWorkflowState(next, ctx);
        return {
          content: [{ type: "text", text: `${completionReport}\n\n${next.status === "completed" ? "工作流已完成。" : `任务 ${task.id} 已完成，下一任务将自动开始。`}\n${formatWorkflowState(next)}` }],
          details: next,
          terminate: true,
        };
      }
      case "block": {
        if (!workflowState) throw new Error("当前没有活动工作流");
        const taskId = params.taskId ?? workflowState.currentTaskId;
        const next = blockWorkflowTask(workflowState, { taskId, reason: params.reason });
        persistWorkflowState(next, ctx);
        workflowDispatchInFlight = false;
        ctx.ui.notify(`工作流已暂停：任务 ${taskId} 被标记为阻塞。`, "warning");
        return { content: [{ type: "text", text: formatWorkflowState(next) }], details: next, terminate: true };
      }
      case "resume": {
        if (!workflowState) throw new Error("当前没有活动工作流");
        const next = resumeWorkflow(workflowState);
        persistWorkflowState(next, ctx);
        return { content: [{ type: "text", text: "工作流已恢复，下一任务将自动开始。" }], details: next, terminate: true };
      }
      case "retry": {
        if (!workflowState) throw new Error("当前没有活动工作流");
        const next = retryWorkflowTask(workflowState, params.taskId);
        persistWorkflowState(next, ctx);
        return { content: [{ type: "text", text: `任务 ${params.taskId ?? ""} 已重新排队，工作流将自动继续。` }], details: next, terminate: true };
      }
      case "cancel": {
        if (!workflowState) throw new Error("当前没有活动工作流");
        const next = cancelWorkflow(workflowState);
        persistWorkflowState(next, ctx);
        workflowDispatchInFlight = false;
        return { content: [{ type: "text", text: "工作流已取消。subtask 运行中的 fork 由 pi-subtask 面板管理，可在其中停止或查看。" }], details: next, terminate: true };
      }
      default:
        throw new Error(`未知工作流动作：${params.action}`);
    }
  }

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
    if (!mode) return undefined;
    if (!ROLE_MODES.includes(mode)) {
      ctx.ui.notify(`未知角色模式：${mode}；可用值：${ROLE_MODES.join(", ")}`, "error");
      return undefined;
    }
    sessionModeOverride = mode;
    setRoleStatus(ctx, mode);
    ctx.ui.notify(`当前会话角色模式：${roleModeLabel(mode)}`, "info");
    return mode;
  }

  async function switchRole(requested: string | undefined, ctx: ExtensionCommandContext) {
    const role = requested || await showMenu(
      ctx,
      "切换角色",
      ROLE_NAMES.map((value) => ({ value, label: roleLabel(value) })),
    );
    if (!role) return;
    if (!ROLE_NAMES.includes(role)) {
      ctx.ui.notify(`未知角色：${role}；可用值：${ROLE_NAMES.join(", ")}`, "error");
      return;
    }
    try {
      const result = await applyRole(role, ctx);
      ctx.ui.notify(
        `已切换到 ${roleLabel(result.role)}：${shortModelName(result.model)}/${result.thinkingLevel}`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(textOf(error), "error");
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

    const config = await readSessionRoleConfig(ctx);
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
      { value: "back", label: "← 返回上一级" },
    ], { selectedValue: config.workflowMode });
    if (!choice || choice === "back") return;

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
      { value: "back", label: "← 返回上一级" },
    ], { selectedValue: config.workflowExecutor });
    if (!executor || executor === "back") return;

    if (choice !== config.workflowMode || executor !== config.workflowExecutor) {
      stageRoleConfig({ workflowMode: choice, workflowExecutor: executor });
    }
    const next = await readSessionRoleConfig(ctx);
    workflowModeStatus = next.workflowMode;
    workflowExecutorStatus = next.workflowExecutor;
    refreshRoleStatus(ctx, roleModeStatus);
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
    if (!role) return;
    if (!ROLE_NAMES.includes(role)) {
      ctx.ui.notify(`未知角色：${role}；可用值：${ROLE_NAMES.join(", ")}`, "error");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("/pi-init config 需要交互式 UI", "error");
      return;
    }

    try {
      const config = await readSessionRoleConfig(ctx);
      const selection = await selectRoleModel(ctx, role);
      if (!selection) {
        ctx.ui.notify("已取消角色配置，没有写入文件。", "warning");
        return;
      }
      stageRoleConfig({ [role]: selection });
      const result = await applyRole(role, ctx);
      ctx.ui.notify(
        `已暂存 ${roleLabel(result.role)}：${shortModelName(result.model)}/${result.thinkingLevel}；仅当前会话生效，执行 /pi-init save 才写入项目文件。`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(textOf(error), "error");
    }
  }

  async function configureRoleCenter(ctx: ExtensionCommandContext) {
    if (!ctx.isProjectTrusted()) {
      ctx.ui.notify("/pi-init config 仅允许在受信任项目中运行；请先信任当前项目", "error");
      return;
    }

    let config = await readSessionRoleConfig(ctx);
    while (true) {
      const mode = sessionModeOverride ?? config.mode;
      const action = await showMenu(ctx, "角色与模型", roleMenuItems(config, mode, hasPendingRoleConfigChanges()));
      if (!action || action === "back") return;
      if (action === "mode") {
        await setSessionMode(undefined, ctx);
        continue;
      }
      if (action === "save") {
        await saveRoleConfig(ctx);
        config = await readSessionRoleConfig(ctx);
        continue;
      }
      if (action === "workflow") {
        await configureWorkflow(ctx);
        config = await readSessionRoleConfig(ctx);
        continue;
      }
      await configureRole(action, ctx);
      config = await readSessionRoleConfig(ctx);
    }
  }

  async function quickInit(targetDir: string, ctx: ExtensionCommandContext) {
    const metadata = await readProjectMetadata(ctx, targetDir);
    const result = await runScaffold(
      ctx,
      targetDir,
      { ...metadata, language: "zh-CN" },
      ctx.hasUI ? "always" : "conflicts",
    );
    await finishScaffold(ctx, result);
  }

  async function advancedInit(targetDir: string, ctx: ExtensionCommandContext) {
    if (!ctx.hasUI) {
      throw new Error("高级初始化需要交互式 UI；无 UI 环境请使用 /pi-init init <目录>");
    }
    const options = await collectOptions(ctx, targetDir);
    if (!options) {
      ctx.ui.notify("已取消项目初始化。", "warning");
      return;
    }
    const result = await runScaffold(ctx, targetDir, options, "always");
    await finishScaffold(ctx, result);
  }

  async function showControlCenter(ctx: ExtensionCommandContext) {
    if (ctx.mode !== "tui") {
      await quickInit(".", ctx);
      return;
    }

    const showGuide = !controlCenterGuideShown;
    controlCenterGuideShown = true;
    let selectedAction: string | undefined;
    while (true) {
      const config = await readSessionRoleConfig(ctx);
      workflowModeStatus = config.workflowMode;
      workflowExecutorStatus = config.workflowExecutor;
      const mode = sessionModeOverride ?? config.mode;
      const role = activeRoleFor(ctx);
      const currentModel = ctx.model
        ? `${shortModelName(ctx.model.id)}/${pi.getThinkingLevel()}`
        : "未选择模型";
      const summary = [
        `模式  ${roleModeLabel(mode)}`,
        role
          ? `角色  ${roleLabel(role.role)}`
          : "角色  尚未切换（按任务自动选择）",
        `模型  ${currentModel}`,
        `工作流策略  ${workflowModeLabel(config.workflowMode)}`,
        `工作流执行器  ${workflowExecutorLabel(config.workflowExecutor)}`,
        `工作流状态  ${workflowStateLabel()}`,
      ];
      if (showGuide) summary.push("", "快速初始化适合大多数项目；高级初始化可修改全部配置。");
      const action = await showMenu(ctx, "Pi Init 控制中心", [
        { value: "quick", label: "◆ 初始化 · 快速初始化当前项目", description: "自动读取项目元数据，只确认一次" },
        { value: "advanced", label: "◆ 初始化 · 高级初始化", description: "编辑项目名称、语言、测试命令和 Skill" },
        { value: "config", label: "◆ 变更 · 角色与模型", description: "查看或暂存三个角色的模型配置" },
        { value: "workflow-config", label: `◆ 变更 · 工作流策略：${workflowModeLabel(config.workflowMode)}`, description: "配置当前会话的 task_workflow 编排策略" },
        { value: "role", label: "◆ 变更 · 切换角色", description: "立即应用某个角色的模型和推理强度" },
        { value: "mode", label: `◆ 变更 · 切换模式：${roleModeLabel(mode)}`, description: "只影响当前会话" },
                { value: "save", label: hasPendingRoleConfigChanges() ? "◆ 保存 · 保存角色配置（有未保存变更）" : "◆ 保存 · 保存角色配置", description: hasPendingRoleConfigChanges() ? "将暂存配置写入 .pi/role-models.json" : "当前没有待保存的配置变更" },
        { value: "workflow", label: "◆ 工作流 · 查看任务进度", description: "查看、恢复、重试或取消架构分配的任务" },
        { value: "exit", label: "← 返回" },
      ], { summary, selectedValue: selectedAction });
      if (!action || action === "exit") return;
      if (action === "quick") return quickInit(".", ctx);
      if (action === "advanced") return advancedInit(".", ctx);
      selectedAction = action;
      if (action === "config") {
        await configureRoleCenter(ctx);
        continue;
      }
      if (action === "save") {
        await saveRoleConfig(ctx);
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
        await workflowCommand("status", undefined, ctx);
      }
    }
  }

  pi.on("model_select", async (event, ctx) => {
    currentContext = ctx;

    let config: ResolvedRoleConfig;
    try {
      config = await readSessionRoleConfig(ctx);
    } catch {
      refreshRoleStatus(ctx, roleModeStatus);
      return;
    }
    if (isManualRoleMode(config)) {
      await writeBackManualModelSelection(event, ctx, config);
    }
    refreshRoleStatus(ctx, effectiveRoleMode(config));
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "Agent" && event.toolName !== "agent") return;

    const input = event.input as Record<string, unknown>;
    if (input.model === undefined) {
      if (!ctx.model) {
        return {
          block: true,
          terminate: true,
          reason: "已阻止 Agent 子代理：当前没有可用模型，无法继承 provider/model",
        };
      }
      const current = normalizeModelReference(ctx.model, "Agent 当前模型");
      input.model = `${current.provider}/${current.model}`;
      return;
    }

    try {
      const requested = normalizeModelReference(input.model, "Agent model");
      if (!ctx.modelRegistry.find(requested.provider, requested.model)) {
        throw new Error(
          `模型不存在：${requested.provider}/${requested.model}；禁止按模糊名称或其他 provider fallback`,
        );
      }
    } catch (error) {
      return {
        block: true,
        terminate: true,
        reason: `已阻止 Agent 子代理：${textOf(error)}`,
      };
    }
  });

  pi.on("input", async (event, ctx) => {
    if (typeof event.text === "string" && event.text.trim().startsWith("/")) {
      return { action: "continue" };
    }
    if (!isExternalRunSource(event.source)) return { action: "continue" };
    if (workflowState && isWorkflowActive(workflowState)) {
      pendingExternalRunSource = undefined;
      acceptedExternalRunSource = undefined;
      return { action: "continue" };
    }
    if (!externalRunTiming) pendingExternalRunSource = event.source;
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (internalContinuationPending) {
      internalContinuationPending = false;
      pendingExternalRunSource = undefined;
      acceptedExternalRunSource = undefined;
      return;
    }
    if (!pendingExternalRunSource) return;
    if (externalRunTiming || (workflowState && isWorkflowActive(workflowState))) {
      pendingExternalRunSource = undefined;
      acceptedExternalRunSource = undefined;
      return;
    }
    acceptedExternalRunSource = pendingExternalRunSource;
    pendingExternalRunSource = undefined;
  });

  pi.on("agent_start", (_event, ctx) => {
    currentContext = ctx;
    internalContinuationPending = false;
    const source = acceptedExternalRunSource;
    acceptedExternalRunSource = undefined;
    pendingExternalRunSource = undefined;
    if (workflowState && isWorkflowActive(workflowState)) {
      externalRunTiming = undefined;
    } else if (!externalRunTiming && source) {
      externalRunTiming = createRunTiming(source);
    }

    if (
      !workflowState ||
      workflowState.executor === "subtask" ||
      !workflowState.currentTaskId ||
      !isWorkflowActive(workflowState)
    ) return;
    const task = getWorkflowTask(workflowState, workflowState.currentTaskId);
    if (!task || task.executionStartedAt !== undefined) return;
    persistWorkflowState(markWorkflowTaskStarted(workflowState, task.id), ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    currentContext = ctx;
    settleExternalRunTiming();
    startPendingRoleCompaction(ctx);
    await scheduleWorkflow(ctx);
  });

  pi.on("session_shutdown", async () => {
    runtimeDisposed = true;
    pendingExternalRunSource = undefined;
    acceptedExternalRunSource = undefined;
    externalRunTiming = undefined;
    internalContinuationPending = false;
    currentContext = undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      runtimeDisposed = false;
      sessionRoleConfigOverrides = {};
      const config = await readSessionRoleConfig(ctx);
      currentContext = ctx;
      workflowModeStatus = config.workflowMode;
      workflowExecutorStatus = config.workflowExecutor;
      const role = findMatchingRole(config, ctx.model, pi.getThinkingLevel());
      activeRole = role && ctx.model
        ? {
            role,
            provider: ctx.model.provider,
            model: ctx.model.id,
            thinkingLevel: pi.getThinkingLevel(),
          }
        : undefined;
      restoreWorkflowState(ctx);
      setRoleStatus(ctx, sessionModeOverride ?? config.mode);
      await scheduleWorkflow(ctx);
    } catch (error) {
      ctx.ui.notify(textOf(error), "error");
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreWorkflowState(ctx);
    refreshRoleStatus(ctx, roleModeStatus);
  });

  pi.registerCommand("pi-init", {
    description: "打开 Pi Init 控制中心：初始化项目、配置角色和切换模型",
    getArgumentCompletions: (prefix) => {
      const tokens = prefix.trim().split(/\s+/).filter(Boolean);
      if (tokens.length <= 1 && !prefix.endsWith(" ")) {
        const values = ["init", "advanced", "config", "save", "role", "mode", "workflow"];
        const matches = values.filter((value) => value.startsWith(tokens[0] ?? ""));
        return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
      }
      const action = tokens[0];
      const values = action === "role"
        ? ROLE_NAMES
        : action === "config"
          ? [...ROLE_NAMES, "workflow"]
          : action === "mode"
          ? ROLE_MODES
          : action === "workflow"
            ? ["status", "resume", "retry", "cancel"]
            : [];
      const partial = prefix.endsWith(" ") ? "" : tokens.at(-1) ?? "";
      const matches = values.filter((value) => value.startsWith(partial));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = tokens.shift();
      try {
        if (!action) return showControlCenter(ctx);
        if (action === "init") return quickInit(tokens.join(" ") || ".", ctx);
        if (action === "advanced") return advancedInit(tokens.join(" ") || ".", ctx);
        if (action === "config") return configureRole(tokens[0], ctx);
        if (action === "save") return saveRoleConfig(ctx);
        if (action === "role") return switchRole(tokens[0], ctx);
        if (action === "mode") return setSessionMode(tokens[0], ctx);
        if (action === "workflow") return workflowCommand(tokens.shift(), tokens.shift(), ctx);
        ctx.ui.notify("用法：/pi-init [init|advanced|config|save|role|mode|workflow] [参数]", "error");
      } catch (error) {
        ctx.ui.notify(textOf(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "init_project",
    label: "Initialize Project",
    description:
      "Generate AGENTS.md, four docs memory files, .pi/role-models.json, and a role-routing .pi/skills/<slug>/SKILL.md in a project. AGENTS.md also records the host platform and command conventions detected during initialization. The Skill defines technical level, model type, and Pi reasoning level for architecture, development/testing, and documentation/commit work. Existing generated files may be overwritten after confirmation.",
    promptSnippet: "Initialize project context files and an intelligent responsibility-routing Skill",
    promptGuidelines: [
      "Use init_project when the user asks to initialize a project with AI Coding collaboration context.",
      "Before calling init_project, inspect available project metadata and provide description and testCommand when known.",
      "init_project records the current Pi host platform in AGENTS.md; if the target runs in WSL, a container, or a remote environment, mention that difference and update the generated context.",
      "Use init_project with dryRun=true first when the target project may already contain generated files.",
    ],
    parameters: initProjectParameters,
    renderCall(args, theme) {
      const target = typeof args.targetDir === "string" ? args.targetDir : ".";
      return new Text(
        theme.fg("toolTitle", theme.bold("pi-init ")) + theme.fg("muted", `初始化 ${target}`),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as ScaffoldOutcome | undefined;
      if (!details || !Array.isArray(details.files)) return new Text(theme.fg("error", "初始化失败"), 0, 0);
      if (details.cancelled) return new Text(theme.fg("warning", "已取消初始化"), 0, 0);
      const prefix = details.dryRun ? "预览" : "已生成";
      const lines = [
        theme.fg("success", `✓ ${prefix} ${details.files.length} 个文件`),
        details.conflicts.length > 0
          ? theme.fg("warning", `覆盖 ${details.conflicts.length} 个已有文件`)
          : theme.fg("muted", "无文件冲突"),
      ];
      if (expanded) lines.push(...details.files.map((file) => theme.fg("dim", `  ${file}`)));
      return new Text(lines.join("\n"), 0, 0);
    },
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
        roleModels: params.roleModels,
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
    name: "task_workflow",
    label: "Task Workflow",
    description:
      `Manage an architecture-led sequential task workflow with up to ${WORKFLOW_MAX_TASKS} tasks. The Architect creates an ordered plan, Development and Test Engineers complete one task at a time, and the next task starts automatically after verified completion. Pause only for an explicit architecture review or a real blocker.`,
    promptSnippet: "Create and advance an architecture-led sequential implementation task workflow",
    promptGuidelines: [
      "Use task_workflow action=plan only after the Architect has inspected the repository and frozen the plan, constraints, files, dependencies, and acceptance criteria.",
      "The project workflowMode defaults to auto: a valid plan with one or two tasks returns a bypass notice without creating state or scheduling; continue those tasks directly in order. Use on when orchestration is required for a small plan.",
      "Set reviewRequired=true only when the user's initial request explicitly asks to inspect the architecture before implementation; otherwise leave it false so the workflow advances automatically without asking for choices.",
      "Use task_workflow action=complete only after the current task is actually implemented and verified; include real commands and results in verification.",
      "Use task_workflow action=block for missing requirements, permissions, credentials, destructive-operation approval, product decisions, or unrecoverable failures; do not mark an uncertain task complete.",
      "When a task completes, the workflow automatically switches to its assigned role and starts the next ready task. Do not ask the user to choose the next task.",
    ],
    parameters: taskWorkflowParameters,
    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "...";
      const taskCount = Array.isArray(args.tasks) ? ` · ${args.tasks.length} 个任务` : "";
      return new Text(theme.fg("toolTitle", theme.bold("工作流 ")) + theme.fg("muted", `${action}${taskCount}`), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      if (result.isError) return new Text(theme.fg("error", "工作流操作失败"), 0, 0);
      const firstContent = result.content[0];
      const contentText = firstContent?.type === "text" ? firstContent.text : "";
      if (contentText.startsWith("任务完成报告") || contentText.startsWith("工作流完成报告")) {
        return new Text(styleReportText(contentText, theme), 0, 0);
      }

      const details = result.details as ReturnType<typeof createWorkflowState> | undefined;
      if (!details || !Array.isArray(details.tasks)) {
        return new Text(contentText || "工作流已更新", 0, 0);
      }
      const progress = workflowProgress(details);
      const current = progress.currentTaskId ? ` · ${progress.currentTaskId}` : "";
      let text = theme.fg("success", "✓ ") + theme.fg("accent", `工作流 ${progress.completed}/${progress.total}`) + theme.fg("muted", current);
      if (details.status === "paused") text += theme.fg("warning", " · 已暂停");
      if (expanded) text += `\n${details.tasks.map((task) => `  [${task.status}] ${task.id} · ${task.task}`).join("\n")}`;
      return new Text(text, 0, 0);
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return runTaskWorkflowAction(params, signal, ctx);
    },
  });

  pi.registerTool({
    name: "switch_role",
    label: "Switch Role",
    description:
      "Switch the active Pi model and reasoning level for a responsibility. Reads project defaults and current-session overrides; switching never writes .pi/role-models.json. Modes: auto applies immediately, confirm asks before automatic changes, manual requires /pi-init role. Use /pi-init save to explicitly persist staged role configuration. Defaults are architect=openai-codex/gpt-5.6-sol:max, developer-test=openai-codex/gpt-5.6-luna:max, docs-commit=openai-codex/gpt-5.6-luna:medium.",
    promptSnippet: "Switch model and reasoning level for architect, developer-test, or docs-commit work",
    promptGuidelines: [
      "Call switch_role before starting a responsibility selected by the project's role-routing Skill and again at every role boundary.",
      "Use switch_role role=architect for architecture, role=developer-test for implementation and testing, and role=docs-commit for documentation or authorized Git operations.",
      "In manual mode, switch_role does not change models; ask the user to run /pi-init role <role> and retry.",
    ],
    parameters: switchRoleParameters,
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("角色切换 ")) + theme.fg("muted", roleLabel(args.role)), 0, 0);
    },
    renderResult(result, _options, theme) {
      if (result.isError) return new Text(theme.fg("error", "角色切换失败"), 0, 0);
      const details = result.details as { role?: string; model?: string; thinkingLevel?: string } | undefined;
      return new Text(
        theme.fg("success", "✓ ") + theme.fg("accent", roleLabel(details?.role ?? "")) +
          theme.fg("muted", ` · ${shortModelName(details?.model ?? "")}/${details?.thinkingLevel ?? "off"}`),
        0,
        0,
      );
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "角色切换已取消。" }], details: {} };
      }
      const selection = await automaticRole(params.role, ctx);
      const result = selection.result;
      const prefix = selection.requestedRole === result.role ? "已切换到" : `已按确认选择切换到 ${result.role}（建议为 ${selection.requestedRole}）`;
      return {
        content: [
          {
            type: "text",
            text: `${prefix}：${result.provider}/${result.model}，推理强度 ${result.thinkingLevel}，模式 ${selection.mode}`,
          },
        ],
        details: { ...result, mode: selection.mode, requestedRole: selection.requestedRole },
      };
    },
  });
}
