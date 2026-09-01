import {
  createEditToolDefinition,
  type EditToolInput,
} from "@earendil-works/pi-coding-agent";

export const EDIT_GUARD_CODES = {
  readArguments: "edit.read-arguments",
  invalidArguments: "edit.invalid-arguments",
  duplicateMatch: "edit.duplicate-match",
  overlap: "edit.overlap",
} as const;

export type EditGuardCode = typeof EDIT_GUARD_CODES[keyof typeof EDIT_GUARD_CODES];

export type EditGuardDiagnostic = {
  kind: "reject";
  code: EditGuardCode;
  message: string;
};

export type EditArgumentsClassification =
  | { kind: "allow"; input: unknown }
  | (EditGuardDiagnostic & {
      code: typeof EDIT_GUARD_CODES.readArguments | typeof EDIT_GUARD_CODES.invalidArguments;
    });

export type EditErrorClassification =
  | EditGuardDiagnostic
  | { kind: "pass-through"; error: unknown };

const READ_ARGUMENTS_MESSAGE = "edit 只接受 path 和非空 edits；读取文件请调用 read。";
const INVALID_ARGUMENTS_MESSAGE = "edit 参数无效：edits 必须是非空的 oldText/newText 替换数组。";
const DUPLICATE_MATCH_MESSAGE = "edit 的 oldText 匹配不唯一；请重新读取并补充唯一上下文。";
const OVERLAP_MESSAGE = "edit 的替换区域重叠；请合并相邻或重叠改动。";

export function formatEditGuardDiagnostic(diagnostic: Pick<EditGuardDiagnostic, "code" | "message">) {
  return `[${diagnostic.code}] ${diagnostic.message}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isReplacement(value: unknown): value is { oldText: string; newText: string } {
  return isRecord(value)
    && typeof value.oldText === "string"
    && typeof value.newText === "string"
    && hasOnlyKeys(value, ["oldText", "newText"]);
}

/**
 * Classify raw edit arguments without normalizing or mutating them.
 *
 * The canonical edit contract is deliberately narrow. In particular, a read-shaped
 * `{ path, offset, limit }` call is rejected instead of being guessed into an edit.
 */
export function classifyEditArguments(input: unknown): EditArgumentsClassification {
  if (!isRecord(input)) {
    return {
      kind: "reject",
      code: EDIT_GUARD_CODES.invalidArguments,
      message: INVALID_ARGUMENTS_MESSAGE,
    };
  }

  const hasEdits = Object.prototype.hasOwnProperty.call(input, "edits");
  const hasReadArguments = Object.prototype.hasOwnProperty.call(input, "offset")
    || Object.prototype.hasOwnProperty.call(input, "limit");
  if (!hasEdits && hasReadArguments) {
    return {
      kind: "reject",
      code: EDIT_GUARD_CODES.readArguments,
      message: READ_ARGUMENTS_MESSAGE,
    };
  }

  if (
    typeof input.path !== "string"
    || !hasEdits
    || !Array.isArray(input.edits)
    || input.edits.length === 0
    || !input.edits.every(isReplacement)
    || !hasOnlyKeys(input, ["path", "edits"])
  ) {
    return {
      kind: "reject",
      code: EDIT_GUARD_CODES.invalidArguments,
      message: INVALID_ARGUMENTS_MESSAGE,
    };
  }

  return { kind: "allow", input };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "";
}

function isDuplicateMatchError(message: string) {
  return /^Found \d+ occurrences? of .* in .*\. (?:Each oldText|The text) must be unique\./s.test(message);
}

function isOverlapError(message: string) {
  return /^edits\[\d+\] and edits\[\d+\] overlap in .*\. Merge them into one edit/.test(message);
}

/**
 * Classify only the stable errors emitted by Pi's built-in edit implementation.
 * Unknown failures remain untouched so callers can preserve their original error.
 */
export function classifyEditError(error: unknown): EditErrorClassification {
  const message = errorMessage(error);
  if (isDuplicateMatchError(message)) {
    return {
      kind: "reject",
      code: EDIT_GUARD_CODES.duplicateMatch,
      message: DUPLICATE_MATCH_MESSAGE,
    };
  }
  if (isOverlapError(message)) {
    return {
      kind: "reject",
      code: EDIT_GUARD_CODES.overlap,
      message: OVERLAP_MESSAGE,
    };
  }
  return { kind: "pass-through", error };
}

/** Wrap Pi's edit definition without changing its schema, renderer, or write path. */
export function createEditGuardTool(cwd = process.cwd()) {
  const nativeEdit = createEditToolDefinition(cwd);
  return {
    ...nativeEdit,
    prepareArguments(input: unknown) {
      const prepared = nativeEdit.prepareArguments?.(input) ?? input;
      const classification = classifyEditArguments(prepared);
      if (classification.kind === "reject") {
        throw new Error(formatEditGuardDiagnostic(classification));
      }
      return classification.input as EditToolInput;
    },
    async execute(...args: Parameters<typeof nativeEdit.execute>) {
      const [toolCallId, params, signal, onUpdate, ctx] = args;
      const delegate = ctx?.cwd && ctx.cwd !== cwd
        ? createEditToolDefinition(ctx.cwd)
        : nativeEdit;
      try {
        return await delegate.execute(toolCallId, params, signal, onUpdate, ctx);
      } catch (error) {
        const classification = classifyEditError(error);
        if (classification.kind === "reject") {
          throw new Error(formatEditGuardDiagnostic(classification));
        }
        throw error;
      }
    },
  };
}
