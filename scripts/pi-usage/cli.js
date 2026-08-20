import os from "node:os";
import path from "node:path";
import { queryUsage, summarizeUsage } from "./refresh.js";
import { formatNumber, formatReport, supportsColor } from "./report.js";

function parseArguments(args, agentDir) {
  let date;
  let update = false;
  let databasePath = process.env.PI_USAGE_DB || path.join(agentDir, "pi-usage.duckdb");
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--update") {
      update = true;
    } else if (argument === "--db") {
      databasePath = args[++index];
      if (!databasePath) throw new Error("--db 需要数据库路径");
    } else if (argument.startsWith("--")) {
      throw new Error(`未知参数：${argument}`);
    } else if (date) {
      throw new Error("只能指定一个日期");
    } else {
      date = argument;
    }
  }
  return { date, databasePath, update };
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
    console.error(
      `刷新完成：扫描 ${formatNumber(stats.filesSeen)} 个文件，跳过 ${formatNumber(stats.filesSkipped)} 个，` +
        `追加 ${formatNumber(stats.filesAppended)} 个，重建 ${formatNumber(stats.filesRebuilt)} 个，` +
        `移除 ${formatNumber(stats.filesRemoved)} 个，读取 ${formatNumber(stats.bytesRead)} 字节，` +
        `重算日期：${dates}。`,
    );
  };
}

export async function runCli() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const { date, databasePath, update } = parseArguments(process.argv.slice(2), agentDir);
  const sessionsDirectory = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(agentDir, "sessions");
  const runtimeDirectory = path.join(agentDir, "pi-usage-runtime");
  const options = process.stderr.isTTY ? { onProgress: createRefreshProgressReporter() } : {};
  const summary = update
    ? await summarizeUsage(sessionsDirectory, date, databasePath, runtimeDirectory, options)
    : await queryUsage(date, databasePath, runtimeDirectory, sessionsDirectory, options);
  console.log(formatReport(summary, { color: supportsColor() }));
}
