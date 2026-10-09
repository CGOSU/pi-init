import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  ACTIVITY_STATUS_KEY,
  activityStatusSegments,
  createActivityStatus,
  renderActivityStatus,
} from "../extensions/activity-status.ts";
import { createExtensionHarness } from "./helpers.js";

const theme = { fg: (_color, text) => text };

test("状态源独立更新，清除缓存不覆盖职责、工作流或压缩状态", () => {
  const harness = createExtensionHarness([], { mode: "tui" });
  const status = createActivityStatus();
  status.setRole(harness.context, { mode: "自动", role: "开发测试", model: "model/high" });
  status.setWorkflow(harness.context, { text: "⏳ 任务执行中 · 1/3", color: "accent" });
  status.setCompaction(harness.context, "compacting");
  status.setCache(harness.context, { kind: "reported", read: 2048, write: 0 });

  status.setCache(harness.context, undefined);

  assert.deepEqual(status.getSnapshot(), {
    role: { mode: "自动", role: "开发测试", model: "model/high" },
    workflow: { text: "⏳ 任务执行中 · 1/3", color: "accent" },
    compaction: "compacting",
    cache: undefined,
  });
  assert.equal(harness.widgets.size, 1);
  assert.deepEqual([...harness.widgets.keys()], [ACTIVITY_STATUS_KEY]);
  assert.equal(harness.statusCalls.length, 0);
});

test("异常优先于普通活动和辅助状态，窄宽度下仍显示首要状态", () => {
  const snapshot = {
    role: { mode: "自动", role: "开发测试", model: "long-model-name/high" },
    workflow: { text: "⏳ 任务执行中 · 1/3", color: "accent" },
    compaction: "stalled",
    cache: { kind: "reported", read: 4096, write: 1024 },
    workTimeMilliseconds: 60_000,
  };

  const lines = renderActivityStatus(snapshot, 14, theme);

  assert.equal(lines.length, 1);
  assert.ok(visibleWidth(lines[0]) <= 14);
  assert.match(lines[0], /⚠/);
  assert.doesNotMatch(lines[0], /long-model-name|缓存/);

  const requestFailure = renderActivityStatus({
    compaction: "compacting",
    cache: { kind: "request-error" },
  }, 80, theme).join("");
  assert.match(requestFailure, /请求失败/);
  assert.doesNotMatch(requestFailure, /正在压缩/);

  const narrowOperation = renderActivityStatus({
    operation: { kind: "tool", label: "工具执行", count: 16, startedAt: 0 },
  }, 9, theme, 2_000).join("");
  assert.ok(visibleWidth(narrowOperation) <= 9);
  assert.match(narrowOperation, /工具/);
});

test("未确认工作流告警优先，确认后收为简短标记且不隐藏真实压缩", () => {
  const source = { kind: "paused", sessionId: "session-a", contextGeneration: 1 };
  const snapshot = {
    operation: { kind: "provider", phase: "streaming", startedAt: 0 },
    workflow: {
      text: "⚠ 工作流暂停详细原因",
      color: "warning",
      notice: { source, sourceKey: JSON.stringify(source), summary: "⚑ 待处理：工作流暂停", acknowledged: false },
    },
  };

  const unacknowledged = activityStatusSegments(snapshot, 2_000);
  assert.equal(unacknowledged[0].text, "⚠ 工作流暂停详细原因");
  assert.match(unacknowledged[1].text, /模型响应/);

  const acknowledged = activityStatusSegments({
    ...snapshot,
    workflow: { ...snapshot.workflow, notice: { ...snapshot.workflow.notice, acknowledged: true } },
  }, 2_000);
  assert.match(acknowledged[0].text, /模型响应/);
  assert.equal(acknowledged[1].text, "⚑ 待处理：工作流暂停");
  assert.equal(acknowledged[1].tone, "muted");

  const withHostCompaction = activityStatusSegments({
    ...snapshot,
    compaction: "stalled",
    workflow: { ...snapshot.workflow, notice: { ...snapshot.workflow.notice, acknowledged: true } },
  }, 2_000);
  assert.equal(withHostCompaction[0].text, "⚠ 压缩等待异常");
});

test("活动持续时间按秒更新，清除活动后停止刷新", async () => {
  const harness = createExtensionHarness([], { mode: "tui" });
  let clock = 0;
  let renderRequests = 0;
  const status = createActivityStatus({ now: () => clock, refreshIntervalMs: 5 });
  status.setRole(harness.context, { mode: "自动", role: "开发测试" });
  status.setOperation(harness.context, { kind: "tool", label: "读取文件", count: 1, startedAt: 0 });
  const widget = harness.widgets.get(ACTIVITY_STATUS_KEY);
  const component = widget.content({ requestRender: () => { renderRequests += 1; } }, theme);

  clock = 1_500;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(renderRequests > 0);
  assert.match(component.render(60).join(""), /读取文件 · 1s/);

  status.setOperation(harness.context, undefined);
  const requestsAtClear = renderRequests;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(renderRequests, requestsAtClear);
});

test("RPC 活动状态按秒刷新持续时间", async () => {
  const harness = createExtensionHarness([], { mode: "rpc" });
  let clock = 0;
  const status = createActivityStatus({ now: () => clock, refreshIntervalMs: 5 });
  status.setOperation(harness.context, { kind: "provider", phase: "request", startedAt: 0 });
  assert.match(harness.statusCalls.at(-1).text, /等待模型/);

  clock = 2_000;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(harness.statusCalls.at(-1).text, /2s/);
  status.setOperation(harness.context, undefined);
});

test("RPC 共用同一活动状态 key，清除后不留旧 status", () => {
  const harness = createExtensionHarness([], { mode: "rpc" });
  const status = createActivityStatus();
  status.setRole(harness.context, { mode: "确认", role: "文档收尾" });
  status.setWorkflow(harness.context, { text: "⏳ 任务执行中 · 1/2", color: "accent" });

  assert.equal(harness.widgets.size, 0);
  assert.ok(harness.statusCalls.length > 0);
  assert.ok(harness.statusCalls.every((call) => call.name === ACTIVITY_STATUS_KEY));
  assert.match(harness.statusCalls.at(-1).text, /文档收尾/);

  status.clear(harness.context);
  assert.equal(harness.statusCalls.at(-1).text, undefined);
});

test("规范化零值标记来源未确认，不当作未报告或命中", () => {
  const harness = createExtensionHarness([], { mode: "rpc" });
  const status = createActivityStatus();
  status.setCache(harness.context, { kind: "zero-unconfirmed", read: 0, write: 0 });

  assert.match(harness.statusCalls.at(-1).text, /缓存 0（来源未确认）/);
  assert.doesNotMatch(harness.statusCalls.at(-1).text, /缓存未报告|命中|未命中/);
  assert.doesNotMatch(harness.statusCalls.at(-1).text, /磁盘|网络/);
});

test("缓存 usage 未报告时不推断磁盘或网络 I/O", () => {
  const harness = createExtensionHarness([], { mode: "rpc" });
  const status = createActivityStatus();
  status.setCache(harness.context, {
    kind: "unreported",
    error: { code: "usage-missing", message: "usage is missing" },
  });

  assert.match(harness.statusCalls.at(-1).text, /缓存 usage 未提供/);
  assert.doesNotMatch(harness.statusCalls.at(-1).text, /磁盘|网络|命中/);
});
