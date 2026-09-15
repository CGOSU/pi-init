import { createHash } from "node:crypto";

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
};

export function normalizeLineEndings(value) {
  return value.replace(/\r\n/g, "\n");
}

export function hashText(value) {
  return createHash("sha256").update(normalizeLineEndings(value), "utf8").digest("hex");
}

export function findManagedBlock(text, definition = FAST_PATH_BLOCK) {
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

export function managedBlockBody(block, definition = FAST_PATH_BLOCK) {
  return normalizeLineEndings(block)
    .replace(`${definition.startMarker}\n`, "")
    .replace(`\n${definition.endMarker}`, "")
    .trim();
}

export function findLegacyBlock(text, language, definition = FAST_PATH_BLOCK) {
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

export function replaceBlock(text, start, end, replacement) {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const prefix = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
  const suffix = after.length > 0 && !after.startsWith("\n") ? "\n" : "";
  return `${before}${prefix}${replacement}${suffix}${after}`;
}

export function replaceManagedBlock(text, match, replacement) {
  return replaceBlock(text, match.start, match.end, replacement);
}

export function createTemplateState(language, managedBlocks) {
  return {
    schemaVersion: 1,
    templateSchemaVersion: TEMPLATE_SCHEMA_VERSION,
    language,
    managedBlocks,
  };
}

export function parseTemplateState(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: "STATE_INVALID_JSON", message: "pi-init 模板状态文件不是有效 JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "STATE_INVALID_SHAPE", message: "pi-init 模板状态文件结构无效" };
  }
  if (parsed.schemaVersion !== 1 || parsed.templateSchemaVersion !== TEMPLATE_SCHEMA_VERSION) {
    return { ok: false, code: "STATE_UNSUPPORTED_VERSION", message: "pi-init 模板状态版本不受支持" };
  }
  return { ok: true, value: parsed };
}
