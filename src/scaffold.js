import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRoleConfig } from "./roles.js";
import {
  createTemplateState,
  FAST_PATH_BLOCK,
  findLegacyBlock,
  findManagedBlock,
  hashText,
  managedBlockBody,
  parseTemplateState,
  replaceBlock,
  replaceManagedBlock,
  TEMPLATE_STATE_PATH,
} from "./template-sync.js";

const TEMPLATE_ROOT = fileURLToPath(new URL("../templates/", import.meta.url));
const SUPPORTED_LANGUAGES = new Set(["zh-CN", "en"]);
const PLATFORM_NAMES = {
  aix: "AIX",
  android: "Android",
  darwin: "macOS",
  freebsd: "FreeBSD",
  haiku: "Haiku",
  linux: "Linux",
  openbsd: "OpenBSD",
  sunos: "SunOS",
  win32: "Windows",
};

const TEMPLATE_FILES = [
  ["AGENTS.md", () => "AGENTS.md"],
  ["docs/clean-code.md", () => "docs/clean-code.md"],
  ["docs/current-state.md", () => "docs/current-state.md"],
  ["docs/decisions.md", () => "docs/decisions.md"],
  ["docs/session-log.md", () => "docs/session-log.md"],
  ["docs/pitfalls.md", () => "docs/pitfalls.md"],
];

function validateSingleLine(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label}必须是文本`);
  }
  const normalized = value.trim();
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new Error(`${label}不能为空或包含换行符`);
  }
  return normalized;
}

function validateProjectName(value) {
  return validateSingleLine(value, "项目名称");
}

function resolveLanguage(value = "zh-CN") {
  if (!SUPPORTED_LANGUAGES.has(value)) {
    throw new Error("模板语言仅支持 zh-CN 或 en");
  }
  return value;
}

export function formatEnvironmentInstructions(
  language = "zh-CN",
  { platform = process.platform, arch = process.arch } = {},
) {
  const platformName = PLATFORM_NAMES[platform] ?? platform;
  const host =
    language === "en"
      ? `${platformName} (\`${platform}\`), CPU architecture: \`${arch}\``
      : `${platformName} (\`${platform}\`)，CPU 架构：\`${arch}\``;
  const commandGuidance =
    platform === "win32"
      ? language === "en"
        ? [
            "- Pi's built-in `bash` tool normally runs through Bash on Windows; extensions using `pi.exec` start processes directly and do not pass through Bash.",
            "- Prefer `where.exe` or the current shell's `command -v` for command discovery; do not use Linux-only `which` as the only check.",
            "- npm global CLIs may be exposed through a Windows `.cmd` shim; choose the platform-appropriate executable entry when spawning them directly.",
            "- If a tool reports a CLI as missing, verify it with `where.exe <command>` (and its `.cmd` shim) before installing anything.",
          ]
        : [
            "- Pi 的内置 `bash` 工具在 Windows 上通常通过 Bash 执行；扩展使用 `pi.exec` 时是直接启动进程，不会经过 Bash。",
            "- 查找命令优先使用 `where.exe` 或当前 shell 支持的 `command -v`；不要把 Linux-only 的 `which` 作为唯一检查。",
            "- npm 全局 CLI 可能通过 Windows `.cmd` shim 暴露；直接启动时要选择当前平台可用的执行入口。",
            "- 如果工具提示 CLI 不存在，先用 `where.exe <command>`（以及对应的 `.cmd` shim）核实，再决定是否安装。",
          ]
      : language === "en"
        ? [
            "- Use commands supported by the current shell and project toolchain; do not assume a different operating system, shell, or package manager.",
            "- Use the current shell's standard command-discovery mechanism (usually `command -v` on POSIX shells); do not hard-code executable paths.",
          ]
        : [
            "- 使用当前 shell 和项目工具链支持的命令；不要假定另一种操作系统、shell 或包管理器。",
            "- 使用当前 shell 的标准方式查找命令（POSIX shell 通常为 `command -v`）；不要硬编码可执行文件路径。",
          ];

  if (language === "en") {
    return [
      `- Host platform detected at initialization: ${host}.`,
      "- This is a snapshot of the Pi host, not necessarily the project's deployment target; if execution moves to WSL, a container, a remote host, or another environment, re-detect and follow that environment.",
      ...commandGuidance,
    ].join("\n");
  }

  return [
    `- 初始化时检测到的宿主系统：${host}。`,
    "- 这是运行 Pi 的宿主环境快照，不一定是项目部署目标；如果实际执行发生在 WSL、容器、远程主机或其他环境中，应重新检测并以当前环境为准。",
    ...commandGuidance,
  ].join("\n");
}

function escapeInlineCode(value) {
  return value.replace(/`/g, "\\`");
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function renderTemplate(source, variables, templatePath) {
  return source.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in variables)) {
      throw new Error(`模板 ${templatePath} 使用了未知变量：${key}`);
    }
    return variables[key];
  });
}

async function renderTemplateFiles(absoluteTarget, language, variables) {
  return Promise.all(
    TEMPLATE_FILES.map(async ([templatePath, outputPath, localize = true]) => {
      const localizedTemplatePath = language === "en" && localize ? path.join("en", templatePath) : templatePath;
      const source = await readFile(path.join(TEMPLATE_ROOT, localizedTemplatePath), "utf8");
      const relativePath = outputPath();
      return {
        relativePath,
        absolutePath: path.join(absoluteTarget, relativePath),
        content: renderTemplate(source, variables, templatePath),
      };
    }),
  );
}

async function readOptionalText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function buildTemplateStateFile(absoluteTarget, language, files) {
  const agents = files.find((file) => file.relativePath === FAST_PATH_BLOCK.file);
  const managed = agents && findManagedBlock(agents.content, FAST_PATH_BLOCK);
  if (!managed || managed.kind !== "managed") {
    throw new Error("AGENTS.md 模板缺少可同步的 Fast Path 托管区块");
  }
  const state = createTemplateState(language, {
    [FAST_PATH_BLOCK.id]: {
      file: FAST_PATH_BLOCK.file,
      hash: hashText(managed.content),
    },
  });
  return {
    relativePath: TEMPLATE_STATE_PATH,
    absolutePath: path.join(absoluteTarget, TEMPLATE_STATE_PATH),
    content: `${JSON.stringify(state, null, 2)}\n`,
  };
}

function conflict(pathname, code, message) {
  return { path: pathname, code, message };
}

function resolveSyncLanguage(options, state, agents) {
  if (options.language !== undefined) return resolveLanguage(options.language);
  if (state?.language && SUPPORTED_LANGUAGES.has(state.language)) return state.language;
  if (agents?.includes(FAST_PATH_BLOCK.sectionEnd.en)) return "en";
  return "zh-CN";
}

/**
 * Generate the long-term AI collaboration files for a project.
 * Existing generated files are intentionally overwritten; unrelated files are untouched.
 */
export async function createScaffold(targetDir, options = {}) {
  const absoluteTarget = path.resolve(targetDir);

  if (await pathExists(absoluteTarget)) {
    const targetStat = await stat(absoluteTarget);
    if (!targetStat.isDirectory()) {
      throw new Error(`目标路径不是目录：${absoluteTarget}`);
    }
  }

  const inferredName = path.basename(absoluteTarget);
  const projectName = validateProjectName(options.projectName ?? inferredName);
  const language = resolveLanguage(options.language);
  const projectDescription = options.description
    ? validateSingleLine(options.description, "项目描述")
    : language === "en"
      ? "To be completed by the project maintainer."
      : "待项目维护者补充。";
  const testCommand = options.testCommand
    ? validateSingleLine(options.testCommand, "测试命令")
    : language === "en"
      ? "To be completed by the project maintainer."
      : "待项目维护者补充。";
  const roleConfig = resolveRoleConfig(options.roleModels);
  const variables = {
    PROJECT_NAME: projectName,
    PROJECT_DESCRIPTION: projectDescription,
    TEST_COMMAND: escapeInlineCode(testCommand),
    ENVIRONMENT_CONTEXT: formatEnvironmentInstructions(language),
  };

  const files = await renderTemplateFiles(absoluteTarget, language, variables);
  const roleConfigPath = ".pi/role-models.json";
  files.push({
    relativePath: roleConfigPath,
    absolutePath: path.join(absoluteTarget, roleConfigPath),
    content: `${JSON.stringify(roleConfig, null, 2)}\n`,
  });
  files.push(buildTemplateStateFile(absoluteTarget, language, files));

  const conflicts = [];
  for (const file of files) {
    if (await pathExists(file.absolutePath)) {
      conflicts.push(file.relativePath);
    }
  }

  if (!options.dryRun) {
    for (const file of files) {
      await mkdir(path.dirname(file.absolutePath), { recursive: true });
      await writeFile(file.absolutePath, file.content, "utf8");
    }
  }

  return {
    targetDir: absoluteTarget,
    projectName,
    language,
    dryRun: options.dryRun === true,
    conflicts,
    files: files.map((file) => file.relativePath),
  };
}

function syncAgentsBlock(current, desired, language, state) {
  const desiredMatch = findManagedBlock(desired, FAST_PATH_BLOCK);
  if (!desiredMatch || desiredMatch.kind !== "managed") {
    throw new Error("当前模板缺少可同步的 Fast Path 托管区块");
  }

  const stateEntry = state?.managedBlocks?.[FAST_PATH_BLOCK.id];
  const currentMatch = findManagedBlock(current, FAST_PATH_BLOCK);
  if (currentMatch.kind === "invalid") {
    return { conflict: conflict("AGENTS.md", currentMatch.code, "现有 AGENTS.md 的托管区块标记不完整或重复") };
  }
  if (currentMatch.kind === "managed") {
    if (stateEntry?.hash && hashText(currentMatch.content) !== stateEntry.hash) {
      return {
        conflict: conflict(
          "AGENTS.md",
          "MANAGED_BLOCK_MODIFIED",
          "现有 Fast Path 托管区块已被本地修改，未自动覆盖",
        ),
      };
    }
    if (!stateEntry && hashText(currentMatch.content) !== hashText(desiredMatch.content)) {
      return {
        conflict: conflict(
          "AGENTS.md",
          "MANAGED_BLOCK_BASELINE_MISSING",
          "缺少同步基线且现有 Fast Path 托管区块与当前模板不同",
        ),
      };
    }
    if (hashText(currentMatch.content) === hashText(desiredMatch.content)) {
      return { content: current, action: "preserved" };
    }
    return {
      content: replaceManagedBlock(current, currentMatch, desiredMatch.content),
      action: "updated",
    };
  }

  if (stateEntry) {
    return {
      conflict: conflict(
        "AGENTS.md",
        "MANAGED_BLOCK_MISSING",
        "同步状态记录了 Fast Path 托管区块，但现有 AGENTS.md 中未找到该区块",
      ),
    };
  }

  const legacyMatch = findLegacyBlock(current, language, FAST_PATH_BLOCK);
  if (legacyMatch.kind === "invalid") {
    return { conflict: conflict("AGENTS.md", legacyMatch.code, "旧版 Fast Path 区块缺少结束标题") };
  }
  if (legacyMatch.kind === "legacy") {
    if (managedBlockBody(legacyMatch.content, FAST_PATH_BLOCK) !== managedBlockBody(desiredMatch.content, FAST_PATH_BLOCK)) {
      return {
        conflict: conflict(
          "AGENTS.md",
          "LEGACY_BLOCK_MODIFIED",
          "旧版 Fast Path 区块已被本地修改，未自动覆盖",
        ),
      };
    }
    return {
      content: replaceBlock(current, legacyMatch.start, legacyMatch.end, `${desiredMatch.content}\n`),
      action: "updated",
    };
  }

  const anchor = FAST_PATH_BLOCK.sectionEnd[language];
  const anchorIndex = current.indexOf(anchor);
  if (anchorIndex < 0) {
    return {
      conflict: conflict(
        "AGENTS.md",
        "SESSION_WRAP_UP_ANCHOR_MISSING",
        "无法在现有 AGENTS.md 中定位会话收尾章节，未自动插入 Fast Path 区块",
      ),
    };
  }
  return {
    content: replaceBlock(current, anchorIndex, anchorIndex, `${desiredMatch.content}\n`),
    action: "updated",
  };
}

/**
 * Synchronize managed template sections without overwriting project memory or role configuration.
 * Existing files are preserved unless they contain an unmodified managed section.
 */
export async function syncScaffold(targetDir, options = {}) {
  const absoluteTarget = path.resolve(targetDir);
  if (!(await pathExists(absoluteTarget))) {
    throw new Error(`同步目标目录不存在：${absoluteTarget}`);
  }
  const targetStat = await stat(absoluteTarget);
  if (!targetStat.isDirectory()) {
    throw new Error(`目标路径不是目录：${absoluteTarget}`);
  }

  const statePath = path.join(absoluteTarget, TEMPLATE_STATE_PATH);
  const stateText = await readOptionalText(statePath);
  let state;
  const conflicts = [];
  if (stateText !== undefined) {
    const parsedState = parseTemplateState(stateText);
    if (!parsedState.ok) {
      conflicts.push(conflict(TEMPLATE_STATE_PATH, parsedState.code, parsedState.message));
    } else {
      state = parsedState.value;
    }
  }

  const currentAgents = await readOptionalText(path.join(absoluteTarget, FAST_PATH_BLOCK.file));
  const language = resolveSyncLanguage(options, state, currentAgents);
  const projectName = validateProjectName(options.projectName ?? path.basename(absoluteTarget));
  const projectDescription = options.description
    ? validateSingleLine(options.description, "项目描述")
    : language === "en"
      ? "To be completed by the project maintainer."
      : "待项目维护者补充。";
  const testCommand = options.testCommand
    ? validateSingleLine(options.testCommand, "测试命令")
    : language === "en"
      ? "To be completed by the project maintainer."
      : "待项目维护者补充。";
  const variables = {
    PROJECT_NAME: projectName,
    PROJECT_DESCRIPTION: projectDescription,
    TEST_COMMAND: escapeInlineCode(testCommand),
    ENVIRONMENT_CONTEXT: formatEnvironmentInstructions(language),
  };
  const renderedFiles = await renderTemplateFiles(absoluteTarget, language, variables);
  const created = [];
  const updated = [];
  const preserved = [];
  const writes = [];

  if (currentAgents === undefined) {
    const agents = renderedFiles.find((file) => file.relativePath === FAST_PATH_BLOCK.file);
    writes.push(agents);
    created.push(FAST_PATH_BLOCK.file);
  } else {
    const agents = renderedFiles.find((file) => file.relativePath === FAST_PATH_BLOCK.file);
    const result = syncAgentsBlock(currentAgents, agents.content, language, state);
    if (result.conflict) conflicts.push(result.conflict);
    else if (result.action === "updated") {
      writes.push({ ...agents, content: result.content });
      updated.push(FAST_PATH_BLOCK.file);
    } else preserved.push(FAST_PATH_BLOCK.file);
  }

  for (const file of renderedFiles) {
    if (file.relativePath === FAST_PATH_BLOCK.file) continue;
    if (await pathExists(file.absolutePath)) preserved.push(file.relativePath);
    else {
      writes.push(file);
      created.push(file.relativePath);
    }
  }

  const agentsContent = currentAgents ?? renderedFiles.find((file) => file.relativePath === FAST_PATH_BLOCK.file).content;
  const desiredMatch = findManagedBlock(
    currentAgents === undefined ? agentsContent : renderedFiles.find((file) => file.relativePath === FAST_PATH_BLOCK.file).content,
    FAST_PATH_BLOCK,
  );
  const nextState = createTemplateState(language, {
    [FAST_PATH_BLOCK.id]: {
      file: FAST_PATH_BLOCK.file,
      hash: hashText(desiredMatch.content),
    },
  });
  const nextStateContent = `${JSON.stringify(nextState, null, 2)}\n`;
  if (stateText === undefined) {
    writes.push({ relativePath: TEMPLATE_STATE_PATH, absolutePath: statePath, content: nextStateContent });
    created.push(TEMPLATE_STATE_PATH);
  } else if (state && stateText !== nextStateContent) {
    writes.push({ relativePath: TEMPLATE_STATE_PATH, absolutePath: statePath, content: nextStateContent });
    updated.push(TEMPLATE_STATE_PATH);
  } else if (stateText !== undefined) {
    preserved.push(TEMPLATE_STATE_PATH);
  }

  const dryRun = options.dryRun === true;
  if (conflicts.length === 0 && !dryRun) {
    for (const file of writes) {
      await mkdir(path.dirname(file.absolutePath), { recursive: true });
      await writeFile(file.absolutePath, file.content, "utf8");
    }
  }

  return {
    targetDir: absoluteTarget,
    projectName,
    language,
    dryRun,
    changed: conflicts.length === 0 && writes.length > 0,
    created,
    updated,
    preserved,
    conflicts,
  };
}
