import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_ROLE_CONFIG } from "./roles.js";

const TEMPLATE_ROOT = fileURLToPath(new URL("../templates/", import.meta.url));
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUPPORTED_LANGUAGES = new Set(["zh-CN", "en"]);

const TEMPLATE_FILES = [
  ["AGENTS.md", () => "AGENTS.md"],
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
 * Generate the six long-term AI collaboration files for a project.
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
      ? `Use when modifying, debugging, testing, or maintaining documentation for ${projectName}; automatically route work and switch models among Architect, Development and Test Engineer, and Documentation and Commit Engineer roles with explicit technical level, model type, and Pi reasoning level. Project purpose: ${projectDescription}`
      : `处理 ${projectName} 的代码修改、调试、测试或文档维护时使用；根据任务在架构师、开发测试工程师、文档与提交工程师之间智能分配职责并自动切换模型，同时指定技术水平、模型类型和 Pi 推理强度。项目定位：${projectDescription}`
    : language === "en"
      ? `Use when modifying, debugging, testing, or maintaining documentation for ${projectName}; automatically route work and switch models among Architect, Development and Test Engineer, and Documentation and Commit Engineer roles with explicit technical level, model type, and Pi reasoning level.`
      : `处理 ${projectName} 的代码修改、调试、测试或文档维护时使用；根据任务在架构师、开发测试工程师、文档与提交工程师之间智能分配职责并自动切换模型，同时指定技术水平、模型类型和 Pi 推理强度。`;
  const variables = {
    PROJECT_NAME: projectName,
    PROJECT_SLUG: projectSlug,
    PROJECT_DESCRIPTION: projectDescription,
    SKILL_DESCRIPTION: JSON.stringify(skillDescription),
    TEST_COMMAND: escapeInlineCode(testCommand),
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
    content: `${JSON.stringify(DEFAULT_ROLE_CONFIG, null, 2)}\n`,
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
