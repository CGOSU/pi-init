import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FILE_REVIEW_THRESHOLD,
  countPhysicalLines,
  scanProjectFiles,
} from "../src/file-review.ts";

export const REVIEW_THRESHOLD = FILE_REVIEW_THRESHOLD;
export { countPhysicalLines };

export async function findCodeFiles(rootDir) {
  const result = await scanProjectFiles(rootDir);
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  if (result.errors.length > 0) {
    throw Object.assign(new Error(result.errors.map((error) => `${error.path}: ${error.message}`).join("\n")), {
      code: "FILE_SCAN_INCOMPLETE",
    });
  }
  return result.files.map((file) => resolve(result.projectRoot, file.path));
}

export async function checkLineCount(rootDir, reviewThreshold = REVIEW_THRESHOLD) {
  const result = await scanProjectFiles(rootDir);
  if (!result.ok) return { ok: false, files: [], candidates: [], errors: [result.error] };
  return {
    ok: result.errors.length === 0,
    files: result.files.map((file) => resolve(result.projectRoot, file.path)),
    candidates: result.files.filter((file) => file.lineCount > reviewThreshold),
    errors: result.errors,
  };
}

export async function main(rootDir = process.cwd(), reviewThreshold = REVIEW_THRESHOLD) {
  const result = await checkLineCount(rootDir, reviewThreshold);
  for (const error of result.errors) {
    console.error(`[${error.code}] ${error.path}: ${error.message}`);
  }
  for (const candidate of result.candidates) {
    console.log(`${candidate.path}: ${candidate.lineCount} lines; structural review recommended`);
  }
  if (!result.ok) return 1;
  if (result.candidates.length === 0) console.log("No code files require structural review.");
  return 0;
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