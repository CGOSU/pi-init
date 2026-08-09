import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRoleConfig } from "./roles.js";

const TEMPLATE_ROOT = fileURLToPath(new URL("../templates/", import.meta.url));
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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
  ["SKILL.md", ({ projectSlug }) => `.pi/skills/${projectSlug}/SKILL.md`],
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

export function slugify(value) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function validateProjectName(value) {
  return validateSingleLine(value, "项目名称");
}

function validateProjectSlug(value) {
  if (typeof value !== "string" || !SKILL_NAME_PATTERN.test(value) || value.length > 64) {
    throw new Error(
      "Skill 名称必须是最长 64 位的小写字母、数字和单个连字符组合；请显式指定 slug",
    );
  }
  return value;
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

/**
 * Generate the seven long-term AI collaboration files for a project.
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
  const projectSlug = validateProjectSlug(options.slug ?? slugify(projectName));
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
  const skillDescription = options.description
    ? language === "en"
      ? `Use when modifying, debugging, testing, maintaining documentation, updating versions, or wrapping up delivery for ${projectName}; automatically route work and switch models among Architect, Development and Test Engineer, and Documentation and Wrap-up Engineer roles with explicit technical level, model type, and Pi reasoning level. Project purpose: ${projectDescription}`
      : `处理 ${projectName} 的代码修改、调试、测试、文档维护、版本号更新或交付收尾时使用；根据任务在架构师、开发测试工程师、文档与收尾工程师之间智能分配职责并自动切换模型，同时指定技术水平、模型类型和 Pi 推理强度。项目定位：${projectDescription}`
    : language === "en"
      ? `Use when modifying, debugging, testing, maintaining documentation, updating versions, or wrapping up delivery for ${projectName}; automatically route work and switch models among Architect, Development and Test Engineer, and Documentation and Wrap-up Engineer roles with explicit technical level, model type, and Pi reasoning level.`
      : `处理 ${projectName} 的代码修改、调试、测试、文档维护、版本号更新或交付收尾时使用；根据任务在架构师、开发测试工程师、文档与收尾工程师之间智能分配职责并自动切换模型，同时指定技术水平、模型类型和 Pi 推理强度。`;
  const roleConfig = resolveRoleConfig(options.roleModels);
  const variables = {
    PROJECT_NAME: projectName,
    PROJECT_SLUG: projectSlug,
    PROJECT_DESCRIPTION: projectDescription,
    SKILL_DESCRIPTION: JSON.stringify(skillDescription),
    TEST_COMMAND: escapeInlineCode(testCommand),
    ENVIRONMENT_CONTEXT: formatEnvironmentInstructions(language),
    ARCHITECT_PROVIDER: roleConfig.architect.provider,
    ARCHITECT_MODEL: roleConfig.architect.model,
    ARCHITECT_THINKING_LEVEL: roleConfig.architect.thinkingLevel,
    DEVELOPER_TEST_PROVIDER: roleConfig["developer-test"].provider,
    DEVELOPER_TEST_MODEL: roleConfig["developer-test"].model,
    DEVELOPER_TEST_THINKING_LEVEL: roleConfig["developer-test"].thinkingLevel,
    DOCS_COMMIT_PROVIDER: roleConfig["docs-commit"].provider,
    DOCS_COMMIT_MODEL: roleConfig["docs-commit"].model,
    DOCS_COMMIT_THINKING_LEVEL: roleConfig["docs-commit"].thinkingLevel,
  };

  const files = await Promise.all(
    TEMPLATE_FILES.map(async ([templatePath, outputPath]) => {
      const localizedTemplatePath = language === "en" ? path.join("en", templatePath) : templatePath;
      const source = await readFile(path.join(TEMPLATE_ROOT, localizedTemplatePath), "utf8");
      const relativePath = outputPath({ projectSlug });
      return {
        relativePath,
        absolutePath: path.join(absoluteTarget, relativePath),
        content: renderTemplate(source, variables, templatePath),
      };
    }),
  );
  const roleConfigPath = ".pi/role-models.json";
  files.splice(-1, 0, {
    relativePath: roleConfigPath,
    absolutePath: path.join(absoluteTarget, roleConfigPath),
    content: `${JSON.stringify(roleConfig, null, 2)}\n`,
  });

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
    projectSlug,
    language,
    dryRun: options.dryRun === true,
    conflicts,
    files: files.map((file) => file.relativePath),
  };
}
