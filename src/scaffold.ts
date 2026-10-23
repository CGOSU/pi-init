
import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRoleConfig, unwrapRoleResult } from "./roles.ts";

import type { EnvironmentFormatOptions, RenderedTemplateFile, ScaffoldOptions, ScaffoldResult, TemplateFileDefinition, TemplateLanguage, TemplateVariables } from "./scaffold-types.ts";

const TEMPLATE_ROOT = fileURLToPath(new URL("../templates/", import.meta.url));
const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set(["zh-CN", "en"]);
const PLATFORM_NAMES: Record<string, string> = {
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
const TEMPLATE_FILES: readonly TemplateFileDefinition[] = [
  ["AGENTS.md", () => "AGENTS.md"],
  ["docs/current-state.md", () => "docs/current-state.md"],
  ["docs/decisions.md", () => "docs/decisions.md"],
  ["docs/session-log.md", () => "docs/session-log.md"],
  ["docs/pitfalls.md", () => "docs/pitfalls.md"],
];

function validateSingleLine(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label}必须是文本`);
  }
  const normalized = value.trim();
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new Error(`${label}不能为空或包含换行符`);
  }
  return normalized;
}

function validateProjectName(value: unknown): string {
  return validateSingleLine(value, "项目名称");
}

function isTemplateLanguage(value: unknown): value is TemplateLanguage {
  return typeof value === "string" && SUPPORTED_LANGUAGES.has(value);
}

function resolveLanguage(value: unknown = "zh-CN"): TemplateLanguage {
  if (!isTemplateLanguage(value)) {
    throw new Error("模板语言仅支持 zh-CN 或 en");
  }
  return value;
}

export function formatEnvironmentInstructions(
  language: TemplateLanguage = "zh-CN",
  { platform = process.platform, arch = process.arch }: EnvironmentFormatOptions = {},
): string {
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

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, "\\`");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function renderTemplate(source: string, variables: TemplateVariables, templatePath: string): string {
  return source.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in variables)) {
      throw new Error(`模板 ${templatePath} 使用了未知变量：${key}`);
    }
    return variables[key];
  });
}

async function renderTemplateFiles(
  absoluteTarget: string,
  language: TemplateLanguage,
  variables: TemplateVariables,
): Promise<RenderedTemplateFile[]> {
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




/** Create missing project-owned files only; existing entries are never overwritten. */
export async function createScaffold(targetDir: string, options: ScaffoldOptions = {}): Promise<ScaffoldResult> {
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
  const roleConfig = unwrapRoleResult(resolveRoleConfig(options.roleModels));
  const variables: TemplateVariables = {
    PROJECT_NAME: projectName,
    PROJECT_DESCRIPTION: projectDescription,
    TEST_COMMAND: escapeInlineCode(testCommand),
    ENVIRONMENT_CONTEXT: formatEnvironmentInstructions(language),
  };

  const files: RenderedTemplateFile[] = await renderTemplateFiles(absoluteTarget, language, variables);
  const roleConfigPath = ".pi/role-models.json";
  files.push({
    relativePath: roleConfigPath,
    absolutePath: path.join(absoluteTarget, roleConfigPath),
    content: `${JSON.stringify(roleConfig, null, 2)}\n`,
  });


  const preserved: string[] = [];
  const created: string[] = [];
  const dryRun = options.dryRun === true;
  for (const file of files) {
    if (await pathExists(file.absolutePath)) {
      preserved.push(file.relativePath);
      continue;
    }
    if (!dryRun) {
      await mkdir(path.dirname(file.absolutePath), { recursive: true });
      try {
        await writeFile(file.absolutePath, file.content, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (isRecord(error) && error.code === "EEXIST") {
          preserved.push(file.relativePath);
          continue;
        }
        throw error;
      }
    }
    created.push(file.relativePath);
  }

  return {
    targetDir: absoluteTarget,
    projectName,
    language,
    dryRun,
    conflicts: [],
    preserved,
    files: created,
  };
}

export async function syncScaffold(_targetDir: string, _options: ScaffoldOptions = {}): Promise<never> {
  throw Object.assign(new Error("Template synchronization is retired; project files belong to their maintainers."), { code: "TEMPLATE_SYNC_RETIRED" });
}
