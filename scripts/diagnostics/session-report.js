// Offline observations only: never interpret tool text, commands or arguments.
const LIMITS = Object.freeze({ records: 100000, sessions: 64, tools: 64, references: 8, nestedCalls: 256 });
const PI_TOOLS = new Set(["task_workflow", "switch_role", "session_handoff"]);
const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
const ENTRY_TYPES = new Set(["message", "custom", "custom_message", "thinking_level_change", "model_change", "usage", "compaction", "branch_summary", "label", "session_info", "context_edit"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:|-]{0,255}$/.test(value) ? value : undefined;
const toolName = value => typeof value === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : undefined;
const validNumber = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

function reference(record, entryId) {
  const sourceId = identifier(record?.sourceId);
  if (!sourceId || !Number.isSafeInteger(record.line) || record.line < 1) return undefined;
  return { sourceId, line: record.line, ...(entryId ? { entryId } : {}) };
}
function addReference(target, ref) {
  if (!ref || target.some(item => JSON.stringify(item) === JSON.stringify(ref))) return false;
  if (target.length >= LIMITS.references) return true;
  target.push(ref);
  return false;
}
function emptyCounts() {
  return {
    toolResults: { total: 0, failed: 0, noFailureFlag: 0, unknown: 0, failureKinds: { toolError: 0, businessRejected: 0, nonzeroExit: 0 } },
    assistant: { messages: 0, error: 0, aborted: 0, unknownStopReason: 0,
      usage: Object.fromEntries(USAGE_KEYS.map(key => [key, { total: 0, observations: 0 }])) },
    nested: { receipts: 0, calls: 0, ok: 0, error: 0, unfinished: 0, incompleteReceipts: 0, unknownRecords: 0, omittedCalls: 0 },
  };
}

function projectEntry(row) {
  if (!ENTRY_TYPES.has(row.type)) return { kind: "unknown", issues: ["unknown-entry-schema"] };
  if (row.type === "custom" || row.type === "custom_message") {
    return { kind: "metadata", associated: typeof row.customType === "string" && row.customType.startsWith("pi-init-") };
  }
  if (row.type !== "message") return { kind: "metadata" };
  if (!object(row.message)) return { kind: "unknown", issues: ["invalid-message"] };
  const message = row.message;
  if (["custom", "hookMessage"].includes(message.role)) {
    return { kind: "metadata", associated: typeof message.customType === "string" && message.customType.startsWith("pi-init-") };
  }
  if (message.role === "assistant") {
    const usage = {};
    const issues = [];
    if (message.usage !== undefined && !object(message.usage)) issues.push("invalid-usage");
    for (const key of USAGE_KEYS) {
      const value = object(message.usage) ? message.usage[key] : undefined;
      if (validNumber(value)) usage[key] = value;
      else if (value !== undefined) issues.push("invalid-usage");
    }
    return { kind: "assistant", stopReason: ["stop", "length", "toolUse", "error", "aborted"].includes(message.stopReason) ? message.stopReason : "unknown", usage, issues };
  }
  if (["user", "system", "bashExecution", "compactionSummary", "branchSummary"].includes(message.role)) return { kind: "metadata" };
  if (message.role !== "toolResult") return { kind: "unknown", issues: ["unknown-message-schema"] };
  const name = toolName(message.toolName);
  const callId = identifier(message.toolCallId);
  const issues = [];
  if (!name || !callId) issues.push("missing-tool-identity");
  const result = { kind: "tool", toolName: name ?? "unknown", toolCallId: callId, associated: PI_TOOLS.has(name),
    toolError: message.isError === true, businessRejected: false, nonzeroExit: false, observed: typeof message.isError === "boolean", issues };
  if (message.isError !== undefined && typeof message.isError !== "boolean") issues.push("invalid-outcome-field");
  for (const container of [message.details, message.structuredContent]) {
    if (!object(container)) continue;
    if (typeof container.ok === "boolean") { result.observed = true; result.businessRejected ||= container.ok === false; }
    else if (container.ok !== undefined) issues.push("invalid-outcome-field");
    for (const key of ["exitCode", "exit_code"]) {
      if (Number.isSafeInteger(container[key])) { result.observed = true; result.nonzeroExit ||= container[key] !== 0; }
      else if (container[key] !== undefined) issues.push("invalid-outcome-field");
    }
  }
  if (message.nestedCalls !== undefined) {
    const receipt = message.nestedCalls;
    result.nested = { calls: [], complete: false, invalid: 0, omitted: 0 };
    if (!object(receipt) || !Array.isArray(receipt.calls) || typeof receipt.complete !== "boolean") {
      result.nested.invalid = 1;
      issues.push("unknown-nested-schema");
    } else {
      result.nested.complete = receipt.complete;
      result.nested.omitted = Math.max(0, receipt.calls.length - LIMITS.nestedCalls);
      const seen = new Map();
      for (const call of receipt.calls.slice(0, LIMITS.nestedCalls)) {
        // Nested IDs may contain '/' but are only compared, never emitted.
        if (!object(call) || typeof call.id !== "string" || !call.id || call.id.length > 512 || !toolName(call.name)
          || !["ok", "error", "unfinished"].includes(call.status)) { result.nested.invalid++; continue; }
        if (seen.has(call.id)) {
          const previous = seen.get(call.id);
          if (previous.name !== call.name || previous.status !== call.status) {
            if (previous.status !== "unknown") result.nested.invalid++;
            seen.set(call.id, { status: "unknown" });
          }
          continue;
        }
        seen.set(call.id, { name: call.name, status: call.status });
      }
      result.nested.calls = [...seen.values()].map(call => call.status).filter(status => status !== "unknown");
      if (result.nested.invalid) issues.push("unknown-nested-schema");
      if (result.nested.omitted) issues.push("nested-call-limit");
    }
  }
  return result;
}

function accumulate(target, entry, issue) {
  if (entry.kind === "assistant") {
    target.assistant.messages++;
    if (entry.stopReason === "error" || entry.stopReason === "aborted") target.assistant[entry.stopReason]++;
    if (entry.stopReason === "unknown") target.assistant.unknownStopReason++;
    for (const [key, value] of Object.entries(entry.usage)) {
      const usage = target.assistant.usage[key];
      if (usage.total + value > Number.MAX_SAFE_INTEGER) { issue("usage-total-limit"); continue; }
      usage.total += value; usage.observations++;
    }
  }
  if (entry.kind !== "tool") return;
  const counts = target.toolResults;
  counts.total++;
  const failed = entry.toolError || entry.businessRejected || entry.nonzeroExit;
  counts[failed ? "failed" : entry.observed ? "noFailureFlag" : "unknown"]++;
  for (const key of ["toolError", "businessRejected", "nonzeroExit"]) if (entry[key]) counts.failureKinds[key]++;
  if (!entry.nested) return;
  target.nested.receipts++;
  if (!entry.nested.complete) target.nested.incompleteReceipts++;
  target.nested.unknownRecords += entry.nested.invalid;
  target.nested.omittedCalls += entry.nested.omitted;
  for (const status of entry.nested.calls) { target.nested.calls++; target.nested[status]++; }
}

/** Summarize explicit source records. sessionIds are associations already established by runtime records. */
export function summarizeSessions(records, { sessionIds = [] } = {}) {
  const rows = Array.isArray(records) ? records.slice(0, LIMITS.records) : [];
  const coverage = { inputRecords: Array.isArray(records) ? records.length : 0, examinedRecords: rows.length,
    sourceCount: 0, associatedSessions: 0, unassociatedSessions: 0, duplicateEntries: 0, conflictingEntries: 0,
    duplicateAcrossSessions: 0, crossSessionDuplicateCandidates: [], omittedCrossSessionCandidates: 0,
    incomplete: false, issues: [] };
  const problems = new Map();
  function issue(code, ref, count = 1) {
    coverage.incomplete = true;
    const item = problems.get(code) ?? { code, count: 0, sourceRefs: [], omittedReferences: 0 };
    item.count += count;
    if (addReference(item.sourceRefs, ref)) item.omittedReferences++;
    problems.set(code, item);
  }
  if (!Array.isArray(records)) issue("invalid-records");
  if (coverage.inputRecords > rows.length) issue("record-limit", undefined, coverage.inputRecords - rows.length);
  const sources = new Map();
  for (const record of rows) {
    const ref = reference(record);
    if (!ref) { issue("missing-source-reference"); continue; }
    if (!object(record.row)) { issue("invalid-record", ref); continue; }
    let source = sources.get(ref.sourceId);
    if (!source) { source = { records: [], headers: [] }; sources.set(ref.sourceId, source); }
    if (record.row.type === "session") source.headers.push({ row: record.row, ref });
    else source.records.push({ row: record.row, ref });
  }
  coverage.sourceCount = sources.size;
  const groups = new Map();
  const cwdById = new Map();
  const ambiguous = new Set();
  for (const source of sources.values()) {
    const header = source.headers[0];
    if (!header) { issue("missing-session-header", source.records[0]?.ref); continue; }
    const { id, cwd, version } = header.row;
    if (!identifier(id) || typeof cwd !== "string" || !cwd || cwd.length > 8192) { issue("invalid-session-header", header.ref); continue; }
    if (![2, 3].includes(version)) { issue("unsupported-session-version", header.ref); continue; }
    if (source.headers.some(item => item.row.id !== id || item.row.cwd !== cwd || item.row.version !== version)) {
      issue("conflicting-session-header", header.ref); continue;
    }
    if (cwdById.has(id) && cwdById.get(id) !== cwd) ambiguous.add(id);
    cwdById.set(id, cwd);
    let group = groups.get(id);
    if (!group) { group = { sessionId: id, headers: [], records: [] }; groups.set(id, group); }
    group.headers.push(header.ref);
    for (const record of source.records) group.records.push(record);
  }
  const knownSessions = new Set(Array.isArray(sessionIds) ? sessionIds.filter(identifier) : []);
  const sessions = [];
  const totals = emptyCounts();
  const observedEntries = new Map();
  for (const group of groups.values()) {
    if (ambiguous.has(group.sessionId)) { issue("conflicting-session-cwd", group.headers[0]); continue; }
    const entries = new Map();
    let associated = knownSessions.has(group.sessionId);
    let associationFromEntries = false;
    for (const { row, ref } of group.records) {
      const id = identifier(row.id);
      if (!id) { issue("missing-entry-id", ref); continue; }
      const projected = projectEntry(row);
      const entryRef = { ...ref, entryId: id, ...(projected.toolCallId ? { toolCallId: projected.toolCallId } : {}) };
      const signature = JSON.stringify(projected);
      const previous = entries.get(id);
      if (previous) {
        coverage.duplicateEntries++;
        if (previous.signature !== signature && !previous.conflict) {
          previous.conflict = true; coverage.conflictingEntries++; issue("conflicting-entry", entryRef);
        }
        continue;
      }
      entries.set(id, { projected, signature, ref: entryRef, conflict: false });
    }
    for (const entry of entries.values()) if (!entry.conflict && entry.projected.associated) associationFromEntries = true;
    associated ||= associationFromEntries;
    if (!associated) { coverage.unassociatedSessions++; continue; }
    coverage.associatedSessions++;
    if (sessions.length >= LIMITS.sessions) { issue("session-limit", group.headers[0]); continue; }
    const session = { sessionId: group.sessionId, association: [knownSessions.has(group.sessionId) ? "runtime-session-id" : undefined, associationFromEntries ? "pi-init-entry-or-result" : undefined].filter(Boolean),
      sourceRefs: [], omittedReferences: 0, ...emptyCounts(), tools: [], assistantSourceRefs: [], assistantFailureSourceRefs: [], nestedFailureSourceRefs: [] };
    for (const ref of group.headers) if (addReference(session.sourceRefs, ref)) session.omittedReferences++;
    const tools = new Map();
    for (const { projected: entry, ref, signature, conflict } of entries.values()) {
      if (conflict) continue;
      if (entry.kind === "tool" || entry.kind === "assistant") {
        const previous = observedEntries.get(ref.entryId);
        if (previous && previous.sessionId !== group.sessionId) {
          coverage.duplicateAcrossSessions++;
          issue("cross-session-entry-reuse", ref);
          if (coverage.crossSessionDuplicateCandidates.length < LIMITS.references) {
            coverage.crossSessionDuplicateCandidates.push({ entryId: ref.entryId, kind: entry.kind,
              sessionIds: [previous.sessionId, group.sessionId], projectionMatches: previous.signature === signature,
              sourceRefs: [previous.ref, ref] });
          } else coverage.omittedCrossSessionCandidates++;
        } else observedEntries.set(ref.entryId, { sessionId: group.sessionId, signature, ref });
      }
      for (const code of entry.issues ?? []) issue(code, ref);
      accumulate(session, entry, () => {});
      accumulate(totals, entry, code => issue(code, ref));
      if (entry.kind === "assistant" && addReference(session.assistantSourceRefs, ref)) session.omittedReferences++;
      if (entry.kind === "assistant" && ["error", "aborted"].includes(entry.stopReason)
        && addReference(session.assistantFailureSourceRefs, ref)) session.omittedReferences++;
      if (entry.kind !== "tool") continue;
      if (entry.nested && (entry.nested.invalid || entry.nested.calls.some(status => status !== "ok"))
        && addReference(session.nestedFailureSourceRefs, ref)) session.omittedReferences++;
      let tool = tools.get(entry.toolName);
      if (!tool) {
        if (tools.size >= LIMITS.tools) { issue("tool-group-limit", ref); continue; }
        tool = { toolName: entry.toolName, group: PI_TOOLS.has(entry.toolName) ? "pi-init" : "other", ...emptyCounts().toolResults, sourceRefs: [], failureSourceRefs: [], omittedReferences: 0 };
        tools.set(entry.toolName, tool);
      }
      accumulate({ toolResults: tool, nested: emptyCounts().nested }, entry, () => {});
      if (addReference(tool.sourceRefs, ref)) tool.omittedReferences++;
      if ((entry.toolError || entry.businessRejected || entry.nonzeroExit) && addReference(tool.failureSourceRefs, ref)) tool.omittedReferences++;
    }
    session.tools = [...tools.values()];
    sessions.push(session);
  }
  coverage.issues = [...problems.values()];
  return { version: 1, scope: "pi-init-associated-session-result-observations",
    totalsSemantics: "sum-of-session-local-observations-not-unique-executions", limits: LIMITS, sessions, totals, coverage,
    limitations: ["Top-level tool results are observations, not task success rates or proof of side-effect completion.",
      "Failure kinds can overlap within one tool result; noFailureFlag does not establish business success.",
      "Totals sum session-local observations and may include inherited fork entries; they are not unique calls or a global usage bill. Cross-session reused IDs are candidates, not proof of identical execution, and are not merged.",
      "Session files may contain multiple branches; this report does not infer the active branch or replay authorization.",
      "Nested SDK receipts are counted separately; complete=false may mean omitted arguments, not an unfinished call.",
      "Usage includes only observed nonnegative assistant fields; missing fields are not zero usage.",
      "Only explicit structured fields are inspected; text, commands, arguments, paths and error messages are not emitted."] };
}
