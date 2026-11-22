import { createWorkflowDirectionInput } from "../extensions/workflow/workflow-direction-input.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { latestWorkflow, workflowMessageIdentity } from "./support/workflow-fixtures.js";
import assert from "node:assert/strict";
import test from "node:test";

import { createExtensionHarness, emitExtensionEvent } from "./support/extension-harness.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { withTempDirectory } from "./support/temp-directory.js";
import { isExplicitWorkflowReplanInput, isWorkflowContinuationInput, parseExplicitWorkflowQuestionInput } from "../src/workflow-input-intent.ts";

const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
const docs = { provider: "openai-codex", id: "gpt-5.6-docs" };
const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };

const task = (id, goal) => ({ id, task: goal, files: ["src"], acceptanceCriteria: [goal], role: "developer-test" });
const input = (h, text, source = "interactive") => emitExtensionEvent(h, "input", { source, text });
const execute = (h, id, args) => h.tools.find(tool => tool.name === "task_workflow").execute(id, args, undefined, undefined, h.context);
const dispatches = h => h.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-task");
const reply = direction => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ direction }) }] });

function stubArchitect(...replies) {
  const calls = [];
  return {
    calls,
    streamSimple(model, context, options) {
      calls.push({ model, context, options });
      assert.ok(replies.length, "未预期的架构判断请求");
      return { result: async () => replies.shift() };
    },
  };
}

async function startTask(h, next = []) {
  await execute(h, "plan", { action: "plan", summary: "查询已发布数据", tasks: [task("check", "验证本地已发布数据查询"), ...next] });
  await emitExtensionEvent(h, "agent_settled");
  const dispatch = dispatches(h).at(-1).message;
  await emitExtensionEvent(h, "agent_start");
  await emitExtensionEvent(h, "message_start", { message: { ...dispatch, role: "custom", timestamp: Date.now() } });
  h.persistSentMessage(dispatch);
  assert.equal(latestWorkflow(h).handoff.phase, "executing");
  return dispatch.details;
}

async function makeHarness(directory, options = {}, config = {}) {
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  await writeFile(path.join(directory, ".pi", "role-models.json"), `${JSON.stringify({
    schemaVersion: 2,
    mode: "auto",
    workflowMode: "on",
    roleModels: {
      architect: { provider: architect.provider, model: architect.id, thinkingLevel: "max" },
      "docs-commit": { provider: docs.provider, model: docs.id, thinkingLevel: "high" },
      "developer-test": { provider: developer.provider, model: developer.id, thinkingLevel: "high" },
    },
    ...config,
  }, null, 2)}\n`);
  const harness = createExtensionHarness([], {
    cwd: directory,
    trusted: true,
    model: architect,
    availableModels: [architect, docs, developer],
    sessionId: "workflow-input-resume-session",
    ...options,
  });
  await emitExtensionEvent(harness, "session_start");
  return harness;
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

test("待审计划按用户方向修订，恢复后仍须审批修订版才派发", async () => {
  await withTempDirectory(async (directory) => {
    const architectModel = stubArchitect(reply("replan"));
    const h = await makeHarness(directory, architectModel);
    try {
      await execute(h, "plan", { action: "plan", summary: "原计划", reviewRequired: true, tasks: [task("original", "检查项目元信息")] });
      const direction = "不要再读 package.json，只验证本地 D1 查询，先给我看新方案";
      await emitExtensionEvent(h, "agent_start");
      assert.equal((await input(h, direction)).action, "handled");
      assert.equal(latestWorkflow(h).status, "replanning");
      assert.equal(architectModel.calls.length, 1);
      assert.equal(JSON.parse(architectModel.calls[0].context.messages[0].content).contract.currentTask, undefined);
      assert.equal(h.sentMessages.length, 0, "当前回合收敛前不启动架构重规划");
      await emitExtensionEvent(h, "agent_settled");
      assert.match(h.sentMessages.at(-1).message.content, /只验证本地 D1 查询/);
      assert.equal(dispatches(h).length, 0);

      await emitExtensionEvent(h, "session_start");
      const identity = workflowMessageIdentity(h, "pi-init-workflow-replan");
      await execute(h, "apply", { action: "replan", ...identity, summary: "修订计划", tasks: [task("d1", "验证本地 D1 查询")] });
      await emitExtensionEvent(h, "agent_settled");
      assert.equal(latestWorkflow(h).pauseReason, "architecture-review");
      assert.equal(latestWorkflow(h).currentTaskId, undefined);
      assert.deepEqual(latestWorkflow(h).tasks.map(t => t.id), ["d1"]);
      assert.equal(dispatches(h).length, 0);
      await input(h, "继续");
      await emitExtensionEvent(h, "agent_settled");
      assert.equal(dispatches(h).length, 0);

      await h.commands.get("pi-init").handler("workflow resume", h.context);
      assert.equal(latestWorkflow(h).currentTaskId, "d1");
      assert.equal(dispatches(h).length, 1);
      assert.equal(architectModel.calls.length, 1);
    } finally { await emitExtensionEvent(h, "session_shutdown"); }
  });
});

test("同任务纠偏只传递一个用户输入，改目标仍走任务边界重规划", async () => {
  await withTempDirectory(async (directory) => {
    const architectModel = stubArchitect(reply(null), reply("correction"), reply("replan"));
    const h = await makeHarness(directory, { ...architectModel, deferSendMessagePersistence: true });
    try {
      const identity = await startTask(h);
      const before = structuredClone(latestWorkflow(h));
      assert.equal(before.handoff.phase, "executing");
      const sent = h.sentMessages.length;
      const result = await input(h, "任务纠偏：绑定已确认；不要再查配置；下一步只验证已发布数据查询。");
      assert.equal(result.action, "transform");
      assert.match(result.text, /绑定已确认；不要再查配置；下一步只验证已发布数据查询/);
      assert.deepEqual(latestWorkflow(h), before);
      assert.equal(h.sentMessages.length, sent);
      assert.equal(h.sentUserMessages.length, 0);

      assert.equal((await input(h, "改成内部分流消息", "extension")).action, "continue");
      assert.equal((await input(h, "这个任务有哪些限制？")).action, "continue");
      const sameTask = "跳过配置检查，先验证已发布数据查询。";
      const corrected = await input(h, sameTask);
      assert.equal(corrected.action, "transform");
      assert.ok(corrected.text.includes(sameTask));
      assert.deepEqual(latestWorkflow(h), before);
      assert.equal(h.context.model, developer);
      assert.equal(h.getThinkingLevel(), "high");
      assert.equal(h.sentMessages.length, sent);
      assert.equal(h.sentUserMessages.length, 0);

      const call = architectModel.calls[1];
      assert.equal(call.model, architect);
      assert.equal(call.options.reasoning, "low");
      assert.equal(call.context.tools, undefined);
      assert.equal(call.context.messages.length, 1);
      assert.deepEqual(JSON.parse(call.context.messages[0].content), {
        contract: {
          goal: "查询已发布数据",
          constraints: [],
          currentTask: { goal: "验证本地已发布数据查询", acceptanceCriteria: ["验证本地已发布数据查询"] },
        },
        userInstruction: sameTask,
      });

      const changeGoal = "改为验证未发布文章的访问权限";
      assert.equal((await input(h, changeGoal)).action, "handled");
      assert.equal(latestWorkflow(h).currentTaskId, "check");
      assert.deepEqual(latestWorkflow(h).handoff, before.handoff);
      assert.equal(latestWorkflow(h).pendingRevision.direction, changeGoal);
      assert.equal((await input(h, "任务纠偏：直接测试新目标")).action, "handled");
      assert.equal(architectModel.calls.length, 3);
      assert.equal(h.sentMessages.length, sent);

      await execute(h, "block", { ...identity, action: "block", reason: "目标改变，旧任务不能按新契约执行。" });
      await emitExtensionEvent(h, "agent_settled");
      h.persistSentMessage();
      const revision = workflowMessageIdentity(h, "pi-init-workflow-replan");
      await execute(h, "apply", { ...revision, action: "replan", summary: changeGoal, tasks: [task("permissions", changeGoal)] });
      await emitExtensionEvent(h, "agent_settled");
      assert.equal(latestWorkflow(h).pauseReason, "architecture-review");
      assert.equal(dispatches(h).length, 1, "未批准的新计划不派发首任务");
      await h.commands.get("pi-init").handler("workflow resume", h.context);
      assert.equal(latestWorkflow(h).currentTaskId, "permissions");
      assert.equal(dispatches(h).length, 2);
    } finally { await emitExtensionEvent(h, "session_shutdown"); }
  });
});

test("Auto 使用固定模型的架构强度，不切换当前执行者", async () => {
  await withTempDirectory(async (directory) => {
    const architectModel = stubArchitect(reply("correction"));
    const fixed = { ...developer, reasoning: true };
    const h = await makeHarness(directory, { ...architectModel, model: fixed, availableModels: [fixed, architect], deferSendMessagePersistence: true }, {
      schemaVersion: 3,
      mode: undefined,
      modelStrategy: "auto",
      autoModel: { provider: developer.provider, model: developer.id, initialThinkingLevel: "medium", minThinkingLevel: "low", maxThinkingLevel: "high" },
    });
    await h.tools.find(tool => tool.name === "switch_role").execute("architect", { role: "architect" }, undefined, undefined, h.context);
    await startTask(h);
    const before = latestWorkflow(h);
    assert.equal(h.getThinkingLevel(), "medium");
    assert.equal((await input(h, "跳过已核实的配置，直接查询", "rpc")).action, "transform");
    assert.equal(architectModel.calls.length, 1);
    assert.equal(architectModel.calls[0].model, fixed);
    assert.equal(architectModel.calls[0].options.reasoning, "low");
    assert.equal(h.context.model, fixed);
    assert.equal(h.getThinkingLevel(), "medium");
    assert.deepEqual(latestWorkflow(h), before);
  });
  await withTempDirectory(async (directory) => {
    const architectModel = stubArchitect(reply("correction"));
    const fixed = { ...developer, reasoning: true };
    const h = await makeHarness(directory, { ...architectModel, model: fixed, availableModels: [fixed, architect], deferSendMessagePersistence: true }, {
      schemaVersion: 3,
      mode: undefined,
      modelStrategy: "auto",
      autoModel: { provider: developer.provider, model: developer.id, initialThinkingLevel: "high", minThinkingLevel: "medium", maxThinkingLevel: "high" },
    });
    await h.tools.find(tool => tool.name === "switch_role").execute("architect", { role: "architect" }, undefined, undefined, h.context);
    await startTask(h);
    assert.equal((await input(h, "跳过已核实的配置，直接查询", "rpc")).action, "transform");
    assert.equal(architectModel.calls[0].options.reasoning, "medium");
  });
});

test("普通会话、未信任项目、显式入口不调用架构模型", async () => {
  await withTempDirectory(async (directory) => {
    const architectModel = stubArchitect();
    const h = await makeHarness(directory, architectModel);
    assert.equal((await input(h, "把搜索范围缩小到文档")).action, "continue");
    await execute(h, "plan", { action: "plan", summary: "等待审阅", reviewRequired: true, tasks: [task("first", "检查方案")] });
    const before = latestWorkflow(h);
    h.context.isProjectTrusted = () => false;
    assert.equal((await input(h, "改为只验证本地查询")).action, "continue");
    assert.deepEqual(latestWorkflow(h), before);
    h.context.isProjectTrusted = () => true;
    assert.equal((await input(h, "/pi-init status")).action, "continue");
    assert.equal((await input(h, "继续原计划")).action, "continue");
    assert.equal((await input(h, "重规划：只验证本地查询")).action, "handled");
    assert.equal(latestWorkflow(h).pendingRevision.reviewRequired, true);
    assert.equal(architectModel.calls.length, 0);
  });
});

test("roles 未配置 architect 时普通输入直通，配置不可用时明确拒绝，均不借用当前执行模型", async () => {
  await withTempDirectory(async (directory) => {
    const architectModel = stubArchitect();
    const h = await makeHarness(directory, { ...architectModel, deferSendMessagePersistence: true });
    await startTask(h);
    await writeFile(path.join(directory, ".pi", "role-models.json"), JSON.stringify({ schemaVersion: 3, workflowMode: "on", roleModels: {} }));
    const before = latestWorkflow(h);
    assert.equal((await input(h, "跳过已核实的配置，直接查询")).action, "continue");
    assert.equal(architectModel.calls.length, 0);
    assert.deepEqual(latestWorkflow(h), before);
    assert.equal((await input(h, "任务纠偏：跳过已核实的配置，直接查询")).action, "transform");

    await writeFile(path.join(directory, ".pi", "role-models.json"), JSON.stringify({
      schemaVersion: 3, workflowMode: "on",
      roleModels: { architect: { provider: "missing", model: "missing", thinkingLevel: "high" } },
    }));
    assert.equal((await input(h, "跳过已核实的配置，直接查询")).action, "handled");
    assert.match(h.notifications.at(-1).message, /没有可用的已配置架构模型.*任务纠偏/);
    assert.equal(architectModel.calls.length, 0);
    assert.deepEqual(latestWorkflow(h), before);
  });
});

test("模型失败、非法动作、围栏格式边界与待审计划收到纠偏结果都不会改变工作流或自动批准", async () => {
  await withTempDirectory(async (directory) => {
    const architectModel = stubArchitect(
      { stopReason: "error", content: [], errorMessage: "provider internal detail" },
      { stopReason: "stop", content: [{ type: "text", text: '{"direction":"replan","action":"resume"}' }] },
      { stopReason: "stop", content: [{ type: "text", text: '```json\n{"direction":"replan","action":"resume"}\n```' }] },
      { stopReason: "stop", content: [{ type: "text", text: '说明：\n```json\n{"direction":"replan"}\n```' }] },
      { stopReason: "toolUse", content: [{ type: "toolCall", name: "task_workflow" }] },
      reply("correction"),
    );
    const h = await makeHarness(directory, architectModel);
    await execute(h, "plan", { action: "plan", summary: "等待审阅", reviewRequired: true, tasks: [task("first", "检查方案")] });
    const before = latestWorkflow(h);
    for (const message of [/判断失败/, /未返回合法方向/, /未返回合法方向/, /未返回合法方向/, /未返回合法方向/, /没有执行中任务/]) {
      assert.equal((await input(h, "只验证本地查询")).action, "handled");
      assert.match(h.notifications.at(-1).message, message);
      assert.doesNotMatch(h.notifications.at(-1).message, /provider internal detail/);
      assert.deepEqual(latestWorkflow(h), before);
    }
    assert.equal(architectModel.calls.length, 6);
    assert.equal(h.sentMessages.length, 0);
  });
  await withTempDirectory(async (directory) => {
    const fencedCorrection = { stopReason: "stop", content: [{ type: "text", text: '```json\n{"direction":"correction"}\n```' }] };
    const architectModel = stubArchitect(fencedCorrection);
    const h = await makeHarness(directory, { ...architectModel, deferSendMessagePersistence: true });
    await startTask(h);
    const result = await input(h, "跳过配置检查，直接验证查询");
    assert.equal(result.action, "transform");
    assert.match(result.text, /跳过配置检查，直接验证查询/);
  });
});

test("方向判断进行中发送斜杠命令不失效当前判断；已有 pendingRevision 时跳过模型判断", async () => {
  await withTempDirectory(async (directory) => {
    const response = Promise.withResolvers();
    const started = Promise.withResolvers();
    const stub = stubArchitect(response.promise);
    const h = await makeHarness(directory, {
      deferSendMessagePersistence: true,
      streamSimple(...args) {
        const stream = stub.streamSimple(...args);
        started.resolve();
        return stream;
      },
    });
    await startTask(h);
    const request = input(h, "跳过已核实配置，直接验证查询");
    await Promise.race([started.promise, request.then(() => assert.fail("没有启动架构判断"))]);
    assert.equal((await input(h, "/pi-init status")).action, "continue");
    response.resolve(reply("correction"));
    const result = await request;
    assert.equal(result.action, "transform");
    assert.match(result.text, /跳过已核实配置/);

    assert.equal((await input(h, "重规划：改为验证写入权限")).action, "handled");
    assert.equal(stub.calls.length, 1);
    assert.equal((await input(h, "顺便问一下进度")).action, "continue");
    assert.equal(stub.calls.length, 1, "已有 pendingRevision 时不再调用架构模型");
  });
});

test("replan 无法应用时给出未应用提示而非静默吞掉输入", async () => {
  await withTempDirectory(async (directory) => {
    const state = createExtensionRuntimeState();
    const architectModel = stubArchitect(reply("replan"));
    const h = await makeHarness(directory, { ...architectModel, deferSendMessagePersistence: true });
    await startTask(h);
    state.workflowState = latestWorkflow(h);
    state.activeRole = { role: "developer-test", provider: developer.provider, model: developer.id, thinkingLevel: "high" };
    const direction = createWorkflowDirectionInput(state, {
      readConfig: async () => ({
        modelStrategy: "roles",
        schemaVersion: 3,
        workflowMode: "on",
        workflowExecutor: "local",
        roleModels: { architect: { provider: architect.provider, model: architect.id, thinkingLevel: "max" } },
      }),
      activeRoleFor: () => state.activeRole,
      revise: async () => false,
      hasOutgoingTransfer: () => false,
    });
    const gen = direction.invalidate();
    const res = await direction.handle({ source: "interactive", text: "改为验证写入权限" }, h.context, gen);
    assert.equal(res.action, "handled");
    assert.match(h.notifications.at(-1).message, /未应用这条输入：当前工作流状态不能记录重规划/);
  });
});

test("方向判断超时不转交执行者，也不重试", async t => {
  await withTempDirectory(async (directory) => {
    const architectModel = stubArchitect(new Promise(() => {}));
    const h = await makeHarness(directory, { ...architectModel, deferSendMessagePersistence: true });
    await startTask(h);
    const before = latestWorkflow(h);
    const started = Promise.withResolvers();
    const stream = h.context.modelRegistry.streamSimple;
    h.context.modelRegistry.streamSimple = (...args) => {
      started.resolve();
      return stream(...args);
    };
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const request = input(h, "改为验证写入路径");
    await Promise.race([started.promise, request.then(() => assert.fail("没有启动架构判断"))]);
    t.mock.timers.tick(60_000);
    assert.equal((await request).action, "handled");
    assert.equal(architectModel.calls[0].options.signal.aborted, true);
    assert.equal(architectModel.calls.length, 1);
    assert.match(h.notifications.at(-1).message, /判断超时/);
    assert.deepEqual(latestWorkflow(h), before);
  });
});

for (const race of ["下一任务", "停止", "新输入", "切换分支"]) {
  test(`架构判断未结束时${race}，不能应用过期方向`, async () => {
    await withTempDirectory(async (directory) => {
      const response = Promise.withResolvers();
      const started = Promise.withResolvers();
      const first = stubArchitect(response.promise, reply(null));
      const h = await makeHarness(directory, {
        deferSendMessagePersistence: true,
        streamSimple(...args) {
          const stream = first.streamSimple(...args);
          started.resolve();
          return stream;
        },
      });
      const identity = await startTask(h, [task("next", "检查分页")]);
      const request = input(h, "把工作流改为验证写入路径");
      await Promise.race([started.promise, request.then(() => assert.fail("没有启动架构判断"))]);
      if (race === "下一任务") {
        await execute(h, "complete", {
          ...identity,
          action: "complete",
          completionSummary: "本地已发布数据查询已验证",
          implementationRationale: "复用当前验收的查询入口",
          verification: [{ check: "本地查询", status: "passed", details: "测试夹具已返回预期数据" }],
        });
        await emitExtensionEvent(h, "agent_settled");
        assert.equal(latestWorkflow(h).currentTaskId, "next");
      } else if (race === "停止") {
        assert.equal((await input(h, "停止")).action, "handled");
        assert.equal(latestWorkflow(h).pauseReason, "handoff-outcome-unknown");
        await input(h, "只验证只读路径");
        assert.equal(first.calls.length, 1, "停止后不发送新的方向判断请求");
      } else if (race === "新输入") {
        assert.equal((await input(h, "为什么选择本地查询？")).action, "continue");
      } else {
        const oldLeafId = h.context.sessionManager.getLeafId();
        await emitExtensionEvent(h, "session_tree", { oldLeafId, newLeafId: "different-branch" });
      }
      response.resolve(reply("replan"));
      assert.equal((await request).action, "handled");
      assert.equal(latestWorkflow(h).pendingRevision, undefined);
      assert.equal(h.sentMessages.some(({ message }) => message.customType === "pi-init-workflow-replan"), false);
      if (race !== "下一任务") assert.equal(first.calls[0].options.signal.aborted, true);
    });
  });
}

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
    assert.equal(pending.pendingRevision.kind, "goal");
    await emitExtensionEvent(harness, "input", { text: "这个设计合理吗？", source: "interactive" });
    assert.deepEqual(latestWorkflow(harness), pending, "待规划期间的讨论不污染显式子流程请求");
    await emitExtensionEvent(harness, "input", { text: "追加任务：补测试", source: "interactive" });
    assert.equal(latestWorkflow(harness).workflowId, pending.workflowId);
    assert.equal(latestWorkflow(harness).pendingRevision.kind, "replan");
    assert.match(latestWorkflow(harness).pendingRevision.direction, /独立检查部署环境/);
    assert.match(latestWorkflow(harness).pendingRevision.direction, /补测试/);
  });
});

test("显式问答与讨论前缀不调用架构模型并直接剥离放行，空正文不误剥离", async () => {
  assert.equal(parseExplicitWorkflowQuestionInput("问答：目前已经验证了哪些边界情况？"), "目前已经验证了哪些边界情况？");
  assert.equal(parseExplicitWorkflowQuestionInput("讨论: 为什么选择这套实现？"), "为什么选择这套实现？");
  assert.equal(parseExplicitWorkflowQuestionInput("问答：   "), undefined);

  await withTempDirectory(async (directory) => {
    const architectModel = stubArchitect({ stopReason: "error", content: [], errorMessage: "down" });
    const h = await makeHarness(directory, { ...architectModel, deferSendMessagePersistence: true });
    await execute(h, "plan", { action: "plan", summary: "待审计划", reviewRequired: true, tasks: [task("first", "检查方案")] });
    const reviewBefore = latestWorkflow(h);
    const reviewResult = await input(h, "问答：这个计划覆盖了哪些验收点？");
    assert.equal(reviewResult.action, "transform");
    assert.equal(reviewResult.text, "这个计划覆盖了哪些验收点？");
    assert.deepEqual(latestWorkflow(h), reviewBefore);
    assert.equal(architectModel.calls.length, 0);
  });

  await withTempDirectory(async (directory) => {
    const architectModel = stubArchitect(reply(null));
    const h = await makeHarness(directory, { ...architectModel, deferSendMessagePersistence: true });
    await startTask(h);
    const before = latestWorkflow(h);
    const q1 = await input(h, "问答：目前已经验证了哪些边界情况？");
    assert.equal(q1.action, "transform");
    assert.equal(q1.text, "目前已经验证了哪些边界情况？");
    const q2 = await input(h, "  讨论: 这个约束为什么存在？ ");
    assert.equal(q2.action, "transform");
    assert.equal(q2.text, "这个约束为什么存在？");
    assert.equal(architectModel.calls.length, 0);
    assert.equal((await input(h, "问答：   ")).action, "continue");
    assert.equal(architectModel.calls.length, 1);
    assert.deepEqual(latestWorkflow(h), before);
  });
});

test("已配置架构模型故障或超时时，交互确认允许按普通消息发送，取消或非交互来源保持拦截", async t => {
  for (const [label, errorCase] of [
    ["model-failed", { reply: { stopReason: "error", content: [], errorMessage: "upstream 503" } }],
    ["invalid-response", { reply: { stopReason: "stop", content: [{ type: "text", text: "not json" }] } }],
    ["model-unavailable", { unavailable: true }],
  ]) {
    await withTempDirectory(async (directory) => {
      const architectModel = errorCase.unavailable ? stubArchitect() : stubArchitect(errorCase.reply, errorCase.reply);
      const confirms = [];
      let answer = true;
      const h = await makeHarness(directory, {
        ...architectModel,
        ...(errorCase.unavailable ? { availableModels: [developer, docs] } : {}),
        deferSendMessagePersistence: true,
        confirm: async (title, message) => { confirms.push({ title, message }); return answer; },
      });
      await startTask(h);
      const before = latestWorkflow(h);

      assert.equal((await input(h, "目前已经验证了哪些边界情况？", "interactive")).action, "continue", label);
      assert.equal(confirms.length, 1);
      assert.match(confirms[0].title, /按普通消息发送/);
      assert.match(confirms[0].message, /问答：<内容>/);
      assert.deepEqual(latestWorkflow(h), before);

      answer = false;
      assert.equal((await input(h, "目前已经验证了哪些边界情况？", "interactive")).action, "handled", label);
      assert.equal(confirms.length, 2);
      assert.match(h.notifications.at(-1).message, /「问答：<内容>」、「任务纠偏：<指令>」或「重规划：<新方向>」/);
      assert.deepEqual(latestWorkflow(h), before);
    });
  }

  await withTempDirectory(async (directory) => {
    const architectModel = stubArchitect(
      { stopReason: "error", content: [], errorMessage: "upstream 503" },
      { stopReason: "error", content: [], errorMessage: "upstream 503" },
    );
    const confirms = [];
    const h = await makeHarness(directory, {
      ...architectModel,
      deferSendMessagePersistence: true,
      confirm: async (title, message) => { confirms.push({ title, message }); return true; },
    });
    await startTask(h);
    const before = latestWorkflow(h);

    assert.equal((await input(h, "目前已经验证了哪些边界情况？", "rpc")).action, "handled");
    assert.equal(confirms.length, 0);
    assert.match(h.notifications.at(-1).message, /「问答：<内容>」/);

    h.context.hasUI = false;
    assert.equal((await input(h, "目前已经验证了哪些边界情况？", "interactive")).action, "handled");
    assert.equal(confirms.length, 0);
    assert.deepEqual(latestWorkflow(h), before);
  });

  await withTempDirectory(async (directory) => {
    const architectModel = stubArchitect(new Promise(() => {}));
    const confirms = [];
    const h = await makeHarness(directory, {
      ...architectModel,
      deferSendMessagePersistence: true,
      confirm: async (title, message) => { confirms.push({ title, message }); return true; },
    });
    await startTask(h);
    const started = Promise.withResolvers();
    const stream = h.context.modelRegistry.streamSimple;
    h.context.modelRegistry.streamSimple = (...args) => { started.resolve(); return stream(...args); };
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const req = input(h, "目前已经验证了哪些边界情况？", "interactive");
    await Promise.race([started.promise, req.then(() => assert.fail("没有启动架构判断"))]);
    t.mock.timers.tick(60_000);
    assert.equal((await req).action, "continue");
    assert.equal(confirms.length, 1);
    assert.match(confirms[0].message, /超时/);
  });
});

test("方向判断确认期间出现新输入或工作流变化，即使确认也拒绝放行，且记录 fallback-continue 诊断", async () => {
  await withTempDirectory(async (directory) => {
    const architectModel = stubArchitect({ stopReason: "error", content: [], errorMessage: "err1" });
    const gate = Promise.withResolvers();
    const confirmOpened = Promise.withResolvers();
    const h = await makeHarness(directory, {
      ...architectModel,
      deferSendMessagePersistence: true,
      confirm: async () => {
        confirmOpened.resolve();
        return await gate.promise;
      },
    });
    await startTask(h);

    const firstReq = input(h, "目前已经验证了哪些边界情况？", "interactive");
    await confirmOpened.promise;
    await input(h, "停止", "interactive");
    gate.resolve(true);
    assert.equal((await firstReq).action, "handled");
  });

  await withTempDirectory(async (directory) => {
    const state = createExtensionRuntimeState();
    const traces = [];
    state.traceHandoff = (_ctx, event, data) => { traces.push({ event, ...data }); };
    const architectModel = stubArchitect(
      { stopReason: "error", content: [], errorMessage: "err1" },
      { stopReason: "error", content: [], errorMessage: "err2" },
    );
    let confirmGate = Promise.withResolvers();
    const h = await makeHarness(directory, {
      ...architectModel,
      deferSendMessagePersistence: true,
      confirm: async () => await confirmGate.promise,
    });
    await startTask(h);
    state.workflowState = latestWorkflow(h);
    state.activeRole = { role: "developer-test", provider: developer.provider, model: developer.id, thinkingLevel: "high" };
    const direction = createWorkflowDirectionInput(state, {
      readConfig: async () => ({
        modelStrategy: "roles",
        schemaVersion: 3,
        workflowMode: "on",
        workflowExecutor: "local",
        roleModels: { architect: { provider: architect.provider, model: architect.id, thinkingLevel: "max" } },
      }),
      activeRoleFor: () => state.activeRole,
      revise: async () => false,
      hasOutgoingTransfer: () => false,
    });

    const gen1 = direction.invalidate();
    const p1 = direction.handle({ source: "interactive", text: "目前已经验证了哪些边界情况？" }, h.context, gen1);
    confirmGate.resolve(true);
    assert.equal(await p1, undefined);
    assert.equal(traces.findLast(t => t.outcome === "fallback-continue")?.code, "model-failed");

    confirmGate = Promise.withResolvers();
    const opened2 = Promise.withResolvers();
    h.context.ui.confirm = async () => { opened2.resolve(); return await confirmGate.promise; };
    const gen2 = direction.invalidate();
    const p2 = direction.handle({ source: "interactive", text: "目前已经验证了哪些边界情况？" }, h.context, gen2);
    await opened2.promise;
    h.branch.splice(0, h.branch.length, { type: "custom", id: "branch-shift", customType: "pi-init-workflow", data: state.workflowState });
    confirmGate.resolve(true);
    assert.equal((await p2).action, "handled");
    assert.equal(traces.at(-1).outcome, "stale-state");
    assert.match(h.notifications.at(-1).message, /确认期间会话或工作流状态已经变化/);
  });
});
