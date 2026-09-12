import assert from "node:assert/strict";
import test from "node:test";

import { SUBTASK_DISPATCH_TIMEOUT_MS } from "../extensions/workflow-dispatch.ts";
import {
  createExtensionHarness,
  createWorkflowState,
  emitExtensionEvent,
  mkdir,
  path,
  withTempDirectory,
  writeFile,
} from "./helpers.js";

const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };

async function writeSubtaskConfig(directory, mode = "auto") {
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  await writeFile(
    path.join(directory, ".pi", "role-models.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      mode,
      workflowMode: "on",
      workflowExecutor: "subtask",
      roleModels: {
        architect: { provider: architect.provider, model: architect.id, thinkingLevel: "max" },
        "developer-test": { provider: developer.provider, model: developer.id, thinkingLevel: "max" },
      },
    }, null, 2)}\n`,
  );
}

function workflowEntry(branch) {
  return [...branch].reverse().find((entry) => entry.customType === "pi-init-workflow");
}

async function settleDispatch() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("subtask 派发前自动切换任务角色并显示等待状态", async () => {
  await withTempDirectory(async (directory) => {
    await writeSubtaskConfig(directory);
    const branch = [{
      type: "custom",
      customType: "pi-init-workflow",
      data: createWorkflowState({
        summary: "角色安全派发",
        executor: "subtask",
        tasks: [{ id: "implementation", role: "developer-test", task: "实现功能", files: ["src/feature.js"], acceptanceCriteria: ["完成"] }],
      }, 100),
    }];
    const harness = createExtensionHarness(branch, {
      cwd: directory,
      trusted: true,
      model: architect,
      availableModels: [architect, developer],
      activeTools: ["subtask"],
    });

    await emitExtensionEvent(harness, "session_start");
    await settleDispatch();

    assert.equal(harness.context.model, developer);
    assert.ok(harness.sentMessages.some(({ message }) => message.customType === "pi-init-subtask-dispatch"));
    assert.ok(harness.notifications.some(({ message }) => message.includes("正在等待 subtask 派发")));
    assert.ok(harness.statusCalls.some(({ text }) => text?.includes("等待子任务派发")));
    assert.equal(workflowEntry(branch).data.tasks[0].delegation.status, "spawning");

    for (const handler of harness.handlers.get("tool_call") ?? []) {
      await handler({ toolName: "subtask", input: {} }, harness.context);
    }
    assert.equal(workflowEntry(branch).data.tasks[0].delegation.status, "running");
    assert.ok(harness.notifications.some(({ message }) => message.includes("已交给 subtask 后台执行")));
  });
});

test("subtask 派发超时会暂停任务并释放等待状态", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await withTempDirectory(async (directory) => {
      await writeSubtaskConfig(directory);
      const branch = [{
        type: "custom",
        customType: "pi-init-workflow",
        data: createWorkflowState({
          summary: "派发超时反馈",
          executor: "subtask",
          tasks: [{ id: "implementation", role: "developer-test", task: "实现功能", files: ["src/feature.js"], acceptanceCriteria: ["完成"] }],
        }, 100),
      }];
      const harness = createExtensionHarness(branch, {
        cwd: directory,
        trusted: true,
        model: developer,
        availableModels: [architect, developer],
        activeTools: ["subtask"],
      });

      await emitExtensionEvent(harness, "session_start");
      t.mock.timers.tick(SUBTASK_DISPATCH_TIMEOUT_MS);

      const persisted = workflowEntry(branch).data;
      assert.equal(persisted.status, "paused");
      assert.equal(persisted.tasks[0].status, "blocked");
      assert.match(persisted.tasks[0].blockReason, /派发等待超过/);
      assert.ok(harness.notifications.some(({ message }) => message.includes("/pi-init workflow retry implementation")));
    });
  } finally {
    t.mock.timers.reset();
  }
});

test("architect 被阻止调用 subtask 时工作流暂停并显示恢复建议", async () => {
  await withTempDirectory(async (directory) => {
    await writeSubtaskConfig(directory);
    const branch = [{
      type: "custom",
      customType: "pi-init-workflow",
      data: createWorkflowState({
        summary: "边界失败反馈",
        executor: "subtask",
        tasks: [{ id: "implementation", role: "developer-test", task: "实现功能", files: ["src/feature.js"], acceptanceCriteria: ["完成"] }],
      }, 100),
    }];
    const harness = createExtensionHarness(branch, {
      cwd: directory,
      trusted: true,
      model: developer,
      availableModels: [architect, developer],
      activeTools: ["subtask"],
    });

    await emitExtensionEvent(harness, "session_start");
    await settleDispatch();
    const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
    assert.ok(switchRole);
    await switchRole.execute("architect", { role: "architect" }, undefined, undefined, harness.context);

    let blocked;
    for (const handler of harness.handlers.get("tool_call") ?? []) {
      const result = await handler({ toolName: "subtask", input: {} }, harness.context);
      if (result?.block) blocked = result;
    }

    assert.equal(blocked?.block, true);
    const persisted = workflowEntry(branch).data;
    assert.equal(persisted.status, "paused");
    assert.equal(persisted.tasks[0].status, "blocked");
    assert.match(persisted.tasks[0].blockReason, /architect/);
    assert.ok(harness.notifications.some(({ message }) => message.includes("/pi-init workflow retry implementation")));
  });
});
