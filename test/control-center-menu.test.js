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

async function waitForRoleModelConfig(directory, expected) {
  const configPath = path.join(directory, ".pi", "role-models.json");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const config = JSON.parse(await readFile(configPath, "utf8"));
      const saved = config.roleModels?.architect;
      if (saved?.provider === expected.provider
        && saved.model === expected.model
        && (expected.thinkingLevel === undefined || saved.thinkingLevel === expected.thinkingLevel)) return;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`角色模型配置未持久化：${JSON.stringify(expected)}`);
}

test("控制中心不再提供改写项目规则的同步菜单", async () => {
  await withTempDirectory(async directory => {
    let rendered = "";
    const h = createExtensionHarness([], { cwd: directory, mode: "tui", custom: async call => {
      rendered = call.component.render(120).join("\n");
      call.component.handleInput("\u001b");
    } });
    await h.commands.get("pi-init").handler("", h.context);
    assert.doesNotMatch(rendered, /同步项目模板/);
    assert.equal(h.reloadCalls.length, 0);
    await assert.rejects(readFile(path.join(directory, "AGENTS.md")), { code: "ENOENT" });
  });
});
test("TUI 菜单 Ctrl+S 保存后仍保持打开并可返回", async () => {
  let saveCalls = 0;
  const harness = createExtensionHarness([], {
    mode: "tui",
    custom: async (call) => {
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
      return { ok: true, message: "角色配置已保存。" };
    },
  });

  assert.equal(result, MENU_BACK);
  assert.equal(saveCalls, 1);
});

test("TUI 菜单支持 F2 作为 Ctrl+S 的兼容保存快捷键", async () => {
  let saveCalls = 0;
  const harness = createExtensionHarness([], {
    mode: "tui",
    custom: async (call) => {
      call.component.handleInput("\u001bOQ");
      await new Promise((resolve) => setTimeout(resolve, 0));
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
});

test("角色模型选择器在首项按上键不会跳到列表末尾", async () => {
  const first = {
    provider: "openai-codex",
    id: "gpt-5.6-luna",
    reasoning: true,
    thinkingLevelMap: { max: "max" },
  };
  const second = {
    provider: "openrouter",
    id: "anthropic/claude-sonnet-4",
    reasoning: true,
    thinkingLevelMap: { max: "max" },
  };
  const harness = createExtensionHarness([], {
    mode: "tui",
    availableModels: [first, second],
    custom: async (call) => {
      if (harness.customCalls.length === 1) {
        call.component.handleInput("\u001b[A");
      }
      call.component.handleInput("\n");
    },
  });

  const result = await selectRoleModel(harness.context, "architect");

  assert.equal(result.model, first.id);
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

test("搜索与推理强度菜单保存的模型配置均已持久化", async () => {
  await withTempDirectory(async (directory) => {
    const model = {
      provider: "openai-codex",
      id: "gpt-6-sol",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    };
    let customCall = 0;
    let interactionError;
    const harness = createExtensionHarness([], {
      cwd: directory,
      mode: "tui",
      trusted: true,
      availableModels: [model],
      custom: async (call) => {
        try {
          customCall += 1;
          if (customCall === 1) {
            call.component.handleInput("\u0013");
            await waitForRoleModelConfig(directory, { provider: model.provider, model: model.id });
            call.component.handleInput("\n");
            return;
          }
          for (let index = 0; index < 6; index += 1) call.component.handleInput("\u001b[B");
          call.component.handleInput("\u0013");
          await waitForRoleModelConfig(directory, { provider: model.provider, model: model.id, thinkingLevel: "max" });
          call.component.handleInput("\n");
        } catch (error) {
          interactionError = error;
        }
      },
    });

    await harness.commands.get("pi-init").handler("config architect", harness.context);

    assert.equal(interactionError, undefined, String(interactionError));
    const persisted = JSON.parse(await readFile(path.join(directory, ".pi", "role-models.json"), "utf8"));
    assert.deepEqual(persisted.roleModels.architect, {
      provider: model.provider,
      model: model.id,
      thinkingLevel: "max",
    });
    assert.equal(harness.notifications.some(({ message }) => message.includes("尚未保存")), false);
  });
});

test("上一级菜单按 Ctrl+S 后覆盖此前的未保存提示", async () => {
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
      id: "gpt-6-luna",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    };
    let rootVisited = false;
    let changeVisited = false;
    let roleCenterVisits = 0;
    const harness = createExtensionHarness([], {
      cwd: directory,
      mode: "tui",
      trusted: true,
      availableModels: [model],
      custom: async (call) => {
        const render = () => call.component.render(80).join("\n");
        const choose = async (label) => {
          for (let attempt = 0; attempt < 8; attempt += 1) {
            if (render().includes(`→ ${label}`)) break;
            call.component.handleInput("\u001b[B");
          }
          call.component.handleInput("\n");
        };
        const screen = render();
        if (screen.includes("Pi Init 控制中心")) {
          if (!rootVisited) {
            rootVisited = true;
            await choose("变更");
          } else {
            call.component.handleInput("\u001b");
          }
        } else if (screen.includes(" 变更")) {
          if (!changeVisited) {
            changeVisited = true;
            await choose("角色与模型");
          } else {
            call.component.handleInput("\u001b");
          }
        } else if (screen.includes("角色与模型")) {
          roleCenterVisits += 1;
          if (roleCenterVisits === 1) {
            await choose("● 架构设计");
          } else {
            call.component.handleInput("\u0013");
            await waitForRoleModelConfig(directory, { provider: model.provider, model: model.id, thinkingLevel: "max" });
            call.component.handleInput("\u001b");
          }
        } else if (screen.includes("选择 架构设计 模型")) {
          call.component.handleInput("\n");
        } else if (screen.includes("推理强度")) {
          await choose("max");
        } else {
          call.component.handleInput("\u001b");
        }
      },
    });

    await harness.commands.get("pi-init").handler("", harness.context);

    const persisted = JSON.parse(await readFile(path.join(directory, ".pi", "role-models.json"), "utf8"));
    assert.equal(persisted.roleModels.architect.model, model.id);
    assert.equal(persisted.roleModels.architect.thinkingLevel, "max");
    assert.doesNotMatch(harness.notifications.at(-1).message, /尚未保存/);
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
