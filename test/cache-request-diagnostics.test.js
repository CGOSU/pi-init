import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandoffDiagnostics } from "../extensions/handoff-diagnostics.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";

// Confirmed requirement: observations never change requests or infer real misses from SDK defaults.
// The SDK exposes ordered hooks, not transport/request IDs; ambiguous association must stay unknown.
async function withDiagnostics(fn, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cache-diagnostics-"));
  const handlers = new Map();
  const notices = [];
  const ctx = { cwd, model: { provider: "openai-codex", id: "model", api: "openai-codex-responses" },
    isProjectTrusted: () => true, sessionManager: { getSessionId: () => "session" }, ui: { notify: (...args) => notices.push(args) } };
  const state = createExtensionRuntimeState();
  const pi = { getThinkingLevel: () => "high", on(name, handler) {
    if (options.unsupportedHook && name === "provider_stream_event") throw new Error("unsupported event");
    handlers.set(name, handler);
  } };
  const monitor = createHandoffDiagnostics(pi, state, { mode: "automatic", ...options });
  const emit = async (name, event = {}) => handlers.get(name)?.(event, ctx);
  const read = async (path) => {
    try { return (await readFile(join(cwd, ".pi", path), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  };
  const rows = async () => { await monitor.flush(); return read("diagnostics/runtime.jsonl"); };
  const cacheRows = async () => (await rows()).filter(row => row.kind === "cache-request");
  let timestamp = 0;
  const start = async (payload = { instructions: "private-system", input: [{ role: "user", content: "private-context" }], tools: [{ name: "private-tool", parameters: {} }] }) => emit("before_provider_request", { payload });
  const raw = async (type, response = {}, overrides = {}) => emit("provider_stream_event", {
    provider: ctx.model.provider, model: ctx.model.id, api: ctx.model.api, data: { type, response }, ...overrides,
  });
  const end = async (overrides = {}) => emit("message_end", { message: {
    role: "assistant", provider: ctx.model.provider, model: ctx.model.id, timestamp: ++timestamp,
    stopReason: "stop", content: [], usage: { cacheRead: 0, cacheWrite: 0 }, ...overrides,
  } });
  const response = async (id, usage, type = "response.done") => {
    await raw("response.created", { id });
    await raw(type, { id, usage });
  };
  try { await emit("before_agent_start"); await fn({ cwd, ctx, state, monitor, emit, start, raw, end, response, rows, cacheRows, read, notices }); }
  finally { await monitor.flush(); await rm(cwd, { recursive: true, force: true }); }
}

test("request comparisons preserve missing tools and locate bounded context changes without leaking keys", async () => {
  await withDiagnostics(async ({ start, end, cacheRows }) => {
    const payload = { instructions: "stable-private-system", input: Array.from({ length: 8 }, () => ({ content: "x".repeat(40000) })), prompt_cache_key: "secret-cache-key" };
    await start(payload); await end();
    await start({ ...payload, input: payload.input.map((v, i) => i === 3 ? { content: "changed-private" } : v), prompt_cache_key: "changed-secret-key" }); await end();
    const [first, second] = await cacheRows();
    assert.equal(first.systemChange, "unknown-no-baseline");
    assert.equal(second.systemChange, "same");
    assert.equal(second.cacheKeyChange, "changed");
    assert.equal(second.toolsChange, "unknown-missing");
    assert.equal(second.contextChange, "changed");
    assert.equal(second.contextFirstChange, 3);
    assert.equal(second.contextSegmentsObserved, 8);
    assert.equal(second.promptFingerprint, "unavailable-partial");
    assert.doesNotMatch(JSON.stringify([first, second]), /secret-cache-key|changed-secret-key|stable-private-system|changed-private/);
  });
});

test("partial prefixes never prove whole equality, and known changes after an unreadable segment have no first-position claim", async () => {
  await withDiagnostics(async ({ start, end, cacheRows }) => {
    const input = Array.from({ length: 33 }, () => ({ content: "same" }));
    await start({ input }); await end();
    await start({ input: input.map((v, i) => i === 32 ? { content: "changed" } : v) }); await end();
    const [, row] = await cacheRows();
    assert.equal(row.contextChange, "changed", "small full payload still has a complete fingerprint");
    assert.equal(row.contextSegmentsState, "partial");
    assert.equal(row.contextSegmentsObserved, 32);
    assert.equal(row.contextFirstChange, undefined);
    assert.equal(row.contextPrefixChange, "unknown-partial");
    const huge = [{ content: "x".repeat(300000) }, { content: "before" }];
    await start({ input: huge }); await end();
    await start({ input: [huge[0], { content: "after" }] }); await end();
    const last = (await cacheRows()).at(-1);
    assert.equal(last.contextChange, "unknown-unavailable");
    assert.equal(last.contextFirstChange, undefined);
    assert.equal(last.contextPrefixChange, "unknown-partial");
    await start({ input: "same" }); await end();
    await start({ input: ["same"] }); await end();
    const reshaped = (await cacheRows()).at(-1);
    assert.equal(reshaped.contextChange, "changed");
    assert.equal(reshaped.contextPrefixChange, "unknown-shape");
    assert.equal(reshaped.contextFirstChange, undefined);
  });
});

test("request baselines distinguish models and sessions; overlap and missing keys cannot manufacture equality", async () => {
  await withDiagnostics(async ({ start, end, cacheRows, ctx, emit }) => {
    await start(); await end();
    ctx.model = { ...ctx.model, id: "next-model" };
    await start(); await end();
    assert.equal((await cacheRows()).at(-1).modelChange, "changed");
    assert.equal((await cacheRows()).at(-1).cacheKeyChange, "unknown-missing");
    ctx.sessionManager.getSessionId = () => "next-session";
    await start(); await end();
    assert.equal((await cacheRows()).at(-1).systemChange, "unknown-no-baseline");
    await start(); await start(); await end();
    assert.equal((await cacheRows()).at(-1).comparisonState, "unknown-overlap");
    await emit("agent_settled", { aborted: false });
    await start(); await end();
    assert.equal((await cacheRows()).at(-1).systemChange, "unknown-no-baseline");
  });
});

test("bounded system sections expose stable prefix changes and distinguish missing tools from an observed empty list", async () => {
  await withDiagnostics(async ({ start, end, cacheRows }) => {
    const system = "私".repeat(100000);
    await start({ instructions: system, input: [], tools: [] }); await end();
    await start({ instructions: system.slice(0, 8192) + "变" + system.slice(8193), input: [], tools: [] }); await end();
    const row = (await cacheRows()).at(-1);
    assert.equal(row.systemFingerprint, "unavailable-budget");
    assert.equal(row.systemChange, "changed");
    assert.equal(row.systemFirstChange, 1);
    assert.equal(row.systemSegmentsState, "complete");
    assert.equal(row.toolsChange, "same");
    assert.equal(row.contextSegmentsCount, 0);
    await start({ instructions: system, input: [] }); await end();
    assert.equal((await cacheRows()).at(-1).toolsChange, "unknown-missing");
  });
});

test("projection observations are scoped, consumed once and never infer content equality from counts", async () => {
  await withDiagnostics(async ({ start, end, cacheRows, state, ctx }) => {
    const project = () => state.traceHandoff(ctx, "context.view.observed", { inputMessages: 20, outputMessages: 10, changed: true });
    project(); await start(); await end();
    project(); await start(); await end();
    const [first, second] = await cacheRows();
    assert.equal(first.projectionInputMessages, 20);
    assert.equal(first.projectionOutputMessages, 10);
    assert.equal(second.projectionChange, "same-counts-not-content");
    await start(); await end();
    assert.equal((await cacheRows()).at(-1).projectionState, "unknown-not-associated");
    project(); state.roleContextGeneration++;
    await start(); await end();
    assert.equal((await cacheRows()).at(-1).projectionState, "unknown-not-associated");
  });
});

for (const [name, original, rawState, readState, conclusion] of [
  ["usage missing", undefined, "missing", "missing", "unknown"],
  ["cache field missing", { input_tokens: 10 }, "observed", "missing", "unknown"],
  ["explicit zero", { input_tokens_details: { cached_tokens: 0 } }, "observed", "zero", "raw-read-zero"],
  ["positive", { input_tokens_details: { cached_tokens: 37, cache_write_tokens: 4 } }, "observed", "positive", "raw-read-positive"],
  ["invalid usage", null, "invalid", "missing", "unknown"],
]) test(`raw Responses ${name} is not confused with normalized defaults`, async () => {
  await withDiagnostics(async ({ start, response, end, cacheRows }) => {
    await start();
    await response("response-private-id", original);
    await end({ responseId: "response-private-id" });
    const [row] = await cacheRows();
    assert.equal(row.rawUsageState, rawState);
    assert.equal(row.rawReadState, readState);
    assert.equal(row.cacheConclusion, conclusion);
    assert.equal(row.normalizedReadTokens, 0);
    assert.equal(row.rawReadTokens, original?.input_tokens_details?.cached_tokens);
    assert.equal(row.readComparison, conclusion === "unknown" ? "unknown" : readState === "positive" ? "different" : "equal");
  });
});

for (const [value, state] of [["0", "invalid-type"], [NaN, "invalid-format"], [-1, "invalid-range"], [0.5, "invalid-precision"], [Number.MAX_SAFE_INTEGER + 1, "invalid-overflow"]]) {
  test(`raw cache count ${state} stays unknown`, async () => {
    await withDiagnostics(async ({ start, response, end, cacheRows }) => {
      await start(); await response("id", { input_tokens_details: { cached_tokens: value } }); await end({ responseId: "id" });
      const [row] = await cacheRows();
      assert.equal(row.rawReadState, state);
      assert.equal(row.rawReadTokens, undefined);
      assert.equal(row.cacheConclusion, "unknown");
    });
  });
}

test("raw failure, HTTP error, abort and missing assistant never become confirmed zero or positive", async () => {
  for (const kind of ["failed", "http", "aborted", "missing-assistant", "raw-failed"]) await withDiagnostics(async ({ start, response, end, emit, cacheRows }) => {
    await start(); await response("id", { input_tokens_details: { cached_tokens: 25 } }, kind === "raw-failed" ? "response.failed" : "response.done");
    if (kind === "http") await emit("after_provider_response", { status: 503 });
    if (kind === "missing-assistant") await emit("agent_settled", { aborted: false });
    else await end({ responseId: "id", stopReason: kind === "failed" ? "error" : kind === "aborted" ? "aborted" : "stop" });
    const [row] = await cacheRows();
    assert.equal(row.cacheConclusion, "unknown", kind);
    assert.equal(row.readComparison, "unknown", kind);
    assert.equal(row.rawReadTokens, 25, "the observed field remains evidence, not a successful outcome");
  });
});

test("Anthropic start and delta usage merge only supplied counters", async () => {
  await withDiagnostics(async ({ ctx, start, emit, end, cacheRows }) => {
    ctx.model = { provider: "anthropic", id: "claude", api: "anthropic-messages" };
    await start({ system: "private-anthropic", messages: [], tools: [] });
    const envelope = { provider: "anthropic", model: "claude", api: "anthropic-messages" };
    await emit("provider_stream_event", { ...envelope, data: { type: "message_start", message: { id: "msg-private", usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 123 } } } });
    await emit("provider_stream_event", { ...envelope, data: { type: "message_delta", usage: { cache_read_input_tokens: 7, output_tokens: 5 } } });
    await end({ responseId: "msg-private", usage: { cacheRead: 7, cacheWrite: 123 } });
    const [row] = await cacheRows();
    assert.equal(row.rawReadTokens, 7);
    assert.equal(row.rawWriteTokens, 123);
    assert.equal(row.cacheConclusion, "raw-read-positive");
    assert.equal(row.readComparison, "equal");
  });
});

test("missing or invalid raw response identities cannot establish cache association", async () => {
  for (const id of [undefined, "", 123, "x".repeat(513)]) await withDiagnostics(async ({ start, raw, end, cacheRows }) => {
    await start();
    await raw("response.created", { id });
    await raw("response.done", { id, usage: { input_tokens_details: { cached_tokens: 8 } } });
    await end();
    const [row] = await cacheRows();
    assert.match(row.correlation, /^unknown-/);
    assert.equal(row.cacheConclusion, "unknown");
  });
});

test("Anthropic deltas without a matching message start retain counters but not a confirmed hit", async () => {
  await withDiagnostics(async ({ ctx, start, emit, end, cacheRows }) => {
    ctx.model = { provider: "anthropic", id: "claude", api: "anthropic-messages" };
    await start();
    await emit("provider_stream_event", { provider: "anthropic", model: "claude", api: "anthropic-messages",
      data: { type: "message_delta", usage: { cache_read_input_tokens: 8 } } });
    await end();
    const [row] = await cacheRows();
    assert.equal(row.rawReadTokens, 8);
    assert.equal(row.correlation, "unknown-response-start");
    assert.equal(row.cacheConclusion, "unknown");
  });
});

test("duplicate raw terminals and assistant finalization do not duplicate requests or sum tokens", async () => {
  await withDiagnostics(async ({ start, raw, end, emit, cacheRows }) => {
    await start(); await raw("response.created", { id: "id" });
    const terminal = { id: "id", usage: { input_tokens_details: { cached_tokens: 8 } } };
    await raw("response.done", terminal); await raw("response.done", terminal);
    const message = { role: "assistant", provider: "openai-codex", model: "model", responseId: "id", timestamp: 12, stopReason: "stop", content: [], usage: { cacheRead: 8, cacheWrite: 0 } };
    await emit("message_end", { message }); await emit("message_end", { message });
    await end();
    const rows = await cacheRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rawReadTokens, 8);
    assert.equal(rows[0].duplicateUsageEvents, 1);
    assert.equal(rows[0].usageEvents, 1);
  });
});

for (const kind of ["model", "raw-response-id", "assistant-response-id", "assistant-identity", "missing-created", "conflicting-terminal", "overlap", "completed-response"]) {
  test(`unreliable association (${kind}) is explicit, never a cache hit`, async () => {
    await withDiagnostics(async ({ start, raw, response, end, emit, cacheRows }) => {
      if (kind === "completed-response") { await start(); await response("id", { input_tokens_details: { cached_tokens: 3 } }); await end({ responseId: "id" }); }
      await start();
      if (kind === "overlap") await start();
      if (kind !== "missing-created") await raw("response.created", { id: "id" });
      await raw("response.done", { id: kind === "raw-response-id" ? "other-id" : "id", usage: { input_tokens_details: { cached_tokens: 9 } } }, kind === "model" ? { model: "other-model" } : {});
      if (kind === "conflicting-terminal") await raw("response.done", { id: "id", usage: { input_tokens_details: { cached_tokens: 11 } } });
      if (kind === "assistant-identity") await emit("message_start", { message: { role: "assistant", provider: "openai-codex", model: "model", timestamp: 999 } });
      await end({ responseId: kind === "assistant-response-id" ? "other-id" : "id" });
      const row = (await cacheRows()).at(-1);
      assert.match(row.correlation, /^unknown-/);
      assert.equal(row.cacheConclusion, "unknown");
      assert.equal(row.rawUsageState, "association-unknown");
    });
  });
}

test("new turn retires an unfinished request and recovers normal observation without replaying it", async () => {
  await withDiagnostics(async ({ emit, start, response, end, cacheRows }) => {
    await start(); await start();
    await emit("turn_start");
    await start(); await response("new-id", { input_tokens_details: { cached_tokens: 6 } }); await end({ responseId: "new-id" });
    const rows = await cacheRows();
    assert.deepEqual(rows.map(row => row.cacheOutcome), ["superseded", "turn-change", "assistant"]);
    assert.equal(rows.at(-1).cacheConclusion, "raw-read-positive");
  });
});

for (const boundary of ["branch", "session", "cwd", "context", "role", "compaction", "model", "untrusted"]) {
  test(`request observations do not leak across ${boundary} changes`, async () => {
    await withDiagnostics(async ({ ctx, state, emit, start, raw, response, end, cacheRows }) => {
      await start(); await raw("response.created", { id: "old-id" });
      if (boundary === "branch") await emit("session_tree");
      if (boundary === "session") ctx.sessionManager.getSessionId = () => "new-session";
      if (boundary === "cwd") { ctx.cwd += "/other"; await raw("response.done", { id: "old-id" }); ctx.cwd = ctx.cwd.slice(0, -6); }
      if (boundary === "context") state.roleContextGeneration++;
      if (boundary === "role") state.roleTransitionGeneration++;
      if (boundary === "compaction") await emit("session_before_compact");
      if (boundary === "model") { await emit("model_select"); ctx.model = { ...ctx.model, id: "new-model" }; }
      if (boundary === "untrusted") { ctx.isProjectTrusted = () => false; await raw("response.done", { id: "old-id" }); ctx.isProjectTrusted = () => true; }
      await raw("response.done", { id: "old-id", usage: { input_tokens_details: { cached_tokens: 99 } } });
      await end({ responseId: "old-id" });
      await emit("turn_start"); await start(); await response("new-id", { input_tokens_details: { cached_tokens: 5 } }); await end({ responseId: "new-id" });
      const rows = await cacheRows();
      assert.equal(rows.filter(row => row.cacheConclusion === "raw-read-positive").length, 1);
      assert.equal(rows.at(-1).rawReadTokens, 5);
    });
  });
}

test("unavailable hook, silent hook and unsupported API remain distinct from missing fields", async () => {
  for (const kind of ["unavailable", "silent", "unsupported-api", "stream-without-usage"]) await withDiagnostics(async ({ ctx, start, emit, end, cacheRows }) => {
    if (kind === "unsupported-api") ctx.model = { ...ctx.model, api: "custom-api" };
    await start();
    if (["unsupported-api", "stream-without-usage"].includes(kind)) await emit("provider_stream_event", { provider: ctx.model.provider, model: ctx.model.id, api: ctx.model.api, data: { type: "text_delta", text: "private-stream" } });
    await end();
    const [row] = await cacheRows();
    assert.equal(row.rawUsageState, kind === "unsupported-api" ? "unsupported-api" : kind === "stream-without-usage" ? "missing" : "no-observation");
    assert.equal(row.streamHook, kind === "unavailable" ? "unavailable" : kind === "silent" ? "not-observed-or-unsupported" : "observed");
    assert.equal(row.cacheConclusion, "unknown");
  }, { unsupportedHook: kind === "unavailable" });
});

test("selected prompt fingerprints are runtime-keyed, stage-specific and sensitive data never lands in either log", async () => {
  let previousFingerprint;
  for (let instance = 0; instance < 2; instance++) await withDiagnostics(async ({ ctx, state, start, response, end, cacheRows, read, emit }) => {
    state.activeRole = { role: "developer-test", provider: ctx.model.provider, model: ctx.model.id, thinkingLevel: "high" };
    const payload = { instructions: "private-system", input: [{ role: "user", content: "private-context" }], tools: [{ name: "private-tool", schema: {} }],
      prompt_cache_key: "private-key", headers: { authorization: "private-token" }, apiKey: "private-api-key" };
    const before = structuredClone(payload);
    for (let i = 0; i < 3; i++) {
      assert.equal(await start(payload), undefined);
      await emit("before_provider_headers", { headers: { authorization: "private-header" } });
      await response("private-response-id-" + i, { input_tokens_details: { cached_tokens: 4 }, secret: "private-usage" });
      await end({ responseId: "private-response-id-" + i, usage: { cacheRead: 4, cacheWrite: 0 }, content: [{ type: "text", text: "private-response" }] });
      if (i === 1) payload.input.push({ role: "user", content: "private-more-context" });
    }
    const rows = await cacheRows();
    assert.equal(rows[0].contextFingerprint, rows[1].contextFingerprint);
    assert.notEqual(rows[1].contextFingerprint, rows[2].contextFingerprint);
    assert.equal(rows[0].systemFingerprint, rows[2].systemFingerprint);
    assert.equal(rows[0].toolsFingerprint, rows[2].toolsFingerprint);
    assert.match(rows[0].promptFingerprint, /^hmac:[a-f0-9]{32}$/);
    if (instance) assert.notEqual(previousFingerprint, rows[0].promptFingerprint);
    previousFingerprint = rows[0].promptFingerprint;
    assert.equal(rows[0].cacheKeyPresence, "present");
    assert.equal(rows[0].requestStage, "before_provider_request");
    assert.equal(rows[0].usageStage, "provider_stream_event:parsed-before-normalization");
    assert.equal(rows[0].transport, "unavailable"); assert.equal(rows[0].requestForm, "unavailable");
    assert.deepEqual(payload.instructions, before.instructions);
    assert.deepEqual(payload.tools, before.tools);
    const logs = JSON.stringify([rows, await read("logs/handoff.jsonl")]);
    assert.equal(logs.includes("private-"), false);
    assert.equal(logs.includes(ctx.cwd), false);
  }, { mode: "verbose" });
});

test("fingerprint budgets, malformed observations and excessive usage cannot interrupt execution", async () => {
  await withDiagnostics(async ({ start, raw, end, cacheRows }) => {
    const cyclic = {}; cyclic.self = cyclic;
    await start({ instructions: "x".repeat(300 * 1024), input: cyclic, tools: Array(5000).fill({}) });
    await raw("response.created", { id: "id" });
    for (let i = 0; i < 25; i++) await raw("response.done", { id: "id", usage: { input_tokens_details: { cached_tokens: i } } });
    await end({ responseId: "id" });
    const [row] = await cacheRows();
    assert.equal(row.systemFingerprint, "unavailable-budget");
    assert.equal(row.contextFingerprint, "unavailable-budget");
    assert.equal(row.toolsFingerprint, "unavailable-budget");
    assert.equal(row.promptFingerprint, "unavailable-partial");
    assert.equal(row.cacheConclusion, "unknown");
    assert.equal(row.usageEvents, 17);
    assert.ok(Buffer.byteLength(JSON.stringify(row)) < 4096);
  });
  await withDiagnostics(async ({ start, raw, end, cacheRows }) => {
    const broken = {}; Object.defineProperty(broken, "response", { get() { throw new Error("private-error"); } });
    await start(); await raw("ignored", {}, { data: broken }); await end();
    assert.equal((await cacheRows())[0].rawUsageState, "observation-error");
  });
});

test("automatic and verbose reports include raw unknown/zero/positive and do not claim cache causes", async () => {
  for (const mode of ["automatic", "verbose"]) await withDiagnostics(async ({ ctx, monitor, start, response, end, emit, cacheRows }) => {
    for (const [i, cached] of [undefined, 0, 12].entries()) {
      await start(); await response("id-" + i, { input_tokens_details: { cached_tokens: cached } }); await end({ responseId: "id-" + i });
    }
    await emit("agent_settled", { aborted: false });
    assert.equal((await cacheRows()).length, 3);
    const report = await monitor.report(ctx);
    assert.match(report, /原始读字段正值：1；显式零：1；未知：1/);
    assert.match(report, /transport\/full-delta unavailable/);
    assert.match(report, /不等于最终网络请求/);
  }, { mode });
});

test("request records share runtime rotation, bounded queues, off/trust guards and write-failure isolation", async () => {
  await withDiagnostics(async ({ cwd, start, end, monitor, cacheRows, emit }) => {
    for (let i = 0; i < 150; i++) { await start(); await end(); }
    await monitor.flush();
    await start(); await end();
    const rows = await cacheRows();
    assert.ok(rows.some(row => row.dropped > 0));
    for (let i = 0; i < 130; i++) { await start(); await end(); await monitor.flush(); }
    const files = await readdir(join(cwd, ".pi/diagnostics"));
    assert.deepEqual(files.sort(), ["runtime.jsonl", "runtime.jsonl.1"]);
    for (const file of files) assert.ok((await stat(join(cwd, ".pi/diagnostics", file))).size <= 128 * 1024);
    await emit("session_shutdown");
  }, { maxBytes: 128 * 1024 });
  for (const mode of ["off", "automatic"]) await withDiagnostics(async ({ cwd, ctx, start, end, monitor }) => {
    if (mode === "automatic") ctx.isProjectTrusted = () => false;
    await start(); await end(); await monitor.flush();
    assert.deepEqual(await readdir(cwd), []);
  }, { mode });
  await withDiagnostics(async ({ cwd, start, end, monitor, notices }) => {
    await writeFile(join(cwd, ".pi"), "blocked");
    await start(); await end(); await monitor.flush();
    await start(); await end(); await monitor.flush();
    assert.equal(notices.length, 1);
  });
});
