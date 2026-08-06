import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve, basename, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  CONFIG_DIR_NAME,
  withFileMutationQueue,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createScaffold } from "../src/scaffold.js";
import { ROLE_NAMES, resolveRoleModel } from "../src/roles.js";
import {
  isPathAllowed,
  MAX_PARALLEL_DEVELOPERS,
  validateParallelTasks,
} from "../src/parallel.js";

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

function getPiInvocation(args: string[]) {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const executable = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) {
    return { command: process.execPath, args };
  }
  return { command: process.platform === "win32" ? "pi.cmd" : "pi", args };
}

async function runGit(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
) {
  const result = await pi.exec("git", args, { cwd, signal });
  if (result.code !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`git ${args.join(" ")} 失败（退出码 ${result.code}）${output ? `：${output}` : ""}`);
  }
  return result.stdout;
}

function truncateText(value: string, maxBytes = 8000) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = value.slice(0, maxBytes);
  while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
  return `${result}\n\n[输出已截断]`;
}

function parseWorkerOutput(stdout: string) {
  let output = "";
  let errorMessage = "";
  let stopReason = "";

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "error") {
      errorMessage = String(event.errorMessage ?? event.message ?? "子代理返回错误");
    }
    const message = event.type === "message_end" ? event.message : undefined;
    if (message?.role !== "assistant") continue;
    const text = Array.isArray(message.content)
      ? message.content
          .filter((part: { type?: string }): part is { type: "text"; text: string } => part.type === "text")
          .map((part: { text: string }) => part.text)
          .join("")
      : typeof message.content === "string"
        ? message.content
        : "";
    if (text) output = text;
    if (message.errorMessage) errorMessage = String(message.errorMessage);
    if (message.stopReason) stopReason = String(message.stopReason);
  }

  return { output, errorMessage, stopReason };
}

async function runDeveloperWorker(
  pi: ExtensionAPI,
  repoRoot: string,
  base: string,
  tempRoot: string,
  worktree: string,
  plan: string,
  task: { id: string; task: string; files: string[] },
  target: { provider: string; model: string; thinkingLevel: string },
  index: number,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
) {
  const promptPath = join(tempRoot, `worker-${index + 1}.md`);
  await writeFile(
    promptPath,
    [
      "你是并行开发测试工程师。架构师已经完成规划；你只负责下面这个独立工作包。",
      "必须在当前独立 worktree 内实现代码并运行相关测试。不要调用其他代理，不要 git commit，不要 git push。",
      `只能修改以下文件或目录：${task.files.join(", ")}`,
      "如果测试或工具产生了声明范围外的文件，清理它们；不要修改范围外的源码。",
      "完成后用简短文字说明修改内容、测试命令和真实结果。",
      "",
      "## 架构规划",
      plan,
      "",
      `## 工作包 ${task.id}`,
      task.task,
    ].join("\n"),
    "utf8",
  );

  onUpdate?.({
    content: [{ type: "text", text: `已启动 ${task.id}（${target.provider}/${target.model}:${target.thinkingLevel}）` }],
    details: { status: "running", id: task.id },
  });

  const invocation = getPiInvocation([
    "--mode",
    "json",
    "-p",
    "--approve",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--model",
    `${target.provider}/${target.model}`,
    "--thinking",
    target.thinkingLevel,
    "--append-system-prompt",
    promptPath,
    `Task: ${task.task}`,
  ]);
  const child = await pi.exec(invocation.command, invocation.args, { cwd: worktree, signal });
  const parsed = parseWorkerOutput(child.stdout);
  if (child.code !== 0 || child.killed || parsed.errorMessage || parsed.stopReason === "error" || parsed.stopReason === "aborted") {
    const detail = parsed.errorMessage || child.stderr.trim() || parsed.output || "子代理未返回结果";
    throw new Error(`任务 ${task.id} 失败：${detail}`);
  }

  await runGit(pi, worktree, ["add", "--all"], signal);
  const changedFiles = (await runGit(pi, worktree, ["diff", "--name-only", "-z", base], signal))
    .split("\0")
    .filter(Boolean);
  const unauthorized = changedFiles.filter((file) => !isPathAllowed(file, task.files));
  if (unauthorized.length > 0) {
    throw new Error(`任务 ${task.id} 修改了未声明范围：${unauthorized.join(", ")}`);
  }

  return {
    id: task.id,
    output: truncateText(parsed.output || "子代理未提供文字摘要"),
    changedFiles,
    patch: await runGit(pi, worktree, ["diff", "--binary", "--full-index", "--no-ext-diff", base], signal),
  };
}

async function runParallelDevelop(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  planInput: string,
  taskInput: unknown,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
) {
  const plan = planInput.trim();
  if (!plan) throw new Error("parallel_develop 缺少架构规划");
  const tasks = validateParallelTasks(taskInput);
  const target = resolveRoleModel(await readRoleConfig(ctx), "developer-test");
  if (!ctx.modelRegistry.find(target.provider, target.model)) {
    throw new Error(`开发测试职责配置的模型不存在：${target.provider}/${target.model}`);
  }

  const repoRoot = (await runGit(pi, ctx.cwd, ["rev-parse", "--show-toplevel"], signal)).trim();
  const status = await runGit(pi, repoRoot, ["status", "--porcelain", "--untracked-files=all"], signal);
  if (status.trim()) {
    throw new Error("parallel_develop 要求主工作区干净；请先处理现有修改，再启动并行开发");
  }
  const base = (await runGit(pi, repoRoot, ["rev-parse", "HEAD"], signal)).trim();
  const tempRoot = await mkdtemp(join(os.tmpdir(), "pi-init-parallel-"));
  const worktrees: string[] = [];

  try {
    for (let index = 0; index < tasks.length; index += 1) {
      const worktree = join(tempRoot, `worktree-${index + 1}`);
      await runGit(pi, repoRoot, ["worktree", "add", "--detach", worktree, base], signal);
      worktrees.push(worktree);
    }

    const settled = await Promise.allSettled(
      tasks.map((task, index) =>
        runDeveloperWorker(
          pi,
          repoRoot,
          base,
          tempRoot,
          worktrees[index],
          plan,
          task,
          target,
          index,
          signal,
          onUpdate,
        ),
      ),
    );
    const results = settled.map((entry, index) =>
      entry.status === "fulfilled"
        ? { ...entry.value, ok: true as const }
        : { id: tasks[index].id, ok: false as const, error: textOf(entry.reason), changedFiles: [], output: "", patch: "" },
    );
    const failures = results.filter((result) => !result.ok);
    if (failures.length > 0) {
      throw new Error(
        [
          `并行开发失败：${failures.length}/${results.length} 个任务失败`,
          ...failures.map((result) => `- ${result.id}: ${result.error}`),
        ].join("\n"),
      );
    }

    const currentStatus = await runGit(pi, repoRoot, ["status", "--porcelain", "--untracked-files=all"], signal);
    const currentBase = (await runGit(pi, repoRoot, ["rev-parse", "HEAD"], signal)).trim();
    if (currentStatus.trim() || currentBase !== base) {
      throw new Error("主工作区在并行执行期间发生变化，已停止合并");
    }

    const patch = results.map((result) => result.patch).filter(Boolean).join("\n");
    if (patch) {
      const patchPath = join(tempRoot, "combined.patch");
      await writeFile(patchPath, patch, "utf8");
      const check = await pi.exec("git", ["apply", "--check", "--binary", patchPath], {
        cwd: repoRoot,
        signal,
      });
      if (check.code !== 0) {
        throw new Error(`并行修改无法合并：${check.stderr.trim() || check.stdout.trim()}`);
      }
      await runGit(pi, repoRoot, ["apply", "--binary", patchPath], signal);
    }

    return { target, results };
  } finally {
    for (const worktree of worktrees.reverse()) {
      await pi.exec("git", ["worktree", "remove", "--force", worktree], {
        cwd: repoRoot,
        timeout: 10000,
      });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
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
    name: "parallel_develop",
    label: "Parallel Development",
    description:
      `Run ${MAX_PARALLEL_DEVELOPERS} or fewer independent development/test workers concurrently with isolated Git worktrees, using the developer-test role model, then merge their non-overlapping patches into the main worktree. The main worktree must be clean; workers do not commit or push.`,
    promptSnippet: "Run independent development and test work packages concurrently after architecture planning",
    promptGuidelines: [
      "Use parallel_develop only after an architecture plan has split the work into at least two independent packages.",
      "Each parallel_develop task must declare non-overlapping files; keep tasks that touch the same file sequential.",
      "parallel_develop uses isolated worktrees and merges successful patches into the main worktree; inspect the merged diff and run the full test command afterward.",
    ],
    parameters: parallelDevelopParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "并行开发已取消。" }], details: {} };
      }
      const role = await applyRole("developer-test", ctx);
      const result = await runParallelDevelop(pi, ctx, params.plan, params.tasks, signal, onUpdate);
      const lines = [
        `已完成 ${result.results.length} 个并行开发测试任务。`,
        `模型：${role.provider}/${role.model}，推理强度：${role.thinkingLevel}`,
        ...result.results.map(
          (worker) => `- ${worker.id}：${worker.changedFiles.length > 0 ? worker.changedFiles.join(", ") : "无文件修改"}\n  ${worker.output}`,
        ),
        "请检查合并后的 diff，并运行项目完整测试。",
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          role: role.role,
          provider: role.provider,
          model: role.model,
          thinkingLevel: role.thinkingLevel,
          tasks: result.results.map(({ id, changedFiles, output }) => ({ id, changedFiles, output })),
        },
      };
    },
  });

  pi.registerTool({
    name: "switch_role",
    label: "Switch Role",
    description:
      "Switch the active Pi model and reasoning level for a responsibility. Reads trusted project overrides from .pi/role-models.json; defaults are architect=openai-codex/gpt-5.6-sol:max, developer-test=openai-codex/gpt-5.6-luna:max, docs-commit=openai-codex/gpt-5.6-luna:medium.",
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
