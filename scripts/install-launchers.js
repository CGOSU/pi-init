import { accessSync, chmodSync, copyFileSync, constants, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findPiPath(platform = process.platform) {
  const command = platform === "win32" ? "where.exe" : "sh";
  const args =
    platform === "win32" ? ["pi.cmd"] : ["-c", "command -v pi"];
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    if (platform !== "win32") return undefined;
    try {
      const output = execFileSync("where.exe", ["pi"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
    } catch {
      return undefined;
    }
  }
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

export function installLaunchers({
  sourceDir = path.dirname(fileURLToPath(import.meta.url)),
  targetDir,
  platform = process.platform,
} = {}) {
  const piPath = targetDir ? undefined : findPiPath(platform);
  const resolvedTargetDir = targetDir ?? resolveTargetDir(piPath, platform);
  if (!resolvedTargetDir) return false;

  copyFileSync(path.join(sourceDir, "pi-usage.js"), path.join(resolvedTargetDir, "pi-usage.js"));
  if (platform === "win32") {
    copyFileSync(path.join(sourceDir, "pi-usage.cmd"), path.join(resolvedTargetDir, "pi-usage.cmd"));
  } else {
    const launcherPath = path.join(resolvedTargetDir, "pi-usage");
    copyFileSync(path.join(sourceDir, "pi-usage.sh"), launcherPath);
    chmodSync(launcherPath, 0o755);
  }
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    if (installLaunchers()) {
      console.log("已自动更新 pi-usage 启动器。");
    } else {
      console.warn("未找到 pi，跳过 pi-usage 启动器更新；可稍后手动运行安装脚本。");
    }
  } catch (error) {
    console.warn(`pi-usage 启动器自动更新失败，已跳过：${error.message}`);
  }
}
