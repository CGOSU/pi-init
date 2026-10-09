import assert from "node:assert/strict";
import test from "node:test";
import { createActivityLifecycle } from "../extensions/activity-lifecycle.ts";
import { ACTIVITY_STATUS_KEY, createActivityStatus } from "../extensions/activity-status.ts";
import { createExtensionHarness } from "./helpers.js";

function createLifecycleHarness(options = {}) {
  const harness = createExtensionHarness([], { mode: "rpc" });
  const handlers = new Map();
  const api = {
    on(name, handler) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
  };
  const activityStatus = createActivityStatus({
    now: options.now,
    refreshIntervalMs: options.refreshIntervalMs ?? 10_000,
  });
  const lifecycle = createActivityLifecycle(api, activityStatus, {
    startDelayMs: options.startDelayMs ?? 5,
    updateDelayMs: options.updateDelayMs ?? 5,
    toolErrorDurationMs: options.toolErrorDurationMs ?? 40,
    now: options.now,
  });
  return {
    ...harness,
    activityStatus,
    lifecycle,
    async emit(name, event = {}) {
      for (const handler of handlers.get(name) ?? []) await handler(event, harness.context);
    },
    latestStatus() {
      return harness.statusCalls.filter((call) => call.name === ACTIVITY_STATUS_KEY).at(-1)?.text;
    },
  };
}

test("Provider 请求显示阶段，delta 合并后只刷新一次且不保留流式状态", async () => {
  let clock = 0;
  const harness = createLifecycleHarness({ now: () => clock });
  await harness.emit("before_provider_request");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(harness.latestStatus(), /等待模型/);
  await harness.emit("message_update", { message: { role: "assistant" } });
  assert.match(harness.latestStatus(), /等待模型/);

  const updates = harness.statusCalls.length;
  clock = 2_000;
  const update = { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta" } };
  await harness.emit("message_update", update);
  await harness.emit("message_update", update);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(harness.latestStatus(), /模型响应 · 2s/);
  assert.equal(harness.statusCalls.length - updates, 1);

  await harness.emit("message_end", { message: { role: "assistant" } });
  assert.equal(harness.latestStatus(), undefined);
  harness.activityStatus.clear(harness.context);
});

test("并发工具以 toolCallId 独立计数，只显示分类不泄露参数或结果", async () => {
  const harness = createLifecycleHarness();
  await harness.emit("tool_execution_start", {
    toolCallId: "call-read",
    toolName: "read",
    args: { path: "C:/private/secret.txt" },
  });
  await harness.emit("tool_execution_start", {
    toolCallId: "call-bash",
    toolName: "bash",
    args: { command: "curl https://private.example/token" },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.match(harness.latestStatus(), /工具执行 ×2/);
  assert.doesNotMatch(harness.latestStatus(), /secret\.txt|private\.example|curl|call-read/);

  await harness.emit("tool_execution_end", {
    toolCallId: "call-read",
    toolName: "read",
    result: { content: "secret text" },
    isError: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(harness.latestStatus(), /执行命令/);
  assert.doesNotMatch(harness.latestStatus(), /×2/);

  await harness.emit("tool_execution_end", { toolCallId: "unknown", toolName: "read", result: {}, isError: false });
  assert.match(harness.latestStatus(), /执行命令/);
  await harness.emit("tool_execution_end", { toolCallId: "call-bash", toolName: "bash", result: {}, isError: false });
  assert.equal(harness.latestStatus(), undefined);

  await harness.emit("tool_execution_start", { toolCallId: "call-write", toolName: "write", args: { path: "private" } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(harness.latestStatus(), /修改文件/);
  await harness.emit("tool_execution_end", { toolCallId: "call-write", toolName: "write", result: {}, isError: false });

  await harness.emit("tool_execution_start", { toolCallId: "call-custom", toolName: "mcp__private__action", args: {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(harness.latestStatus(), /调用工具/);
  assert.doesNotMatch(harness.latestStatus(), /mcp__private__action/);
  await harness.emit("tool_execution_end", { toolCallId: "call-custom", toolName: "mcp__private__action", result: {}, isError: false });
  harness.lifecycle.clear(harness.context);
});

test("短暂工具事件结束后不会延迟闪现", async () => {
  const harness = createLifecycleHarness({ startDelayMs: 30 });
  await harness.emit("tool_execution_start", { toolCallId: "quick", toolName: "read", args: {} });
  await harness.emit("tool_execution_end", { toolCallId: "quick", toolName: "read", result: {}, isError: false });
  await new Promise((resolve) => setTimeout(resolve, 45));

  assert.equal(harness.latestStatus(), undefined);
  assert.equal(harness.statusCalls.length, 0);
  harness.lifecycle.clear(harness.context);
});

test("错误工具只显示局部失败提示，不伪报工作流失败并按时清除", async () => {
  const harness = createLifecycleHarness({ toolErrorDurationMs: 25 });
  harness.activityStatus.setWorkflow(harness.context, { text: "⏳ 任务执行中 · 1/2", color: "accent" });
  await harness.emit("tool_execution_start", { toolCallId: "read-fail", toolName: "read", args: {} });
  await harness.emit("tool_execution_end", { toolCallId: "read-fail", toolName: "read", result: { error: "private details" }, isError: true });

  assert.match(harness.latestStatus(), /读取文件失败/);
  assert.doesNotMatch(harness.latestStatus(), /工作流失败|private details/);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.match(harness.latestStatus(), /任务执行中/);
  assert.doesNotMatch(harness.latestStatus(), /读取文件失败/);
  harness.lifecycle.clear(harness.context);
});

test("session tree 和 settle 清理活动，迟到的旧 toolCallId 不影响新调用", async () => {
  const harness = createLifecycleHarness();
  await harness.emit("tool_execution_start", { toolCallId: "old-tree", toolName: "read", args: {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(harness.latestStatus(), /读取文件/);

  await harness.emit("session_tree", { oldLeafId: "a", newLeafId: "b" });
  assert.equal(harness.latestStatus(), undefined);
  await harness.emit("tool_execution_start", { toolCallId: "new-run", toolName: "bash", args: {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(harness.latestStatus(), /执行命令/);

  await harness.emit("tool_execution_end", { toolCallId: "old-tree", toolName: "read", result: {}, isError: false });
  assert.match(harness.latestStatus(), /执行命令/);
  await harness.emit("agent_settled", { aborted: true });
  assert.equal(harness.latestStatus(), undefined);

  await harness.emit("tool_execution_start", { toolCallId: "settled-old", toolName: "write", args: {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await harness.emit("agent_settled", { aborted: false });
  await harness.emit("tool_execution_end", { toolCallId: "settled-old", toolName: "write", result: {}, isError: false });
  assert.equal(harness.latestStatus(), undefined);
  harness.lifecycle.clear(harness.context);
});

test("agent settle 清除错误提示和计时器", async () => {
  const harness = createLifecycleHarness({ toolErrorDurationMs: 25 });
  await harness.emit("tool_execution_start", { toolCallId: "settled-error", toolName: "bash", args: {} });
  await harness.emit("tool_execution_end", { toolCallId: "settled-error", toolName: "bash", result: {}, isError: true });
  assert.match(harness.latestStatus(), /执行命令失败/);

  await harness.emit("agent_settled", { aborted: false });
  assert.equal(harness.latestStatus(), undefined);
  const callsAtSettle = harness.statusCalls.length;
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(harness.statusCalls.length, callsAtSettle);
  harness.lifecycle.clear(harness.context);
});

test("shutdown 清除错误提示计时器，过期回调不复活状态", async () => {
  const harness = createLifecycleHarness({ toolErrorDurationMs: 30 });
  await harness.emit("tool_execution_start", { toolCallId: "bad", toolName: "bash", args: {} });
  await harness.emit("tool_execution_end", { toolCallId: "bad", toolName: "bash", result: {}, isError: true });
  assert.match(harness.latestStatus(), /执行命令失败/);

  await harness.emit("session_shutdown", { reason: "quit" });
  assert.equal(harness.latestStatus(), undefined);
  const callsAtShutdown = harness.statusCalls.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(harness.statusCalls.length, callsAtShutdown);
  harness.lifecycle.clear(harness.context);
});
