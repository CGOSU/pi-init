import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentSession, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { createAutoModelRuntime } from "../extensions/auto-model-runtime.ts";
import { createRoleRuntime } from "../extensions/role-runtime.ts";
import { registerRoleTool } from "../extensions/role-tool.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { parseAutoModel, validateAutoModelCapabilities } from "../src/auto-model.ts";
import { mergeRoleConfigData, resolveRoleConfig, resolveRoleModel } from "../src/roles.ts";
import { withTempDirectory } from "./support/temp-directory.js";
import { createExtensionHarness } from "./support/extension-harness.js";
import { configureModelStrategy } from "../extensions/model-strategy-menu.ts";

const fixed = { provider: "test", model: "fixed", initialThinkingLevel: "medium", minThinkingLevel: "low", maxThinkingLevel: "high" };
const roleModels = {
  architect: { provider: "other", model: "architect", thinkingLevel: "high" },
  reviewer: { provider: "other", model: "reviewer", thinkingLevel: "low" },
};
function fixture(cwd = process.cwd(), withAuto = true) {
  const state = createExtensionRuntimeState();
  let config = { mode: "auto", modelStrategy: "auto", autoModel: { ...fixed }, roleModels };
  let thinking = "low";
  const branch = [];
  const handlers = new Map();
  const tools = new Map();
  const errors = [];
  const notices = [];
  let available = true;
  let auth = true;
  let authWait;
  const model = { provider: "test", id: "fixed", reasoning: true };
  const ctx = {
    cwd, model, hasUI: false, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "auto-test", getBranch: () => branch },
    modelRegistry: { find: () => available ? model : undefined, async getApiKeyAndHeaders() { if (authWait) await authWait(); return { ok: auth }; } },
    ui: { notify(message, level) { notices.push({ message, level }); } },
    abort() { ctx.aborted = true; },
  };
  const pi = {
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    appendEntry(customType, data) { branch.push({ type: "custom", customType, data }); },
    registerTool(tool) { tools.set(tool.name, tool); },
    getThinkingLevel: () => thinking,
    setThinkingLevel(level) {
      const previousLevel = thinking;
      thinking = level;
      if (previousLevel !== level) void runner.emit({ type: "thinking_level_select", level, previousLevel });
    },
    async setModel(value) {
      ctx.model = value;
      pi.setThinkingLevel("low");
      return true;
    },
  };
  const runner = new ExtensionRunner([{ path: "auto-test", handlers }], {}, cwd, ctx.sessionManager, {});
  runner.createContext = () => ctx;
  runner.onError(error => errors.push(error));
  const auto = withAuto ? createAutoModelRuntime(pi, state, async () => config) : undefined;
  state.activeRole = { role: "developer-test", provider: "test", model: "fixed", thinkingLevel: thinking };
  return { state, ctx, pi, runner, auto, tools, errors, notices, branch, model,
    get config() { return config; }, set config(value) { config = value; },
    get thinking() { return thinking; }, set thinking(value) { thinking = value; }, set available(value) { available = value; }, set auth(value) { auth = value; }, set authWait(value) { authWait = value; },
    async start() { return runner.emitBeforeAgentStart({ prompt: "Task", messageType: "user" }, { sections: {}, selectedTools: [] }); },
    async manual(level) { const previousLevel = thinking; thinking = level; await runner.emit({ type: "thinking_level_select", level, previousLevel }); },
    async suggest(level, reason = "Task risk assessment", taskBoundary = false) { return auto.suggest(state.activeRole.role, level, reason, ctx, undefined, taskBoundary); },
  };
}

test("Auto config rejects distinct invalid inputs and retains legacy defaults and enabled-role boundaries", () => {
  assert.equal(parseAutoModel(null).code, "AUTO_MODEL_TYPE_INVALID");
  assert.equal(parseAutoModel({ ...fixed, provider: "" }).code, "AUTO_PROVIDER_MISSING");
  assert.equal(parseAutoModel({ ...fixed, initialThinkingLevel: "unknown" }).code, "AUTO_THINKING_LEVEL_INVALID");
  assert.equal(parseAutoModel({ ...fixed, minThinkingLevel: "high" }).code, "AUTO_THINKING_RANGE_INVALID");
  assert.equal(validateAutoModelCapabilities(fixed, ["off"]).code, "AUTO_THINKING_UNSUPPORTED");
  assert.equal(resolveRoleConfig({ modelStrategy: "auto" }).code, "AUTO_MODEL_MISSING");
  assert.equal(resolveRoleConfig({ modelStrategy: "invalid" }).code, "MODEL_STRATEGY_INVALID");
  const original = { schemaVersion: 2, mode: "confirm", roleModels, custom: { keep: true } };
  const merged = mergeRoleConfigData(original, { modelStrategy: "auto", autoModel: fixed });
  assert.deepEqual(merged.roleModels, roleModels);
  assert.deepEqual(merged.custom, original.custom);
  const resolved = resolveRoleConfig(merged).value;
  assert.equal(resolveRoleModel(resolved, "reviewer").value.model, "fixed");
  assert.equal(resolveRoleModel(resolved, "not-enabled").code, "ROLE_NOT_ENABLED");
  assert.equal(resolveRoleModel({ ...resolved, modelStrategy: "roles" }, "reviewer").value.model, "reviewer");
  assert.equal(resolveRoleConfig(original).value.modelStrategy, undefined);
});

test("SDK event chain applies initial strength, then only future requests use a suggested strength", async () => {
  const f = fixture();
  await f.start();
  assert.equal(f.thinking, "medium");
  assert.equal((await f.suggest("high")).ok, true);
  assert.equal(f.thinking, "high");
  assert.equal((await f.suggest("low")).ok, true);
  assert.equal(f.thinking, "low");
  await f.start();
  assert.equal(f.thinking, "low", "ordinary rounds must not reset the adaptive level");
  assert.equal((await f.suggest("low", "New task", true)).code, "AUTO_TASK_BOUNDARY_UNAVAILABLE");
  assert.equal((await f.suggest("high")).ok, true);
  await f.runner.emit({ type: "input", text: "Independent new task", source: "interactive" });
  assert.equal((await f.suggest("low", "Independent new task", true)).ok, true);
  assert.equal(f.thinking, "low");
  assert.equal((await f.suggest("xhigh")).code, "AUTO_THINKING_OUT_OF_RANGE");
  assert.equal((await f.suggest("medium", "")).code, "AUTO_REASON_MISSING");
  assert.deepEqual(f.errors, []);
});

test("real SDK thinking setter and ExtensionRunner preserve own adjustments and detect external manual changes", async () => {
  const f = fixture();
  const history = [];
  const host = {
    agent: { state: { get thinkingLevel() { return f.thinking; }, set thinkingLevel(level) { f.thinking = level; } } },
    getAvailableThinkingLevels: () => getSupportedThinkingLevels(f.model),
    sessionManager: { appendThinkingLevelChange(level) { history.push(level); } },
    _emit() {}, _extensionRunner: f.runner,
  };
  f.pi.setThinkingLevel = level => AgentSession.prototype.setThinkingLevel.call(host, level);
  await f.start();
  assert.equal(f.thinking, "medium");
  assert.equal((await f.suggest("high")).ok, true);
  assert.equal(f.thinking, "high");
  assert.deepEqual(history, ["medium", "high"]);
  AgentSession.prototype.setThinkingLevel.call(host, "low");
  await f.runner.emit({ type: "input", text: "Continue", source: "interactive" });
  assert.equal((await f.suggest("medium")).code, "AUTO_MANUAL_OVERRIDE");
  assert.equal(f.thinking, "low");
});

test("manual thinking selection survives rounds and runtime restoration until explicit resume", async () => {
  const f = fixture();
  await f.start();
  await f.manual("high");
  assert.equal((await f.suggest("low")).code, "AUTO_MANUAL_OVERRIDE");
  await f.start();
  assert.equal(f.thinking, "high");
  const restored = createAutoModelRuntime({ ...f.pi, on() {} }, f.state, async () => f.config);
  assert.equal((await restored.suggest("developer-test", "low", "new task", f.ctx)).code, "AUTO_MANUAL_OVERRIDE");
  await f.auto.resume(f.ctx);
  assert.equal((await f.suggest("low")).ok, true);
  assert.equal(f.thinking, "low");
});

test("manual selection before the first Auto request is not overwritten by the initial level", async () => {
  const f = fixture();
  await f.manual("high");
  await f.start();
  assert.equal(f.thinking, "high");
  assert.equal((await f.suggest("medium")).code, "AUTO_MANUAL_OVERRIDE");
});

test("workflow permits strength increases and decreases within a task without requiring a new boundary", async () => {
  const f = fixture();
  f.state.workflowState = { status: "running", currentTaskId: "one", tasks: [{ id: "one", status: "in_progress" }] };
  await f.start();
  assert.equal((await f.suggest("high")).ok, true);
  f.state.activeRole.role = "docs-commit";
  await f.runner.emit({ type: "input", text: "Continue", source: "extension" });
  assert.equal((await f.suggest("low")).ok, true);
  assert.equal(f.thinking, "low");
  assert.equal((await f.suggest("high")).ok, true);
  assert.equal(f.thinking, "high");
  f.state.workflowState.currentTaskId = "two";
  f.state.workflowState.tasks.push({ id: "two", status: "in_progress" });
  assert.equal((await f.suggest("low")).ok, true);
});

test("Auto cannot bypass stop, role recovery, paused workflow or unknown-result protection", async () => {
  for (const protect of [
    f => { f.state.userStopRequested = true; },
    f => { f.state.roleRecoveryPending = true; },
    f => { f.state.roleRecoveryPersistenceFailed = true; },
    f => { f.state.pendingWorkflowRecovery = {}; },
    f => { f.state.workflowState = { status: "paused", tasks: [] }; },
    f => { f.state.workflowState = { status: "running", currentTaskId: "task", tasks: [{ id: "task", status: "in_progress", outcomeUnknown: true }] }; },
  ]) {
    const f = fixture();
    await f.start();
    protect(f);
    assert.equal((await f.suggest("high")).code, "AUTO_EXECUTION_PROTECTED");
    await assert.rejects(f.auto.resume(f.ctx));
    assert.equal(f.thinking, "medium");
  }
});

test("unavailable, unsupported and unauthenticated fixed models fail without a fallback", async () => {
  for (const setup of [f => { f.available = false; }, f => { f.auth = false; }, f => { f.model.reasoning = false; }]) {
    const f = fixture();
    setup(f);
    await f.start();
    assert.equal(f.ctx.aborted, true);
    assert.equal(f.thinking, "low");
    assert.equal(f.ctx.model.id, "fixed");
    assert.deepEqual(f.errors, []);
  }
  const f = fixture();
  await f.start();
  f.ctx.model = { ...f.model, id: "other" };
  assert.equal((await f.suggest("high")).code, "AUTO_MODEL_MISMATCH");
});

test("own model selection is not a manual override and a mid-run model mismatch aborts before provider use", async () => {
  const f = fixture();
  f.ctx.model = { ...f.model, provider: "other", id: "other" };
  await f.start();
  assert.equal(f.ctx.model.id, "fixed");
  assert.equal(f.thinking, "medium");
  assert.equal((await f.suggest("high")).ok, true);
  f.ctx.model = { ...f.model, id: "manual-other" };
  await f.runner.emitBeforeProviderRequest({ test: true });
  assert.equal(f.ctx.aborted, true);
  assert.equal(f.ctx.model.id, "manual-other", "the guard must not silently replace or replay the request");
});

test("cancelled signals and a host that does not apply the requested level cannot report success", async () => {
  const f = fixture();
  await f.start();
  const controller = new AbortController();
  controller.abort();
  assert.equal((await f.auto.suggest("developer-test", "high", "Complex task", f.ctx, controller.signal)).code, "AUTO_EXECUTION_PROTECTED");
  f.pi.setThinkingLevel = () => {};
  await assert.rejects(f.suggest("high"), /未生效/);
  assert.equal(f.thinking, "medium");
});

test("manual mode and noninteractive confirm mode never silently apply an adjustment", async () => {
  const f = fixture();
  await f.start();
  f.config.mode = "manual";
  assert.equal((await f.suggest("high")).code, "AUTO_MANUAL_MODE");
  f.config.mode = "confirm";
  assert.equal((await f.suggest("high")).code, "AUTO_CANCELLED");
  assert.equal(f.thinking, "medium");
  const initial = fixture();
  initial.config.mode = "manual";
  await initial.start();
  assert.equal(initial.ctx.aborted, true);
  assert.equal(initial.thinking, "low");
});

test("manual choice or stop during an awaited credential check wins over an Auto suggestion", async () => {
  for (const interrupt of [f => f.manual("low"), f => { f.state.userStopRequested = true; }]) {
    const f = fixture();
    await f.start();
    f.authWait = async () => { await interrupt(f); };
    const result = await f.suggest("high");
    assert.equal(result.ok, false);
    assert.notEqual(f.thinking, "high");
  }
});

test("switch_role strength entry does not capture a role handoff or terminate/replay the current run", async () => {
  const f = fixture();
  await f.start();
  registerRoleTool(f.pi, f.state, { roleRuntime: { suggestThinking: f.auto.suggest },
    roleHandoff: { checkSwitchRole: () => ({ allowed: true }), capture() { assert.fail("strength adjustment must not create a role handoff"); } },
    userControl: {}, observeRejection() { assert.fail("valid strength adjustment is not a rejection"); },
  });
  const tool = f.tools.get("switch_role");
  const result = await tool.execute("adjust", { role: "developer-test", thinkingLevel: "high", reason: "High risk" }, new AbortController().signal, undefined, f.ctx);
  assert.equal(result.details.ok, true);
  assert.equal(result.details.thinkingLevel, "high");
  assert.equal(result.terminate, undefined);
  assert.equal(f.state.roleTransitionGeneration, 0);
  assert.equal(f.state.activeRole.role, "developer-test");
});

test("interactive confirmation accepts, cancels and respects a stop during the prompt", async () => {
  for (const decision of ["accept", "cancel", "stop", "manual"]) {
    const f = fixture();
    await f.start();
    f.config.mode = "confirm";
    f.ctx.hasUI = true;
    f.ctx.mode = "tui";
    const harness = createExtensionHarness([], { mode: "tui", custom: async call => {
      if (decision === "cancel") call.component.handleInput("\u001b[B");
      if (decision === "stop") f.state.userStopRequested = true;
      if (decision === "manual") await f.manual("low");
      call.component.handleInput("\n");
    } });
    f.ctx.ui = harness.context.ui;
    const result = await f.suggest("high");
    assert.equal(result.ok, decision === "accept");
    assert.equal(f.thinking, decision === "accept" ? "high" : decision === "manual" ? "low" : "medium");
  }
});

test("model strategy picker stages only a complete valid selection and cancellation preserves configuration", async () => {
  for (const cancelAt of [1, 2, 4, 5, undefined]) {
    let step = 0;
    let config = { mode: "auto", roleModels };
    const keys = [["\u001b[B", "\n"], ["\n"], ["\u001b[B", "\u001b[B", "\u001b[B", "\n"], ["\u001b[B", "\u001b[B", "\n"], ["\u001b[B", "\n"]];
    const harness = createExtensionHarness([], { mode: "tui", availableModels: [{ provider: "test", id: "fixed", reasoning: true }], custom: async call => {
      const current = ++step;
      for (const key of current === cancelAt ? ["\u0003"] : keys[current - 1]) call.component.handleInput(key);
    } });
    await configureModelStrategy(harness.context, config, { stageRoleConfig(changes) { config = resolveRoleConfig(config, changes).value; } });
    assert.equal(config.modelStrategy, cancelAt === undefined ? "auto" : undefined);
    assert.deepEqual(config.roleModels, roleModels);
    if (cancelAt === undefined) assert.deepEqual(config.autoModel, fixed);
  }
});

test("staging/save/reload retains inactive role mappings and unrelated project configuration", async () => {
  await withTempDirectory(async cwd => {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    const path = join(cwd, ".pi", "role-models.json");
    const original = { schemaVersion: 2, mode: "auto", workflowMode: "auto", roleModels, custom: { keep: true } };
    await writeFile(path, JSON.stringify(original));
    const f = fixture(cwd, false);
    const runtime = createRoleRuntime(f.pi, f.state, { activityStatus: { setRole() {} }, acknowledgeRoleRecovery() {} });
    runtime.stageRoleConfig({ modelStrategy: "auto", autoModel: fixed });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), original);
    assert.equal((await runtime.readSessionRoleConfig(f.ctx)).modelStrategy, "auto");
    assert.equal((await runtime.saveRoleConfig(f.ctx)).ok, true);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(saved.roleModels, roleModels);
    assert.deepEqual(saved.custom, original.custom);
    assert.deepEqual(saved.autoModel, fixed);
    assert.equal(runtime.hasPendingRoleConfigChanges(), false);
    assert.equal((await runtime.readSessionRoleConfig(f.ctx)).modelStrategy, "auto");
    await runtime.automaticRole("reviewer", f.ctx);
    assert.equal(f.state.activeRole.model, "fixed");
    assert.equal(f.thinking, "medium");
    await runtime.suggestThinking("reviewer", "high", "Complex review", f.ctx);
    await runtime.automaticRole("architect", f.ctx);
    assert.equal(f.thinking, "high");
    runtime.stageRoleConfig({ modelStrategy: "roles" });
    assert.equal(resolveRoleModel(await runtime.readSessionRoleConfig(f.ctx), "reviewer").value.model, "reviewer");
  });
});
