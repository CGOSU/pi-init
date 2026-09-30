import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";
import {
  DEFAULT_ROLE_MODELS,
  mergeRoleConfig,
  resolveRoleConfig,
  resolveRoleModel,
  serializeRoleConfig,
} from "../src/roles.js";

const { createScaffold, path, readFile, withTempDirectory } = helpers;

test("角色档位解析提供直接模型映射，单角色变更不影响同档位角色", () => {
  const config = {
    schemaVersion: 3,
    roleTiers: {
      architect: "deep",
      "developer-test": "balanced",
      "docs-commit": "balanced",
    },
    tiers: {
      deep: { modelRef: "reasoning-model", thinkingLevel: "high" },
      balanced: { modelRef: "coding-model", thinkingLevel: "medium" },
    },
    models: {
      "reasoning-model": { provider: "provider-a", model: "reasoning-v6" },
      "coding-model": { provider: "provider-a", model: "coding-v6" },
    },
  };
  const resolved = resolveRoleConfig(config);

  assert.deepEqual(resolved.roleModels["developer-test"], {
    provider: "provider-a",
    model: "coding-v6",
    thinkingLevel: "medium",
  });
  assert.deepEqual(resolveRoleModel(resolved, "docs-commit"), resolved.roleModels["developer-test"]);
  assert.equal(serializeRoleConfig(resolved).roleModels, undefined);
  assert.deepEqual(resolveRoleConfig(serializeRoleConfig(resolved)).roleModels, resolved.roleModels);

  const changed = resolveRoleConfig(mergeRoleConfig(resolved, {
    roleModels: {
      "docs-commit": { provider: "provider-b", model: "writer-v1", thinkingLevel: "low" },
    },
  }));
  assert.equal(changed.roleTiers["developer-test"], "balanced");
  assert.notEqual(changed.roleTiers["docs-commit"], "balanced");
  assert.equal(changed.roleModels["developer-test"].model, "coding-v6");
  assert.equal(changed.roleModels["docs-commit"].model, "writer-v1");
});

test("v1/v2 与旧式角色映射可迁移到分层 schema，等价角色共享档位", () => {
  const legacy = {
    schemaVersion: 2,
    roleModels: {
      writer: { provider: "provider-a", model: "model-v5", thinkingLevel: "medium" },
      reviewer: { provider: "provider-a", model: "model-v5", thinkingLevel: "medium" },
      architect: { provider: "provider-a", model: "model-v5", thinkingLevel: "high" },
    },
  };
  const migrated = resolveRoleConfig(legacy);
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.roleTiers.writer, migrated.roleTiers.reviewer);
  assert.notEqual(migrated.roleTiers.writer, migrated.roleTiers.architect);
  assert.deepEqual(migrated.roleModels.writer, legacy.roleModels.writer);
  assert.deepEqual(migrated.roleModels.architect, legacy.roleModels.architect);
  assert.equal(serializeRoleConfig(legacy).roleModels, undefined);

  const v1 = resolveRoleConfig({
    schemaVersion: 1,
    roleModels: {
      editor: { provider: "provider-v1", model: "model-v1", thinkingLevel: "low" },
    },
  });
  assert.deepEqual(v1.roleModels.editor, {
    provider: "provider-v1",
    model: "model-v1",
    thinkingLevel: "low",
  });

  const oldTopLevel = resolveRoleConfig({
    architect: { provider: "provider-b", model: "model-new", thinkingLevel: "max" },
  });
  assert.equal(oldTopLevel.schemaVersion, 3);
  assert.deepEqual(oldTopLevel.roleModels.architect, {
    provider: "provider-b",
    model: "model-new",
    thinkingLevel: "max",
  });
  assert.deepEqual(oldTopLevel.roleModels["developer-test"], DEFAULT_ROLE_MODELS["developer-test"]);
});

test("分层角色配置拒绝缺失引用、重复模型与无效档位", () => {
  const config = {
    schemaVersion: 3,
    roleTiers: { editor: "balanced" },
    tiers: { balanced: { modelRef: "model-a", thinkingLevel: "medium" } },
    models: { "model-a": { provider: "provider-a", model: "model-v6" } },
  };

  assert.throws(() => resolveRoleConfig({ ...config, roleTiers: { editor: "missing" } }), /未配置的档位/);
  assert.throws(() => resolveRoleConfig({
    ...config,
    tiers: { balanced: { modelRef: "missing", thinkingLevel: "medium" } },
  }), /未配置的模型/);
  assert.throws(() => resolveRoleConfig({
    ...config,
    models: { ...config.models, duplicate: { provider: "provider-a", model: "model-v6" } },
  }), /provider\/model 重复/);
  assert.throws(() => resolveRoleConfig({
    ...config,
    tiers: { balanced: { modelRef: "model-a", thinkingLevel: "invalid" } },
  }), /thinkingLevel 无效/);
  assert.throws(() => resolveRoleConfig({ schemaVersion: 3, roleTiers: {}, tiers: {} }), /缺少 models/);
});

test("无效职责配置会被拒绝", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "invalid-app");
    const roleModels = {
      architect: {
        provider: "provider",
        model: "model",
        thinkingLevel: "invalid",
      },
    };

    assert.throws(() => resolveRoleConfig(roleModels), /thinkingLevel 无效/);
    await assert.rejects(createScaffold(target, { roleModels }), /thinkingLevel 无效/);
    await assert.rejects(readFile(path.join(target, ".pi/role-models.json"), "utf8"), { code: "ENOENT" });
  });
});
