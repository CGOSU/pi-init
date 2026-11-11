import { analyzeHandoffLog, parseHandoffLog } from "../handoff-report.js";

function validNumericInputs(row) {
  const numberOrMissing = value => value === undefined || typeof value === "number" && Number.isFinite(value);
  if (!numberOrMissing(row.data.status)) return false;
  const files = Array.isArray(row.data.files) ? row.data.files : [];
  return files.every(file => !file || typeof file !== "object"
    || numberOrMissing(file.offset) && numberOrMissing(file.limit));
}

// Reuse the existing analyzer, but never copy its file paths or caller-provided
// metadata into the collection bundle. This boundary is intentionally scalar.
export function summarizeHandoff(input) {
  const records = [];
  const refs = new Map();
  const identities = new Map();
  let conflictingDuplicates = 0;
  let invalid = 0;
  for (const item of input) {
    const parsed = parseHandoffLog(JSON.stringify(item.row));
    invalid += parsed.warnings.length;
    for (const row of parsed.records) {
      if (!validNumericInputs(row)) { invalid++; continue; }
      records.push(row);
      const key = JSON.stringify([row.runtimeId, row.sessionId, row.sequence]);
      if (!refs.has(key)) {
        refs.set(key, { sourceId: item.sourceId, line: item.line });
        identities.set(key, JSON.stringify(row));
      } else if (identities.get(key) !== JSON.stringify(row)) conflictingDuplicates++;
    }
  }
  const result = analyzeHandoffLog(records);
  const reference = row => refs.get(JSON.stringify([row.runtimeId, row.sessionId, row.sequence ?? row.startSequence]));
  return {
    inputRecords: input.length, invalidRecords: invalid, events: result.events,
    duplicateEvents: result.duplicateEvents, conflictingDuplicates,
    tools: Object.fromEntries(Object.entries(result.tools).filter(([, value]) => typeof value === "number" && Number.isFinite(value))),
    candidateCounts: { sameRoleSwitches: result.sameRoleSwitches.length,
      repeatedReads: result.repeatedReads.length, statusLoops: result.statusLoops.length,
      workflowRejections: result.workflowRejections.length },
    candidates: [
      ...result.sameRoleSwitches.map(row => ({ rule: "same-role-switch", source: reference(row) })),
      ...result.statusLoops.map(row => ({ rule: "repeated-status", source: reference(row), count: row.count })),
      ...result.repeatedReads.map(row => ({ rule: "overlapping-read-range",
        source: reference({ ...row, sequence: row.sequences[0] }), overlapLines: row.overlapLines })),
    ].slice(0, 100),
    candidatesTruncated: result.sameRoleSwitches.length + result.statusLoops.length + result.repeatedReads.length > 100,
    droppedObservations: result.dropped,
    limitations: ["详细日志候选不证明操作冗余，读取范围重叠不等于可省略读取。",
      "同事件身份内容冲突时仅保留首次输入作为诊断候选，并披露冲突；不能用于确认该事件事实。",
      "SDK 耗时可能嵌套；此处工具数不与 runtime 或 session 数相加。"],
  };
}
