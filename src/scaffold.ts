import { isRecord } from "./value-guards.ts";
import { readProjectMetadata } from "./project-metadata.ts";

import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRoleConfig } from "./roles.ts";
import { textOf } from "./error-utils.ts";

import type { EnvironmentFormatOptions, RenderedTemplateFile, ScaffoldOptions, ScaffoldOperationResult, TemplateFileDefinition, TemplateLanguage, TemplateVariables } from "./scaffold-types.ts";

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

function validateSingleLine(value: unknown, label: string, code: string): ScaffoldOperationResult<string> {
  if (typeof value !== "string") {
    return { ok: false, code: `${code}_TYPE`, message: `${label}必须是文本` };
  }
  const normalized = value.trim();
  if (!normalized) return { ok: false, code: `${code}_EMPTY`, message: `${label}不能为空` };
  if (/[\r\n]/.test(normalized)) return { ok: false, code: `${code}_MULTILINE`, message: `${label}不能包含换行符` };
  return { ok: true, value: normalized };
}

function isTemplateLanguage(value: unknown): value is TemplateLanguage {
  return typeof value === "string" && SUPPORTED_LANGUAGES.has(value);
}

function resolveLanguage(value: unknown = "zh-CN"): ScaffoldOperationResult<TemplateLanguage> {
  if (!isTemplateLanguage(value)) {
    return { ok: false, code: "SCAFFOLD_LANGUAGE_INVALID", message: "模板语言仅支持 zh-CN 或 en" };
  }
  return { ok: true, value };
}

async function validateOutputDirectories(target: string, outputs: string[]): Promise<ScaffoldOperationResult<void>> {
  const directories = new Set<string>();
  for (const output of outputs) {
    let directory = path.dirname(output);
    while (directory !== ".") {
      directories.add(directory);
      directory = path.dirname(directory);
    }
  }
  for (const directory of [...directories].sort()) {
    try {
      const info = await lstat(path.join(target, directory));
      if (info.isSymbolicLink()) {
        return { ok: false, code: "SCAFFOLD_OUTPUT_DIRECTORY_LINK", message: `初始化输出目录不允许使用链接：${directory}` };
      }
      if (!info.isDirectory()) {
        return { ok: false, code: "SCAFFOLD_OUTPUT_NOT_DIRECTORY", message: `初始化输出路径不是目录：${directory}` };
      }
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") continue;
      return {
        ok: false,
        code: "SCAFFOLD_OUTPUT_INSPECTION_FAILED",
        message: `无法检查初始化输出目录 ${directory}：${textOf(error)}`,
        causeCode: isRecord(error) && typeof error.code === "string" ? error.code : undefined,
      };
    }
  }
  return { ok: true, value: undefined };
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
export async function createScaffold(targetDir: string, options: ScaffoldOptions = {}): Promise<ScaffoldOperationResult> {
  const targetInput = validateSingleLine(targetDir, "目标目录", "SCAFFOLD_TARGET");
  if (!targetInput.ok) return targetInput;
  if (!isRecord(options)) return { ok: false, code: "SCAFFOLD_OPTIONS_TYPE", message: "初始化选项必须是对象" };
  if (options.dryRun !== undefined && typeof options.dryRun !== "boolean") {
    return { ok: false, code: "SCAFFOLD_DRY_RUN_TYPE", message: "dryRun 必须是布尔值" };
  }
  const absoluteTarget = path.resolve(targetDir);
  try {
    if (await pathExists(absoluteTarget)) {
      const targetStat = await stat(absoluteTarget);
      if (!targetStat.isDirectory()) {
        return { ok: false, code: "SCAFFOLD_TARGET_NOT_DIRECTORY", message: `目标路径不是目录：${absoluteTarget}` };
      }
    }
    const roleConfigPath = ".pi/role-models.json";
    const outputs = [...TEMPLATE_FILES.map(([, output]) => output()), roleConfigPath];
    const boundary = await validateOutputDirectories(absoluteTarget, outputs);
    if (!boundary.ok) return boundary;

    const projectName = validateSingleLine(options.projectName === undefined ? path.basename(absoluteTarget) : options.projectName, "项目名称", "SCAFFOLD_PROJECT_NAME");
    if (!projectName.ok) return projectName;
    const language = resolveLanguage(options.language);
    if (!language.ok) return language;
    const placeholder = language.value === "en" ? "To be completed by the project maintainer." : "待项目维护者补充。";
    const description = options.description === undefined || options.description === "" ? placeholder : options.description;
    const projectDescription = validateSingleLine(description, "项目描述", "SCAFFOLD_DESCRIPTION");
    if (!projectDescription.ok) return projectDescription;
    const requestedTestCommand = options.testCommand === undefined ? (await readProjectMetadata(absoluteTarget)).testCommand : options.testCommand;
    const testCommand = validateSingleLine(requestedTestCommand === undefined || requestedTestCommand === "" ? placeholder : requestedTestCommand, "测试命令", "SCAFFOLD_TEST_COMMAND");
    if (!testCommand.ok) return testCommand;
    const roleConfig = resolveRoleConfig(options.roleModels);
    if (!roleConfig.ok) return roleConfig;
    const variables: TemplateVariables = {
      PROJECT_NAME: projectName.value,
      PROJECT_DESCRIPTION: projectDescription.value,
      TEST_COMMAND: escapeInlineCode(testCommand.value),
      ENVIRONMENT_CONTEXT: formatEnvironmentInstructions(language.value),
    };
    const files = await renderTemplateFiles(absoluteTarget, language.value, variables);
    files.push({
      relativePath: roleConfigPath,
      absolutePath: path.join(absoluteTarget, roleConfigPath),
      content: `${JSON.stringify(roleConfig.value, null, 2)}\n`,
    });

    const preserved: string[] = [];
    const created: string[] = [];
    const dryRun = options.dryRun === true;
    for (const file of files) {
      const currentBoundary = await validateOutputDirectories(absoluteTarget, outputs);
      if (!currentBoundary.ok) return currentBoundary;
      if (await pathExists(file.absolutePath)) {
        preserved.push(file.relativePath);
        continue;
      }
      if (!dryRun) {
        await mkdir(path.dirname(file.absolutePath), { recursive: true });
        const createdBoundary = await validateOutputDirectories(absoluteTarget, outputs);
        if (!createdBoundary.ok) return createdBoundary;
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
      ok: true,
      value: {
        targetDir: absoluteTarget,
        projectName: projectName.value,
        language: language.value,
        dryRun,
        conflicts: [],
        preserved,
        files: created,
      },
    };
  } catch (error) {
    if (!isRecord(error) || typeof error.code !== "string") throw error;
    return { ok: false, code: "SCAFFOLD_IO_ERROR", causeCode: error.code, message: `无法生成项目初始化文件：${textOf(error)}` };
  }
}
