import assert from "node:assert/strict";
import test from "node:test";
import {
  blockWorkflowTask,
  cancelWorkflow,
  completeWorkflowTask,
  createWorkflowState,
  markWorkflowTaskStarted,
  setWorkflowHandoffPhase,
  startWorkflowTask,
} from "../src/workflow.ts";
import { createWorkflowReport } from "../extensions/workflow-report.ts";
import { createWorkflowStatusView } from "../extensions/workflow-status-view.ts";
import { formatWorkflowStatusText } from "../extensions/workflow-status-renderer.ts";
import { attachWorkflowPresentation } from "../extensions/workflow-presentation.ts";
import { createExtensionHarness, emitExtensionEvent, workflowMessageIdentity, withTempDirectory } from "./helpers.js";

function createCompletedWorkflow() {
  const plan = createWorkflowState({
    summary: "报告格式测试",
    sessionId: "test-session",
    tasks: [
      { id: "completed", task: "已完成任务的长描述", files: ["src/completed.js"], acceptanceCriteria: ["完成"] },
      { id: "blocked", task: "被阻塞任务", files: ["src/blocked.js"], acceptanceCriteria: ["解除阻塞"] },
      { id: "legacy-blocked", task: "历史阻塞任务", files: ["src/legacy.js"], acceptanceCriteria: ["保留原因"] },
    ],
  }, 100);
  const completed = completeWorkflowTask(
    markWorkflowTaskStarted(
      setWorkflowHandoffPhase(startWorkflowTask(plan, "completed", 110), "queued"),
      "completed",
      111,
    ),
    {
      taskId: "completed",
      completionSummary: "重复展示时应隐藏的完整完成摘要",
      implementationRationale: "保持报告审阅价值",
      verification: ["针对性测试通过"],
    },
    120,
  );
  return completed;
}

function createActiveWorkflow() {
  return markWorkflowTaskStarted(
    setWorkflowHandoffPhase(startWorkflowTask(createCompletedWorkflow(), "blocked", 130), "queued"),
    "blocked",
    131,
  );
}

function latestActivityStatus(harness) {
  return harness.statusCalls.filter((call) => call.name === "pi-init-activity").at(-1)?.text ?? "";
}

function createBlockedHistory() {
  const blocked = blockWorkflowTask(createActiveWorkflow(), { taskId: "blocked", reason: "缺少产品决策" }, 140);
  return {
    ...blocked,
    tasks: blocked.tasks.map((task) => task.id === "legacy-blocked"
      ? { ...task, status: "blocked", blockReason: undefined }
      : task),
  };
}

test("workflow acknowledge 只收起当前告警、按 branch/reload 重新提醒且不改业务状态", async () => {
  const branch = [{
    type: "custom",
    customType: "pi-init-workflow",
    id: "workflow-alert-source",
    data: createBlockedHistory(),
  }];
  const harness = createExtensionHarness(branch, { trusted: true });
  await emitExtensionEvent(harness, "session_start");
  const currentWorkflow = () => harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-workflow")?.data;
  const workflowBeforeAck = structuredClone(currentWorkflow());
  const branchLengthBeforeAck = harness.branch.length;
  assert.match(latestActivityStatus(harness), /已暂停/);
  assert.doesNotMatch(latestActivityStatus(harness), /待处理：/);

  await emitExtensionEvent(harness, "before_provider_request");
  await emitExtensionEvent(harness, "message_end", {
    message: { role: "assistant", stopReason: "stop", usage: { cacheRead: 2048, cacheWrite: 0 } },
  });
  await harness.commands.get("pi-init").handler("workflow acknowledge", harness.context);

  assert.deepEqual(currentWorkflow(), workflowBeforeAck);
  assert.equal(harness.branch.length, branchLengthBeforeAck);
  assert.match(latestActivityStatus(harness), /待处理：已暂停工作流/);
  assert.match(latestActivityStatus(harness), /缓存 R2\.0k/);
  assert.match(harness.notifications.at(-1).message, /工作流状态和恢复守卫未改变/);
  const statusTool = harness.tools.find((tool) => tool.name === "task_workflow");
  const fullStatus = await statusTool.execute("acknowledged-full-status", { action: "status" }, undefined, undefined, harness.context);
  assert.match(fullStatus.content[0].text, /缺少产品决策/);

  const statusBeforeFast = harness.branch.length;
  await harness.commands.get("fast").handler("不可绕过的独立任务", harness.context);
  assert.equal(harness.sentUserMessages.length, 0);
  assert.equal(harness.branch.length, statusBeforeFast);
  assert.equal(currentWorkflow().status, "paused");

  await emitExtensionEvent(harness, "session_tree", { oldLeafId: "branch-a", newLeafId: "branch-b" });
  assert.match(latestActivityStatus(harness), /已暂停/);
  assert.doesNotMatch(latestActivityStatus(harness), /待处理：/);

  const reloadHarness = createExtensionHarness(structuredClone(harness.branch), { trusted: true });
  await emitExtensionEvent(reloadHarness, "session_start");
  assert.match(latestActivityStatus(reloadHarness), /已暂停/);
  assert.doesNotMatch(latestActivityStatus(reloadHarness), /待处理：/);
  assert.ok(reloadHarness.commands.get("pi-init").getArgumentCompletions("workflow ").some(({ value }) => value === "acknowledge"));

  await emitExtensionEvent(reloadHarness, "before_provider_request");
  await emitExtensionEvent(reloadHarness, "message_end", {
    message: { role: "assistant", stopReason: "stop", usage: { cacheRead: 2048, cacheWrite: 0 } },
  });
  await reloadHarness.commands.get("pi-init").handler("workflow acknowledge", reloadHarness.context);
  assert.match(latestActivityStatus(reloadHarness), /待处理：已暂停工作流/);
  await reloadHarness.commands.get("pi-init").handler("workflow cancel", reloadHarness.context);
  assert.doesNotMatch(latestActivityStatus(reloadHarness), /待处理：|已暂停/);
  assert.match(latestActivityStatus(reloadHarness), /缓存 R2\.0k/);
  const branchLengthAfterCancel = reloadHarness.branch.length;
  await reloadHarness.commands.get("pi-init").handler("workflow acknowledge", reloadHarness.context);
  assert.equal(reloadHarness.branch.length, branchLengthAfterCancel);
  assert.match(reloadHarness.notifications.at(-1).message, /当前没有可确认的工作流告警/);
});

test("告警确认绑定原因与恢复/attempt身份，状态刷新不被旧确认压制", () => {
  const state = {
    workflowState: createBlockedHistory(),
    roleContextGeneration: 2,
    roleModeStatus: "auto",
  };
  let currentSessionId = "test-session";
  const context = { sessionManager: { getSessionId: () => currentSessionId } };
  let projection;
  const report = createWorkflowReport(state, {
    pi: {},
    roleRuntime: { refreshRoleStatus() {} },
    activityStatus: { setWorkflow(_ctx, value) { projection = value; } },
  });

  report.updateWorkflowStatus(context);
  const firstSource = projection.notice.sourceKey;
  assert.equal(projection.notice.acknowledged, false);
  assert.equal(report.acknowledgeWorkflowNotice(context).ok, true);
  assert.equal(projection.notice.acknowledged, true);

  report.updateWorkflowStatus(context);
  assert.equal(projection.notice.acknowledged, true);
  state.workflowState = { ...state.workflowState, taskPauseReason: "新的阻塞原因" };
  report.updateWorkflowStatus(context);
  assert.notEqual(projection.notice.sourceKey, firstSource);
  assert.equal(projection.notice.acknowledged, false);

  report.acknowledgeWorkflowNotice(context);
  state.workflowState = { ...state.workflowState, recoveryGeneration: state.workflowState.recoveryGeneration + 1 };
  report.updateWorkflowStatus(context);
  assert.equal(projection.notice.acknowledged, false);

  report.acknowledgeWorkflowNotice(context);
  state.roleContextGeneration += 1;
  report.updateWorkflowStatus(context);
  assert.equal(projection.notice.acknowledged, false);

  state.workflowState = createActiveWorkflow();
  state.workflowRestoreError = { code: "WORKFLOW_EXECUTION_ROLE_FORBIDDEN", message: "角色不允许执行" };
  report.updateWorkflowStatus(context);
  currentSessionId = "other-session";
  report.updateWorkflowStatus(context);
  const mismatchedSessionAck = report.acknowledgeWorkflowNotice(context);
  assert.equal(mismatchedSessionAck.ok, false);
  if (!mismatchedSessionAck.ok) assert.equal(mismatchedSessionAck.error.code, "WORKFLOW_NOTICE_SESSION_MISMATCH");
  currentSessionId = "test-session";
  report.updateWorkflowStatus(context);
  const attemptSource = projection.notice.sourceKey;
  report.acknowledgeWorkflowNotice(context);
  state.workflowState = {
    ...state.workflowState,
    handoff: { ...state.workflowState.handoff, attemptId: `${state.workflowState.handoff.attemptId}-next` },
  };
  report.updateWorkflowStatus(context);
  assert.notEqual(projection.notice.sourceKey, attemptSource);
  assert.equal(projection.notice.acknowledged, false);

  state.workflowState = undefined;
  state.workflowRestoreError = { code: "WORKFLOW_STATE_INVALID", message: "旧 session 恢复错误", sourceEntryId: "entry-old" };
  report.updateWorkflowStatus(context);
  const sessionSource = projection.notice.sourceKey;
  report.acknowledgeWorkflowNotice(context);
  currentSessionId = "other-session";
  report.updateWorkflowStatus(context);
  assert.notEqual(projection.notice.sourceKey, sessionSource);
  assert.equal(projection.notice.acknowledged, false);
  currentSessionId = "test-session";

  state.workflowState = createActiveWorkflow();
  state.workflowRestoreError = { code: "WORKFLOW_EXECUTION_ROLE_FORBIDDEN", message: "角色不允许执行" };
  report.updateWorkflowStatus(context);
  report.acknowledgeWorkflowNotice(context);
  state.workflowState = { ...state.workflowState, status: "completed" };
  state.workflowRestoreError = undefined;
  report.updateWorkflowStatus(context);
  assert.equal(projection, undefined);
  assert.equal(state.workflowNoticeAcknowledgement, undefined);

  state.workflowState = undefined;
  report.updateWorkflowStatus(context);
  assert.equal(projection, undefined);
});

test("恢复状态详情只展示当前分类允许的建议并保留原记录范围", () => {
  const runtime = {
    workflowRestoreError: {
      code: "WORKFLOW_STATE_INVALID_TYPE",
      message: "保存记录损坏",
      sourceEntryId: "source-entry-1",
    },
    roleCompactionPhase: "idle",
    workflowDispatchInFlight: false,
  };
  const discardable = formatWorkflowStatusText(createWorkflowStatusView(undefined, runtime));
  assert.match(discardable, /source-entry-1/);
  assert.match(discardable, /项目受信任且 Agent 空闲/);
  assert.match(discardable, /--confirm-unknown-outcome/);
  assert.match(discardable, /不代表任务成功或已取消/);

  const sessionMismatch = formatWorkflowStatusText(createWorkflowStatusView(undefined, {
    ...runtime,
    workflowRestoreError: { code: "WORKFLOW_SESSION_MISMATCH", message: "session 不一致", sourceEntryId: "other-entry" },
  }));
  assert.match(sessionMismatch, /回到所属 session/);
  assert.doesNotMatch(sessionMismatch, /discard-recovery|workflow cancel/);

  const unknown = formatWorkflowStatusText(createWorkflowStatusView(undefined, {
    ...runtime,
    workflowRestoreError: { code: "WORKFLOW_FUTURE_ERROR", message: "未知恢复错误", sourceEntryId: "source-entry-1" },
  }));
  assert.match(unknown, /未识别的恢复错误/);
  assert.doesNotMatch(unknown, /discard-recovery|workflow cancel/);
});

test("暂停摘要精简已完成任务内容且保留全部真实阻塞原因和恢复建议", () => {
  const workflowState = createBlockedHistory();
  const report = createWorkflowReport({ workflowState }, { pi: {}, roleRuntime: {} });
  const pauseSummary = report.formatWorkflowPauseSummary(workflowState);

  assert.match(pauseSummary, /工作流已暂停/);
  assert.equal((pauseSummary.match(/缺少产品决策/g) ?? []).length, 1);
  assert.match(pauseSummary, /未记录（历史状态未保存阻塞原因）/);
  assert.equal((pauseSummary.match(/恢复建议：/g) ?? []).length, 2);
  assert.match(pauseSummary, /\/pi-init workflow retry blocked/);
  assert.match(pauseSummary, /\/pi-init workflow retry legacy-blocked/);
  assert.doesNotMatch(pauseSummary, /已完成任务的长描述|重复展示时应隐藏的完整完成摘要/);

  const unknownState = {
    ...workflowState,
    tasks: workflowState.tasks.map((task) => task.id === "blocked" ? { ...task, outcomeUnknown: true } : task),
  };
  const unknownSummary = report.formatWorkflowPauseSummary(unknownState);
  assert.ok(unknownSummary.indexOf("先核对是否已产生外部副作用") < unknownSummary.indexOf("--confirm-unknown-outcome"));
  assert.match(unknownSummary, /--confirm-unknown-outcome/);

  const reviewState = {
    ...workflowState,
    pauseReason: "architecture-review",
    tasks: workflowState.tasks.map((task) => task.status === "blocked"
      ? { ...task, status: "pending", blockReason: undefined }
      : task),
  };
  assert.match(report.formatWorkflowPauseSummary(reviewState), /等待架构师审阅/);
  assert.match(report.formatWorkflowPauseSummary(reviewState), /\/pi-init workflow resume/);

  const fullStatus = report.formatWorkflowState(workflowState);
  assert.match(fullStatus, /已完成任务的长描述/);
  assert.match(fullStatus, /重复展示时应隐藏的完整完成摘要/);
});

test("暂停工具结果突出原因和恢复操作，完整技术状态仅在展开时显示", () => {
  const workflowState = createBlockedHistory();
  const harness = createExtensionHarness();
  const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
  const result = {
    content: [{ type: "text", text: "暂停内容" }],
    details: workflowState,
  };
  const compact = workflow.renderResult(
    result,
    { expanded: false, isPartial: false },
    harness.context.ui.theme,
    { isError: false },
  ).render(80).join("\n");
  assert.match(compact, /工作流已暂停/);
  assert.doesNotMatch(compact, /✓ 工作流/);
  assert.match(compact, /缺少产品决策/);
  assert.match(compact, /\/pi-init workflow retry blocked/);
  assert.doesNotMatch(compact, /workflowId：/);

  const expanded = workflow.renderResult(
    result,
    { expanded: true, isPartial: false },
    harness.context.ui.theme,
    { isError: false },
  ).render(80).join("\n");
  assert.match(expanded, /workflowId：/);
  assert.match(expanded, /recoveryGeneration：/);
});

test("工作流状态工具结果使用结构化状态视图且展开后保留完整身份与任务历史", () => {
  const workflowState = createActiveWorkflow();
  const harness = createExtensionHarness();
  const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
  const result = {
    content: [{ type: "text", text: "此处文本标题不参与展示类别判断" }],
    details: attachWorkflowPresentation(workflowState, {
      kind: "workflow-status",
      view: createWorkflowStatusView(workflowState, { roleCompactionPhase: "idle", workflowDispatchInFlight: false }),
    }),
  };
  const compact = workflow.renderResult(
    result,
    { expanded: false, isPartial: false },
    harness.context.ui.theme,
    { isError: false },
  ).render(80).join("\n");
  assert.match(compact, /已完成 1\/3/);
  assert.match(compact, /当前项 2\/3/);
  assert.doesNotMatch(compact, /当前基础动作身份 JSON/);

  const expanded = workflow.renderResult(
    result,
    { expanded: true, isPartial: false },
    harness.context.ui.theme,
    { isError: false },
  ).render(500).join("\n");
  assert.match(expanded, /当前基础动作身份 JSON/);
  assert.match(expanded, /当前任务结果身份 JSON（complete\/block）/);
  assert.match(expanded, /重复展示时应隐藏的完整完成摘要/);
});

test("旧完成报告结果缺少展示元数据时保留原始工具文本", () => {
  const state = { ...createActiveWorkflow(), status: "completed" };
  const harness = createExtensionHarness();
  const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
  const content = "任务完成报告\n旧会话中的原始摘要";
  const result = workflow.renderResult(
    { content: [{ type: "text", text: content }], details: state },
    { expanded: false, isPartial: false },
    harness.context.ui.theme,
    { isError: false },
  ).render(300).join("\n");
  assert.match(result, /旧会话中的原始摘要/);
  assert.doesNotMatch(result, /当前基础动作身份 JSON/);
});

test("block 工具结果精简且不会再发出重复阻塞通知", async () => {
  await withTempDirectory(async (directory) => {
    const active = createCompletedWorkflow();
    const harness = createExtensionHarness([
      { type: "custom", customType: "pi-init-workflow", data: active },
    ], { cwd: directory, trusted: true });
    await emitExtensionEvent(harness, "session_start");
    await emitExtensionEvent(harness, "agent_start");
    const taskWorkflow = harness.tools.find((tool) => tool.name === "task_workflow");
    const result = await taskWorkflow.execute("block-test", {
      ...workflowMessageIdentity(harness),
      action: "block",
      taskId: "blocked",
      reason: "缺少产品决策",
    }, undefined, undefined, harness.context);

    const content = result.content[0].text;
    assert.equal((content.match(/缺少产品决策/g) ?? []).length, 1);
    assert.match(content, /\/pi-init workflow retry blocked/);
    assert.doesNotMatch(content, /已完成任务的长描述|重复展示时应隐藏的完整完成摘要/);
    assert.equal(harness.notifications.some(({ message }) => message.includes("缺少产品决策")), false);
    assert.equal(harness.notifications.some(({ message }) => message.includes("/pi-init workflow retry blocked")), false);
    assert.equal(result.details.tasks.find((task) => task.id === "completed").completionSummary, "重复展示时应隐藏的完整完成摘要");
  });
});
