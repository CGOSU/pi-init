import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";
import { MENU_BACK, selectRoleModel, showMenu } from "../extensions/ui.ts";

const {
  createExtensionHarness,
  mkdir,
  readFile,
  withTempDirectory,
  writeFile,
  path,
} = helpers;

test("/pi-init sync 提供命令补全并同步指定目录", async () => {
  await withTempDirectory(async (directory) => {
    const target = path.join(directory, "legacy-project");
    await mkdir(target, { recursive: true });
    const harness = createExtensionHarness([], { cwd: directory, hasUI: false });
    const command = harness.commands.get("pi-init");
    assert.ok(command.getArgumentCompletions("s").some((item) => item.value === "sync"));

    await command.handler(`sync ${target}`, harness.context);

    assert.match(await readFile(path.join(target, "AGENTS.md"), "utf8"), /fast-path-wrap-up/);
    assert.equal(harness.reloadCalls.length, 0);
  });
});

test("控制中心提供模板同步入口并在当前项目变更后 reload", async () => {
  await withTempDirectory(async (directory) => {
    let menuCalls = 0;
    const harness = createExtensionHarness([], {
      cwd: directory,
      mode: "tui",
      custom: async (call) => {
        menuCalls += 1;
        if (menuCalls === 1) {
          call.component.handleInput("\u001b[B");
          call.component.handleInput("\u001b[B");
          call.component.handleInput("\n");
        } else {
          call.component.handleInput("\u001b");
        }
      },
    });

    await harness.commands.get("pi-init").handler("", harness.context);

    assert.match(await readFile(path.join(directory, "AGENTS.md"), "utf8"), /fast-path-wrap-up/);
    assert.equal(harness.reloadCalls.length, 1);
  });
});

test("TUI 菜单按 Ctrl+S 显示保存进度和结果并保持菜单", async () => {
  let saveCalls = 0;
  let savingText = "";
  let savedText = "";
  const harness = createExtensionHarness([], {
    mode: "tui",
    custom: async (call) => {
      call.component.handleInput("\u0013");
      savingText = call.component.render(80).join("\n");
      call.component.handleInput("\u0013");
      await new Promise((resolve) => setTimeout(resolve, 0));
      savedText = call.component.render(80).join("\n");
      call.component.handleInput("\u001b");
    },
  });

  const result = await showMenu(harness.context, "测试菜单", [
    { value: "item", label: "菜单项" },
  ], {
    onSave: async () => {
      saveCalls += 1;
      return { ok: true, message: "角色配置已保存。" };
    },
  });

  assert.equal(result, MENU_BACK);
  assert.equal(saveCalls, 1);
  assert.match(savingText, /正在保存/);
  assert.match(savedText, /角色配置已保存/);
});

test("TUI 菜单在当前界面显示保存失败", async () => {
  let savedText = "";
  const harness = createExtensionHarness([], {
    mode: "tui",
    custom: async (call) => {
      call.component.handleInput("\u0013");
      await new Promise((resolve) => setTimeout(resolve, 0));
      savedText = call.component.render(80).join("\n");
      call.component.handleInput("\u001b");
    },
  });

  await showMenu(harness.context, "测试菜单", [
    { value: "item", label: "菜单项" },
  ], {
    onSave: async () => ({ ok: false, message: "项目未受信任" }),
  });

  assert.match(savedText, /项目未受信任/);
});

test("Ctrl+S 在推理强度菜单保存当前完整角色模型配置", async () => {
  const model = {
    provider: "openai-codex",
    id: "gpt-5.6-luna",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  };
  let saveCalls = 0;
  let savedSelection;
  let modelPickerScreen = "";
  let savedScreen = "";
  let customCall = 0;
  const harness = createExtensionHarness([], {
    mode: "tui",
    availableModels: [model],
    custom: async (call) => {
      customCall += 1;
      if (customCall === 1) {
        modelPickerScreen = call.component.render(80).join("\n");
        call.component.handleInput("\n");
        return;
      }
      for (let index = 0; index < 5; index += 1) call.component.handleInput("\u001b[B");
      call.component.handleInput("\u0013");
      await new Promise((resolve) => setTimeout(resolve, 0));
      savedScreen = call.component.render(80).join("\n");
      call.component.handleInput("\n");
    },
  });

  const result = await selectRoleModel(harness.context, "architect", undefined, {
    onSave: async (selection) => {
      saveCalls += 1;
      savedSelection = selection;
      return { ok: true, message: "角色配置已保存。" };
    },
  });

  assert.equal(result.provider, model.provider);
  assert.equal(result.model, model.id);
  assert.equal(result.thinkingLevel, "xhigh");
  assert.equal(saveCalls, 1);
  assert.deepEqual(savedSelection, result);
  assert.doesNotMatch(modelPickerScreen, /Ctrl\+S 保存/);
  assert.match(savedScreen, /角色配置已保存/);
});

test("角色模型菜单按 Ctrl+S 保存当前草稿，应用后不再提示尚未保存", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, ".pi"), { recursive: true });
    await writeFile(path.join(directory, ".pi", "role-models.json"), JSON.stringify({
      schemaVersion: 2,
      mode: "auto",
      roleModels: {
        architect: { provider: "openai-codex", model: "gpt-5.6-sol", thinkingLevel: "max" },
      },
    }));

    const model = {
      provider: "openai-codex",
      id: "gpt-6-sol",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    };
    let customCall = 0;
    let savedScreen = "";
    const harness = createExtensionHarness([], {
      cwd: directory,
      mode: "tui",
      trusted: true,
      availableModels: [model],
      custom: async (call) => {
        customCall += 1;
        if (customCall === 1) {
          call.component.handleInput("\n");
          return;
        }
        for (let index = 0; index < 5; index += 1) call.component.handleInput("\u001b[B");
        call.component.handleInput("\u0013");
        for (let attempt = 0; attempt < 50; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          savedScreen = call.component.render(80).join("\n");
          if (savedScreen.includes("角色配置已保存")) break;
        }
        call.component.handleInput("\n");
      },
    });

    await harness.commands.get("pi-init").handler("config architect", harness.context);

    const persisted = JSON.parse(await readFile(path.join(directory, ".pi", "role-models.json"), "utf8"));
    assert.equal(persisted.roleModels.architect.model, model.id);
    assert.equal(persisted.roleModels.architect.thinkingLevel, "xhigh");
    assert.match(savedScreen, /角色配置已保存/);
    assert.equal(harness.notifications.some(({ message }) => message.includes("尚未保存")), false);
    assert.ok(harness.notifications.some(({ message }) => message.includes("角色配置已保存并应用")));
  });
});

test("选择已持久化的角色模型不会误报尚未保存", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, ".pi"), { recursive: true });
    await writeFile(path.join(directory, ".pi", "role-models.json"), JSON.stringify({
      schemaVersion: 2,
      mode: "auto",
      roleModels: {
        architect: { provider: "openai-codex", model: "gpt-6-sol", thinkingLevel: "max" },
      },
    }));

    const model = {
      provider: "openai-codex",
      id: "gpt-6-sol",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    };
    const harness = createExtensionHarness([], {
      cwd: directory,
      mode: "tui",
      trusted: true,
      availableModels: [model],
      custom: async (call) => {
        call.component.handleInput("\n");
      },
    });

    await harness.commands.get("pi-init").handler("config architect", harness.context);

    assert.equal(harness.notifications.some(({ message }) => message.includes("尚未保存")), false);
    assert.ok(harness.notifications.some(({ message }) => message.includes("角色配置已保存并应用")));
  });
});

test("没有保存能力的 TUI 菜单不拦截 Ctrl+S", async () => {
  const harness = createExtensionHarness([], {
    mode: "tui",
    custom: async (call) => {
      call.component.handleInput("\u0013");
      call.component.handleInput("\n");
    },
  });

  const result = await showMenu(harness.context, "测试菜单", [
    { value: "item", label: "菜单项" },
  ]);

  assert.equal(result, "item");
});
