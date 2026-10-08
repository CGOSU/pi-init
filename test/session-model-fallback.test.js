import assert from "node:assert/strict";
import test from "node:test";
import {
  createExtensionHarness,
  DEFAULT_ROLE_NAMES,
  emitExtensionEvent,
  mkdir,
  path,
  readFile,
  withTempDirectory,
  writeFile,
} from "./helpers.js";
import { resolveRoleConfig, unwrapRoleResult } from "../src/roles.ts";

test("无角色配置时标准职责只切换身份并沿用会话模型与推理", async () => {
  await withTempDirectory(async (directory) => {
    const model = { provider: "test-provider", id: "session-model" };
    const harness = createExtensionHarness([], {
      cwd: directory,
      trusted: true,
      model,
      availableModels: [model],
      thinkingLevel: "medium",
    });
    await emitExtensionEvent(harness, "session_start");
    assert.deepEqual(
      harness.commands.get("pi-init").getArgumentCompletions("role ").map(({ value }) => value),
      DEFAULT_ROLE_NAMES,
    );

    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    const result = await switchRole.execute("default-model", { role: "docs-commit" }, undefined, undefined, harness.context);
    assert.equal(harness.context.model, model);
    assert.match(result.content[0].text, /test-provider\/session-model.*medium/);
    await assert.rejects(readFile(path.join(directory, ".pi", "role-models.json")), { code: "ENOENT" });
  });
});

test("schema v2 缺少 roleModels 时使用会话默认且不会补写映射", async () => {
  await withTempDirectory(async (directory) => {
    const configPath = path.join(directory, ".pi", "role-models.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ schemaVersion: 2 }));
    const model = { provider: "test-provider", id: "session-model" };
    const harness = createExtensionHarness([], {
      cwd: directory,
      trusted: true,
      model,
      availableModels: [model],
      thinkingLevel: "medium",
    });
    await emitExtensionEvent(harness, "session_start");

    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    const result = await switchRole.execute("default-model", { role: "developer-test" }, undefined, undefined, harness.context);
    assert.equal(harness.context.model, model);
    assert.match(result.content[0].text, /test-provider\/session-model.*medium/);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { schemaVersion: 2 });
  });
});

test("schema v2 缺省 roleModels 但拒绝显式错误映射类型", () => {
  assert.deepEqual(unwrapRoleResult(resolveRoleConfig({ schemaVersion: 2 })).roleModels, {});
  assert.deepEqual(unwrapRoleResult(resolveRoleConfig({ schemaVersion: 2, roleModels: {} })).roleModels, {});
  for (const roleModels of [null, []]) {
    assert.equal(resolveRoleConfig({ schemaVersion: 2, roleModels }).code, "ROLE_MODELS_INVALID_TYPE");
  }
});

test("手动模式下无映射的活动职责不会因宿主模型切换生成映射", async () => {
  await withTempDirectory(async (directory) => {
    const model = { provider: "test-provider", id: "session-model" };
    const nextModel = { provider: "test-provider", id: "next-session-model" };
    await mkdir(path.join(directory, ".pi"), { recursive: true });
    await writeFile(path.join(directory, ".pi", "role-models.json"), JSON.stringify({
      mode: "manual",
      roleModels: {},
    }));
    const harness = createExtensionHarness([], {
      cwd: directory,
      trusted: true,
      model,
      availableModels: [model, nextModel],
    });
    await emitExtensionEvent(harness, "session_start");
    await harness.commands.get("pi-init").handler("role developer-test", harness.context);

    harness.context.model = nextModel;
    await emitExtensionEvent(harness, "model_select", { model: nextModel, previousModel: model, source: "user" });
    const persisted = JSON.parse(await readFile(path.join(directory, ".pi", "role-models.json"), "utf8"));
    assert.deepEqual(persisted.roleModels, {});
    assert.match(harness.notifications.at(-1).message, /会话默认模型.*不会创建固定映射/);
  });
});
