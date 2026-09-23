import assert from "node:assert/strict";
import test from "node:test";
import {
  createExtensionHarness,
  emitExtensionEvent,
  mkdir,
  path,
  readFile,
  withTempDirectory,
  writeFile,
} from "./helpers.js";

test("/pi-init save 在命令面板中反馈保存成功与信任校验失败", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, ".pi"), { recursive: true });
    await writeFile(path.join(directory, ".pi", "role-models.json"), JSON.stringify({
      schemaVersion: 2,
      mode: "auto",
      workflowMode: "auto",
      workflowExecutor: "local",
      roleModels: {},
    }));

    const trustedHarness = createExtensionHarness([], { cwd: directory, trusted: true });
    await trustedHarness.commands.get("pi-init").handler("save", trustedHarness.context);
    assert.deepEqual(trustedHarness.notifications.at(-1), {
      message: "角色配置已保存。",
      level: "info",
    });

    const untrustedHarness = createExtensionHarness([], { cwd: directory, trusted: false });
    await untrustedHarness.commands.get("pi-init").handler("save", untrustedHarness.context);
    assert.deepEqual(untrustedHarness.notifications.at(-1), {
      message: "保存角色配置仅允许在受信任项目中运行；请先信任当前项目",
      level: "error",
    });
  });
});

test("手动模式内部角色切换不会把目标模型写回旧角色", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, ".pi"), { recursive: true });
    const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };
    const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
    await writeFile(path.join(directory, ".pi", "role-models.json"), JSON.stringify({
      mode: "manual",
      roleModels: {
        architect: { provider: architect.provider, model: architect.id, thinkingLevel: "max" },
        "developer-test": { provider: developer.provider, model: developer.id, thinkingLevel: "max" },
      },
    }));

    const harness = createExtensionHarness([], {
      cwd: directory,
      model: developer,
      availableModels: [developer, architect],
      trusted: true,
      emitModelSelectOnSetModel: true,
    });
    await emitExtensionEvent(harness, "session_start");
    await harness.commands.get("pi-init").handler("role architect", harness.context);

    const persisted = JSON.parse(await readFile(path.join(directory, ".pi", "role-models.json"), "utf8"));
    assert.deepEqual(persisted.roleModels.architect, {
      provider: architect.provider,
      model: architect.id,
      thinkingLevel: "max",
    });
    assert.deepEqual(persisted.roleModels["developer-test"], {
      provider: developer.provider,
      model: developer.id,
      thinkingLevel: "max",
    });
  });
});
