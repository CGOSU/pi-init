import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";
import { advancedInit, runScaffold } from "../extensions/scaffold-runtime.ts";
import { createWorkflowReport } from "../extensions/workflow-report.ts";
import { collectRoleModels, input, MENU_BACK, showMenu } from "../extensions/ui.ts";

const {
  mkdir,
  readFile,
  writeFile,
  path,
  completeWorkflowTask,
  createWorkflowState,
  markWorkflowTaskStarted,
  startWorkflowTask,
  withTempDirectory,
  createExtensionHarness,
  emitExtensionEvent,
} = helpers;

test("TUI 菜单按 Esc 返回上一级而不是取消", async () => {
  const harness = createExtensionHarness([], {
    mode: "tui",
    custom: async (call) => call.component.handleInput("\u001b"),
  });

  const result = await showMenu(harness.context, "测试菜单", [
    { value: "item", label: "菜单项" },
  ]);

  assert.equal(result, MENU_BACK);
});

test("TUI 文本输入按 Esc 返回且恢复内容可继续追加", async () => {
  const backHarness = createExtensionHarness([], { mode: "tui", custom: async (call) => call.component.handleInput("\u001b") });
  assert.equal(await input(backHarness.context, "测试输入", "占位文本"), MENU_BACK);

  const harness = createExtensionHarness([], { mode: "tui", custom: async (call) => {
    call.component.handleInput("X");
    call.component.handleInput("\n");
  } });
  assert.equal(await input(harness.context, "测试输入", "占位文本", "Description"), "DescriptionX");
});

test("角色模型选择按 Esc 逐级返回并保留已选角色", async () => {
  const first = { provider: "openai-codex", id: "gpt-5.6-luna" };
  const second = { provider: "openrouter", id: "anthropic/claude-sonnet-4" };
  const harness = createExtensionHarness([], {
    mode: "tui",
    availableModels: [first, second],
    custom: async (call) => {
      const index = harness.customCalls.length;
      if (index === 1) {
        call.component.handleInput(String.fromCharCode(27) + "[B");
        call.component.handleInput("\n");
      } else if (index === 2 || index === 5) {
        call.component.handleInput("\u001b");
      } else {
        call.component.handleInput("\n");
      }
    },
  });

  const result = await collectRoleModels(harness.context);

  assert.equal(result.architect.model, second.id);
  assert.deepEqual(Object.keys(result), ["architect", "developer-test", "docs-commit"]);
  const backHarness = createExtensionHarness([], { mode: "tui", custom: async (call) => call.component.handleInput("\u001b") });
  assert.equal(await collectRoleModels(backHarness.context), MENU_BACK);
  const cancelHarness = createExtensionHarness([], { mode: "tui", custom: async (call) => call.component.handleInput("\u0003") });
  assert.equal(await collectRoleModels(cancelHarness.context), undefined);
});

test("高级初始化按 Esc 返回上一个属性并保留页面内容", async () => {
  await withTempDirectory(async (directory) => {
    const esc = "\u001b";
    const down = String.fromCharCode(27) + "[B";
    const actions = [["Project", "\n"], ["\n"], ["Description", "\n"], [esc], ["\n"], ["npm test", "\n"], ["\n"], [esc], [down, down, "\n"]];
    let step = 0;
    const harness = createExtensionHarness([], { cwd: directory, mode: "tui", custom: async (call) => {
      for (const data of actions[step++] ?? []) call.component.handleInput(data);
    } });

    const result = await advancedInit(".", harness.context);
    assert.equal(result, undefined);
  });
});

test("高级初始化首项 Esc 返回上级", async () => {
  const direct = createExtensionHarness([], { mode: "tui", custom: async (call) => call.component.handleInput("\u001b") });
  assert.equal(await advancedInit(".", direct.context), MENU_BACK);
});

test("高级初始化确认菜单支持显式取消", async () => {
  await withTempDirectory(async (directory) => {
    const harness = createExtensionHarness([], { cwd: directory, mode: "tui", custom: async (call) => {
      call.component.handleInput(String.fromCharCode(27) + "[B");
      call.component.handleInput("\n");
    } });
    const result = await runScaffold(harness.context, ".", { projectName: "p", language: "zh-CN" }, "always", true);
    assert.equal(result.cancelled, true);
  });
});

test("移除 Provider 锁后原生模型切换不再被回滚或拦截", async () => {
  const safe = { provider: "openai-codex", id: "gpt-5.6-luna" };
  const other = { provider: "openrouter", id: "anthropic/claude-haiku-4.5" };

  const restored = createExtensionHarness([], {
    model: other,
    availableModels: [other, safe],
    trusted: true,
  });
  await emitExtensionEvent(restored, "session_start");
  assert.deepEqual(restored.context.model, other);
  assert.equal(restored.aborts.length, 0);

  const switched = createExtensionHarness([], {
    model: other,
    availableModels: [other, safe],
    trusted: true,
  });
  await emitExtensionEvent(switched, "model_select", {
    model: other,
    previousModel: safe,
    source: "set",
  });
  assert.deepEqual(switched.context.model, other);
  assert.equal(switched.aborts.length, 0);

  const inputHandler = (switched.handlers.get("input") ?? [])[0];
  assert.deepEqual(
    await inputHandler({ source: "interactive", text: "继续工作" }, switched.context),
    { action: "continue" },
  );

});

test("手动模式原生模型切换写回 v3 并隔离共享档位，且不重复写入", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, ".pi"), { recursive: true });
    const configPath = path.join(directory, ".pi", "role-models.json");
    const safe = { provider: "openai-codex", id: "gpt-5.6-luna" };
    const unsafe = { provider: "openrouter", id: "anthropic/claude-haiku-4.5" };
    await writeFile(configPath, JSON.stringify({
      mode: "manual",
      roleModels: {
        "developer-test": { provider: safe.provider, model: safe.id, thinkingLevel: "max" },
        "docs-commit": { provider: safe.provider, model: safe.id, thinkingLevel: "medium" },
      },
    }));
    const harness = createExtensionHarness([], {
      cwd: directory,
      model: safe,
      availableModels: [safe, unsafe],
      trusted: true,
    });
    await emitExtensionEvent(harness, "session_start");
    assert.deepEqual(harness.context.model, safe);

    await writeFile(configPath, JSON.stringify({
      schemaVersion: 3,
      mode: "manual",
      roleTiers: { "developer-test": "shared-tier", "docs-commit": "shared-tier" },
      tiers: { "shared-tier": { modelRef: "safe-model", thinkingLevel: "max" } },
      models: { "safe-model": { provider: safe.provider, model: safe.id } },
    }));
    harness.context.model = unsafe;
    await emitExtensionEvent(harness, "model_select", { model: unsafe, previousModel: safe, source: "user" });
    assert.deepEqual(harness.context.model, unsafe);

    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(persisted.schemaVersion, 3);
    assert.equal(persisted.roleModels, undefined);
    assert.notEqual(persisted.roleTiers["developer-test"], persisted.roleTiers["docs-commit"]);
    const resolved = helpers.resolveRoleConfig(persisted);
    assert.deepEqual(resolved.roleModels["developer-test"], {
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
      thinkingLevel: "max",
    });
    assert.deepEqual(resolved.roleModels["docs-commit"], {
      provider: safe.provider,
      model: safe.id,
      thinkingLevel: "max",
    });
    assert.equal(persisted.providerPolicy, undefined);
    const notificationsBefore = harness.notifications.length;
    const fileBefore = await readFile(configPath, "utf8");
    await emitExtensionEvent(harness, "model_select", { model: unsafe, previousModel: unsafe, source: "user" });
    assert.equal(harness.notifications.length, notificationsBefore);
    assert.equal(await readFile(configPath, "utf8"), fileBefore);

    const inputHandler = (harness.handlers.get("input") ?? [])[0];
    assert.deepEqual(
      await inputHandler({ source: "interactive", text: "继续" }, harness.context),
      { action: "continue" },
    );

  });
});

test("手动模式下无活动角色的原生切换只提示不写文件", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, ".pi"), { recursive: true });
    await writeFile(path.join(directory, ".pi", "role-models.json"), JSON.stringify({ mode: "manual" }));

    const model = { provider: "openai-codex", id: "gpt-5.6-luna" };
    const harness = createExtensionHarness([], {
      cwd: directory,
      model,
      availableModels: [model],
      trusted: true,
      thinkingLevel: "off",
    });
    await emitExtensionEvent(harness, "session_start");

    const next = { provider: "openrouter", id: "anthropic/claude-haiku-4.5" };
    harness.context.model = next;
    await emitExtensionEvent(harness, "model_select", { model: next, previousModel: model, source: "user" });

    const persisted = JSON.parse(await readFile(path.join(directory, ".pi", "role-models.json"), "utf8"));
    assert.deepEqual(persisted, { mode: "manual" });
  });
});

test("角色模型选择器展示全部已注册模型并可暂存跨 Provider 选择", async () => {
  const safe = { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" };
  const other = { provider: "openrouter", id: "anthropic/claude-sonnet-4", name: "Sonnet" };
  const harness = createExtensionHarness([], {
    model: safe,
    availableModels: [safe, other],
    trusted: true,
    input: async () => "",
    select: async (title, items) => title.includes("共用档位")
      ? items.find((item) => item.startsWith("仅更改"))
      : title.startsWith("选择 架构设计 模型")
        ? items.find((item) => item.includes("openrouter")) ?? items[0]
        : title.startsWith("推理强度")
          ? items[0]
          : undefined,
  });
  const command = harness.commands.get("pi-init");
  await command.handler("config architect", harness.context);

  const selectedItems = harness.selectCalls.find((call) => call.title.startsWith("选择 架构设计 模型"))?.items ?? [];
  assert.ok(selectedItems.some((item) => item.includes("openrouter")));
});

test("共享档位编辑预览并确认影响范围，单角色编辑隔离同档位成员", async () => {
  const safe = { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" };
  const other = { provider: "openrouter", id: "anthropic/claude-sonnet-4", name: "Sonnet" };

  async function configureSharedTier(scope) {
    await withTempDirectory(async (directory) => {
      const configPath = path.join(directory, ".pi", "role-models.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, JSON.stringify({
        schemaVersion: 3,
        mode: "auto",
        roleTiers: { "developer-test": "shared-tier", "docs-commit": "shared-tier" },
        tiers: { "shared-tier": { modelRef: "safe-model", thinkingLevel: "max" } },
        models: { "safe-model": { provider: safe.provider, model: safe.id } },
      }));

      const harness = createExtensionHarness([], {
        cwd: directory,
        model: safe,
        availableModels: [safe, other],
        trusted: true,
        input: async () => "",
        select: async (title, items) => {
          if (title.includes("共用档位")) {
            return items.find((item) => scope === "tier"
              ? item.startsWith("更改整个共享档位")
              : item.startsWith("仅更改"));
          }
          if (title.startsWith("确认更改共享档位")) return items[0];
          if (title.startsWith("选择 开发测试 模型")) return items.find((item) => item.includes(other.id));
          if (title.startsWith("推理强度")) return items[0];
          return undefined;
        },
      });
      await harness.commands.get("pi-init").handler("config developer-test", harness.context);

      const scopeCall = harness.selectCalls.find((call) => call.title.includes("共用档位"));
      assert.ok(scopeCall);
      assert.match(scopeCall.title, /开发测试/);
      assert.match(scopeCall.title, /文档收尾/);
      assert.match(scopeCall.title, /openai-codex\/gpt-5\.6-luna/);
      const confirmationIndex = harness.selectCalls.findIndex((call) => call.title.startsWith("确认更改共享档位"));
      const modelIndex = harness.selectCalls.findIndex((call) => call.title.startsWith("选择 开发测试 模型"));
      if (scope === "tier") {
        assert.ok(confirmationIndex > harness.selectCalls.indexOf(scopeCall));
        assert.ok(modelIndex > confirmationIndex);
      } else {
        assert.equal(confirmationIndex, -1);
      }

      await harness.commands.get("pi-init").handler("save", harness.context);
      const saved = JSON.parse(await readFile(configPath, "utf8"));
      const resolved = helpers.resolveRoleConfig(saved);
      assert.deepEqual(resolved.roleModels["developer-test"], {
        provider: other.provider,
        model: other.id,
        thinkingLevel: resolved.roleModels["developer-test"].thinkingLevel,
      });
      if (scope === "tier") {
        assert.equal(saved.roleTiers["developer-test"], saved.roleTiers["docs-commit"]);
        assert.deepEqual(resolved.roleModels["docs-commit"], resolved.roleModels["developer-test"]);
      } else {
        assert.notEqual(saved.roleTiers["developer-test"], saved.roleTiers["docs-commit"]);
        assert.deepEqual(resolved.roleModels["docs-commit"], {
          provider: safe.provider,
          model: safe.id,
          thinkingLevel: "max",
        });
      }
    });
  }

  await configureSharedTier("tier");
  await configureSharedTier("role");
});

test("非 TUI 工作流状态继续使用通知文本", async () => {
  const state = createWorkflowState({
    summary: "冻结认证改造",
    tasks: [{ id: "schema", task: "更新结构", files: ["src/schema.js"], acceptanceCriteria: ["测试通过"] }],
  }, 100);
  state.status = "completed";
  state.startedAt = 115;
  state.completedAt = 125;
  state.tasks[0] = {
    ...state.tasks[0],
    status: "completed",
    startedAt: 115,
    completedAt: 125,
    completionSummary: "结构完成",
  };
  const harness = createExtensionHarness(
    [{ type: "custom", customType: "pi-init-workflow", data: state }],
    { mode: "rpc" },
  );
  await emitExtensionEvent(harness, "session_start");
  await harness.commands.get("pi-init").handler("workflow status", harness.context);

  assert.equal(harness.customCalls.length, 0);
  assert.equal(harness.notifications.length, 1);
});

test("task_workflow 报告区分任务级别并筛选验证结果", () => {
  const planned = createWorkflowState({
    summary: "冻结认证改造",
    tasks: [
      { id: "schema", task: "更新结构", files: ["src/schema.js"], acceptanceCriteria: ["测试通过"] },
      { id: "docs", task: "更新文档", files: ["README.md"], acceptanceCriteria: ["文档同步"], dependsOn: ["schema"] },
    ],
  }, 100);
  const firstStarted = markWorkflowTaskStarted(startWorkflowTask(planned, "schema", 110), "schema", 115);
  const intermediate = completeWorkflowTask(
    firstStarted,
    { taskId: "schema", completionSummary: "结构完成", implementationRationale: "先固定结构以保持后续改动可控", verification: ["npm test：通过", "node --check：失败：类型错误"] },
    125,
  );
  const finalStarted = markWorkflowTaskStarted(startWorkflowTask(intermediate, "docs", 150), "docs", 155);
  const completed = completeWorkflowTask(
    finalStarted,
    { taskId: "docs", completionSummary: "文档完成", implementationRationale: "让最终说明与已验证行为一致", verification: ["git diff --check：通过", "npm test：失败：1 个测试失败"] },
    175,
  );

  const report = createWorkflowReport({}, { pi: {}, roleRuntime: {} });
  const taskReport = report.formatWorkflowTaskCompletion(intermediate.tasks[0]);
  assert.match(taskReport, /node --check：失败：类型错误/);
  assert.doesNotMatch(taskReport, /npm test：通过/);
  assert.doesNotMatch(taskReport, /工作流完成报告|整体总耗时/);

  const workflowReport = report.formatWorkflowCompletion(completed, completed.tasks[1]);
  assert.match(workflowReport, /npm test：失败：1 个测试失败/);
  assert.doesNotMatch(workflowReport, /git diff --check：通过/);
  assert.match(workflowReport, /总耗时：60 毫秒/);

  const passedOnlyReport = report.formatWorkflowTaskCompletion({
    ...intermediate.tasks[0],
    verification: ["npm test：通过"],
  });
  assert.doesNotMatch(passedOnlyReport, /^验证：/m);
});

