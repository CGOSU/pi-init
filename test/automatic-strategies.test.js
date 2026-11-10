import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRoleRuntime } from "../extensions/role-runtime.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { createExtensionHarness, emitExtensionEvent } from "./support/extension-harness.js";
import { withTempDirectory } from "./support/temp-directory.js";

const mappedModel = { provider: "test", id: "reviewer" };
const fixedModel = { provider: "test", id: "fixed", reasoning: true };
const fixed = {
  provider: fixedModel.provider, model: fixedModel.id,
  initialThinkingLevel: "medium", minThinkingLevel: "low", maxThinkingLevel: "high",
  customFixed: { retained: true },
};
const roleModels = {
  reviewer: { provider: mappedModel.provider, model: mappedModel.id, thinkingLevel: "high", customRole: "retained" },
};

function runtimeFor(cwd) {
  const state = createExtensionRuntimeState();
  let thinking = "low";
  const ctx = {
    cwd, model: mappedModel, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "strategies", getBranch: () => [] },
    modelRegistry: {
      find(provider, id) { return [mappedModel, fixedModel].find(model => model.provider === provider && model.id === id); },
      async getApiKeyAndHeaders() { return { ok: true }; },
    },
    ui: { notify() { } },
  };
  const pi = {
    on() { }, appendEntry() { }, getThinkingLevel: () => thinking,
    setThinkingLevel(level) { thinking = level; },
    async setModel(model) { ctx.model = model; return true; },
  };
  const runtime = createRoleRuntime(pi, state, {
    activityStatus: { setRole() { } }, getWorkflowState: () => state.workflowState,
    acknowledgeRoleRecovery() { state.roleRecoveryPending = false; },
  });
  return { state, ctx, pi, runtime };
}

async function writeConfig(cwd, config) {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const path = join(cwd, ".pi", "role-models.json");
  const original = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(path, original);
  return { path, original };
}

test("旧 confirm/manual 配置加载、保存与 reload 都不提升授权，显式启用后才迁移", async () => {
  for (const mode of ["confirm", "manual"]) {
    await withTempDirectory(async cwd => {
      const { path, original } = await writeConfig(cwd, {
        schemaVersion: 2, mode, modelStrategy: "roles", autoModel: fixed, roleModels,
        custom: { retained: true },
      });
      const f = runtimeFor(cwd);
      assert.equal((await f.runtime.readSessionRoleConfig(f.ctx)).requiresAutomaticMigration, true);
      await assert.rejects(f.runtime.automaticRole("reviewer", f.ctx), error => error.code === "AUTOMATIC_MIGRATION_REQUIRED");
      assert.equal((await f.runtime.saveRoleConfig(f.ctx)).ok, false);
      assert.equal(await readFile(path, "utf8"), original);
      const reloaded = runtimeFor(cwd);
      await assert.rejects(reloaded.runtime.automaticRole("reviewer", reloaded.ctx), error => error.code === "AUTOMATIC_MIGRATION_REQUIRED");
      assert.equal(await readFile(path, "utf8"), original);
      await f.runtime.enableAutomaticSwitching(f.ctx);
      assert.equal(await readFile(path, "utf8"), original);
      assert.equal((await f.runtime.automaticRole("reviewer", f.ctx)).result.model, mappedModel.id);
      assert.equal((await f.runtime.saveRoleConfig(f.ctx)).ok, true);
      const saved = JSON.parse(await readFile(path, "utf8"));
      assert.equal(saved.schemaVersion, 3);
      assert.equal("mode" in saved, false);
      assert.equal("requiresAutomaticMigration" in saved, false);
      assert.deepEqual(saved.roleModels, roleModels);
      assert.deepEqual(saved.autoModel, fixed);
      assert.deepEqual(saved.custom, { retained: true });
      const migrated = runtimeFor(cwd);
      assert.equal((await migrated.runtime.automaticRole("reviewer", migrated.ctx)).result.model, mappedModel.id);
    });
  }
});

test("两种策略反复切换保留配置：角色映射强度与固定模型自适应互不叠加", async () => {
  await withTempDirectory(async cwd => {
    const { path, original } = await writeConfig(cwd, {
      schemaVersion: 3, modelStrategy: "roles", autoModel: fixed, roleModels,
    });
    const f = runtimeFor(cwd);
    assert.equal((await f.runtime.automaticRole("reviewer", f.ctx)).result.thinkingLevel, "high");
    assert.equal((await f.runtime.suggestThinking("reviewer", "low", "Not adaptive", f.ctx)).code, "AUTO_NOT_ENABLED");
    f.runtime.stageRoleConfig({ modelStrategy: "auto" });
    assert.equal((await f.runtime.automaticRole("reviewer", f.ctx)).result.model, fixedModel.id);
    assert.equal(f.pi.getThinkingLevel(), "medium");
    assert.equal((await f.runtime.suggestThinking("reviewer", "low", "Local reversible task", f.ctx)).ok, true);
    await f.runtime.automaticRole("architect", f.ctx);
    assert.equal(f.ctx.model.id, fixedModel.id);
    assert.equal(f.pi.getThinkingLevel(), "low");
    f.runtime.stageRoleConfig({ modelStrategy: "roles" });
    const mapped = await f.runtime.automaticRole("reviewer", f.ctx);
    assert.equal(mapped.result.model, mappedModel.id);
    assert.equal(mapped.result.thinkingLevel, "high");
    f.runtime.stageRoleConfig({ modelStrategy: "auto" });
    await f.runtime.automaticRole("reviewer", f.ctx);
    assert.equal(f.ctx.model.id, fixedModel.id);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal((await f.runtime.saveRoleConfig(f.ctx)).ok, true);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(saved.roleModels, roleModels);
    assert.deepEqual(saved.autoModel, fixed);
    assert.equal(saved.modelStrategy, "auto");
  });
});

test("角色应用等待凭据时停止、取消或宿主手动操作优先，不确认旧请求", async () => {
  for (const interruption of ["stop", "abort", "thinking", "model"]) {
    await withTempDirectory(async cwd => {
      await writeConfig(cwd, { schemaVersion: 3, roleModels });
      const f = runtimeFor(cwd);
      const controller = new AbortController();
      f.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
        if (interruption === "stop") f.state.userStopRequested = true;
        if (interruption === "abort") controller.abort();
        if (interruption === "thinking") f.pi.setThinkingLevel("medium");
        if (interruption === "model") f.ctx.model = fixedModel;
        return { ok: true };
      };
      await assert.rejects(f.runtime.automaticRole("reviewer", f.ctx, controller.signal), error =>
        error.code === (["stop", "abort"].includes(interruption) ? "ROLE_EXECUTION_PROTECTED" : "ROLE_CONTEXT_CHANGED"));
      assert.equal(f.pi.getThinkingLevel(), interruption === "thinking" ? "medium" : "low");
      assert.equal(f.ctx.model.id, interruption === "model" ? fixedModel.id : mappedModel.id);
      assert.equal(f.state.activeRole, undefined);
    });
  }
});

test("固定模型的显式职责确认也不能绕过等待期间的工具取消", async () => {
  await withTempDirectory(async cwd => {
    await writeConfig(cwd, { schemaVersion: 3, modelStrategy: "auto", autoModel: fixed, roleModels });
    const f = runtimeFor(cwd);
    const controller = new AbortController();
    f.ctx.modelRegistry.getApiKeyAndHeaders = async () => {
      controller.abort();
      return { ok: true };
    };
    await assert.rejects(f.runtime.automaticRole("reviewer", f.ctx, controller.signal), /保护阻止/);
    assert.equal(f.ctx.model.id, mappedModel.id);
    assert.equal(f.pi.getThinkingLevel(), "low");
    assert.equal(f.state.activeRole, undefined);
  });
});

test("宿主未实际应用配置时不误报职责切换成功", async () => {
  for (const modelStrategy of ["roles", "auto"]) {
    await withTempDirectory(async cwd => {
      await writeConfig(cwd, { schemaVersion: 3, modelStrategy, autoModel: fixed, roleModels });
      const f = runtimeFor(cwd);
      if (modelStrategy === "roles") f.pi.setThinkingLevel = () => { };
      else f.pi.setModel = async () => true;
      await assert.rejects(f.runtime.automaticRole("reviewer", f.ctx), /未.*生效/);
      assert.equal(f.state.activeRole, undefined);
      assert.equal(f.pi.getThinkingLevel(), "low");
    });
  }
});

test("模式命令已退役且不能被旧命令重新启用，项目加载不改写文件", async () => {
  await withTempDirectory(async cwd => {
    const { path, original } = await writeConfig(cwd, { schemaVersion: 3, roleModels });
    const harness = createExtensionHarness([], { cwd, trusted: true, model: mappedModel, availableModels: [mappedModel] });
    await emitExtensionEvent(harness, "session_start");
    const command = harness.commands.get("pi-init");
    assert.equal(command.getArgumentCompletions("mo"), null);
    assert.equal(command.getArgumentCompletions("mode "), null);
    await command.handler("mode manual", harness.context);
    assert.equal(harness.notifications.at(-1).level, "error");
    const result = await harness.tools.find(tool => tool.name === "switch_role").execute(
      "automatic", { role: "reviewer" }, undefined, undefined, harness.context,
    );
    assert.equal(result.details.model, mappedModel.id);
    assert.equal("mode" in result.details, false);
    assert.equal(await readFile(path, "utf8"), original);
  });
});
