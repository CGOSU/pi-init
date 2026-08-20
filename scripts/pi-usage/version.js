import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EMBEDDED_PACKAGE_VERSION = "__PI_INIT_VERSION__";
const SOURCE_PACKAGE_VERSION_MARKER = "__PI_INIT_VERSION__";

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
