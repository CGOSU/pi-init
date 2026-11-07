import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isRecord } from "./value-guards.ts";

export async function readProjectMetadata(absoluteTarget: string) {
  let packageJson: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(join(absoluteTarget, "package.json"), "utf8"));
    if (isRecord(parsed)) packageJson = parsed;
  } catch {
    // package.json is optional; directory-name defaults still make quick init useful.
  }

  const declaredPackageManager = typeof packageJson.packageManager === "string"
    ? packageJson.packageManager.split("@")[0]?.trim()
    : undefined;
  let packageManager = declaredPackageManager || "pnpm";
  if (!declaredPackageManager) {
    for (const [lockfile, manager] of [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lockb", "bun"],
      ["bun.lock", "bun"],
      ["package-lock.json", "npm"],
      ["npm-shrinkwrap.json", "npm"],
    ] as const) {
      try {
        await readFile(join(absoluteTarget, lockfile));
        packageManager = manager;
        break;
      } catch {
        // Try the next package manager marker.
      }
    }
  }

  const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
  const scriptName = ["test", "check", "lint"].find((name) => typeof scripts[name] === "string");
  const scriptRunner = packageManager === "npm" && scriptName !== "test" ? "npm run" : packageManager;
  const inferredName = basename(absoluteTarget);
  return {
    projectName: typeof packageJson.name === "string" && packageJson.name.trim()
      ? packageJson.name.trim()
      : inferredName,
    description:
      typeof packageJson.description === "string" && packageJson.description.trim()
        ? packageJson.description.trim()
        : undefined,
    testCommand: scriptName ? `${scriptRunner} ${scriptName}` : undefined,
  };
}
