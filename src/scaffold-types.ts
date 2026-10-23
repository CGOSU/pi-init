export type TemplateLanguage = "zh-CN" | "en";

export type ScaffoldOptions = {
  projectName?: unknown;
  language?: unknown;
  description?: unknown;
  testCommand?: unknown;
  roleModels?: unknown;
  dryRun?: unknown;
};

export type TemplateVariables = Record<string, string>;
export type RenderedTemplateFile = { relativePath: string; absolutePath: string; content: string };

export type ScaffoldResult = {
  targetDir: string;
  projectName: string;
  language: TemplateLanguage;
  dryRun: boolean;
  conflicts: string[];
  files: string[];
  preserved: string[];
};

export type EnvironmentFormatOptions = { platform?: string; arch?: string };

export type TemplateFileDefinition = readonly [templatePath: string, outputPath: () => string, localize?: boolean];
