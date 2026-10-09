import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export const FILE_REVIEW_POLICY_VERSION = 1;
export const FILE_REVIEW_THRESHOLD = 500;
export const FILE_REVIEW_ENTRY_TYPE = "pi-init-file-review";

export const FILE_REVIEW_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx",
  ".rs", ".go", ".py", ".pyi", ".php", ".phtml",
]);
export const FILE_REVIEW_EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git", "node_modules", "dist", "coverage", ".next", "out", "target", "vendor", ".venv", "venv", "__pycache__", ".tox",
]);

export type FileSnapshot = {
  path: string;
  lineCount: number;
  fingerprint: string;
  size: string;
  modifiedAt: string;
};

export type FileScanError = {
  code: "PROJECT_ROOT_UNREADABLE" | "PROJECT_ROOT_NOT_DIRECTORY" | "DIRECTORY_UNREADABLE" | "FILE_UNREADABLE" | "FILE_NOT_FOUND" | "UNSUPPORTED_FILE" | "PATH_OUTSIDE_PROJECT" | "SYMLINK_UNSUPPORTED" | "FILE_CHANGED_DURING_READ";
  path: string;
  message: string;
};

export type FileScanResult =
  | { ok: false; error: FileScanError }
  | { ok: true; projectRoot: string; files: FileSnapshot[]; errors: FileScanError[] };

export type FileReviewConclusion = "keep" | "recommend-split";

export type FileReviewDecision = {
  path: string;
  lineCount: number;
  fingerprint: string;
  conclusion: FileReviewConclusion;
  rationale: string;
  reviewedAt: number;
};

export type PersistedFileReviewState = {
  schemaVersion: 1;
  policyVersion: number;
  projectRoot: string;
  sessionId: string;
  decisions: FileReviewDecision[];
};

export type StateReadResult =
  | { ok: true; value: PersistedFileReviewState }
  | { ok: false; code: "INVALID_STATE" | "PROJECT_MISMATCH" | "SESSION_MISMATCH" | "POLICY_MISMATCH"; message: string };

export function countPhysicalLines(content: string) {
  if (content.length === 0) return 0;
  const lines = content.split(/\r\n|\r|\n/);
  return lines.length - (/[\r\n]$/.test(content) ? 1 : 0);
}

export function normalizeReviewPath(rootDir: string, candidate: string):
  | { ok: false; code: "PATH_OUTSIDE_PROJECT" | "UNSUPPORTED_FILE"; message: string }
  | { ok: true; absolutePath: string; path: string } {
  const absolutePath = resolve(rootDir, candidate);
  const pathFromRoot = relative(rootDir, absolutePath);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot) ||
    pathFromRoot === ""
  ) {
    return { ok: false as const, code: "PATH_OUTSIDE_PROJECT", message: "文件路径必须位于当前项目内" };
  }
  const normalizedPath = pathFromRoot.split(sep).join("/");
  if (!FILE_REVIEW_CODE_EXTENSIONS.has(extname(normalizedPath).toLowerCase())) {
    return { ok: false as const, code: "UNSUPPORTED_FILE", message: "该路径不是受审阅策略覆盖的代码文件" };
  }
  return { ok: true as const, absolutePath, path: normalizedPath };
}

function scanError(code: FileScanError["code"], path: string, error: unknown): FileScanError {
  return {
    code,
    path,
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function scanProjectFiles(
  rootDir: string,
  options: { previous?: readonly FileSnapshot[]; forcePaths?: readonly string[]; forceAll?: boolean } = {},
): Promise<FileScanResult> {
  let projectRoot: string;
  try {
    projectRoot = await realpath(resolve(rootDir));
  } catch (error) {
    return { ok: false, error: scanError("PROJECT_ROOT_UNREADABLE", resolve(rootDir), error) };
  }

  try {
    if (!(await stat(projectRoot)).isDirectory()) {
      return {
        ok: false,
        error: { code: "PROJECT_ROOT_NOT_DIRECTORY", path: projectRoot, message: "项目路径不是目录" },
      };
    }
  } catch (error) {
    return { ok: false, error: scanError("PROJECT_ROOT_UNREADABLE", projectRoot, error) };
  }

  const previous = new Map((options.previous ?? []).map((file) => [file.path, file]));
  const forced = new Set(options.forcePaths ?? []);
  const files: FileSnapshot[] = [];
  const errors: FileScanError[] = [];

  async function visit(directory: string) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      errors.push(scanError("DIRECTORY_UNREADABLE", relative(projectRoot, directory).split(sep).join("/"), error));
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!FILE_REVIEW_EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) await visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !FILE_REVIEW_CODE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;

      const path = relative(projectRoot, absolutePath).split(sep).join("/");
      try {
        const fileStat = await lstat(absolutePath, { bigint: true });
        if (fileStat.isSymbolicLink() || !fileStat.isFile()) continue;
        const size = fileStat.size.toString();
        const modifiedAt = fileStat.mtimeNs.toString();
        const cached = previous.get(path);
        if (cached && cached.size === size && cached.modifiedAt === modifiedAt && !options.forceAll && !forced.has(path)) {
          files.push(cached);
          continue;
        }
        const content = await readFile(absolutePath, "utf8");
        const after = await lstat(absolutePath, { bigint: true });
        if (after.isSymbolicLink() || after.size.toString() !== size || after.mtimeNs.toString() !== modifiedAt) {
          errors.push({ code: "FILE_CHANGED_DURING_READ", path, message: "读取期间文件发生变化，请重试" });
          continue;
        }
        files.push({
          path,
          lineCount: countPhysicalLines(content),
          fingerprint: createHash("sha256").update(content).digest("hex"),
          size,
          modifiedAt,
        });
      } catch (error) {
        errors.push(scanError("FILE_UNREADABLE", path, error));
      }
    }
  }

  await visit(projectRoot);
  files.sort((left, right) => left.path.localeCompare(right.path));
  errors.sort((left, right) => left.path.localeCompare(right.path));
  return { ok: true, projectRoot, files, errors };
}

export async function inspectProjectFile(rootDir: string, candidate: string): Promise<
  | { ok: true; projectRoot: string; file: FileSnapshot }
  | { ok: false; error: FileScanError }
> {
  let projectRoot: string;
  try {
    projectRoot = await realpath(resolve(rootDir));
  } catch (error) {
    return { ok: false, error: scanError("PROJECT_ROOT_UNREADABLE", resolve(rootDir), error) };
  }
  const normalized = normalizeReviewPath(projectRoot, candidate);
  if (!normalized.ok) {
    return { ok: false, error: { code: normalized.code, path: candidate, message: normalized.message } };
  }
  try {
    const segments = normalized.path.split("/");
    let currentPath = projectRoot;
    let beforePath: Awaited<ReturnType<typeof lstat>> | undefined;
    for (const [index, segment] of segments.entries()) {
      currentPath = resolve(currentPath, segment);
      const component = await lstat(currentPath);
      if (component.isSymbolicLink()) {
        return { ok: false, error: { code: "SYMLINK_UNSUPPORTED", path: normalized.path, message: "不跟随符号链接读取项目代码" } };
      }
      if (index < segments.length - 1 && !component.isDirectory()) {
        return { ok: false, error: { code: "FILE_NOT_FOUND", path: normalized.path, message: "文件父路径不是目录" } };
      }
      if (index === segments.length - 1) beforePath = component;
    }
    if (!beforePath?.isFile()) {
      return { ok: false, error: { code: "FILE_NOT_FOUND", path: normalized.path, message: "路径不是普通文件" } };
    }
    const before = await lstat(normalized.absolutePath, { bigint: true });
    const content = await readFile(normalized.absolutePath, "utf8");
    const after = await lstat(normalized.absolutePath, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      return { ok: false, error: { code: "FILE_CHANGED_DURING_READ", path: normalized.path, message: "读取期间文件发生变化，请重试" } };
    }
    return {
      ok: true,
      projectRoot,
      file: {
        path: normalized.path,
        lineCount: countPhysicalLines(content),
        fingerprint: createHash("sha256").update(content).digest("hex"),
        size: after.size.toString(),
        modifiedAt: after.mtimeNs.toString(),
      },
    };
  } catch (error) {
    return { ok: false, error: scanError("FILE_UNREADABLE", normalized.path, error) };
  }
}

export function createFileReviewState(projectRoot: string, sessionId: string): PersistedFileReviewState {
  return {
    schemaVersion: 1,
    policyVersion: FILE_REVIEW_POLICY_VERSION,
    projectRoot,
    sessionId,
    decisions: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validReviewPath(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || isAbsolute(value)) return false;
  const parts = value.split("/");
  return !parts.includes("..") && !parts.includes("") && FILE_REVIEW_CODE_EXTENSIONS.has(extname(value).toLowerCase());
}

export function readFileReviewState(value: unknown, projectRoot: string, sessionId: string): StateReadResult {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.decisions)) {
    return { ok: false, code: "INVALID_STATE", message: "保存的大文件审阅状态格式无效" };
  }
  if (value.policyVersion !== FILE_REVIEW_POLICY_VERSION) {
    return { ok: false, code: "POLICY_MISMATCH", message: "保存的大文件审阅状态使用了旧策略版本" };
  }
  if (value.projectRoot !== projectRoot) {
    return { ok: false, code: "PROJECT_MISMATCH", message: "保存的审阅状态属于其他项目" };
  }
  if (value.sessionId !== sessionId) {
    return { ok: false, code: "SESSION_MISMATCH", message: "保存的审阅状态属于其他 Pi 会话" };
  }

  const decisions: FileReviewDecision[] = [];
  const seenPaths = new Set<string>();
  for (const item of value.decisions) {
    if (
      !isRecord(item) ||
      !validReviewPath(item.path) ||
      !Number.isInteger(item.lineCount) ||
      Number(item.lineCount) <= FILE_REVIEW_THRESHOLD ||
      typeof item.fingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(item.fingerprint) ||
      (item.conclusion !== "keep" && item.conclusion !== "recommend-split") ||
      typeof item.rationale !== "string" ||
      !item.rationale.trim() ||
      item.rationale.trim().length > 2000 ||
      !Number.isFinite(item.reviewedAt)
    ) {
      return { ok: false, code: "INVALID_STATE", message: "保存的大文件审阅结果包含无效字段" };
    }
    if (seenPaths.has(item.path as string)) {
      return { ok: false, code: "INVALID_STATE", message: "保存的大文件审阅状态包含重复路径" };
    }
    seenPaths.add(item.path as string);
    decisions.push({
      path: item.path as string,
      lineCount: Number(item.lineCount),
      fingerprint: item.fingerprint as string,
      conclusion: item.conclusion,
      rationale: item.rationale.trim(),
      reviewedAt: Number(item.reviewedAt),
    });
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      policyVersion: FILE_REVIEW_POLICY_VERSION,
      projectRoot,
      sessionId,
      decisions,
    },
  };
}

export function pendingFileReviews(files: readonly FileSnapshot[], decisions: readonly FileReviewDecision[]) {
  const reviewed = new Map(decisions.map((decision) => [decision.path, decision.fingerprint]));
  return files.filter((file) =>
    file.lineCount > FILE_REVIEW_THRESHOLD && reviewed.get(file.path) !== file.fingerprint,
  );
}

export function recordFileReview(
  state: PersistedFileReviewState,
  file: FileSnapshot,
  conclusion: FileReviewConclusion,
  rationale: string,
  reviewedAt = Date.now(),
): PersistedFileReviewState {
  const decision: FileReviewDecision = {
    path: file.path,
    lineCount: file.lineCount,
    fingerprint: file.fingerprint,
    conclusion,
    rationale: rationale.trim(),
    reviewedAt,
  };
  return {
    ...state,
    decisions: [...state.decisions.filter((item) => item.path !== file.path), decision],
  };
}

export function normalizeFileReviewError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export type { FileScanError as FileReviewDiagnostic };