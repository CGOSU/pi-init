import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION as sdkVersion } from "@earendil-works/pi-coding-agent";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const safeVersion = (value: unknown) => typeof value === "string" && /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(value) ? value : "unknown";

// Capture once when this module loads, never when an event is written. The
// fingerprint describes bounded on-disk package sources at that time; it is not
// a claim that every module was re-evaluated atomically during a hot reload.
export function captureRuntimeIdentity(root = packageRoot) {
  let extensionVersion = "unknown";
  let sourceCommit: string | undefined;
  let sourceFingerprint: string | undefined;
  try {
    if (statSync(join(root, "package.json")).size <= 64 * 1024) {
      extensionVersion = safeVersion(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
    }
  } catch {}
  if (existsSync(join(root, ".git"))) {
    try {
      const value = execFileSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000, maxBuffer: 1024,
      }).trim();
      if (/^[0-9a-f]{40,64}$/.test(value)) sourceCommit = value;
    } catch { /* Git-less packages and broken Git metadata remain usable. */ }
  }
  try {
    const files = ["package.json"];
    let entries = 0;
    const visit = (directory: string, extension = ".ts", depth = 0) => {
      if (depth > 8) throw new Error("source depth budget");
      for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
        if (++entries > 4096) throw new Error("source entry budget");
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path, extension, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(extension)) files.push(path);
        if (files.length > 1024) throw new Error("source file budget");
      }
    };
    visit("extensions"); visit("src");
    if (existsSync(join(root, "skills"))) visit("skills", ".md");
    const hash = createHash("sha256");
    let bytes = 0;
    for (const file of files.sort()) {
      bytes += statSync(join(root, file)).size;
      if (bytes > 4 * 1024 * 1024) throw new Error("source byte budget");
      hash.update(file.replaceAll("\\", "/") + "\0").update(readFileSync(join(root, file))).update("\0");
    }
    sourceFingerprint = hash.digest("hex");
  } catch { /* Unavailable identity must not prevent loading the extension. */ }
  return Object.freeze({ extensionVersion, sdkVersion: safeVersion(sdkVersion), sourceCommit, sourceFingerprint,
    pid: process.pid, loadedAt: new Date().toISOString() });
}

export const loadedRuntimeIdentity = captureRuntimeIdentity();

export function formatRuntimeIdentity() {
  const identity = loadedRuntimeIdentity;
  return `已加载运行身份：pi-init ${identity.extensionVersion}；SDK ${identity.sdkVersion}；commit ${identity.sourceCommit?.slice(0, 12) ?? "不可用"}；源码指纹 ${identity.sourceFingerprint?.slice(0, 12) ?? "不可用"}；PID ${identity.pid}；加载 ${identity.loadedAt}。指纹为模块加载时的磁盘源码观察，不证明热重载的所有模块同步更新。`;
}
