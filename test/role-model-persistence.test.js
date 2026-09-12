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
    assert.match(harness.notifications.at(-1)?.message ?? "", /已切换到/);
  });
});
