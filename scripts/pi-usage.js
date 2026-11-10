import { runCli } from "./pi-usage/cli.js";

export * from "./pi-usage/version.js";
export * from "./pi-usage/core.js";
export * from "./pi-usage/refresh.js";
export * from "./pi-usage/report.js";
export * from "./pi-usage/bill.js";
export { parseArguments } from "./pi-usage/cli.js";

if (import.meta.main) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
