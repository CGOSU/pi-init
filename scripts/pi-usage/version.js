import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EMBEDDED_PACKAGE_VERSION = "__PI_INIT_VERSION__";
const SOURCE_PACKAGE_VERSION_MARKER = "__PI_INIT_VERSION__";
const EMBEDDED_GIT_HEAD = "__PI_INIT_GIT_HEAD__";
const SOURCE_GIT_HEAD_MARKER = "__PI_INIT_GIT_HEAD__";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readPackageGitHead(root = packageRoot) {
  if (!existsSync(path.join(root, ".git"))) return { ok: false, code: "NOT_GIT", message: "插件目录不是 Git 检出" };
  try {
    const value = execFileSync("git", ["-C", root, "rev-parse", "--short=7", "HEAD"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 2000,
    }).trim();
    if (!/^[0-9a-f]{7,40}$/.test(value)) return { ok: false, code: "INVALID_HEAD", message: "Git HEAD 格式无效" };
    return { ok: true, value };
  } catch {
    return { ok: false, code: "GIT_UNAVAILABLE", message: "无法读取插件 Git HEAD" };
  }
}

function resolvePackageVersion() {
  if (EMBEDDED_PACKAGE_VERSION !== SOURCE_PACKAGE_VERSION_MARKER) return EMBEDDED_PACKAGE_VERSION;
  try {
    const manifest = JSON.parse(
      readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"),
        "utf8",
      ),
    );
    return typeof manifest.version === "string" && manifest.version ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

export const PI_USAGE_VERSION = resolvePackageVersion();
const gitHead = EMBEDDED_GIT_HEAD === SOURCE_GIT_HEAD_MARKER ? readPackageGitHead() : { ok: true, value: EMBEDDED_GIT_HEAD };
export const PI_USAGE_GIT_HEAD = gitHead.ok ? gitHead.value : undefined;
export const PI_USAGE_BUILD = `${PI_USAGE_VERSION}${PI_USAGE_GIT_HEAD ? ` (git: ${PI_USAGE_GIT_HEAD})` : ""}`;
