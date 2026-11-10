import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { readSources, SOURCE_LIMITS } from "./diagnostics/sources.js";
import { summarizeRuntime } from "./diagnostics/runtime-report.js";
import { summarizeSessions } from "./diagnostics/session-report.js";
import { summarizeHandoff } from "./diagnostics/handoff-report.js";

export const HELP = `pi-init 本地诊断采集（离线，不上传）
用法：node scripts/diagnostics-report.js --runtime <文件> [--session <文件>] [--handoff <文件>] --output <新目录>

各来源参数可重复，轮转文件需显式指定；至少指定一个项目 runtime 文件。
只读取指定文件，不遍历用户目录，不执行会话中的工具或指令。
生成 manifest.json、report.json、report.md；拒绝覆盖已有目录。
manifest 包含本地来源路径；报告只保留元数据、聚合结果与来源行号。
这是所选字节范围的派生报告，不是原始日志备份或完整任务成功率统计。
上限：32 文件，单文件 64 MiB，总计 128 MiB，100000 条记录。`;

export function parseArguments(args) {
  const inputs = [];
  let output;
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!["--runtime", "--session", "--handoff", "--output"].includes(flag) || !value || value.startsWith("--")) {
      throw new Error("参数无效；使用 --help 查看用法");
    }
    if (flag === "--output") {
      if (output !== undefined) throw new Error("只能指定一个输出目录");
      output = resolve(value);
    } else inputs.push({ kind: flag.slice(2), path: value });
  }
  if (!output || !inputs.some(input => input.kind === "runtime")) throw new Error("必须指定 --runtime 和 --output");
  return { inputs, output };
}

export async function collectDiagnostics(inputs) {
  const { sources, records } = await readSources(inputs);
  const runtime = summarizeRuntime(records.runtime);
  const sessionIds = [...new Set(records.runtime.flatMap(({ row }) => row.version === 1
    && ["summary", "issue", "provider-request", "cache-request"].includes(row.kind)
    && typeof row.sessionId === "string" ? [row.sessionId] : []))];
  const sessions = summarizeSessions(records.session, { sessionIds });
  const handoff = summarizeHandoff(records.handoff);
  const sourceProblems = sources.filter(source => source.changedDuringRead || source.unterminatedTail
    || source.invalidLines || source.oversizedLines || source.omittedRecords);
  const report = {
    schemaVersion: 1, rulesVersion: 1, generatedAt: new Date().toISOString(), scope: "pi-init",
    sources: sources.map(({ sourceId, kind, sha256, byteRange, parsed, changedDuringRead, unterminatedTail,
      invalidLines, oversizedLines, omittedRecords }) => ({ sourceId, kind, sha256, byteRange, parsed,
      changedDuringRead, unterminatedTail, invalidLines, oversizedLines, omittedRecords })),
    runtime, sessions, handoff,
    sourceIntegrity: { hasReadGaps: sourceProblems.length > 0, affectedSources: sourceProblems.map(source => source.sourceId),
      scope: "explicit-files-only", crossFileSnapshot: "sequential-not-atomic", rawLogsArchived: false },
    limitations: [
      "只覆盖显式指定的文件与读取时的字节范围；未自动寻找轮转文件或其他 session。没有记录不代表没有故障。",
      "runtime、session、handoff 是不同观察口径，可能描述同一调用，数字不能相加成为总失败数。",
      "issue count 是同一故障类的累计观察，已折叠快照；不是独立根因数、失败请求数或任务失败率。",
      "正常模型停止和工具无失败标志都不证明需求已验收；版本比较还受任务复杂度、模型和样本缺失影响。",
      "报告不解析任意输出正文来猜测内层失败，不推断 Provider 自动重试，不估算单次错误的费用。",
      "本目录保存派生统计和有限来源引用，不备份原始正文；不同采集目录的重叠样本不可直接相加。",
    ],
  };
  const packageVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  const collectorHash = createHash("sha256");
  for (const path of ["diagnostics-report.js", "diagnostics/sources.js", "diagnostics/runtime-report.js",
    "diagnostics/session-report.js", "diagnostics/handoff-report.js", "handoff-report.js", "../src/record-guard.js"]) {
    collectorHash.update(path + "\0").update(await readFile(new URL(path, import.meta.url))).update("\0");
  }
  return { report, manifest: { schemaVersion: 1, collector: "pi-init/diagnostics-report", packageVersion,
    collectorSourceFingerprint: collectorHash.digest("hex"), generatedAt: report.generatedAt, limits: SOURCE_LIMITS, sources } };
}

function cell(value) {
  return String(value ?? "unknown").replace(/[\r\n\x00-\x1f\x7f|`<>\[\]\\]/g, " ").slice(0, 160);
}

export function renderReport(report) {
  const runtime = report.runtime;
  const lines = ["# pi-init 本地诊断报告", "", `采集时间：${report.generatedAt}`, "",
    `输入 ${report.sources.length} 个文件。来源读取缺口：${report.sourceIntegrity.hasReadGaps ? "存在，见 report.json" : "未发现；不代表日志覆盖完整"}。`, "",
    "## 运行时观察", "", `累计故障观察：${runtime.issues.observations}；已记录回合：${runtime.rounds.count}；健康基线样本：${runtime.rounds.healthySamples}。`, "",
    "| 故障类别 | 错误码 | 工具 | 观察次数 |", "| --- | --- | --- | --- |"];
  for (const issue of runtime.issues.entries.slice(0, 30)) {
    lines.push(`| ${cell(issue.category)} | ${cell(issue.code)} | ${cell(issue.toolName)} | ${issue.count} |`);
  }
  lines.push("", "## 加载版本与样本", "", "| 版本 | 加载 commit | 源码指纹 | 模型 / 角色 / 推理 | 回合数 |", "| --- | --- | --- | --- | --- |");
  for (const version of runtime.versions.slice(0, 30)) {
    const profile = [version.profile?.provider, version.profile?.model, version.profile?.role, version.profile?.thinkingLevel].map(cell).join(" / ");
    lines.push(`| ${cell(version.identity.extensionVersion)} | ${cell(version.identity.sourceCommit)} | ${cell(version.identity.sourceFingerprint)} | ${profile} | ${cell(version.rounds?.count)} |`);
  }
  const session = report.sessions.totals;
  lines.push("", "## 关联会话与详细日志", "",
    `关联 session 顶层工具结果 ${session.toolResults.total} 条，其中失败标志 ${session.toolResults.failed} 条、结果未知 ${session.toolResults.unknown} 条；assistant 错误 ${session.assistant.error} 条、中止 ${session.assistant.aborted} 条。`, "",
    `另有结构化嵌套回执 ${session.nested.receipts} 条，包含子调用错误 ${session.nested.error} 次。它们与顶层结果及 runtime 可能重复，分别统计。`, "",
    `跨 session 重用 entry 的候选 ${report.sessions.coverage.duplicateAcrossSessions} 次。合计按会话累计，可能含 fork 继承历史，不是唯一调用数或全局账单。`, "",
    `详细日志候选：同角色切换 ${report.handoff.candidateCounts.sameRoleSwitches}，读取范围重叠 ${report.handoff.candidateCounts.repeatedReads}，连续状态查询 ${report.handoff.candidateCounts.statusLoops}。候选不等于已确认浪费。`, "",
    `runtime 完整性标记：${runtime.integrity.flags.map(cell).join("、") || "未发现已知标记"}。session 解析缺口：${report.sessions.coverage.incomplete ? "存在" : "未发现"}。详细日志坏记录 ${report.handoff.invalidRecords} 条、身份冲突 ${report.handoff.conflictingDuplicates} 条。未提供某类输入时，该类的零计数不表示无故障。`, "",
    "## 完整性与使用边界", "", ...report.limitations.map(text => `- ${text}`), "",
    "完整指标及来源引用保存在 report.json；sourceId 与文件、SHA-256、字节范围的映射在 manifest.json。manifest 含本地路径，分享前请检查。", "");
  return lines.join("\n");
}

export async function writeBundle(output, bundle) {
  // Exclusive creation prevents an accidental overwrite of earlier evidence.
  await mkdir(output, { mode: 0o700 });
  const json = JSON.stringify(bundle.report, null, 2) + "\n";
  const markdown = renderReport(bundle.report);
  const artifacts = { "report.json": json, "report.md": markdown };
  const manifest = { ...bundle.manifest, artifacts: Object.entries(artifacts).map(([file, contents]) => ({ file,
    sha256: createHash("sha256").update(contents).digest("hex") })) };
  for (const [name, contents] of Object.entries({ ...artifacts, "manifest.json": JSON.stringify(manifest, null, 2) + "\n" })) {
    await writeFile(join(output, name), contents, { flag: "wx", mode: 0o600 });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const bundle = await collectDiagnostics(options.inputs);
  await writeBundle(options.output, bundle);
  console.log(`pi-init 本地诊断已保存：${options.output}`);
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error?.code === "EEXIST" ? "输出目录已存在，未覆盖；请选择新的目录。"
      : error?.code ? `采集未完成（${/^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : "IO_ERROR"}）；输出目录可能包含部分文件。`
        : error.message);
    process.exitCode = 1;
  });
}
