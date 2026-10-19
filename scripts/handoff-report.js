import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function parseHandoffLog(text, source = "log") {
  const records = [];
  const warnings = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.version !== 1 || typeof row.runtimeId !== "string" || typeof row.sessionId !== "string"
        || !Number.isSafeInteger(row.sequence) || typeof row.event !== "string"
        || !Number.isSafeInteger(row.run) || !Number.isFinite(Date.parse(row.timestamp))
        || !row.data || typeof row.data !== "object" || Array.isArray(row.data)
        || (row.snapshot != null && (typeof row.snapshot !== "object" || Array.isArray(row.snapshot)))
        || (row.dropped !== undefined && (!Number.isSafeInteger(row.dropped) || row.dropped < 0))) {
        throw new Error("unsupported record");
      }
      records.push(row);
    } catch {
      warnings.push(source + ":" + (index + 1) + "：无效、截断或不支持的日志行，已跳过");
    }
  }
  return { records, warnings };
}

function addRange(ranges, start, end) {
  let overlap = 0;
  for (const [left, right] of ranges) overlap += Math.max(0, Math.min(end, right) - Math.max(start, left));
  const merged = [];
  for (const [left, right] of [...ranges, [start, end]].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && left <= last[1]) last[1] = Math.max(last[1], right);
    else merged.push([left, right]);
  }
  ranges.splice(0, ranges.length, ...merged);
  return overlap;
}

export function analyzeHandoffLog(input) {
  const seen = new Set();
  const rows = [];
  let duplicateEvents = 0;
  for (const row of input) {
    const key = JSON.stringify([row.runtimeId, row.sessionId, row.sequence]);
    if (seen.has(key)) { duplicateEvents++; continue; }
    seen.add(key);
    rows.push(row);
  }
  const scope = row => JSON.stringify([row.runtimeId, row.sessionId]);
  rows.sort((a, b) => scope(a).localeCompare(scope(b)) || a.sequence - b.sequence);
  const calls = new Map();
  const runs = new Map();
  const reads = new Map();
  const pendingHandoffs = new Map();
  const handoffs = [];
  const sameRoleSwitches = [];
  const warnings = [];
  let dropped = 0;
  for (const row of rows) {
    const { event, data } = row;
    const snapshot = row.snapshot ?? {};
    const identity = { runtimeId: row.runtimeId, sessionId: row.sessionId };
    const time = Date.parse(row.timestamp);
    dropped += row.dropped ?? 0;
    const runKey = JSON.stringify([scope(row), row.run]);
    if (event === "agent.before_start" || event === "agent.start" || event === "agent.settled") {
      const run = runs.get(runKey) ?? { ...identity, run: row.run, role: snapshot.role, starts: 0, startedAt: null, settledAt: null };
      if (event === "agent.before_start" && run.startedAt === null) run.startedAt = time;
      if (event === "agent.start") run.starts++;
      if (event === "agent.settled") run.settledAt = time;
      runs.set(runKey, run);
    }
    if (["tool.call", "routing.tool_call", "tool.result", "routing.tool_result", "tool.execution_start", "tool.execution_end"].includes(event)
      && typeof data.toolCallId === "string") {
      const key = JSON.stringify([scope(row), data.toolCallId]);
      const call = calls.get(key) ?? { called: false, executed: false, result: false, error: false, durationMs: null };
      if (event.endsWith(".tool_call") || event === "tool.call") call.called = true;
      if (event === "tool.execution_start" || event === "tool.execution_end") call.executed = true;
      if (event.endsWith(".tool_result") || event === "tool.result" || event === "tool.execution_end") call.result = true;
      call.error ||= data.isError === true || data.businessOk === false || (typeof data.exitCode === "number" && data.exitCode !== 0);
      if (event === "tool.execution_end" && Number.isFinite(data.durationMs) && data.durationMs >= 0) call.durationMs = data.durationMs;
      calls.set(key, call);
    }
    if (event === "routing.tool_call" && data.toolName === "switch_role" && data.role === snapshot.role && !snapshot.locks?.roleRecovery) {
      sameRoleSwitches.push({ ...identity, run: row.run, sequence: row.sequence, role: data.role });
    }
    if (event === "tool.result" && data.toolName === "read" && data.isError !== true && data.businessOk !== false && !data.truncated) {
      for (const file of Array.isArray(data.files) ? data.files : []) {
        if (!file || typeof file !== "object") continue;
        if (!file.path || file.outsideProject || !file.version || !file.versionKind || file.rangesTruncated) continue;
        const ranges = Array.isArray(file.ranges) ? file.ranges : [{ start: file.offset ?? 1, end: (file.offset ?? 1) + file.limit - 1 }];
        const key = JSON.stringify([scope(row), file.path, file.versionKind, file.version]);
        const read = reads.get(key) ?? { ...identity, path: file.path, versionKind: file.versionKind, version: file.version,
          requestedLines: 0, overlapLines: 0, ranges: [], sequences: [] };
        let included = false;
        for (const range of ranges) {
          if (!range || typeof range !== "object") continue;
          const start = range.start;
          const end = range.end;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || !Number.isSafeInteger(end + 1)) continue;
          read.requestedLines += end - start + 1;
          read.overlapLines += addRange(read.ranges, start, end + 1);
          included = true;
        }
        if (included) { read.sequences.push(row.sequence); reads.set(key, read); }
      }
    }
    const coordination = snapshot.coordination?.handoff;
    let handoff;
    let phase;
    let kind;
    if (event === "coordination.persisted" && coordination) {
      handoff = coordination.handoffId; phase = coordination.phase; kind = "coordination";
    } else if (event === "workflow.persisted" && snapshot.workflow?.handoff) {
      handoff = snapshot.workflow.handoff.handoffId; phase = snapshot.workflow.handoff.phase; kind = "workflow";
    } else if (event === "role.handoff_prepared" || event === "role.handoff_dispatched") {
      handoff = data.handoffId; phase = event === "role.handoff_prepared" ? "prepared" : "executing"; kind = "role-dispatch";
    }
    if (handoff) {
      const key = JSON.stringify([scope(row), kind, handoff]);
      if (phase === "prepared" && !pendingHandoffs.has(key)) pendingHandoffs.set(key, time);
      const start = pendingHandoffs.get(key);
      if (phase === "executing" && start !== undefined) {
        if (time >= start) handoffs.push({ ...identity, kind, handoffId: handoff, durationMs: time - start });
        pendingHandoffs.delete(key);
      }
    }
  }
  const runSummaries = [...runs.values()].map(run => {
    if (run.starts > 1) warnings.push(run.runtimeId + "/" + run.sessionId + "/run=" + run.run + "：多个 agent.start，run 并非唯一执行实例");
    const durationMs = run.startedAt !== null && run.settledAt !== null && run.settledAt >= run.startedAt
      ? run.settledAt - run.startedAt : null;
    return { ...run, durationMs };
  });
  if (dropped) warnings.push("日志报告丢弃 " + dropped + " 条，统计不完整");
  const tools = [...calls.values()];
  return {
    events: rows.length, duplicateEvents, dropped,
    tools: { calls: tools.filter(call => call.called).length, executions: tools.filter(call => call.executed).length,
      errors: tools.filter(call => call.error).length, missingResults: tools.filter(call => !call.result).length,
      sdkDurationMs: tools.reduce((total, call) => total + (call.durationMs ?? 0), 0) },
    runs: runSummaries, sameRoleSwitches, handoffs,
    repeatedReads: [...reads.values()].filter(read => read.overlapLines > 0).map(({ ranges, ...read }) => read),
    warnings,
    caveats: ["读取重叠按成功结果中显式请求范围计算；不证明实际返回行数或读取冗余。stat 版本不是内容哈希。",
      "同角色切换仅为候选；可能用于模型配置或职责恢复。缺少结果不等于被拒绝或执行失败。",
      "SDK 耗时可包含嵌套或并行工具，不能从回合耗时相减推算模型推理时间。未闭合回合 durationMs 为 null。"],
  };
}

async function main() {
  const paths = process.argv.slice(2);
  if (!paths.length) paths.push(".pi/logs/handoff.jsonl");
  const records = [];
  const warnings = [];
  for (const path of paths) {
    const parsed = parseHandoffLog(await readFile(path, "utf8"), path);
    records.push(...parsed.records);
    warnings.push(...parsed.warnings);
  }
  const report = analyzeHandoffLog(records);
  report.warnings.unshift(...warnings);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
