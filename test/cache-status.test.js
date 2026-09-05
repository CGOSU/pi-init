import assert from "node:assert/strict";
import test from "node:test";

import {
  createExtensionHarness,
  emitExtensionEvent,
} from "./helpers.js";

function usage(cacheRead = 0, cacheWrite = 0) {
  return {
    input: 100,
    output: 20,
    cacheRead,
    cacheWrite,
    totalTokens: 100 + 20 + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistantMessage(cacheRead = 0, cacheWrite = 0, stopReason = "stop") {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    usage: usage(cacheRead, cacheWrite),
    stopReason,
    timestamp: Date.now(),
  };
}

function useMarkedTheme(harness) {
  harness.context.ui.theme.fg = (color, text) => `<${color}>${text}</${color}>`;
  harness.context.ui.theme.bold = (text) => `<bold>${text}</bold>`;
}

function cacheCalls(harness) {
  return harness.statusCalls.filter((call) => call.name === "pi-cache");
}

function latestCacheStatus(harness) {
  return cacheCalls(harness).at(-1)?.text ?? "";
}

async function beginRequest(harness) {
  await emitExtensionEvent(harness, "before_provider_request", { payload: {} });
}

async function emitUpdate(harness, type, cacheRead = 0, cacheWrite = 0) {
  const message = assistantMessage(cacheRead, cacheWrite);
  await emitExtensionEvent(harness, "message_update", {
    message,
    assistantMessageEvent: { type, partial: message },
  });
}

async function finishRequest(harness, cacheRead = 0, cacheWrite = 0, stopReason = "stop") {
  await emitExtensionEvent(harness, "message_end", {
    message: assistantMessage(cacheRead, cacheWrite, stopReason),
  });
}

test("注册 pi-cache 生命周期状态并与 pi-init 状态共存", async () => {
  const harness = createExtensionHarness();
  useMarkedTheme(harness);

  assert.ok(harness.handlers.has("before_provider_request"));
  assert.ok(harness.handlers.has("message_update"));
  assert.ok(harness.handlers.has("message_end"));
  assert.ok(harness.handlers.has("agent_settled"));

  await emitExtensionEvent(harness, "session_start");
  assert.match(latestCacheStatus(harness), /缓存 · 等待请求/);
  assert.ok(harness.statusCalls.some((call) => call.name === "pi-init"));
});

test("请求阶段高亮 Input，首个输出 delta 后高亮 Output", async () => {
  const harness = createExtensionHarness();
  useMarkedTheme(harness);

  await beginRequest(harness);
  assert.match(latestCacheStatus(harness), /<bold><accent>↑Input<\/accent><\/bold>/);
  assert.match(latestCacheStatus(harness), /<warning>◌ 缓存判定中<\/warning>/);

  await emitUpdate(harness, "text_delta");
  assert.match(latestCacheStatus(harness), /<bold><accent>↓Output<\/accent><\/bold>/);
});

test("相同语义的逐 token update 不重复刷新状态", async () => {
  const harness = createExtensionHarness();
  useMarkedTheme(harness);

  await beginRequest(harness);
  await emitUpdate(harness, "text_delta");
  const count = cacheCalls(harness).length;
  await emitUpdate(harness, "text_delta");

  assert.equal(cacheCalls(harness).length, count);
});

test("Provider 延迟到 message_end 才报告 Cache Read，最终值覆盖暂态", async () => {
  const harness = createExtensionHarness();
  useMarkedTheme(harness);

  await beginRequest(harness);
  await emitUpdate(harness, "text_delta");
  assert.match(latestCacheStatus(harness), /缓存判定中/);

  await finishRequest(harness, 2048, 0);
  assert.match(latestCacheStatus(harness), /<success>R缓存读 2\.0k<\/success>/);
  assert.doesNotMatch(latestCacheStatus(harness), /<bold>|<accent>/);

  const status = latestCacheStatus(harness);
  await emitExtensionEvent(harness, "agent_settled");
  assert.equal(latestCacheStatus(harness), status);
});

test("只确认明确报告的 Cache Write 和读写组合", async () => {
  for (const [cacheRead, cacheWrite, expected] of [
    [0, 3072, /<success>W缓存写 3\.1k<\/success>/],
    [4096, 1024, /<success>R缓存读 4\.1k<\/success> · <success>W缓存写 1\.0k<\/success>/],
  ]) {
    const harness = createExtensionHarness();
    useMarkedTheme(harness);
    await beginRequest(harness);
    await finishRequest(harness, cacheRead, cacheWrite);
    assert.match(latestCacheStatus(harness), expected);
    assert.doesNotMatch(latestCacheStatus(harness), /<bold>|<accent>/);
  }
});

test("message_end 的最终零值不推断为命中、写入或未命中", async () => {
  const harness = createExtensionHarness();
  useMarkedTheme(harness);

  await beginRequest(harness);
  await emitUpdate(harness, "text_delta");
  await finishRequest(harness);

  assert.match(latestCacheStatus(harness), /<muted>– 上轮缓存未报告<\/muted>/);
  assert.doesNotMatch(latestCacheStatus(harness), /缓存读|缓存写|<success>/);
  assert.doesNotMatch(latestCacheStatus(harness), /<bold>|<accent>|判定中/);
});

test("最终 usage 覆盖流式阶段的暂态缓存数据", async () => {
  const harness = createExtensionHarness();
  useMarkedTheme(harness);

  await beginRequest(harness);
  await emitUpdate(harness, "text_delta", 2048, 0);
  assert.match(latestCacheStatus(harness), /R缓存读/);

  await finishRequest(harness, 0, 1024);
  assert.doesNotMatch(latestCacheStatus(harness), /R缓存读/);
  assert.match(latestCacheStatus(harness), /W缓存写/);
});

test("错误、中止和缺少结束事件时都清除活动高亮", async () => {
  for (const stopReason of ["error", "aborted"]) {
    const harness = createExtensionHarness();
    useMarkedTheme(harness);
    await beginRequest(harness);
    await finishRequest(harness, 0, 0, stopReason);
    assert.doesNotMatch(latestCacheStatus(harness), /<bold>|<accent>|判定中/);
    assert.match(latestCacheStatus(harness), stopReason === "error" ? /请求失败/ : /已中止/);
  }

  const unfinished = createExtensionHarness();
  useMarkedTheme(unfinished);
  await beginRequest(unfinished);
  await emitExtensionEvent(unfinished, "agent_settled");
  assert.doesNotMatch(latestCacheStatus(unfinished), /<bold>|<accent>|判定中/);
  assert.match(latestCacheStatus(unfinished), /缓存未报告/);
});

test("新会话会重置上一轮缓存状态", async () => {
  const harness = createExtensionHarness();
  useMarkedTheme(harness);

  await beginRequest(harness);
  await finishRequest(harness, 2048, 0);
  assert.match(latestCacheStatus(harness), /R缓存读/);

  await emitExtensionEvent(harness, "session_start", { reason: "new" });
  assert.match(latestCacheStatus(harness), /缓存 · 等待请求/);
  assert.doesNotMatch(latestCacheStatus(harness), /R缓存读|<bold>|<accent>/);
});
