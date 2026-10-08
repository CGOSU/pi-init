import { createHash } from "node:crypto";
import type {
  LegacyBlockMatch,
  ManagedBlockDefinition,
  ManagedBlockMatch,
  ManagedTemplateBlocks,
  ParsedTemplateState,
  TemplateLanguage,
  TemplateState,
  TemplateStateParseResult,
} from "./scaffold-types.ts";

export const TEMPLATE_SCHEMA_VERSION = 1;
export const TEMPLATE_STATE_PATH = ".pi/pi-init-state.json";

export const FAST_PATH_BLOCK = {
  id: "fast-path-wrap-up",
  file: "AGENTS.md",
  startMarker: "<!-- pi-init:managed:start fast-path-wrap-up -->",
  endMarker: "<!-- pi-init:managed:end fast-path-wrap-up -->",
  sectionStart: {
    "zh-CN": "## Fast Path 收尾优先级",
    en: "## Fast Path Wrap-up Priority",
  },
  sectionEnd: {
    "zh-CN": "## 会话收尾",
    en: "## Session Wrap-up",
  },
} as const satisfies ManagedBlockDefinition;

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

export function hashText(value: string): string {
  return createHash("sha256").update(normalizeLineEndings(value), "utf8").digest("hex");
}

export function findManagedBlock(text: string, definition: ManagedBlockDefinition = FAST_PATH_BLOCK): ManagedBlockMatch {
  const start = text.indexOf(definition.startMarker);
  if (start < 0) return { kind: "missing" };
  const endMarkerStart = text.indexOf(definition.endMarker, start + definition.startMarker.length);
  if (endMarkerStart < 0) {
    return { kind: "invalid", code: "MANAGED_BLOCK_END_MISSING" };
  }
  const duplicateStart = text.indexOf(definition.startMarker, start + definition.startMarker.length);
  if (duplicateStart >= 0 && duplicateStart < endMarkerStart) {
    return { kind: "invalid", code: "MANAGED_BLOCK_DUPLICATE" };
  }
  const end = endMarkerStart + definition.endMarker.length;
  return {
    kind: "managed",
    start,
    end,
    content: text.slice(start, end),
  };
}

export function managedBlockBody(block: string, definition: ManagedBlockDefinition = FAST_PATH_BLOCK): string {
  return normalizeLineEndings(block)
    .replace(`${definition.startMarker}\n`, "")
    .replace(`\n${definition.endMarker}`, "")
    .trim();
}

export function findLegacyBlock(
  text: string,
  language: TemplateLanguage,
  definition: ManagedBlockDefinition = FAST_PATH_BLOCK,
): LegacyBlockMatch {
  const sectionStart = definition.sectionStart[language];
  const sectionEnd = definition.sectionEnd[language];
  const start = text.indexOf(sectionStart);
  if (start < 0) return { kind: "missing" };
  const end = text.indexOf(sectionEnd, start + sectionStart.length);
  if (end < 0) return { kind: "invalid", code: "LEGACY_BLOCK_END_MISSING" };
  return {
    kind: "legacy",
    start,
    end,
    content: text.slice(start, end),
  };
}

export function replaceBlock(text: string, start: number, end: number, replacement: string): string {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const prefix = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
  const suffix = after.length > 0 && !after.startsWith("\n") ? "\n" : "";
  return `${before}${prefix}${replacement}${suffix}${after}`;
}

export function replaceManagedBlock(text: string, match: Extract<ManagedBlockMatch, { kind: "managed" }>, replacement: string): string {
  return replaceBlock(text, match.start, match.end, replacement);
}

export function createTemplateState(language: TemplateLanguage, managedBlocks: ManagedTemplateBlocks): TemplateState {
  return {
    schemaVersion: 1,
    templateSchemaVersion: TEMPLATE_SCHEMA_VERSION,
    language,
    managedBlocks,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseTemplateState(text: string): TemplateStateParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: "STATE_INVALID_JSON", message: "pi-init 模板状态文件不是有效 JSON" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, code: "STATE_INVALID_SHAPE", message: "pi-init 模板状态文件结构无效" };
  }
  if (parsed.schemaVersion !== 1 || parsed.templateSchemaVersion !== TEMPLATE_SCHEMA_VERSION) {
    return { ok: false, code: "STATE_UNSUPPORTED_VERSION", message: "pi-init 模板状态版本不受支持" };
  }
  const value: ParsedTemplateState = {
    ...parsed,
    schemaVersion: 1,
    templateSchemaVersion: TEMPLATE_SCHEMA_VERSION,
  };
  return { ok: true, value };
}
