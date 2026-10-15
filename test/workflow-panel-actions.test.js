import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { workflowPanelChoices, runWorkflowPanelRequest } from "../extensions/workflow-panel-actions.ts";
import { createWorkflowReport } from "../extensions/workflow-report.ts";
import { createWorkflowState } from "../src/workflow.ts";
import { createExtensionHarness } from "./helpers.js";
import { createWorkflowActions } from "../extensions/workflow-actions.ts";
import { showWorkflowPanel } from "../extensions/workflow-panel.ts";

function fixture() {
  const state = createExtensionRuntimeState();
  state.workflowState = createWorkflowState({ sessionId: "test-session", summary: "人体工程学检查", tasks: [{ id: "first", task: "当前任务", files: ["src"], acceptanceCriteria: ["完整验收标准"] }] });
  return state;
}
function request(state, value) {
  return { choice: workflowPanelChoices(state).find((item) => item.value === value), workflow: state.workflowState, contextGeneration: state.roleContextGeneration, sessionId: "test-session" };
}
function context(select = async () => undefined) {
  const warnings = [];
  return { warnings, ctx: { isIdle: () => true, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "test-session" }, ui: { select, notify: (text) => warnings.push(text) } } };
}
test("取消确认默认返回，不确认不执行；确认后复用既有取消命令", async () => {
  const state = fixture();
  const calls = [];
  const run = async (...args) => calls.push(args);
  const safe = context(async (_title, items) => { assert.equal(items[0], "返回，不执行"); return items[0]; });
  await runWorkflowPanelRequest(request(state, "cancel"), safe.ctx, state, run);
  assert.deepEqual(calls, []);
  const accepted = context(async (title, items) => { assert.match(title, /不回滚/); return items[1]; });
  await runWorkflowPanelRequest(request(state, "cancel"), accepted.ctx, state, run);
  assert.deepEqual(calls, [["cancel", undefined, false]]);
});
test("确认期间流程或上下文变化，旧操作失效", async () => {
  for (const change of [s => { s.workflowState = { ...s.workflowState }; }, s => { s.roleContextGeneration += 1; }]) {
    const state = fixture(); const original = request(state, "cancel"); let calls = 0;
    const { ctx, warnings } = context(async (_title, items) => { change(state); return items[1]; });
    await runWorkflowPanelRequest(original, ctx, state, async () => { calls++; });
    assert.equal(calls, 0); assert.match(warnings[0], /工作流已变化/);
  }
});
test("未知结果只能在核对副作用并确认后创建新尝试", async () => {
  const state = fixture(); state.workflowState.status = "paused"; state.workflowState.pauseReason = "handoff-outcome-unknown";
  Object.assign(state.workflowState.tasks[0], { status: "blocked", outcomeUnknown: true });
  const calls = []; const { ctx } = context(async (title, items) => { assert.match(title, /先核对实际结果/); return items[1]; });
  await runWorkflowPanelRequest(request(state, "retry:first"), ctx, state, async (...args) => calls.push(args));
  assert.deepEqual(calls, [["retry", "first", true]]);
});
test("AI 审阅等待、恢复异常和终态不提供可绕过守卫的操作", () => {
  const state = fixture(); state.workflowState.status = "replanning";
  assert.match(workflowPanelChoices(state).find(item => item.action === "resume").disabledReason, /AI/);
  state.workflowRestoreError = { code: "bad", message: "损坏" };
  assert.ok(workflowPanelChoices(state).every(item => item.disabledReason));
  state.workflowState.status = "completed";
  assert.deepEqual(workflowPanelChoices(state), []);
});
test("详情滚动可到最后一行，窄终端保留返回提示且行宽受限", async () => {
  const state = fixture(); state.workflowState.tasks[0].verification = Array.from({ length: 50 }, (_, i) => "验证结果 " + i);
  const h = createExtensionHarness([], { mode: "tui", hasUI: true, trusted: true, custom: async call => {
    call.component.render(30); call.component.handleInput("\r");
    for (let i = 0; i < 100; i++) call.component.handleInput("\u001b[B");
    const lines = call.component.render(30);
    assert.match(lines.join("\n"), /验证结果 49/);
    assert.match(lines.join("\n"), /Esc\s*返回/);
    assert.ok(lines.every(line => visibleWidth(line) <= 30));
  } });
  await createWorkflowReport(state, { pi: {}, roleRuntime: { refreshRoleStatus() {} } }).showWorkflowProgress(h.context);
});
test("操作菜单和技术详情逐层返回，刷新不替用户执行动作", async () => {
  const state = fixture();
  const h = createExtensionHarness([], { mode: "tui", hasUI: true, trusted: true, custom: async call => {
    call.component.render(80); call.component.handleInput("\r"); call.component.handleInput("a");
    assert.match(call.component.render(80).join("\n"), /取消当前工作流/);
    call.component.handleInput("d"); assert.match(call.component.render(80).join("\n"), /技术详情/);
    call.component.handleInput("\u001b"); assert.match(call.component.render(80).join("\n"), /当前可用操作/);
    call.component.handleInput("\u001b"); assert.match(call.component.render(80).join("\n"), /任务详情/);
    assert.notEqual(call.done, true);
  } });
  await createWorkflowReport(state, { pi: {}, roleRuntime: { refreshRoleStatus() {} } }).showWorkflowProgress(h.context);
});

test("面板取消入口经过确认后复用业务命令，默认返回不写状态", async () => {
  for (const accept of [false, true]) {
    const state = fixture(); const writes = []; const retired = [];
    const h = createExtensionHarness([], { mode: "tui", hasUI: true, trusted: true, select: (_title, items) => items[accept ? 1 : 0], custom: async call => {
      call.component.render(80); call.component.handleInput("a"); call.component.render(80);
      call.component.handleInput("\u001b[B"); call.component.handleInput("\r");
    } });
    const roleRuntime = { refreshRoleStatus() {}, retireWorkflowContinuation: identity => retired.push(identity) };
    const report = createWorkflowReport(state, { pi: { appendEntry: (_type, next) => writes.push(next) }, roleRuntime });
    const actions = createWorkflowActions(state, { report, roleRuntime, dispatch: {}, coordination: { isLinkedToWorkflow: () => false } });
    await actions.workflowCommand("status", undefined, h.context);
    assert.equal(writes.length, accept ? 1 : 0);
    assert.equal(retired.length, accept ? 1 : 0);
    assert.equal(state.workflowState.status, accept ? "cancelled" : "running");
  }
});
test("不受信任项目和忙碌 Agent 不会通过面板启动恢复", async () => {
  for (const mode of ["untrusted", "busy"]) {
    const state = fixture(); const { ctx, warnings } = context(); let calls = 0;
    ctx.isProjectTrusted = () => mode !== "untrusted"; ctx.isIdle = () => mode !== "busy";
    await runWorkflowPanelRequest(request(state, "resume"), ctx, state, async () => { calls++; });
    assert.equal(calls, 0); assert.equal(warnings.length, 1);
  }
});

test("20 列短终端不溢出，底部返回与操作入口保持可见", async () => {
  const state = fixture();
  const { ctx } = context();
  ctx.ui.custom = async factory => {
    const component = factory({ terminal: { rows: 12 }, requestRender() {} }, { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text }, {}, () => {});
    const lines = component.render(20);
    assert.ok(lines.length <= 12);
    assert.ok(lines.every(line => visibleWidth(line) <= 20));
    assert.match(lines.join("\n"), /Esc关闭/);
    assert.match(lines.join("\n"), /a操作/);
    component.handleInput("\r");
    assert.match(component.render(20).join("\n"), /Esc返回/);
  };
  await showWorkflowPanel(ctx, state);
});
