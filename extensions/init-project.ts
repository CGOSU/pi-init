import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, basename, dirname, join } from "node:path";
import { getSupportedThinkingLevels, StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  CONFIG_DIR_NAME,
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
  resolveRoleConfig,
} from "../src/roles.js";
import { MAX_PARALLEL_DEVELOPERS } from "../src/parallel.js";
import { runParallelDevelop } from "../src/parallel-runner.js";

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
  description: "要切换的职责：architect、developer-test 或 docs-commit",
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
    throw new Error(`无法读取职责模型配置 ${configPath}：${textOf(error)}`);
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

function formatParallelStatus(update: any) {
  const details = update.details;
  if (!details || typeof details !== "object" || !Array.isArray((details as { tasks?: unknown }).tasks)) {
    return "并行子代理：工作中";
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
  return `并行子代理：${finished}/${tasks.length} 完成 · ${running} 运行${failed > 0 ? ` · ${failed} 失败` : ""}${suffix}`.slice(0, 240);
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

async function selectRoleModel(ctx: ExtensionContext, role: string) {
  const models = getAvailableRoleModels(ctx);
  if (models.length === 0) {
    throw new Error("当前没有可用模型；请先配置模型凭据或调整模型范围");
  }

  const query = await ctx.ui.input(
    `搜索 ${role} 的模型（可留空显示全部）`,
    "provider/model 或模型名称",
  );
  if (query === undefined) return undefined;

  const filteredModels = filterRoleModels(models, query);
  if (filteredModels.length === 0) {
    throw new Error(`没有匹配“${query.trim()}”的模型，请重新执行配置并调整搜索条件`);
  }

  const modelLabels = filteredModels.map((model) => `${model.provider}/${model.id}`);
  const selectedModelLabel = await ctx.ui.select(`为 ${role} 选择模型`, modelLabels);
  if (selectedModelLabel === undefined) return undefined;

  const model = filteredModels.find(
    (candidate) => `${candidate.provider}/${candidate.id}` === selectedModelLabel,
  );
  if (!model) throw new Error(`未知模型选择：${selectedModelLabel}`);

  const supportedThinkingLevels = getSupportedThinkingLevels(model).filter((level) =>
    (THINKING_LEVELS as readonly string[]).includes(level),
  );
  if (supportedThinkingLevels.length === 0) {
    throw new Error(`模型 ${selectedModelLabel} 不支持任何可用的 Pi 推理强度`);
  }

  const thinkingLevel = await ctx.ui.select(
    `为 ${role} 选择推理强度（${selectedModelLabel}）`,
    supportedThinkingLevels,
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
  const roleConfiguration = await ctx.ui.select("职责模型配置", ["使用默认配置", "逐个配置", "取消"]);
  if (roleConfiguration === undefined || roleConfiguration === "取消") return undefined;
  const roleModels = roleConfiguration === "逐个配置" ? await collectRoleModels(ctx) : undefined;
  if (roleConfiguration === "逐个配置" && !roleModels) return undefined;

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
    ...(roleModels ? { roleModels } : {}),
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
  let activeRole: {
    role: string;
    provider: string;
    model: string;
    thinkingLevel: string;
  } | undefined;
  let sessionModeOverride: string | undefined;

  async function applyRole(role: string, ctx: ExtensionContext) {
    const config = resolveRoleConfig(await readRoleConfig(ctx)) as Record<string, RoleModelConfig>;
    const target = config[role];
    if (!target) throw new Error(`未知职责：${role}`);
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
    activeRole = result;
    ctx.ui.setStatus(
      "pi-init-role",
      `${role}: ${target.provider}/${target.model} · ${result.thinkingLevel}`,
    );
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
      throw new Error(`当前为手动模式，请先执行 /role ${role}`);
    }
    return result;
  }

  async function automaticRole(role: string, ctx: ExtensionContext) {
    const configuredMode = (resolveRoleConfig(await readRoleConfig(ctx)) as { mode: string }).mode;
    const mode = sessionModeOverride ?? configuredMode;
    if (mode === "auto") {
      return { mode, requestedRole: role, result: await applyRole(role, ctx) };
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
      throw new Error(`职责切换模式为 confirm，但当前环境无法确认；请先执行 /role ${role} 或 /role-mode auto`);
    }

    const decision = await ctx.ui.select(
      `自动建议切换到 ${role}，请选择`,
      ["采用建议", "切换为手动模式", "取消"],
    );
    if (decision === "采用建议") {
      return { mode, requestedRole: role, result: await applyRole(role, ctx) };
    }
    if (decision === "切换为手动模式") {
      sessionModeOverride = "manual";
      ctx.ui.setStatus("pi-init-mode", "职责模式：manual");
      const selected = await ctx.ui.select("手动选择职责", ROLE_NAMES);
      if (!selected) throw new Error("已取消手动职责选择");
      return {
        mode: "manual",
        requestedRole: role,
        result: await applyRole(selected, ctx),
      };
    }
    throw new Error("已取消职责切换");
  }

  pi.registerCommand("role-mode", {
    description: "设置职责自动切换模式（当前会话临时生效）",
    getArgumentCompletions: (prefix) => {
      const matches = ROLE_MODES.filter((mode) => mode.startsWith(prefix));
      return matches.length > 0 ? matches.map((mode) => ({ value: mode, label: mode })) : null;
    },
    handler: async (args, ctx) => {
      const requested = args.trim();
      const mode = requested || (ctx.hasUI ? await ctx.ui.select("职责切换模式", ROLE_MODES) : undefined);
      if (!mode) return;
      if (!ROLE_MODES.includes(mode)) {
        ctx.ui.notify(`未知职责模式：${mode}；可用值：${ROLE_MODES.join(", ")}`, "error");
        return;
      }
      sessionModeOverride = mode;
      ctx.ui.setStatus("pi-init-mode", `职责模式：${mode}`);
      ctx.ui.notify(`当前会话职责模式已设为 ${mode}`, "info");
    },
  });

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

  pi.registerCommand("role-config", {
    description: "交互配置并立即应用职责对应的模型与推理强度",
    getArgumentCompletions: (prefix) => {
      const matches = ROLE_NAMES.filter((role) => role.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("/role-config 仅允许在受信任项目中运行；请先信任当前项目", "error");
        return;
      }
      const requested = args.trim();
      const role = requested || (ctx.hasUI ? await ctx.ui.select("选择要配置的职责", ROLE_NAMES) : undefined);
      if (!role) {
        ctx.ui.notify("用法：/role-config <architect|developer-test|docs-commit>", "error");
        return;
      }
      if (!ROLE_NAMES.includes(role)) {
        ctx.ui.notify(`未知职责：${role}；可用值：${ROLE_NAMES.join(", ")}`, "error");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/role-config 需要交互式 UI", "error");
        return;
      }

      try {
        const selection = await selectRoleModel(ctx, role);
        if (!selection) {
          ctx.ui.notify("已取消职责配置，没有写入文件。", "warning");
          return;
        }
        await writeRoleConfig(ctx, role, selection);
        const result = await applyRole(role, ctx);
        ctx.ui.notify(
          `已更新并应用 ${result.role}：${result.provider}/${result.model}，推理强度 ${result.thinkingLevel}`,
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

      try {
        const options = await collectOptions(ctx, targetDir);
        if (!options) {
          ctx.ui.notify("已取消项目初始化。", "warning");
          return;
        }
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
      "Generate AGENTS.md, four docs memory files, .pi/role-models.json, and a role-routing .pi/skills/<slug>/SKILL.md in a project. AGENTS.md also records the host platform and command conventions detected during initialization. The Skill defines technical level, model type, and Pi reasoning level for architecture, development/testing, and documentation/commit work. Existing generated files may be overwritten after confirmation.",
    promptSnippet: "Initialize project context files and an intelligent responsibility-routing Skill",
    promptGuidelines: [
      "Use init_project when the user asks to initialize a project with AI Coding collaboration context.",
      "Before calling init_project, inspect available project metadata and provide description and testCommand when known.",
      "init_project records the current Pi host platform in AGENTS.md; if the target runs in WSL, a container, or a remote environment, mention that difference and update the generated context.",
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
        throw new Error("parallel_develop 需要 developer-test 职责；请执行 /role developer-test 后重试");
      }
      const total = params.tasks.length;
      ctx.ui.setStatus("pi-init-parallel", `并行子代理：准备启动 0/${total}`);
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
            ctx.ui.setStatus("pi-init-parallel", `并行子代理：已启动 ${count}/${taskTotal}（${id}）`);
          },
        });
        ctx.ui.setStatus("pi-init-parallel", `并行子代理：已完成 ${result.results.length}/${total}`);
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
        ctx.ui.setStatus("pi-init-parallel", "并行子代理：失败，等待主开发测试工程师接管");
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "switch_role",
    label: "Switch Role",
    description:
      "Switch the active Pi model and reasoning level for a responsibility. Reads the mode and trusted project overrides from .pi/role-models.json. Modes: auto applies immediately, confirm asks before automatic changes, manual requires /role. Defaults are architect=openai-codex/gpt-5.6-sol:max, developer-test=openai-codex/gpt-5.6-luna:max, docs-commit=openai-codex/gpt-5.6-luna:medium.",
    promptSnippet: "Switch model and reasoning level for architect, developer-test, or docs-commit work",
    promptGuidelines: [
      "Call switch_role before starting a responsibility selected by the project's role-routing Skill and again at every role boundary.",
      "Use switch_role role=architect for architecture, role=developer-test for implementation and testing, and role=docs-commit for documentation or authorized Git operations.",
      "In manual mode, switch_role does not change models; ask the user to run /role <role> and retry.",
    ],
    parameters: switchRoleParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "职责切换已取消。" }], details: {} };
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
