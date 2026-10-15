import assert from "node:assert/strict";
import test from "node:test";

import {
  createExtensionHarness,
  emitExtensionEvent,
  mkdir,
  path,
  withTempDirectory,
  writeFile,
} from "./helpers.js";
import { isExplicitWorkflowReplanInput, isWorkflowContinuationInput } from "../src/workflow-input-intent.ts";

const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
const docs = { provider: "openai-codex", id: "gpt-5.6-docs" };
const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };

async function makeHarness(directory) {
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  await writeFile(path.join(directory, ".pi", "role-models.json"), `${JSON.stringify({
    schemaVersion: 2,
    mode: "auto",
    workflowMode: "on",
    roleModels: {
      architect: { provider: architect.provider, model: architect.id, thinkingLevel: "max" },
      "docs-commit": { provider: docs.provider, model: docs.id, thinkingLevel: "high" },
      "developer-test": { provider: developer.provider, model: developer.id, thinkingLevel: "max" },
    },
  }, null, 2)}\n`);
  const harness = createExtensionHarness([], {
    cwd: directory,
    trusted: true,
    model: architect,
    availableModels: [architect, docs, developer],
    sessionId: "workflow-input-resume-session",
  });
  await emitExtensionEvent(harness, "session_start");
  return harness;
}

function latestWorkflow(harness) {
  return harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow")?.data;
}

test("只将明确的继续/恢复短句识别为恢复意图", () => {
  for (const value of ["继续", "继续吧。", "继续当前工作流", "恢复工作流", "continue", "Resume workflow"]) {
    assert.equal(isWorkflowContinuationInput(value), true, value);
  }
  for (const value of ["把当前任务改成异步", "新增一个缓存目标", "继续并改成另一种方案", "请调查这个新问题"]) {
    assert.equal(isWorkflowContinuationInput(value), false, value);
  }
  for (const value of ["重规划：把第二步拆开", "修改当前计划，先完成数据校验", "replan workflow: retain the first task"]) {
    assert.equal(isExplicitWorkflowReplanInput(value), true, value);
  }
  for (const value of ["新增一个缓存目标", "请调查这个新问题"]) {
    assert.equal(isExplicitWorkflowReplanInput(value), false, value);
  }
});

test("普通继续输入不创建 pendingRevision，中断后沿原计划继续调度", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    await workflow.execute("plan-before-interruption", {
      action: "plan",
      summary: "恢复原有计划",
      constraints: ["保留已保存计划，不因继续输入重规划"],
      tasks: [{
        id: "first-task",
        task: "按原计划完成当前任务",
        files: ["src/current.ts"],
        acceptanceCriteria: ["结果符合原计划"],
        role: "developer-test",
      }],
    }, undefined, undefined, harness.context);

    const before = latestWorkflow(harness);
    assert.equal(before.status, "running");
    assert.equal(before.pendingRevision, undefined);
    assert.deepEqual(before.revisions, []);

    let inputResult;
    for (const handler of harness.handlers.get("input") ?? []) {
      inputResult = await handler({ text: "继续", source: "interactive" }, harness.context) ?? inputResult;
    }
    assert.equal(inputResult?.action, "continue", "继续文本保留为普通输入，不被吞成重规划指令");
    const afterInput = latestWorkflow(harness);
    assert.equal(afterInput.workflowId, before.workflowId);
    assert.equal(afterInput.planVersion, before.planVersion);
    assert.equal(afterInput.pendingRevision, undefined);
    assert.deepEqual(afterInput.revisions, []);
    assert.deepEqual(afterInput.tasks.map(({ id, status }) => ({ id, status })), [{ id: "first-task", status: "pending" }]);

    await emitExtensionEvent(harness, "agent_settled");
    const resumed = latestWorkflow(harness);
    assert.equal(resumed.workflowId, before.workflowId);
    assert.equal(resumed.planVersion, before.planVersion);
    assert.equal(resumed.pendingRevision, undefined);
    assert.equal(resumed.currentTaskId, "first-task");
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 1);
  });
});

test("讨论和纠正不被自动吞成子流程，待规划期间也不污染请求", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    await workflow.execute("plan-discussion", { action: "plan", summary: "父目标", tasks: [{ id: "first", task: "原任务", files: ["src"], acceptanceCriteria: ["通过"] }] }, undefined, undefined, harness.context);
    const initial = structuredClone(latestWorkflow(harness));
    for (const text of ["这个设计合理吗？", "这里理解错了", "先解释一下为什么", "顺便看一下日志"]) {
      await emitExtensionEvent(harness, "input", { text, source: "interactive" });
      assert.deepEqual(latestWorkflow(harness), initial, "讨论和纠正不改变当前工作流，也不自动创建子流程");
    }
    await emitExtensionEvent(harness, "input", { text: "子流程：独立检查部署环境", source: "interactive" });
    const pending = structuredClone(latestWorkflow(harness));
    assert.equal(pending.pendingRevision.kind, "nested");
    await emitExtensionEvent(harness, "input", { text: "这个设计合理吗？", source: "interactive" });
    assert.deepEqual(latestWorkflow(harness), pending, "待规划期间的讨论不污染显式子流程请求");
    await emitExtensionEvent(harness, "input", { text: "追加任务：补测试", source: "interactive" });
    assert.deepEqual(latestWorkflow(harness), pending, "不把追加任务混入待规划子目标");
  });
});
