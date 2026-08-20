import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./pi-usage/cli.js";

export * from "./pi-usage/version.js";
export * from "./pi-usage/core.js";
export * from "./pi-usage/refresh.js";
export * from "./pi-usage/report.js";

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
