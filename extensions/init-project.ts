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
  filterRoleModels,
  findMatchingRole,
  resolveRoleConfig,
  roleLabel,
  roleModeLabel,
  shouldCompactOnRoleSwitch,
} from "../src/roles.js";
import { MAX_PARALLEL_DEVELOPERS } from "../src/parallel.js";
import { runParallelDevelop } from "../src/parallel-runner.js";
import { Box, Container, Input, Key, matchesKey, SelectList, Spacer, Text, type SelectItem } from "@earendil-works/pi-tui";

const roleModelSchema = Type.Object({
  provider: Type.String({ description: "模型提供商 ID" }),
  model: Type.String({ description: "模型 ID" }),
  thinkingLevel: StringEnum(THINKING_LEVELS, {
    description: "Pi 推理强度",
  }),
});
const roleModelsSchema = Type.Object({
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
const parallelTaskSchema = Type.Object({
  id: Type.String({ description: "唯一任务 ID" }),
  task: Type.String({ description: "开发测试任务和验收要求" }),
  files: Type.Array(Type.String(), {
    minItems: 1,
    description: "允许修改的项目内文件或目录；不同任务不能重叠",
  }),
});
const parallelDevelopParameters = Type.Object({
  plan: Type.String({ description: "架构师完成的规划、约束和验收标准" }),
  tasks: Type.Array(parallelTaskSchema, {
    minItems: 2,
    maxItems: MAX_PARALLEL_DEVELOPERS,
    description: `并行开发任务，最多 ${MAX_PARALLEL_DEVELOPERS} 个`,
  }),
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

function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
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

function formatParallelStatus(update: any) {
  const details = update.details;
  if (!details || typeof details !== "object" || !Array.isArray((details as { tasks?: unknown }).tasks)) {
    return "● 并行开发 · 工作中";
  }

  const tasks = (details as {
    tasks: Array<{ id: string; status: string; current?: string; elapsedMs?: number }>;
  }).tasks;
  const terminal = new Set(["completed", "failed", "cancelled"]);
  const finished = tasks.filter((task) => terminal.has(task.status)).length;
  const running = tasks.length - finished;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const active = tasks.find((task) => !terminal.has(task.status));
  const suffix = active ? ` · ${active.id}: ${active.current ?? active.status}` : "";
  return `● 并行开发 · ${finished}/${tasks.length} 完成 · ${running} 运行${failed > 0 ? ` · ${failed} 失败` : ""}${suffix}`.slice(0, 180);
}

type RoleModelConfig = {
  provider: string;
  model: string;
  thinkingLevel: string;
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

function roleMenuItems(config: Record<string, RoleModelConfig>, mode: string) {
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
    { value: "back", label: "← 返回上一级", description: "不修改其他设置" },
  ];
}

async function writeRoleConfig(
  ctx: ExtensionContext,
  role: string,
  selection: RoleModelConfig,
) {
  const configPath = resolve(ctx.cwd, CONFIG_DIR_NAME, "role-models.json");
  return withFileMutationQueue(configPath, async () => {
    const current = resolveRoleConfig(await readRoleConfig(ctx)) as Record<string, unknown>;
    const next = resolveRoleConfig({ ...current, [role]: selection });
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  });
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
  const roleModels = roleConfiguration === "custom" ? await collectRoleModels(ctx) : undefined;
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
  let controlCenterGuideShown = false;
  let pendingRoleCompaction: { fromRole: string; toRole: string } | undefined;
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

  function setRoleStatus(ctx: ExtensionContext, mode: string) {
    const role = activeRoleFor(ctx);
    const model = ctx.model
      ? `${shortModelName(ctx.model.id)}/${pi.getThinkingLevel()}`
      : "未选择模型";
    ctx.ui.setStatus(
      "pi-init",
      `● ${roleModeLabel(mode)} · ${role ? `${roleLabel(role.role)} · ` : ""}${model}`,
    );
  }

  function startPendingRoleCompaction(ctx: ExtensionContext) {
    if (!pendingRoleCompaction || roleCompactionInFlight) return;

    const transition = pendingRoleCompaction;
    pendingRoleCompaction = undefined;
    roleCompactionInFlight = true;
    ctx.ui.setStatus("pi-init-compaction", "● 角色切换 · 正在压缩上下文");
    ctx.compact({
      customInstructions: ROLE_SWITCH_COMPACTION_INSTRUCTIONS,
      onComplete: () => {
        roleCompactionInFlight = false;
        ctx.ui.setStatus("pi-init-compaction", undefined);
        try {
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
          ctx.ui.notify(`上下文压缩已完成，但无法自动继续：${textOf(error)}`, "warning");
        }
      },
      onError: (error) => {
        roleCompactionInFlight = false;
        ctx.ui.setStatus("pi-init-compaction", undefined);
        ctx.ui.notify(`角色切换后的上下文压缩失败：${error.message}`, "warning");
      },
    });
  }

  async function applyRole(role: string, ctx: ExtensionContext) {
    const config = resolveRoleConfig(await readRoleConfig(ctx)) as Record<string, RoleModelConfig> & { mode: string };
    const target = config[role];
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
    const configuredMode = (resolveRoleConfig(await readRoleConfig(ctx)) as { mode: string }).mode;
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
      if (compactAfterSwitch && previousRole) {
        pendingRoleCompaction = { fromRole: previousRole, toRole: result.role };
      }
      return { mode, requestedRole: role, result };
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

  async function setSessionMode(requested: string | undefined, ctx: ExtensionCommandContext) {
    const mode = requested || await showMenu(
      ctx,
      "角色切换模式",
      ROLE_MODES.map((value) => ({
        value,
        label: roleModeLabel(value),
        description: value === "auto" ? "按任务自动选择角色和模型" : undefined,
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

  async function configureRole(requested: string | undefined, ctx: ExtensionCommandContext) {
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
      const selection = await selectRoleModel(ctx, role);
      if (!selection) {
        ctx.ui.notify("已取消角色配置，没有写入文件。", "warning");
        return;
      }
      await writeRoleConfig(ctx, role, selection);
      const result = await applyRole(role, ctx);
      ctx.ui.notify(
        `已更新 ${roleLabel(result.role)}：${shortModelName(result.model)}/${result.thinkingLevel}`,
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

    let config = resolveRoleConfig(await readRoleConfig(ctx)) as Record<string, RoleModelConfig> & { mode: string };
    while (true) {
      const mode = sessionModeOverride ?? config.mode;
      const action = await showMenu(ctx, "角色与模型", roleMenuItems(config, mode));
      if (!action || action === "back") return;
      if (action === "mode") {
        await setSessionMode(undefined, ctx);
        continue;
      }
      await configureRole(action, ctx);
      config = resolveRoleConfig(await readRoleConfig(ctx)) as Record<string, RoleModelConfig> & { mode: string };
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
    while (true) {
      const config = resolveRoleConfig(await readRoleConfig(ctx)) as Record<string, RoleModelConfig> & { mode: string };
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
      ];
      if (showGuide) summary.push("", "快速初始化适合大多数项目；高级初始化可修改全部配置。");
      const action = await showMenu(ctx, "Pi Init 控制中心", [
        { value: "quick", label: "◆ 初始化 · 快速初始化当前项目", description: "自动读取项目元数据，只确认一次" },
        { value: "advanced", label: "◆ 初始化 · 高级初始化", description: "编辑项目名称、语言、测试命令和 Skill" },
        { value: "config", label: "◆ 变更 · 角色与模型", description: "查看或修改三个角色的模型配置" },
        { value: "role", label: "◆ 变更 · 切换角色", description: "立即应用某个角色的模型和推理强度" },
        { value: "mode", label: `◆ 变更 · 切换模式：${roleModeLabel(mode)}`, description: "只影响当前会话" },
        { value: "exit", label: "← 返回" },
      ], { summary });
      if (!action || action === "exit") return;
      if (action === "quick") return quickInit(".", ctx);
      if (action === "advanced") return advancedInit(".", ctx);
      if (action === "config") {
        await configureRoleCenter(ctx);
        continue;
      }
      if (action === "role") {
        await switchRole(undefined, ctx);
        continue;
      }
      if (action === "mode") {
        await setSessionMode(undefined, ctx);
      }
    }
  }

  pi.on("agent_settled", (_event, ctx) => {
    startPendingRoleCompaction(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const config = resolveRoleConfig(await readRoleConfig(ctx)) as Record<string, RoleModelConfig> & { mode: string };
      const role = findMatchingRole(config, ctx.model, pi.getThinkingLevel());
      activeRole = role && ctx.model
        ? {
            role,
            provider: ctx.model.provider,
            model: ctx.model.id,
            thinkingLevel: pi.getThinkingLevel(),
          }
        : undefined;
      setRoleStatus(ctx, sessionModeOverride ?? config.mode);
    } catch (error) {
      ctx.ui.notify(textOf(error), "error");
    }
  });

  pi.registerCommand("pi-init", {
    description: "打开 Pi Init 控制中心：初始化项目、配置角色和切换模型",
    getArgumentCompletions: (prefix) => {
      const tokens = prefix.trim().split(/\s+/).filter(Boolean);
      if (tokens.length <= 1 && !prefix.endsWith(" ")) {
        const values = ["init", "advanced", "config", "role", "mode"];
        const matches = values.filter((value) => value.startsWith(tokens[0] ?? ""));
        return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
      }
      const action = tokens[0];
      const values = action === "role" || action === "config" ? ROLE_NAMES : action === "mode" ? ROLE_MODES : [];
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
        if (action === "role") return switchRole(tokens[0], ctx);
        if (action === "mode") return setSessionMode(tokens[0], ctx);
        ctx.ui.notify("用法：/pi-init [init|advanced|config|role|mode] [参数]", "error");
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
    name: "parallel_develop",
    label: "Parallel Development",
    description:
      `Run ${MAX_PARALLEL_DEVELOPERS} or fewer independent development/test workers with isolated Git worktrees, using the active developer-test role model; two workers run concurrently by default, then successful non-overlapping patches are merged into the main worktree. Only run in trusted projects; the main worktree must be clean, and workers do not commit or push.`,
    promptSnippet: "Run independent development and test work packages concurrently after architecture planning",
    promptGuidelines: [
      "Use parallel_develop only after an architecture plan has split the work into at least two truly independent, contract-frozen packages that are large enough to run for a while; use one worker for small or semantically coupled work.",
      "Each parallel_develop task must declare non-overlapping files; non-overlapping files are not sufficient when tasks share a DOM, API, or test contract. The runner accepts up to four tasks and defaults to two concurrent workers.",
      "parallel_develop runs only in trusted projects, uses isolated worktrees, throttles high-frequency progress updates, retries transient transport failures such as terminated once, and merges successful patches into the main worktree; inspect the metrics and merged diff, then run the full test command afterward.",
    ],
    parameters: parallelDevelopParameters,
    renderCall(args, theme) {
      const count = Array.isArray(args.tasks) ? args.tasks.length : 0;
      return new Text(
        theme.fg("toolTitle", theme.bold("并行开发 ")) + theme.fg("muted", `${count} 个工作包`),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as {
        results?: Array<{ id: string; changedFiles?: string[]; metrics?: { elapsedMs?: number } }>;
        metrics?: { totalMs?: number };
      } | undefined;
      if (result.isError) return new Text(theme.fg("error", "并行开发失败，请由主开发测试工程师接管"), 0, 0);
      const results = details?.results ?? [];
      const changedFiles = results.reduce((count, worker) => count + (worker.changedFiles?.length ?? 0), 0);
      const lines = [
        theme.fg("success", `✓ ${results.length} 个工作包完成`),
        theme.fg("muted", `${changedFiles} 个文件 · ${formatElapsed(details?.metrics?.totalMs ?? 0)}`),
      ];
      if (expanded) {
        lines.push(
          ...results.map((worker) =>
            theme.fg("dim", `  ${worker.id} · ${worker.changedFiles?.join(", ") || "无文件修改"}`),
          ),
        );
      }
      return new Text(lines.join("\n"), 0, 0);
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "并行开发已取消。" }], details: {} };
      }
      if (!ctx.isProjectTrusted()) {
        throw new Error("parallel_develop 仅允许在受信任项目中运行；请先信任当前项目");
      }
      const selection = await automaticRole("developer-test", ctx);
      const role = selection.result;
      if (role.role !== "developer-test") {
        throw new Error("parallel_develop 需要开发测试角色；请执行 /pi-init role developer-test 后重试");
      }
      const total = params.tasks.length;
      ctx.ui.setStatus("pi-init-parallel", `并行开发 · 准备启动 0/${total}`);
      const reportUpdate = (update: any) => {
        ctx.ui.setStatus("pi-init-parallel", formatParallelStatus(update));
        onUpdate?.(update);
      };

      try {
        const result = await runParallelDevelop({
          exec: pi.exec.bind(pi),
          cwd: ctx.cwd,
          planInput: params.plan,
          taskInput: params.tasks,
          target: {
            provider: role.provider,
            model: role.model,
            thinkingLevel: role.thinkingLevel,
          },
          signal,
          onUpdate: reportUpdate,
          onStarted: ({ started: count, total: taskTotal, id }: { started: number; total: number; id: string }) => {
            ctx.ui.setStatus("pi-init-parallel", `并行开发 · 已启动 ${count}/${taskTotal}（${id}）`);
          },
        });
        ctx.ui.setStatus("pi-init-parallel", `并行开发 · 已完成 ${result.results.length}/${total}`);
        const lines = [
          `已启动并完成 ${result.results.length}/${total} 个并行开发测试任务。`,
          `模型：${role.provider}/${role.model}，推理强度：${role.thinkingLevel}`,
          ...result.results.map(
            (worker) =>
              `- ${worker.id}：${worker.changedFiles.length > 0 ? worker.changedFiles.join(", ") : "无文件修改"}` +
              `（${formatElapsed(worker.metrics?.elapsedMs ?? 0)}，${worker.metrics?.turns ?? 0} turns，` +
              `${worker.metrics?.totalTokens ?? 0} tokens，自动重试 ${worker.metrics?.autoRetries ?? 0} 次）\n  ${worker.output}`,
          ),
          `阶段耗时：准备 ${formatElapsed(result.metrics?.setupMs ?? 0)} · worker ${formatElapsed(result.metrics?.workersMs ?? 0)} · 合并 ${formatElapsed(result.metrics?.mergeMs ?? 0)}`,
          "请检查合并后的 diff，并运行项目完整测试。",
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            role: role.role,
            mode: selection.mode,
            provider: role.provider,
            model: role.model,
            thinkingLevel: role.thinkingLevel,
            tasks: result.tasks,
            metrics: result.metrics,
            results: result.results.map(({ id, changedFiles, output, metrics }) => ({
              id,
              changedFiles,
              output,
              metrics,
            })),
          },
        };
      } catch (error) {
        ctx.ui.setStatus("pi-init-parallel", "并行开发 · 失败，等待主开发测试工程师接管");
        throw error;
      } finally {
        ctx.ui.setStatus("pi-init-parallel", undefined);
      }
    },
  });

  pi.registerTool({
    name: "switch_role",
    label: "Switch Role",
    description:
      "Switch the active Pi model and reasoning level for a responsibility. Reads the mode and trusted project overrides from .pi/role-models.json. Modes: auto applies immediately, confirm asks before automatic changes, manual requires /pi-init role. Defaults are architect=openai-codex/gpt-5.6-sol:max, developer-test=openai-codex/gpt-5.6-luna:max, docs-commit=openai-codex/gpt-5.6-luna:medium.",
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
