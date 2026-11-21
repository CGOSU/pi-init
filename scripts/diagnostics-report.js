import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { readSources, SOURCE_LIMITS } from "./diagnostics/sources.js";
import { discoverDiagnosticSources, parseSince } from "./diagnostics/discovery.js";
import { summarizeRuntime } from "./diagnostics/runtime-report.js";
import { summarizeSessions } from "./diagnostics/session-report.js";
import { summarizeHandoff } from "./diagnostics/handoff-report.js";

export const HELP = `pi-init 本地诊断采集（离线，不上传）
用法：node scripts/diagnostics-report.js --project <路径> [--session-id <ID>] [--since <时长>] --output <新目录>
   或 node scripts/diagnostics-report.js --runtime <文件> --output <新目录>
两种方式均可追加 --runtime/--handoff/--session <文件>，可重复，显式输入的轮转文件需单列。
--project 只在 Pi Agent 目录中查找所选项目的侧车；--since 以段文件的最后修改时间筛选（如 48h、7d），不筛逐条事件或显式文件。
不扫描工作区或 Pi 原始会话，不执行会话中的工具或指令。
生成 manifest.json、report.json、report.md；拒绝覆盖已有目录。
manifest 包含本地来源路径；报告只保留元数据、聚合结果与来源行号。
这是所选字节范围的派生报告，不是原始日志备份或完整任务成功率统计。
上限：32 文件，单文件 64 MiB，总计 128 MiB，100000 条记录。`;

export function parseArguments(args) {
  const inputs = [];
  const options = {};
  const keys = { "--project": "project", "--session-id": "sessionId", "--since": "sinceMs", "--output": "output" };
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const sourceFlag = ["--runtime", "--session", "--handoff"].includes(flag);
    if (!(sourceFlag || Object.hasOwn(keys, flag)) || !value || value.startsWith("--")) {
      throw new Error("参数无效；使用 --help 查看用法");
    }
    if (sourceFlag) {
      inputs.push({ kind: flag.slice(2), path: value });
      continue;
    }
    const key = keys[flag];
    if (Object.hasOwn(options, key)) throw new Error(`只能指定一次 ${flag}`);
    const parsed = flag === "--since" ? parseSince(value) : { ok: true, value: flag === "--session-id" ? value : resolve(value) };
    if (!parsed.ok) throw new Error(parsed.message);
    options[key] = parsed.value;
  }
  if (!options.output || !(options.project || inputs.some(input => input.kind === "runtime"))) {
    throw new Error("必须指定 --output 及 --project 或 --runtime");
  }
  if (!options.project && (options.sessionId !== undefined || options.sinceMs !== undefined)) {
    throw new Error("--session-id 和 --since 仅用于 --project 发现");
  }
  if (inputs.length > SOURCE_LIMITS.files) throw new Error(`最多指定 ${SOURCE_LIMITS.files} 个日志文件`);
  return { inputs, ...options };
}

export async function collectDiagnostics(inputs, selection) {
  const { sources, records, unavailable } = !inputs.length && selection
    ? { sources: [], records: { runtime: [], session: [], handoff: [] }, unavailable: [] }
    : await readSources(inputs);
  const discovery = selection && { ...selection, streams: selection.streams.map(stream => ({ ...stream,
    read: sources.filter(source => source.kind === stream.kind && source.selection === "discovered").length,
  })) };
  const selectionIncomplete = discovery?.streams.some(stream => stream.omittedByBudget > 0 || Object.keys(stream.warnings).length > 0) ?? false;
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
    sourceIntegrity: { hasReadGaps: sourceProblems.length > 0 || selectionIncomplete || unavailable.length > 0,
      affectedSources: [...sourceProblems, ...unavailable].map(source => source.sourceId),
      scope: discovery ? "project-discovery-and-explicit" : "explicit-files-only",
      crossFileSnapshot: "sequential-not-atomic", rawLogsArchived: false,
      ...(discovery && { discovery, unavailable: unavailable.map(({ sourceId, kind, code }) => ({ sourceId, kind, code })) }) },
    limitations: [
      "只覆盖所选文件与读取时的字节范围。发现只查所选项目的诊断侧车；没有记录不代表没有故障。",
      "runtime、session、handoff 是不同观察口径，可能描述同一调用，数字不能相加成为总失败数。",
      "issue count 是同一故障类的累计观察，已折叠快照；不是独立根因数、失败请求数或任务失败率。",
      "正常模型停止和工具无失败标志都不证明需求已验收；版本比较还受任务复杂度、模型和样本缺失影响。",
      "报告不解析任意输出正文来猜测内层失败，不推断 Provider 自动重试，不估算单次错误的费用。",
      "本目录保存派生统计和有限来源引用，不备份原始正文；不同采集目录的重叠样本不可直接相加。",
    ],
  };
  const packageVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  const collectorHash = createHash("sha256");
  for (const path of ["diagnostics-report.js", "diagnostics/sources.js", "diagnostics/discovery.js", "diagnostics/runtime-report.js",
    "diagnostics/session-report.js", "diagnostics/handoff-report.js", "handoff-report.js", "../src/record-guard.js", "../src/diagnostic-paths.ts"]) {
    collectorHash.update(path + "\0").update(await readFile(new URL(path, import.meta.url))).update("\0");
  }
  return { report, manifest: { schemaVersion: 1, collector: "pi-init/diagnostics-report", packageVersion,
    collectorSourceFingerprint: collectorHash.digest("hex"), generatedAt: report.generatedAt, limits: SOURCE_LIMITS, sources,
    ...(discovery && { discovery, unavailable }) } };
}

function cell(value) {
  return String(value ?? "unknown").replace(/[\r\n\x00-\x1f\x7f|`<>\[\]\\]/g, " ").slice(0, 160);
}

export function renderReport(report) {
  const runtime = report.runtime;
  const lines = ["# pi-init 本地诊断报告", "", `采集时间：${report.generatedAt}`, "",
    `成功读取 ${report.sources.length} 个文件。来源读取缺口：${report.sourceIntegrity.hasReadGaps ? "存在，见 report.json" : "未发现；不代表日志覆盖完整"}。`, ""];
  const discovery = report.sourceIntegrity.discovery;
  if (discovery) {
    lines.push("## 项目侧车发现", "", `按段文件修改时间选取（起点：${discovery.since ?? "不限"}）。`);
    for (const stream of discovery.streams) {
      const kind = stream.kind === "runtime" ? "黑匣子" : "详细交接日志";
      lines.push(`- ${kind}：发现读取 ${stream.read}/${stream.selected} 段，时间排除 ${stream.excludedByTime} 段，数量上限排除 ${stream.omittedByBudget} 段。${stream.read ? "" : "未取得该类侧车样本。"}`);
    }
    lines.push("", "目录状态、扫描和读入问题见 report.json；显式文件不受发现范围或时间过滤。", "");
  }
  lines.push("## 运行时观察", "", `累计故障观察：${runtime.issues.observations}；已记录回合：${runtime.rounds.count}；健康基线样本：${runtime.rounds.healthySamples}。`, "",
    "| 故障类别 | 错误码 | 工具 | 观察次数 |", "| --- | --- | --- | --- |");
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
  const found = options.project && await discoverDiagnosticSources(options, options.inputs.length);
  const bundle = await collectDiagnostics([...options.inputs, ...(found ? found.inputs : [])], found ? found.selection : undefined);
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
