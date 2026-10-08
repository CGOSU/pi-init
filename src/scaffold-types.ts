export type TemplateLanguage = "zh-CN" | "en";

export type ManagedBlockDefinition = {
  id: string;
  file: string;
  startMarker: string;
  endMarker: string;
  sectionStart: Readonly<Record<TemplateLanguage, string>>;
  sectionEnd: Readonly<Record<TemplateLanguage, string>>;
};

export type ManagedBlockMatch =
  | { kind: "missing" }
  | { kind: "invalid"; code: "MANAGED_BLOCK_END_MISSING" | "MANAGED_BLOCK_DUPLICATE" }
  | { kind: "managed"; start: number; end: number; content: string };

export type LegacyBlockMatch =
  | { kind: "missing" }
  | { kind: "invalid"; code: "LEGACY_BLOCK_END_MISSING" }
  | { kind: "legacy"; start: number; end: number; content: string };

export type ManagedTemplateState = { file: string; hash: string };
export type ManagedTemplateBlocks = Record<string, ManagedTemplateState>;

/** Parsed state preserves unknown metadata; only version fields are required by the current reader. */
export type ParsedTemplateState = {
  schemaVersion: 1;
  templateSchemaVersion: 1;
  language?: unknown;
  managedBlocks?: unknown;
  [key: string]: unknown;
};

export type TemplateState = {
  schemaVersion: 1;
  templateSchemaVersion: 1;
  language: TemplateLanguage;
  managedBlocks: ManagedTemplateBlocks;
};

export type TemplateStateParseErrorCode = "STATE_INVALID_JSON" | "STATE_INVALID_SHAPE" | "STATE_UNSUPPORTED_VERSION";
export type TemplateStateParseResult =
  | { ok: true; value: ParsedTemplateState }
  | { ok: false; code: TemplateStateParseErrorCode; message: string };

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
export type ScaffoldConflict = { path: string; code: string; message: string };

export type ScaffoldResult = {
  targetDir: string;
  projectName: string;
  language: TemplateLanguage;
  dryRun: boolean;
  conflicts: string[];
  files: string[];
};

export type SyncScaffoldResult = {
  targetDir: string;
  projectName: string;
  language: TemplateLanguage;
  dryRun: boolean;
  changed: boolean;
  created: string[];
  updated: string[];
  preserved: string[];
  conflicts: ScaffoldConflict[];
};

export type EnvironmentFormatOptions = { platform?: string; arch?: string };

export type SyncAgentsResult =
  | { conflict: ScaffoldConflict; content?: never; action?: never }
  | { conflict?: never; content: string; action: "updated" | "preserved" };

export type TemplateFileDefinition = readonly [templatePath: string, outputPath: () => string, localize?: boolean];
