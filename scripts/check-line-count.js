import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const REVIEW_THRESHOLD = 500;
export const FILE_REVIEW_LEDGER_PATH = ".pi/file-review.json";
export const CODE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx",
  ".rs", ".go", ".py", ".pyi", ".php", ".phtml",
]);
export const EXCLUDED_DIRECTORIES = new Set([
  ".git", "node_modules", "dist", "coverage", ".next", "out", "target",
  "vendor", ".venv", "venv", "__pycache__", ".tox", ".pi-graph",
]);

export function countPhysicalLines(content) {
  if (content.length === 0) return 0;
  const lines = content.split(/\r\n|\r|\n/);
  return lines.length - (/[\r\n]$/.test(content) ? 1 : 0);
}

function isExcludedDirectory(segments) {
  return segments.some((segment, index) =>
    EXCLUDED_DIRECTORIES.has(segment.toLowerCase())
    || (segment.toLowerCase() === "diagnostics" && segments[index - 1]?.toLowerCase() === ".pi"));
}

function isTemporaryRootDirectory(entryPath) {
  return !entryPath.includes("/") && (entryPath === ".tmp" || entryPath.startsWith(".tmp-"));
}

function isPathWithin(candidate, prefix) {
  return prefix === "." || candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function normalizeRelativeDir(raw, flag) {
  const cleaned = String(raw ?? "").trim().replace(/^\.\//, "").replace(/\/$/, "");
  if (!cleaned || cleaned.startsWith("/") || cleaned.startsWith("--") || /[\\:*?\[\]"']/.test(cleaned)
    || cleaned.split("/").some((part) => !part || part === ".." || (part === "." && cleaned !== "."))) {
    return { ok: false, message: `${flag} 必须是项目内的相对目录前缀，不能包含 ..、绝对路径或 glob。` };
  }
  return { ok: true, value: cleaned };
}

async function scanCodeFiles(rootDir, options = {}) {
  let projectRoot;
  try {
    projectRoot = await realpath(resolve(rootDir));
    if (!(await stat(projectRoot)).isDirectory()) {
      return { ok: false, errors: [{ code: "PROJECT_ROOT_NOT_DIRECTORY", path: projectRoot, message: "项目路径不是目录" }] };
    }
  } catch (error) {
    return { ok: false, errors: [{ code: "PROJECT_ROOT_UNREADABLE", path: resolve(rootDir), message: error instanceof Error ? error.message : String(error) }] };
  }
  const scope = options.scope;
  const exclude = options.exclude ?? [];
  if (scope && isExcludedDirectory(scope.split("/"))) {
    return { ok: false, errors: [{ code: "UNSUPPORTED_SCOPE", path: scope, message: "扫描范围属于排除目录" }] };
  }
  const files = [];
  const errors = [];
  let scopeFound = !scope || scope === ".";

  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      errors.push({ code: "DIRECTORY_UNREADABLE", path: relative(projectRoot, directory).split(sep).join("/") || ".", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = resolve(directory, entry.name);
      const entryPath = relative(projectRoot, absolutePath).split(sep).join("/");
      if (exclude.some((prefix) => isPathWithin(entryPath, prefix))) continue;
      if (!options.includeTemporary && entry.isDirectory() && isTemporaryRootDirectory(entryPath)) continue;
      if (entry.isDirectory()) {
        const withinScope = !scope || isPathWithin(entryPath, scope) || isPathWithin(scope, entryPath);
        if (withinScope && !isExcludedDirectory(entryPath.split("/"))) {
          if (scope === entryPath) scopeFound = true;
          await visit(absolutePath);
        }
        continue;
      }
      if (scope && !isPathWithin(entryPath, scope)) continue;
      if (!entry.isFile() || !CODE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      try {
        const info = await lstat(absolutePath);
        if (info.isSymbolicLink() || !info.isFile()) continue;
        const content = await readFile(absolutePath, "utf8");
        files.push({
          path: entryPath,
          lineCount: countPhysicalLines(content),
          fingerprint: createHash("sha256").update(content).digest("hex"),
        });
      } catch (error) {
        errors.push({ code: "FILE_UNREADABLE", path: entryPath, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  await visit(projectRoot);
  if (!scopeFound) errors.push({ code: "SCOPE_NOT_FOUND", path: scope, message: "扫描范围目录不存在、被排除或为符号链接" });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: errors.length === 0, projectRoot, files, errors };
}

export async function readFileReviewLedger(rootDir) {
  const piDir = resolve(rootDir, ".pi");
  try {
    const dirInfo = await lstat(piDir);
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
      return { ok: false, error: { code: "UNSAFE_LEDGER_PATH", path: ".pi", message: ".pi 不是普通目录，拒绝跟随符号链接" } };
    }
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return { ok: true, decisions: new Map() };
    return { ok: false, error: { code: "LEDGER_UNREADABLE", path: ".pi", message: String(error) } };
  }
  const ledgerFile = resolve(piDir, "file-review.json");
  try {
    const fileInfo = await lstat(ledgerFile);
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.nlink !== 1) {
      return { ok: false, error: { code: "UNSAFE_LEDGER_PATH", path: FILE_REVIEW_LEDGER_PATH, message: "审阅账本不是普通独立文件" } };
    }
    const raw = JSON.parse(await readFile(ledgerFile, "utf8"));
    if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1 || !Array.isArray(raw.decisions)) {
      return { ok: false, error: { code: "INVALID_LEDGER", path: FILE_REVIEW_LEDGER_PATH, message: "审阅账本 schemaVersion 或结构无效" } };
    }
    const decisions = new Map();
    for (const item of raw.decisions) {
      if (!item || typeof item !== "object" || typeof item.path !== "string" || !item.path
        || item.path.includes("\\") || isAbsolute(item.path) || item.path.split("/").includes("..")
        || !Number.isInteger(item.lineCount) || item.lineCount <= 0
        || typeof item.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(item.fingerprint)
        || (item.conclusion !== "keep" && item.conclusion !== "recommend-split")
        || typeof item.rationale !== "string" || item.rationale.trim().length < 12 || item.rationale.trim().length > 2000
        || !Number.isFinite(item.reviewedAt)) {
        return { ok: false, error: { code: "INVALID_LEDGER", path: FILE_REVIEW_LEDGER_PATH, message: "审阅账本包含无效记录字段" } };
      }
      decisions.set(item.path, {
        path: item.path,
        lineCount: item.lineCount,
        fingerprint: item.fingerprint,
        conclusion: item.conclusion,
        rationale: item.rationale.trim(),
        reviewedAt: item.reviewedAt,
      });
    }
    return { ok: true, decisions };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return { ok: true, decisions: new Map() };
    return { ok: false, error: { code: "INVALID_LEDGER", path: FILE_REVIEW_LEDGER_PATH, message: error instanceof Error ? error.message : String(error) } };
  }
}

export async function findCodeFiles(rootDir, options = {}) {
  const result = await scanCodeFiles(rootDir, options);
  if (!result.ok) {
    const first = result.errors[0];
    throw Object.assign(new Error(result.errors.map((e) => `${e.path}: ${e.message}`).join("\n")), {
      code: first?.code ?? "FILE_SCAN_INCOMPLETE",
    });
  }
  return result.files.map((file) => resolve(result.projectRoot, file.path));
}

export async function checkLineCount(rootDir, reviewThreshold = REVIEW_THRESHOLD, options = {}) {
  const scan = await scanCodeFiles(rootDir, options);
  if (!scan.projectRoot) return { ok: false, files: [], candidates: [], reviewed: [], errors: scan.errors };
  const ledger = await readFileReviewLedger(scan.projectRoot);
  const errors = [...scan.errors, ...(ledger.ok ? [] : [ledger.error])];
  const decisions = ledger.ok ? ledger.decisions : new Map();
  const largeFiles = scan.files.filter((file) => file.lineCount > reviewThreshold);
  const reviewed = [];
  const candidates = [];
  for (const file of largeFiles) {
    const match = decisions.get(file.path);
    const isReviewed = match && match.fingerprint === file.fingerprint;
    if (isReviewed) reviewed.push({ ...file, conclusion: match.conclusion, rationale: match.rationale, reviewedAt: match.reviewedAt });
    if (!isReviewed || options.all) {
      candidates.push(isReviewed ? { ...file, conclusion: match.conclusion, rationale: match.rationale } : file);
    }
  }
  return {
    ok: errors.length === 0,
    files: scan.files.map((file) => resolve(scan.projectRoot, file.path)),
    candidates,
    reviewed,
    errors,
  };
}

export async function recordFileReviewDecision(rootDir, { path: targetPath, conclusion, rationale, fingerprint, reviewThreshold = REVIEW_THRESHOLD } = {}) {
  const fail = (code, message) => ({ ok: false, code, message });
  if (conclusion !== "keep" && conclusion !== "recommend-split") return fail("INVALID_CONCLUSION", "conclusion 仅支持 keep 或 recommend-split");
  const trimmedRationale = typeof rationale === "string" ? rationale.trim() : "";
  if (trimmedRationale.length < 12 || trimmedRationale.length > 2000) return fail("INVALID_RATIONALE", "rationale 去除首尾空白后需为 12-2000 字符");
  let projectRoot;
  try { projectRoot = await realpath(resolve(rootDir)); }
  catch (error) { return fail("PROJECT_ROOT_UNREADABLE", error instanceof Error ? error.message : String(error)); }
  const absolutePath = resolve(projectRoot, String(targetPath ?? ""));
  const rel = relative(projectRoot, absolutePath);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return fail("PATH_OUTSIDE_PROJECT", "文件路径必须位于当前项目内");
  const normalizedPath = rel.split(sep).join("/");
  if (!CODE_EXTENSIONS.has(extname(normalizedPath).toLowerCase()) || isExcludedDirectory(normalizedPath.split("/").slice(0, -1))) {
    return fail("UNSUPPORTED_FILE", "该路径不是受支持的代码文件");
  }
  try {
    let cursor = projectRoot;
    for (const part of normalizedPath.split("/")) {
      cursor = join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) return fail("SYMLINK_UNSUPPORTED", "不跟随符号链接登记代码审阅");
    }
    const content = await readFile(absolutePath, "utf8");
    const lineCount = countPhysicalLines(content);
    if (lineCount <= reviewThreshold) return fail("BELOW_THRESHOLD", `该文件当前为 ${lineCount} 行，未超过 ${reviewThreshold} 行阈值`);
    const currentFingerprint = createHash("sha256").update(content).digest("hex");
    if (fingerprint && fingerprint !== currentFingerprint) return fail("STALE_VERSION", "文件指纹与当前内容不匹配，请重新读取最新原文");
    const ledger = await readFileReviewLedger(projectRoot);
    if (!ledger.ok) return fail(ledger.error.code, ledger.error.message);
    const piDir = join(projectRoot, ".pi");
    await mkdir(piDir, { recursive: true });
    const piStat = await lstat(piDir);
    if (piStat.isSymbolicLink() || !piStat.isDirectory()) return fail("UNSAFE_LEDGER_PATH", ".pi 不是普通目录");
    const ledgerFile = join(piDir, "file-review.json");
    try {
      const existing = await lstat(ledgerFile);
      if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) return fail("UNSAFE_LEDGER_PATH", "审阅账本不是普通独立文件");
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
    const decision = { path: normalizedPath, lineCount, fingerprint: currentFingerprint, conclusion, rationale: trimmedRationale, reviewedAt: Date.now() };
    ledger.decisions.set(normalizedPath, decision);
    const sorted = [...ledger.decisions.values()].sort((a, b) => a.path.localeCompare(b.path));
    const handle = await open(ledgerFile, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, decisions: sorted }, null, 2) + "\n", "utf8"); }
    finally { await handle.close(); }
    return { ok: true, decision };
  } catch (error) {
    return fail("FILE_UNREADABLE", error instanceof Error ? error.message : String(error));
  }
}

function parseCliArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("-") ? args.shift() : "scan";
  if (command === "record" || command === "mark") {
    const positional = [];
    let fingerprint;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--fingerprint") {
        fingerprint = args[++i];
        if (!fingerprint) return { ok: false, message: "--fingerprint 缺少 SHA-256 参数" };
      } else if (args[i].startsWith("-")) {
        return { ok: false, message: `未知参数：${args[i]}` };
      } else {
        positional.push(args[i]);
      }
    }
    if (positional.length < 3) {
      return { ok: false, message: "用法：node scripts/check-line-count.js record <path> <keep|recommend-split> <rationale> [--fingerprint <sha256>]" };
    }
    const [targetPath, conclusion, ...rationaleParts] = positional;
    return { ok: true, command: "record", path: targetPath, conclusion, rationale: rationaleParts.join(" "), fingerprint };
  }
  if (command !== "scan") {
    return { ok: false, message: `未知子命令：${command}（支持 scan 或 record）` };
  }
  const options = { exclude: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--include-temporary") { options.includeTemporary = true; continue; }
    if (flag === "--all") { options.all = true; continue; }
    if (flag === "--scope" || flag === "--exclude") {
      const checked = normalizeRelativeDir(args[++i], flag);
      if (!checked.ok) return checked;
      if (flag === "--scope") options.scope = checked.value;
      else options.exclude.push(checked.value);
      continue;
    }
    return { ok: false, message: `未知参数：${flag}` };
  }
  return { ok: true, command: "scan", options };
}

export async function main(firstArg = process.argv.slice(2), secondArg = process.cwd(), thirdArg = REVIEW_THRESHOLD) {
  const argv = Array.isArray(firstArg) ? firstArg : [];
  const rootDir = typeof firstArg === "string" ? firstArg : secondArg;
  const reviewThreshold = typeof firstArg === "string" ? (typeof secondArg === "number" ? secondArg : REVIEW_THRESHOLD) : thirdArg;
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.message);
    return 1;
  }
  if (parsed.command === "record") {
    const recorded = await recordFileReviewDecision(rootDir, {
      path: parsed.path,
      conclusion: parsed.conclusion,
      rationale: parsed.rationale,
      fingerprint: parsed.fingerprint,
      reviewThreshold,
    });
    if (!recorded.ok) {
      console.error(`[${recorded.code}] ${recorded.message}`);
      return 1;
    }
    const { decision } = recorded;
    console.log(`${decision.path}: recorded ${decision.conclusion} (${decision.lineCount} lines, fingerprint: ${decision.fingerprint})`);
    return 0;
  }
  const result = await checkLineCount(rootDir, reviewThreshold, parsed.options);
  for (const error of result.errors) {
    console.error(`[${error.code}] ${error.path}: ${error.message}`);
  }
  for (const candidate of result.candidates) {
    const suffix = candidate.conclusion
      ? `reviewed=${candidate.conclusion} (fingerprint: ${candidate.fingerprint})`
      : `structural review recommended (fingerprint: ${candidate.fingerprint})`;
    console.log(`${candidate.path}: ${candidate.lineCount} lines; ${suffix}`);
  }
  if (!result.ok) return 1;
  if (result.candidates.length === 0) console.log("No code files require structural review.");
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
