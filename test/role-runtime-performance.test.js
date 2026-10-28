import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDirectory } from "./helpers.js";
import { createRoleRuntime } from "../extensions/role-runtime.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";

function fixture(cwd) {
  const state = createExtensionRuntimeState();
  const counts = { model: 0, thinking: 0, recovery: 0 };
  let thinking = "high";
  const model = { provider: "test", id: "configured" };
  const records = [];
  const ctx = { cwd, model, isProjectTrusted: () => true,
    modelRegistry: { find: () => model, async getApiKeyAndHeaders() { return { ok: true }; } }, ui: { notify() {} } };
  const pi = { on() {}, getThinkingLevel: () => thinking, setThinkingLevel(level) {
    thinking = level; counts.thinking++; records.push({ type: "thinking", level });
  },
    async setModel(value) {
      ctx.model = value; counts.model++;
      records.push({ type: "model", provider: value.provider, model: value.id });
      pi.setThinkingLevel("medium");
      return true;
    } };
  const runtime = createRoleRuntime(pi, state, { activityStatus: { setRole() {} },
    acknowledgeRoleRecovery() { state.roleRecoveryPending = false; counts.recovery++; } });
  return { runtime, state, counts, ctx, records };
}

async function configure(cwd, thinkingLevel = "high") {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "role-models.json"), JSON.stringify({ schemaVersion: 2, mode: "auto",
    roleModels: { "developer-test": { provider: "test", model: "configured", thinkingLevel } } }));
}

test("confirmed identical role is a no-op for model, thinking, recovery and transition generation", async () => {
  await withTempDirectory(async cwd => {
    await configure(cwd);
    const f = fixture(cwd);
    await f.runtime.automaticRole("developer-test", f.ctx);
    const generation = f.state.roleTransitionGeneration;
    const counts = { ...f.counts };
    await f.runtime.automaticRole("developer-test", f.ctx);
    assert.deepEqual(f.counts, counts);
    assert.equal(f.state.roleTransitionGeneration, generation);
    await configure(cwd, "max");
    await f.runtime.automaticRole("developer-test", f.ctx);
    assert.deepEqual(f.records, [{ type: "thinking", level: "max" }]);
    assert.equal(f.state.activeRole.thinkingLevel, "max");
    f.state.roleRecoveryPending = true;
    await f.runtime.automaticRole("developer-test", f.ctx);
    assert.equal(f.counts.recovery, counts.recovery + 2);
    assert.equal(f.state.roleRecoveryPending, false);
  });
});

test("same model role transition confirms the new responsibility without rewriting session model or thinking", async () => {
  await withTempDirectory(async cwd => {
    await configure(cwd);
    const f = fixture(cwd);
    await f.runtime.automaticRole("docs-commit", f.ctx);
    const generation = f.state.roleTransitionGeneration;
    f.state.roleRecoveryPending = true;
    await f.runtime.automaticRole("developer-test", f.ctx);
    assert.deepEqual(f.records, []);
    assert.deepEqual(f.state.activeRole, { role: "developer-test", provider: "test", model: "configured", thinkingLevel: "high" });
    assert.equal(f.state.roleTransitionGeneration, generation + 1);
    assert.equal(f.state.roleRecoveryPending, false);
  });
});

test("real session model, not stale role state, determines whether a model transition is required", async () => {
  await withTempDirectory(async cwd => {
    await configure(cwd);
    const f = fixture(cwd);
    await f.runtime.automaticRole("developer-test", f.ctx);
    f.ctx.model = { provider: "other", id: "configured" };
    await f.runtime.automaticRole("developer-test", f.ctx);
    assert.deepEqual(f.records, [
      { type: "model", provider: "test", model: "configured" },
      { type: "thinking", level: "medium" }, { type: "thinking", level: "high" },
    ]);
    assert.equal(f.ctx.model.provider, "test");
    assert.equal(f.state.activeRole.thinkingLevel, "high");
    f.records.length = 0;
    f.state.activeRole = { ...f.state.activeRole, provider: "stale" };
    await f.runtime.automaticRole("developer-test", f.ctx);
    assert.deepEqual(f.records, []);
    assert.equal(f.state.activeRole.provider, "test");
  });
});

test("role reuse never caches config across calls or hides missing explicit models", async () => {
  await withTempDirectory(async cwd => {
    await configure(cwd);
    const f = fixture(cwd);
    await f.runtime.automaticRole("developer-test", f.ctx);
    f.ctx.modelRegistry.find = () => undefined;
    await assert.rejects(f.runtime.automaticRole("developer-test", f.ctx), error => error.code === "ROLE_MODEL_NOT_AVAILABLE");
    await writeFile(join(cwd, ".pi", "role-models.json"), "invalid-json");
    await assert.rejects(f.runtime.automaticRole("developer-test", f.ctx), /JSON/);
  });
});

test("unmapped default role is reused without incrementing generation or weakening recovery", async () => {
  await withTempDirectory(async cwd => {
    const f = fixture(cwd);
    await f.runtime.automaticRole("docs-commit", f.ctx);
    const generation = f.state.roleTransitionGeneration;
    await f.runtime.automaticRole("docs-commit", f.ctx);
    assert.equal(f.state.roleTransitionGeneration, generation);
    assert.equal(f.counts.recovery, 1);
    f.state.roleRecoveryPersistenceFailed = true;
    await f.runtime.automaticRole("docs-commit", f.ctx);
    assert.equal(f.counts.recovery, 2);
  });
});

