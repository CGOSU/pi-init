import {
  accessSync,
  chmodSync,
  copyFileSync,
  constants,
  readdirSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPackageGitHead } from "./pi-usage/version.js";

function isInside(directory, candidate, platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const relative = pathApi.relative(pathApi.resolve(directory), pathApi.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${pathApi.sep}`) && relative !== ".." && !pathApi.isAbsolute(relative))
  );
}

function findPiPath(platform = process.platform, pathValue = process.env.PATH, excludedDirectory) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const pathEntries = (pathValue ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const commandNames = platform === "win32" ? ["pi.cmd", "pi.exe", "pi.bat", "pi"] : ["pi"];

  for (const directory of pathEntries) {
    for (const commandName of commandNames) {
      const candidate = pathApi.join(directory, commandName);
      if (excludedDirectory && isInside(excludedDirectory, candidate, platform)) continue;
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function canWrite(directory) {
  try {
    accessSync(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveTargetDir(piPath, platform) {
  if (!piPath) return undefined;
  const piDir = path.dirname(piPath);
  if (canWrite(piDir) || platform === "win32") return piDir;

  const fallbackDir = process.env.XDG_BIN_HOME || path.join(os.homedir(), ".local", "bin");
  mkdirSync(fallbackDir, { recursive: true });
  return fallbackDir;
}

function readPackageVersion(sourceDir) {
  const packagePath = path.join(sourceDir, "..", "package.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("package.json 缺少有效版本号");
  }
  return manifest.version;
}

function copyPiUsageSupport(sourceDir, targetDir, version) {
  const sourceSupportDir = path.join(sourceDir, "pi-usage");
  const targetSupportDir = path.join(targetDir, "pi-usage-lib");
  const gitHead = readPackageGitHead(path.resolve(sourceDir, ".."));
  mkdirSync(targetSupportDir, { recursive: true });
  for (const entry of readdirSync(sourceSupportDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceSupportDir, entry.name);
    const targetPath = path.join(targetSupportDir, entry.name);
    if (entry.isDirectory()) {
      throw new Error(`pi-usage 支持目录不应包含嵌套目录：${entry.name}`);
    }
    if (entry.name === "version.js") {
      const source = readFileSync(sourcePath, "utf8");
      const marker = 'const EMBEDDED_PACKAGE_VERSION = "__PI_INIT_VERSION__";';
      const gitMarker = 'const EMBEDDED_GIT_HEAD = "__PI_INIT_GIT_HEAD__";';
      if (!source.includes(marker) || !source.includes(gitMarker)) throw new Error("pi-usage/version.js 缺少版本标识占位符");
      writeFileSync(
        targetPath,
        source.replace(marker, () => `const EMBEDDED_PACKAGE_VERSION = ${JSON.stringify(version)};`)
          .replace(gitMarker, () => `const EMBEDDED_GIT_HEAD = ${JSON.stringify(gitHead.ok ? gitHead.value : null)};`),
      );
    } else {
      copyFileSync(sourcePath, targetPath);
    }
  }
}

function copyVersionedUsageScript(sourceDir, targetDir, version) {
  const source = readFileSync(path.join(sourceDir, "pi-usage.js"), "utf8");
  const target = source.replaceAll("./pi-usage/", "./pi-usage-lib/");
  writeFileSync(path.join(targetDir, "pi-usage.js"), target);
  copyPiUsageSupport(sourceDir, targetDir, version);
}

export function installLaunchers({
  sourceDir = path.dirname(fileURLToPath(import.meta.url)),
  targetDir,
  platform = process.platform,
  pathValue = process.env.PATH,
} = {}) {
  const piPath = targetDir
    ? undefined
    : findPiPath(platform, pathValue, path.resolve(sourceDir, "..", "node_modules", ".bin"));
  const resolvedTargetDir = targetDir ?? resolveTargetDir(piPath, platform);
  if (!resolvedTargetDir) return false;

  copyVersionedUsageScript(sourceDir, resolvedTargetDir, readPackageVersion(sourceDir));
  if (platform === "win32") {
    copyFileSync(path.join(sourceDir, "pi-usage.cmd"), path.join(resolvedTargetDir, "pi-usage.cmd"));
  } else {
    const launcherPath = path.join(resolvedTargetDir, "pi-usage");
    copyFileSync(path.join(sourceDir, "pi-usage.sh"), launcherPath);
    chmodSync(launcherPath, 0o755);
  }
  return true;
}

function parseInstallerArguments(args) {
  if (args.length === 0) return { ok: true, value: {} };
  if (args[0] !== "--target-dir") return { ok: false, code: "UNKNOWN_INSTALLER_OPTION", message: `未知安装参数：${args[0]}` };
  if (args.length < 2 || !args[1].trim()) return { ok: false, code: "MISSING_TARGET_DIRECTORY", message: "--target-dir 需要非空目录路径。" };
  if (args.length > 2) return { ok: false, code: "EXTRA_INSTALLER_ARGUMENTS", message: "--target-dir 后只能提供一个目录路径。" };
  return { ok: true, value: { targetDir: args[1] } };
}

if (import.meta.main) {
  const parsed = parseInstallerArguments(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`${parsed.code}：${parsed.message}`);
    process.exitCode = 1;
  } else {
    const { targetDir } = parsed.value;
    try {
      if (installLaunchers({ targetDir })) {
        console.log(targetDir ? `已安装到：${targetDir}\n统计用量：pi-usage` : "已自动更新 pi-usage 启动器。");
      } else {
        console.warn("未找到 pi，跳过 pi-usage 启动器更新；可稍后手动运行安装脚本。");
      }
    } catch (error) {
      if (targetDir !== undefined) {
        console.error(`pi-usage 启动器安装失败：${error.message}`);
        process.exitCode = 1;
      } else {
        console.warn(`pi-usage 启动器自动更新失败，已跳过：${error.message}`);
      }
    }
  }
}
