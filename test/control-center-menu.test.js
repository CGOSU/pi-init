import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";
import { MENU_BACK, selectRoleModel, showMenu } from "../extensions/ui.ts";

const {
  DEFAULT_ROLE_CONFIG,
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
    assert.ok(command);
    assert.ok(command.getArgumentCompletions("s").some((item) => item.value === "sync"));

    await command.handler(`sync ${target}`, harness.context);

    assert.match(await readFile(path.join(target, "AGENTS.md"), "utf8"), /fast-path-wrap-up/);
    assert.match(harness.notifications.at(-1)?.message ?? "", /已同步/);
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
    assert.equal(menuCalls, 1);
    assert.match(harness.notifications.at(-2)?.message ?? "", /已同步/);
  });
});

test("控制中心根菜单提升为初始化、变更、同步、工作流四个分组", async () => {
  const screens = [];
  const harness = createExtensionHarness([], {
    mode: "tui",
    custom: async (call) => {
      screens.push(call.component.render(120).join("\n"));
      call.component.handleInput(screens.length === 1 ? "\n" : "\u001b");
    },
  });

  await harness.commands.get("pi-init").handler("", harness.context);

  assert.match(screens[0], /初始化/);
  assert.match(screens[0], /变更/);
  assert.match(screens[0], /同步/);
  assert.match(screens[0], /工作流/);
  assert.doesNotMatch(screens[0], /◆/);
  assert.match(screens[1], /快速初始化当前项目/);
  assert.match(screens[1], /高级初始化/);
});

test("TUI 菜单在窄宽度下换行显示当前描述", async () => {
  let rendered = "";
  const harness = createExtensionHarness([], {
    mode: "tui",
    custom: async (call) => {
      rendered = call.component.render(50).join("\n");
      call.component.handleInput("\n");
    },
  });
  const description = "这是一段很长的描述，用来确认窄屏下内容会自动换行而不是被截断。";

  const result = await showMenu(harness.context, "测试菜单", [
    { value: "item", label: "菜单项", description },
  ]);

  assert.equal(result, "item");
  assert.match(rendered, /这是一段很长的描述/);
  assert.match(rendered, /自动换行而不是被截断/);
  assert.ok(rendered.split("\n").filter((line) => line.includes("描述") || line.includes("自动换行")).length >= 2);
});

test("控制中心根菜单通过 Ctrl+S 保存且不显示保存列表项", async () => {
  await withTempDirectory(async (directory) => {
    let menuCalls = 0;
    let rendered = "";
    const harness = createExtensionHarness([], {
      cwd: directory,
      mode: "tui",
      trusted: true,
      custom: async (call) => {
        menuCalls += 1;
        rendered = call.component.render(120).join("\n");
        call.component.handleInput("\u0013");
        call.component.handleInput("\u0013");
        await new Promise((resolve) => setTimeout(resolve, 20));
        call.component.handleInput("\u001b");
      },
    });

    await harness.commands.get("pi-init").handler("", harness.context);

    assert.equal(menuCalls, 1);
    assert.doesNotMatch(rendered, /保存角色配置/);
    assert.match(harness.notifications.at(-1)?.message ?? "", /角色配置已保存/);
  });
});

test("角色与模型子菜单通过 Ctrl+S 保存且不显示保存列表项", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, ".pi"), { recursive: true });
    await writeFile(path.join(directory, ".pi", "role-models.json"), `${JSON.stringify(DEFAULT_ROLE_CONFIG, null, 2)}\n`, "utf8");
    let menuCalls = 0;
    let roleMenuRendered = "";
    const harness = createExtensionHarness([], {
      cwd: directory,
      mode: "tui",
      trusted: true,
      custom: async (call) => {
        menuCalls += 1;
        if (menuCalls === 1) {
          call.component.handleInput("\u001b[B");
          call.component.handleInput("\n");
        } else if (menuCalls === 2) {
          call.component.handleInput("\n");
        } else if (menuCalls === 3) {
          roleMenuRendered = call.component.render(120).join("\n");
          call.component.handleInput("\u0013");
          await new Promise((resolve) => setTimeout(resolve, 0));
          call.component.handleInput("\u001b");
        } else {
          call.component.handleInput("\u001b");
        }
      },
    });

    await harness.commands.get("pi-init").handler("", harness.context);

    assert.doesNotMatch(roleMenuRendered, /保存角色配置/);
    assert.match(harness.notifications.map(({ message }) => message).join("\n"), /角色配置已保存/);
  });
});

test("TUI 菜单按 Ctrl+S 调用保存回调并保持菜单", async () => {
  let saveCalls = 0;
  const harness = createExtensionHarness([], {
    mode: "tui",
    custom: async (call) => {
      call.component.handleInput("\u0013");
      call.component.handleInput("\u0013");
      await new Promise((resolve) => setTimeout(resolve, 0));
      call.component.handleInput("\u001b");
    },
  });

  const result = await showMenu(harness.context, "测试菜单", [
    { value: "item", label: "菜单项" },
  ], {
    onSave: async () => {
      saveCalls += 1;
    },
  });

  assert.equal(result, MENU_BACK);
  assert.equal(saveCalls, 1);
});

test("角色模型搜索和推理强度菜单都支持 Ctrl+S", async () => {
  const model = { provider: "openai-codex", id: "gpt-5.6-luna" };
  let saveCalls = 0;
  const harness = createExtensionHarness([], {
    mode: "tui",
    availableModels: [model],
    custom: async (call) => {
      call.component.handleInput("\u0013");
      await new Promise((resolve) => setTimeout(resolve, 0));
      call.component.handleInput("\n");
    },
  });

  const result = await selectRoleModel(harness.context, "architect", undefined, {
    onSave: async () => {
      saveCalls += 1;
    },
  });

  assert.equal(result.provider, model.provider);
  assert.equal(result.model, model.id);
  assert.equal(saveCalls, 2);
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
