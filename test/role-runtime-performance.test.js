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
  const ctx = { cwd, model, isProjectTrusted: () => true,
    modelRegistry: { find: () => model }, ui: { notify() {} } };
  const pi = { on() {}, getThinkingLevel: () => thinking, setThinkingLevel(level) { thinking = level; counts.thinking++; },
    async setModel(value) { ctx.model = value; counts.model++; return true; } };
  const runtime = createRoleRuntime(pi, state, { activityStatus: { setRole() {} },
    acknowledgeRoleRecovery() { state.roleRecoveryPending = false; counts.recovery++; } });
  return { runtime, state, counts, ctx };
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
    assert.equal(f.counts.model, counts.model + 1);
    assert.equal(f.state.activeRole.thinkingLevel, "max");
    f.state.roleRecoveryPending = true;
    await f.runtime.automaticRole("developer-test", f.ctx);
    assert.equal(f.counts.recovery, counts.recovery + 2);
    assert.equal(f.state.roleRecoveryPending, false);
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

