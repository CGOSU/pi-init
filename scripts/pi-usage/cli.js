import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBillSvg } from "./bill.js";
import { queryUsage, summarizeUsage } from "./refresh.js";
import { formatDateMinute, formatNumber, formatReport, supportsColor } from "./report.js";

export function parseArguments(args, agentDir) {
  const rangeArguments = [];
  let update = false;
  let outputPath;
  let databasePath = process.env.PI_USAGE_DB || path.join(agentDir, "pi-usage.duckdb");
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--update") {
      update = true;
    } else if (argument === "--output") {
      outputPath = args[++index];
      if (!outputPath || outputPath.startsWith("--")) throw new Error("--output 需要输出路径");
      if (path.extname(outputPath).toLowerCase() !== ".svg") {
        throw new Error("--output 目前仅支持 .svg 文件");
      }
    } else if (argument === "--db") {
      databasePath = args[++index];
      if (!databasePath || databasePath.startsWith("--")) throw new Error("--db 需要数据库路径");
    } else if (argument.startsWith("--")) {
      throw new Error(`未知参数：${argument}`);
    } else if (rangeArguments.length >= 2) {
      throw new Error("最多指定两个日期");
    } else {
      rangeArguments.push(argument);
    }
  }
  return { rangeArguments, databasePath, update, outputPath };
}

function createRefreshProgressReporter() {
  return (event) => {
    if (event.type === "start") {
      console.error("正在扫描 session、增量更新 DuckDB...");
      return;
    }
    if (event.type !== "complete") return;
    const stats = event.stats;
    const dates = stats.durationDates.length ? stats.durationDates.join(", ") : "无";
    const latestUpdatedAt = stats.latestUpdatedAt ? formatDateMinute(stats.latestUpdatedAt) : "无";
    console.error(
      `刷新完成：扫描 ${formatNumber(stats.filesSeen)} 个文件，跳过 ${formatNumber(stats.filesSkipped)} 个，` +
        `追加 ${formatNumber(stats.filesAppended)} 个，重建 ${formatNumber(stats.filesRebuilt)} 个，` +
        `移除 ${formatNumber(stats.filesRemoved)} 个，读取 ${formatNumber(stats.bytesRead)} 字节，` +
        `重算日期：${latestUpdatedAt}，受影响日期：${dates}。`,
    );
  };
}

export async function runCli() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const { rangeArguments, databasePath, update, outputPath } = parseArguments(
    process.argv.slice(2),
    agentDir,
  );
  const sessionsDirectory = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDir, "sessions");
  const runtimeDirectory = path.join(agentDir, "pi-usage-runtime");
  const options = process.stderr.isTTY ? { onProgress: createRefreshProgressReporter() } : {};
  const summary = update
    ? await summarizeUsage(sessionsDirectory, rangeArguments, databasePath, runtimeDirectory, options)
    : await queryUsage(rangeArguments, databasePath, runtimeDirectory, sessionsDirectory, options);
  if (outputPath) {
    const resolvedOutputPath = path.resolve(outputPath);
    await writeFile(resolvedOutputPath, createBillSvg(summary), "utf8");
    console.log(`SVG 已生成：${resolvedOutputPath}`);
    return;
  }
  console.log(formatReport(summary, { color: supportsColor() }));
}
