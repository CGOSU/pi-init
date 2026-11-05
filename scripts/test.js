import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const valueOptions = new Set(["--test-name-pattern", "--test-skip-pattern", "--test-reporter",
  "--test-reporter-destination", "--test-concurrency", "--test-timeout", "--test-shard"]);
const booleanOptions = new Set(["--test-only", "--experimental-test-coverage", "--test-force-exit",
  "--test-update-snapshots", "--watch", "--watch-preserve-output", "--no-warnings", "--trace-warnings", "--help"]);

// Only separate file selection from common Node flags. Node owns matching,
// execution, reporting and option validation; this is not a change detector.
function testArguments(args) {
  const options = [], files = [];
  let pathsOnly = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (pathsOnly || !arg.startsWith("-")) { files.push(arg); continue; }
    if (arg === "--") { pathsOnly = true; continue; }
    if (valueOptions.has(arg)) {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} 缺少值`);
      options.push(arg, value);
    } else if (arg.startsWith("--") && arg.includes("=") || booleanOptions.has(arg)) {
      options.push(arg);
    } else {
      throw new Error(`未支持的裸选项 ${arg}；带值选项请使用 --key=value`);
    }
  }
  return ["--import", new URL("./test-bootstrap.js", import.meta.url).href, "--test", ...options,
    "--", ...(files.length ? files : ["test/**/*.test.js"])];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const child = spawn(process.execPath, testArguments(process.argv.slice(2)), { stdio: "inherit" });
    child.once("error", error => { console.error(error.message); process.exitCode = 1; });
    child.once("exit", code => { process.exitCode = code ?? 1; });
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}
