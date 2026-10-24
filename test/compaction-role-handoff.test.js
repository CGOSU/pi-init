import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionHarness, emitExtensionEvent } from "./helpers.js";
import { createWorkflowState, requestWorkflowReplan } from "../src/workflow.ts";

const handoffs = h => h.sentMessages.filter(({ message }) => message.customType === "pi-init-role-handoff");
const switchRole = (h, role) => h.tools.find(tool => tool.name === "switch_role")
  .execute("switch-" + role, { role }, undefined, undefined, h.context);
async function start(h) {
  await emitExtensionEvent(h, "before_agent_start", { messageType: "user", prompt: "继续", systemPromptOptions: { sections: {} } });
  await emitExtensionEvent(h, "agent_start");
}
async function settled(h) {
  await emitExtensionEvent(h, "agent_end");
  await emitExtensionEvent(h, "agent_settled", { aborted: true }); // compact() aborts the old run.
}

async function fixture({ replanning = false, executing = false, changeRole = true } = {}) {
  const branch = [];
  if (replanning || executing) {
    const planned = createWorkflowState({ sessionId: "test-session", summary: "重新规划", tasks: [
      { id: "task", role: "developer-test", task: "实现", files: ["src"], acceptanceCriteria: ["通过"] },
    ] });
    const data = executing ? planned : requestWorkflowReplan(planned, { direction: "调整队列" });
    branch.push({ id: "workflow", type: "custom", customType: "pi-init-workflow", data });
  }
  const h = createExtensionHarness(branch, {
    model: { provider: "test", id: "model", contextWindow: 100000, maxTokens: 1000 },
    deferSendMessagePersistence: executing, // Active-loop message_start precedes branch persistence.
  });
  h.context.hasPendingMessages = () => false;
  const callbacks = [];
  h.context.compact = options => callbacks.push(options);
  if (replanning || executing) await emitExtensionEvent(h, "session_start");
  if (executing) await h.commands.get("pi-init").handler("role docs-commit", h.context);
  else await switchRole(h, "docs-commit");
  await start(h);
  if (executing) {
    const taskMessage = h.sentMessages.find(({ message }) => message.customType === "pi-init-workflow-task")?.message;
    assert.ok(taskMessage, "fixture must dispatch a real workflow task");
    await emitExtensionEvent(h, "message_start", { message: { role: "custom", ...taskMessage } });
    const workflow = h.entries.filter(entry => entry.type === "pi-init-workflow").at(-1)?.data;
    assert.equal(workflow?.status, "running");
    assert.equal(workflow?.handoff?.phase, "executing", "fixture must not rely on a recovered/paused task");
    assert.equal(workflow?.tasks[0].outcomeUnknown, undefined);
  }
  if (changeRole) assert.equal((await switchRole(h, executing ? "developer-test" : "architect")).terminate, true);
  h.context.getContextUsage = () => ({ tokens: 90000, contextWindow: 100000, percent: 90 });
  await emitExtensionEvent(h, "turn_end", {
    outcome: "completed", message: { role: "assistant", content: [{ type: "toolCall", id: "switch" }] },
    toolResults: [{ toolCallId: "switch" }], toolResultEntryIds: ["switch-result"],
  });
  return { h, callbacks, complete: async () => h.completeCompaction(callbacks[0]) };
}

// Approved contract: budget compaction resumes only the already prepared role handoff,
// through its existing scheduler. These are lifecycle mocks, not Provider validation.
for (const order of ["compact-first", "settled-first"]) {
  test(`预算压缩与 settled ${order}：切回 architect 后只续接一次原交接`, async () => {
    const f = await fixture();
    assert.equal(f.callbacks.length, 1);
    if (order === "compact-first") {
      await f.complete();
      assert.equal(handoffs(f.h).length, 0, "old run is still active");
      await settled(f.h);
    } else {
      await settled(f.h);
      assert.equal(handoffs(f.h).length, 0, "compaction has not succeeded yet");
      await f.complete();
    }
    assert.equal(handoffs(f.h).length, 1);
    assert.equal(handoffs(f.h)[0].message.details.role, "architect");
    assert.equal(handoffs(f.h)[0].options.triggerTurn, true);
    f.callbacks[0].onComplete({}); // Duplicate/stale callbacks cannot dispatch again.
    await emitExtensionEvent(f.h, "agent_settled");
    assert.equal(handoffs(f.h).length, 1);
    await start(f.h);
    await settled(f.h);
    assert.equal(handoffs(f.h).length, 1, "no extra run after new role finishes");
    await emitExtensionEvent(f.h, "session_shutdown");
  });
}

test("replanning 的可信角色交接可压缩并续接，不重复派发架构工作流消息", async () => {
  const f = await fixture({ replanning: true });
  assert.equal(f.callbacks.length, 1);
  const replans = f.h.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-replan").length;
  await settled(f.h);
  await f.complete();
  assert.equal(handoffs(f.h).length, 1);
  assert.equal(f.h.sentMessages.filter(({ message }) => message.customType === "pi-init-workflow-replan").length, replans);
  await emitExtensionEvent(f.h, "session_shutdown");
});

for (const failure of ["error", "unknown-result"]) {
  test(`压缩 ${failure} 后即使 settled 迟到也不续接角色交接`, async () => {
    const f = await fixture();
    if (failure === "error") f.callbacks[0].onError(new Error("compaction failed"));
    else f.callbacks[0].onComplete({});
    await settled(f.h);
    assert.equal(handoffs(f.h).length, 0);
    const diagnostic = f.h.sentMessages.find(({ message }) => message.customType === "pi-init-role-transition");
    assert.equal(diagnostic.options.triggerTurn, false);
    assert.equal(diagnostic.message.details.code, "ROLE_COMPACTION_FAILED");
    await emitExtensionEvent(f.h, "session_shutdown");
  });
}

for (const order of ["compact-first", "settled-first"]) {
  for (const failure of ["error", "unknown-result"]) {
    test(`执行中任务压缩 ${failure}/${order}：不回落到工作流提醒派发`, async () => {
      const f = await fixture({ executing: true });
      assert.equal(f.callbacks.length, 1);
      const before = f.h.sentMessages.filter(({ options }) => options?.triggerTurn).length;
      if (order === "settled-first") await settled(f.h);
      if (failure === "error") f.callbacks[0].onError(new Error("compaction failed"));
      else f.callbacks[0].onComplete({});
      if (order === "compact-first") await settled(f.h);
      await emitExtensionEvent(f.h, "agent_settled");
      f.callbacks[0].onComplete({});
      assert.equal(f.h.sentMessages.filter(({ options }) => options?.triggerTurn).length, before);
      assert.equal(handoffs(f.h).length, 0);
      await emitExtensionEvent(f.h, "session_shutdown");
    });
  }
}

test("已有排队消息不追加交接，宿主新回合开始后不补发旧交接", async () => {
  const f = await fixture();
  f.h.context.hasPendingMessages = () => true;
  await settled(f.h);
  await f.complete();
  assert.equal(handoffs(f.h).length, 0);
  await start(f.h);
  f.h.context.hasPendingMessages = () => false;
  await settled(f.h);
  assert.equal(handoffs(f.h).length, 0);
  await emitExtensionEvent(f.h, "session_shutdown");
});

test("压缩成功但宿主仍忙时等待原 settled 入口，不提前启动", async () => {
  const f = await fixture();
  await settled(f.h);
  f.h.context.isIdle = () => false;
  await f.complete();
  assert.equal(handoffs(f.h).length, 0);
  f.h.context.isIdle = () => true;
  await emitExtensionEvent(f.h, "agent_settled");
  assert.equal(handoffs(f.h).length, 1);
  await emitExtensionEvent(f.h, "session_shutdown");
});

for (const invalidation of ["stop", "assistant-error", "assistant-aborted", "branch", "session", "role", "shutdown"]) {
  test(`${invalidation} 撤销待交接，压缩迟到成功不续跑`, async () => {
    const f = await fixture();
    if (invalidation === "stop") await emitExtensionEvent(f.h, "input", { source: "interactive", text: "停止" });
    if (invalidation.startsWith("assistant-")) await emitExtensionEvent(f.h, "message_end", { message: { role: "assistant", stopReason: invalidation.slice("assistant-".length) } });
    if (invalidation === "branch") f.h.branch.splice(0, f.h.branch.length, { id: "different-branch", type: "custom" });
    if (invalidation === "session") f.h.context.sessionManager.getSessionId = () => "different-session";
    if (invalidation === "role") f.h.context.model = { ...f.h.context.model, id: "different-model" };
    if (invalidation === "shutdown") await emitExtensionEvent(f.h, "session_shutdown");
    await f.complete();
    await settled(f.h);
    assert.equal(handoffs(f.h).length, 0);
    await emitExtensionEvent(f.h, "session_shutdown");
  });
}

test("宿主先自行开启新回合时，旧压缩回调不追加职责交接", async () => {
  const f = await fixture();
  await settled(f.h);
  await start(f.h);
  await f.complete();
  await settled(f.h);
  assert.equal(handoffs(f.h).length, 0);
  await emitExtensionEvent(f.h, "session_shutdown");
});

test("无待交接的普通任务压缩成功不额外开启回合", async () => {
  const f = await fixture({ changeRole: false });
  assert.equal(f.callbacks.length, 1);
  await settled(f.h);
  await f.complete();
  await emitExtensionEvent(f.h, "agent_settled");
  assert.equal(handoffs(f.h).length, 0);
  assert.equal(f.h.sentMessages.filter(({ options }) => options?.triggerTurn).length, 0);
  await emitExtensionEvent(f.h, "session_shutdown");
});
