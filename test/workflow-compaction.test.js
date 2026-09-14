import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";

const {
  DEFAULT_ROLE_MODELS,
  createExtensionHarness,
  createWorkflowState,
  emitExtensionEvent,
  mkdir,
  path,
  shouldCompactAfterWorkflowTask,
  withTempDirectory,
  writeFile,
} = helpers;

const developerModel = { provider: "openai-codex", id: "gpt-5.6-luna" };

function tasks() {
  return [
    { id: "first", role: "developer-test", task: "完成第一项", files: ["src/first.js"], acceptanceCriteria: ["通过"] },
    { id: "second", role: "developer-test", task: "完成第二项", files: ["src/second.js"], acceptanceCriteria: ["通过"] },
  ];
}

async function writeWorkflowConfig(directory, executor) {
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  await writeFile(
    path.join(directory, ".pi", "role-models.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      mode: "auto",
      workflowMode: "on",
      workflowExecutor: executor,
      roleModels: DEFAULT_ROLE_MODELS,
    }, null, 2)}\n`,
  );
}

function completeParams(taskId, summary) {
  return {
    action: "complete",
    taskId,
    completionSummary: summary,
    implementationRationale: "在任务边界先压缩上下文，再继续后续任务",
    verification: ["通过"],
  };
}

test("长工作流在非最终任务完成后压缩并在最终任务后停止压缩", async () => {
  await withTempDirectory(async (directory) => {
    await writeWorkflowConfig(directory, "local");
    const branch = [{
      type: "custom",
      customType: "pi-init-workflow",
      data: createWorkflowState({ summary: "任务边界压缩", tasks: tasks(), executor: "local" }, 100),
    }];
    const harness = createExtensionHarness(branch, {
      cwd: directory,
      trusted: true,
      model: developerModel,
      availableModels: [developerModel],
    });
    let compactCalls = 0;
    harness.context.getContextUsage = () => ({ percent: 60 });
    harness.context.compact = ({ onComplete }) => {
      compactCalls++;
      onComplete?.({});
    };

    await emitExtensionEvent(harness, "session_start");
    await emitExtensionEvent(harness, "agent_start");
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const first = await workflow.execute("complete-first", completeParams("first", "第一项完成"), undefined, undefined, harness.context);
    assert.equal(first.details.status, "running");

    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(compactCalls, 1);
    assert.equal(harness.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task").length, 2);

    await emitExtensionEvent(harness, "agent_start");
    const second = await workflow.execute("complete-second", completeParams("second", "第二项完成"), undefined, undefined, harness.context);
    assert.equal(second.details.status, "completed");
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(compactCalls, 1);
  });
});

test("任务边界压缩要求自动模式和至少 50% 上下文", () => {
  assert.equal(shouldCompactAfterWorkflowTask({ mode: "auto", contextUsage: { percent: 50 } }), true);
  assert.equal(shouldCompactAfterWorkflowTask({ mode: "auto", contextUsage: { percent: 49.9 } }), false);
  assert.equal(shouldCompactAfterWorkflowTask({ mode: "auto", contextUsage: { percent: null } }), false);
  assert.equal(shouldCompactAfterWorkflowTask({ mode: "confirm", contextUsage: { percent: 90 } }), false);
});
