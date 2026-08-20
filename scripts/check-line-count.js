import { extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readdir, readFile } from "node:fs/promises";

export const MAX_LINE_COUNT = 500;

const CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx"]);
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules"]);

export function countPhysicalLines(content) {
  if (content.length === 0) return 0;
  const lines = content.split(/\r\n|\r|\n/);
  return lines.length - (/[\r\n]$/.test(content) ? 1 : 0);
}

export async function findCodeFiles(rootDir) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) {
        await visit(resolve(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (CODE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(resolve(directory, entry.name));
      }
    }
  }

  await visit(resolve(rootDir));
  return files;
}

export async function checkLineCount(rootDir, maxLines = MAX_LINE_COUNT) {
  const files = await findCodeFiles(rootDir);
  const violations = [];

  for (const file of files) {
    const lineCount = countPhysicalLines(await readFile(file, "utf8"));
    if (lineCount > maxLines) {
      violations.push({
        file,
        lineCount,
      });
    }
  }

  return { files, violations };
}

function displayPath(rootDir, file) {
  return relative(rootDir, file).split("\\").join("/");
}

export async function main(rootDir = process.cwd(), maxLines = MAX_LINE_COUNT) {
  const result = await checkLineCount(rootDir, maxLines);
  if (result.violations.length === 0) return 0;

  console.error(`Code files must not exceed ${maxLines} physical lines.`);
  for (const violation of result.violations) {
    console.error(`${displayPath(rootDir, violation.file)}: ${violation.lineCount} lines`);
  }
  return 1;
}

const invokedScript = process.argv[1];
if (invokedScript && pathToFileURL(resolve(invokedScript)).href === import.meta.url) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
