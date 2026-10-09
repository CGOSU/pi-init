import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseCacheUsage } from "../extensions/cache-status.ts";

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

let assistantMessageSequence = 0;

function assistantMessage(cacheRead = 0, cacheWrite = 0, stopReason = "stop") {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    usage: usage(cacheRead, cacheWrite),
    stopReason,
    timestamp: Date.now() + assistantMessageSequence++,
  };
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function useMarkedTheme(harness) {
  harness.context.ui.theme.fg = (color, text) => `<${color}>${text}</${color}>`;
  harness.context.ui.theme.bold = (text) => `<bold>${text}</bold>`;
}

function activityCalls(harness) {
  return harness.statusCalls.filter((call) => call.name === "pi-init-activity");
}

function latestActivityStatus(harness) {
  return activityCalls(harness).at(-1)?.text ?? "";
}

test("cache usage parser returns normalized values and structured validation errors", () => {
  assert.deepEqual(parseCacheUsage({ cacheRead: 2048, cacheWrite: 0 }), {
    ok: true,
    value: { kind: "reported", read: 2048, write: 0 },
  });
  assert.deepEqual(parseCacheUsage({ cacheRead: 0, cacheWrite: 0 }), {
    ok: true,
    value: { kind: "zero-unconfirmed", read: 0, write: 0 },
  });

  const invalidInputs = [
    [undefined, "usage-missing"],
    [[], "usage-type"],
    [{ cacheWrite: 0 }, "cache-read-missing"],
    [{ cacheRead: 0 }, "cache-write-missing"],
    [{ cacheRead: "1", cacheWrite: 0 }, "cache-read-type"],
    [{ cacheRead: Number.NaN, cacheWrite: 0 }, "cache-read-format"],
    [{ cacheRead: 0, cacheWrite: Number.POSITIVE_INFINITY }, "cache-write-format"],
    [{ cacheRead: -1, cacheWrite: 0 }, "cache-read-range"],
    [{ cacheRead: 0.5, cacheWrite: 0 }, "cache-read-precision"],
    [{ cacheRead: Number.MAX_SAFE_INTEGER + 1, cacheWrite: 0 }, "cache-read-overflow"],
  ];

  for (const [input, code] of invalidInputs) {
    const result = parseCacheUsage(input);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, code);
      assert.ok(result.error.message.length > 0);
    }
  }
});

async function beginRequest(harness) {
  await emitExtensionEvent(harness, "before_provider_request", { payload: {} });
  harness.cacheAssistantMessage = assistantMessage();
  await emitExtensionEvent(harness, "message_start", { message: harness.cacheAssistantMessage });
}

async function emitUpdate(harness, type, cacheRead = 0, cacheWrite = 0) {
  const message = harness.cacheAssistantMessage ?? assistantMessage(cacheRead, cacheWrite);
  message.usage = usage(cacheRead, cacheWrite);
  await emitExtensionEvent(harness, "message_update", {
    message,
    assistantMessageEvent: { type, partial: message },
  });
}

async function finishRequest(harness, cacheRead = 0, cacheWrite = 0, stopReason = "stop") {
  const message = harness.cacheAssistantMessage ?? assistantMessage(cacheRead, cacheWrite, stopReason);
  message.usage = usage(cacheRead, cacheWrite);
  message.stopReason = stopReason;
  await emitExtensionEvent(harness, "message_end", { message });
  harness.cacheAssistantMessage = undefined;
}

test("缓存状态共享唯一的 pi-init 活动状态出口", async () => {
  const harness = createExtensionHarness();
  useMarkedTheme(harness);

  assert.ok(harness.handlers.has("before_provider_request"));
  assert.ok(harness.handlers.has("message_update"));
  assert.ok(harness.handlers.has("message_end"));
  assert.ok(harness.handlers.has("agent_settled"));

  await emitExtensionEvent(harness, "session_start");
  assert.match(latestActivityStatus(harness), /自动/);
  assert.doesNotMatch(latestActivityStatus(harness), /缓存 · 等待请求/);
  assert.ok(activityCalls(harness).length > 0);
  assert.ok(harness.statusCalls.every((call) => call.name === "pi-init-activity"));
});

test("TUI 将职责、Provider 阶段和累计时长合并到唯一活动 widget", async () => {
  const harness = createExtensionHarness([], { mode: "tui" });
  await emitExtensionEvent(harness, "session_start");
  await emitExtensionEvent(harness, "agent_start");
  await beginRequest(harness);
  await wait(170);
  await emitUpdate(harness, "text_delta");
  await wait(70);

  assert.deepEqual([...harness.widgets.keys()], ["pi-init-activity"]);
  assert.equal(harness.statusCalls.length, 0);
  const widget = harness.widgets.get("pi-init-activity");
  const component = widget.content({}, harness.context.ui.theme);
  const lines = component.render(48);
  assert.equal(lines.length, 1);
  assert.ok(visibleWidth(lines[0]) <= 48);
  assert.match(lines[0], /模型响应/);

  await finishRequest(harness, 2048, 0);
  await emitExtensionEvent(harness, "agent_settled");
  assert.deepEqual([...harness.widgets.keys()], ["pi-init-activity"]);
  const completedWidget = harness.widgets.get("pi-init-activity");
  const completedLines = completedWidget.content({}, harness.context.ui.theme).render(80);
  assert.match(completedLines[0], /缓存 R2\.0k/);
  assert.match(completedLines[0], /累计/);
});

test("请求中将旧 usage 明确标为上次，结束后只显示本次最终结果", async () => {
  const harness = createExtensionHarness();
  useMarkedTheme(harness);

  await beginRequest(harness);
  await finishRequest(harness, 2048, 0);
  assert.match(latestActivityStatus(harness), /本次缓存 R2\.0k/);

  await beginRequest(harness);
  assert.match(latestActivityStatus(harness), /上次缓存 R2\.0k/);
  assert.doesNotMatch(latestActivityStatus(harness), /本次缓存 R2\.0k/);

  await finishRequest(harness, 0, 1024);
  assert.match(latestActivityStatus(harness), /本次缓存 W1\.0k/);
  assert.doesNotMatch(latestActivityStatus(harness), /上次缓存/);
});

test("Provider 请求和首个输出 delta 显示不同阶段", async () => {
  const harness = createExtensionHarness();
  useMarkedTheme(harness);

  await beginRequest(harness);
  await wait(170);
  assert.match(latestActivityStatus(harness), /↑ 等待模型/);

  await emitUpdate(harness, "text_delta");
  await wait(70);
  assert.match(latestActivityStatus(harness), /↓ 模型响应/);
});

test("相同语义的逐 token update 不重复刷新状态", async () => {
  const harness = createExtensionHarness();
  useMarkedTheme(harness);

  await beginRequest(harness);
  await wait(170);
  await emitUpdate(harness, "text_delta");
  await wait(70);
  const count = activityCalls(harness).length;
  await emitUpdate(harness, "text_delta");

  assert.equal(activityCalls(harness).length, count);
});

test("Provider 延迟到 message_end 才报告 Cache Read，最终值覆盖暂态", async () => {
  const harness = createExtensionHarness();
  useMarkedTheme(harness);

  await beginRequest(harness);
  await wait(170);
  await emitUpdate(harness, "text_delta");
  await wait(70);
  assert.match(latestActivityStatus(harness), /↓ 模型响应/);

  await finishRequest(harness, 2048, 0);
  assert.match(latestActivityStatus(harness), /缓存 R2\.0k/);

  await emitExtensionEvent(harness, "agent_settled");
  assert.match(latestActivityStatus(harness), /缓存 R2\.0k/);
});

test("只确认明确报告的 Cache Write 和读写组合", async () => {
  for (const [cacheRead, cacheWrite, expected] of [
    [0, 3072, /缓存 W3\.1k/],
    [4096, 1024, /缓存 R4\.1k\/W1\.0k/],
  ]) {
    const harness = createExtensionHarness();
    useMarkedTheme(harness);
    await beginRequest(harness);
    await finishRequest(harness, cacheRead, cacheWrite);
    assert.match(latestActivityStatus(harness), expected);
  }
});

test("message_end 的最终零值不推断为命中、写入或未命中", async () => {
  const harness = createExtensionHarness();
  useMarkedTheme(harness);

  await beginRequest(harness);
  await emitUpdate(harness, "text_delta");
  await finishRequest(harness);

  assert.match(latestActivityStatus(harness), /缓存 0（来源未确认）/);
  assert.doesNotMatch(latestActivityStatus(harness), /缓存 R|缓存 W|命中|未命中/);
});

test("缺少缓存计数时与零值保持不同状态", async () => {
  const missingUsage = createExtensionHarness();
  useMarkedTheme(missingUsage);
  await beginRequest(missingUsage);
  const messageWithoutUsage = missingUsage.cacheAssistantMessage;
  messageWithoutUsage.usage = undefined;
  await emitExtensionEvent(missingUsage, "message_end", { message: messageWithoutUsage });
  missingUsage.cacheAssistantMessage = undefined;
  assert.match(latestActivityStatus(missingUsage), /缓存 usage 未提供/);
  assert.doesNotMatch(latestActivityStatus(missingUsage), /缓存 0/);

  const missingFields = createExtensionHarness();
  useMarkedTheme(missingFields);
  await beginRequest(missingFields);
  const messageWithoutCounts = missingFields.cacheAssistantMessage;
  messageWithoutCounts.usage = { input: 120, output: 20, totalTokens: 140, cost: {} };
  await emitExtensionEvent(missingFields, "message_end", { message: messageWithoutCounts });
  missingFields.cacheAssistantMessage = undefined;
  assert.match(latestActivityStatus(missingFields), /缓存 usage 字段不完整/);
  assert.doesNotMatch(latestActivityStatus(missingFields), /缓存 0|缓存 R|缓存 W/);

  const partialCounts = createExtensionHarness();
  useMarkedTheme(partialCounts);
  await beginRequest(partialCounts);
  const messageWithPartialCounts = partialCounts.cacheAssistantMessage;
  messageWithPartialCounts.usage = { cacheRead: 1024 };
  await emitExtensionEvent(partialCounts, "message_end", { message: messageWithPartialCounts });
  partialCounts.cacheAssistantMessage = undefined;
  assert.match(latestActivityStatus(partialCounts), /缓存 usage 字段不完整/);
  assert.doesNotMatch(latestActivityStatus(partialCounts), /缓存 R1\.0k/);

  const invalidUsage = createExtensionHarness();
  useMarkedTheme(invalidUsage);
  await beginRequest(invalidUsage);
  const messageWithInvalidUsage = invalidUsage.cacheAssistantMessage;
  messageWithInvalidUsage.usage = { cacheRead: "bad", cacheWrite: 0 };
  await emitExtensionEvent(invalidUsage, "message_end", { message: messageWithInvalidUsage });
  invalidUsage.cacheAssistantMessage = undefined;
  assert.match(latestActivityStatus(invalidUsage), /缓存 usage 无效/);
});

test("缓存 usage 只在 message_end 使用最终报告值", async () => {
  const harness = createExtensionHarness();
  useMarkedTheme(harness);

  await beginRequest(harness);
  await emitUpdate(harness, "text_delta", 2048, 0);
  assert.doesNotMatch(latestActivityStatus(harness), /缓存 R/);

  await finishRequest(harness, 0, 1024);
  assert.doesNotMatch(latestActivityStatus(harness), /缓存 R/);
  assert.match(latestActivityStatus(harness), /缓存 W/);
});

test("错误、中止和缺少结束事件时都清除活动高亮", async () => {
  for (const stopReason of ["error", "aborted"]) {
    const harness = createExtensionHarness();
    useMarkedTheme(harness);
    await beginRequest(harness);
    await finishRequest(harness, 0, 0, stopReason);
    assert.match(latestActivityStatus(harness), stopReason === "error" ? /请求失败/ : /已中止/);
  }

  const unfinished = createExtensionHarness();
  useMarkedTheme(unfinished);
  await beginRequest(unfinished);
  await emitExtensionEvent(unfinished, "agent_settled");
  assert.match(latestActivityStatus(unfinished), /缓存结果未到达/);
});

test("本次缺失、零值、无效、失败、中止或缺少结束事件不被上次成功遮蔽", async () => {
  const scenarios = [
    ["usage missing", /本次缓存 usage 未提供/, async (harness) => {
      const message = harness.cacheAssistantMessage;
      message.usage = undefined;
      await emitExtensionEvent(harness, "message_end", { message });
      harness.cacheAssistantMessage = undefined;
    }],
    ["zero unconfirmed", /本次缓存 0（来源未确认）/, (harness) => finishRequest(harness, 0, 0)],
    ["invalid usage", /本次缓存 usage 无效/, async (harness) => {
      const message = harness.cacheAssistantMessage;
      message.usage = { cacheRead: "invalid", cacheWrite: 0 };
      await emitExtensionEvent(harness, "message_end", { message });
      harness.cacheAssistantMessage = undefined;
    }],
    ["request error", /本次请求失败/, (harness) => finishRequest(harness, 0, 0, "error")],
    ["aborted", /本次请求已中止/, (harness) => finishRequest(harness, 0, 0, "aborted")],
    ["missing message_end", /本次缓存结果未到达/, (harness) => emitExtensionEvent(harness, "agent_settled")],
  ];

  for (const [_name, expected, finishCurrent] of scenarios) {
    const harness = createExtensionHarness();
    useMarkedTheme(harness);
    await beginRequest(harness);
    await finishRequest(harness, 4096, 0);
    await beginRequest(harness);
    assert.match(latestActivityStatus(harness), /上次缓存 R4\.1k/);

    await finishCurrent(harness);

    assert.match(latestActivityStatus(harness), expected);
    assert.doesNotMatch(latestActivityStatus(harness), /上次缓存 R4\.1k/);
  }
});

test("tree change 后迟到的 assistant message_end 不污染新分支或新请求", async () => {
  const harness = createExtensionHarness();
  useMarkedTheme(harness);
  await beginRequest(harness);
  const staleMessage = harness.cacheAssistantMessage;
  await emitExtensionEvent(harness, "session_tree", { oldLeafId: "old", newLeafId: "new" });

  await emitExtensionEvent(harness, "message_end", { message: staleMessage });
  assert.doesNotMatch(latestActivityStatus(harness), /本次缓存 R|本次缓存 W/);

  await beginRequest(harness);
  await emitExtensionEvent(harness, "message_end", { message: staleMessage });
  assert.doesNotMatch(latestActivityStatus(harness), /本次缓存 R|本次缓存 W/);

  await finishRequest(harness, 0, 1024);
  assert.match(latestActivityStatus(harness), /本次缓存 W1\.0k/);
});

test("模型切换使缓存来源退休，不沿用上一个模型的结果", async () => {
  const harness = createExtensionHarness();
  useMarkedTheme(harness);
  await beginRequest(harness);
  await finishRequest(harness, 2048, 0);
  assert.match(latestActivityStatus(harness), /本次缓存 R2\.0k/);

  const previousModel = harness.context.model;
  harness.context.model = { provider: "other-provider", id: "other-model" };
  await emitExtensionEvent(harness, "model_select", { model: harness.context.model, previousModel, source: "cycle" });
  assert.doesNotMatch(latestActivityStatus(harness), /本次缓存 R|上次缓存 R/);

  await beginRequest(harness);
  assert.doesNotMatch(latestActivityStatus(harness), /上次缓存 R/);
  await finishRequest(harness, 1024, 0);
  assert.match(latestActivityStatus(harness), /本次缓存 R1\.0k/);
});

test("新会话会重置上一轮缓存状态", async () => {
  const harness = createExtensionHarness();
  useMarkedTheme(harness);

  await beginRequest(harness);
  await finishRequest(harness, 2048, 0);
  assert.match(latestActivityStatus(harness), /缓存 R/);

  await emitExtensionEvent(harness, "session_start", { reason: "new" });
  assert.match(latestActivityStatus(harness), /自动/);
  assert.doesNotMatch(latestActivityStatus(harness), /缓存 R|缓存 W|请求失败|已中止/);
});
