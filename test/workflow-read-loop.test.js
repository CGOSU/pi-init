import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowProgressObserver } from '../extensions/workflow/workflow-status-polling.ts';
import { createExtensionRuntimeState } from '../extensions/runtime-state.ts';
import { createWorkflowState } from '../src/workflow.ts';

function fixture() {
  const state = createExtensionRuntimeState();
  const identity = { workflowId: 'w', sessionId: 's', planVersion: 1, recoveryGeneration: 0 };
  state.activeRole = { role: 'coder', provider: 'p', model: 'm', thinkingLevel: 'high' };
  state.workflowState = { ...identity, status: 'running', currentTaskId: 't',
    tasks: [{ id: 't', role: 'coder', status: 'in_progress' }],
    handoff: { ...identity, taskId: 't', attemptId: 'a', handoffId: 'h', phase: 'executing' } };
  const handlers = new Map(), diagnostics = [];
  let pauses = 0, id = 0;
  state.traceHandoff = (_, name, data) => diagnostics.push({ name, ...data });
  const branch = [{ type: "custom_message", id: "anchor", customType: "pi-init-workflow-task", details: { ...state.workflowState.handoff } }];
  const ctx = { isProjectTrusted: () => true, sessionManager: { getSessionId: () => "s", getBranch: () => branch } };
  const observer = createWorkflowProgressObserver({ on: (name, fn) => handlers.set(name, fn) }, state,
    { onRepeatedRead: () => { pauses++; } });
  const emit = (name, event) => handlers.get(name)(event, ctx);
  async function read(input = { path: 'secret' }, text = 'private', toolName = 'read', isError = false) {
    const toolCallId = String(++id);
    await emit('tool_call', { toolName, toolCallId, input });
    return emit('tool_result', { toolName, toolCallId, content: [{ type: 'text', text }], isError });
  }
  return { state, ctx, branch, emit, read, observer, diagnostics, pauses: () => pauses };
}

test('one bounded hint at third repeat, one pause at sixth; status is not a fact', async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) {
    f.state.workflowState.updatedAt = i;
    await f.read({ action: 'status' }, 'status', 'task_workflow');
    const result = await f.read();
    assert.equal(Boolean(result), i === 3);
    if (result) {
      assert.deepEqual(result.content[0], { type: 'text', text: 'private' });
      assert.equal('isError' in result, false);
    }
  }
  assert.equal(f.pauses(), 1);
  assert.equal(f.diagnostics.length, 2);
  assert.ok(f.diagnostics.every(d => d.name === 'workflow.suspected_loop' && d.code === 'WORKFLOW_REPEATED_READ'));
  assert.ok(!JSON.stringify(f.diagnostics).includes('private'));
  assert.ok(!JSON.stringify(f.diagnostics).includes('secret'));
});

test('new contents, ranges, and actual non-read activity reset observations', async () => {
  for (const mode of ['content', 'range', 'write', 'bash', 'command', 'codemode']) {
    const f = fixture();
    for (let i = 0; i < 12; i++) {
      if (!['content', 'range'].includes(mode)) await f.read({}, 'ok', mode);
      await f.read({ path: 'x', offset: mode === 'range' ? i : 0 }, mode === 'content' ? String(i) : 'same');
    }
    assert.equal(f.pauses(), 0, mode);
    assert.equal(f.diagnostics.length, 0, mode);
  }
});

test('review reads distinguish new pages, files and contents, and reset on external input', async () => {
  for (const change of ['page', 'file', 'content', 'input']) {
    const f = fixture();
    f.state.workflowState = createWorkflowState({
      sessionId: 's', summary: 'Review plan', reviewRequired: true,
      tasks: [{ id: 't', task: 'Check bindings', role: 'developer-test', files: ['src'], acceptanceCriteria: ['Bound'] }],
    });
    f.ctx.cwd = process.cwd();
    for (let i = 0; i < 6; i++) await f.read({ path: 'package.json' }, 'same');
    if (change === 'input') await f.emit('input', { source: 'interactive', text: 'new question' });
    const input = { path: change === 'file' ? 'other/package.json' : 'package.json', offset: change === 'page' ? 2 : 1 };
    await f.read(input, change === 'content' ? 'updated' : 'same');
    assert.equal(f.pauses(), 0, change);
    assert.equal(f.diagnostics.length, 1, change);
  }
});

test('errors, recovery gates, different identities and branches cannot share counts', async () => {
  for (const change of [f => f.state.activeRole.model = 'other',
    f => f.state.roleContextGeneration++, f => f.state.workflowState.handoff.attemptId = 'new',
    f => f.emit('session_tree', { oldLeafId: 'a', newLeafId: 'b' }),
    f => f.state.userStopRequested = true, f => f.state.roleRecoveryPending = true,
    f => f.state.workflowState.handoff.sessionId = 'wrong',
    f => f.read({}, 'failed', 'read', true)]) {
    const f = fixture();
    for (let i = 0; i < 6; i++) await f.read();
    await change(f);
    await f.read();
    assert.equal(f.pauses(), 0);
  }
});

test('parallel out-of-order and old-role/old-branch results are ignored', async () => {
  for (const change of [() => {}, f => f.state.roleTransitionGeneration++,
    f => f.emit('session_tree', { oldLeafId: 'a', newLeafId: 'b' })]) {
    const f = fixture();
    for (let i = 0; i < 6; i++) await f.read();
    for (const toolCallId of ['x', 'y']) await f.emit('tool_call', { toolName: 'read', toolCallId, input: { path: 'secret' } });
    await change(f);
    for (const toolCallId of ['y', 'x']) await f.emit('tool_result', { toolName: 'read', toolCallId, content: [{ type: 'text', text: 'private' }], isError: false });
    assert.equal(f.pauses(), 0);
  }
});

test("missing branch anchor or revoked trust cannot trigger an automatic pause", async () => {
  for (const change of [f => f.branch.splice(0), f => f.ctx.isProjectTrusted = () => false]) {
    const f = fixture();
    for (let i = 0; i < 6; i++) await f.read();
    change(f);
    for (let i = 0; i < 8; i++) await f.read();
    assert.equal(f.pauses(), 0);
  }
});
test("a late result from a replaced descendant branch is not counted", async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) await f.read();
  f.branch.push({ id: "old-leaf", type: "custom", customType: "observation", data: {} });
  await f.emit("tool_call", { toolName: "read", toolCallId: "late", input: { path: "secret" } });
  f.branch.pop();
  f.branch.push({ id: "new-leaf", type: "custom", customType: "observation", data: {} });
  await f.emit("tool_result", { toolName: "read", toolCallId: "late", content: [{ type: "text", text: "private" }], isError: false });
  assert.equal(f.pauses(), 0);
  await f.read();
  assert.equal(f.pauses(), 0, "a replaced branch must not inherit the previous repeat count");
});

test("consecutive same-path edit failures and identical tool errors emit bounded tool_result hints without pausing", async () => {
  const f = fixture();
  const edit1 = await f.read({ path: "src/secret.ts", edits: [{ oldText: "a", newText: "b" }] }, "duplicate match", "edit", true);
  const edit2 = await f.read({ path: "src/secret.ts", edits: [{ oldText: "c", newText: "d" }] }, "overlap", "edit", true);
  assert.equal(edit1, undefined);
  assert.equal(edit2, undefined);
  const edit3 = await f.read({ path: "src/secret.ts", edits: [{ oldText: "e", newText: "f" }] }, "not found", "edit", true);
  assert.ok(edit3);
  assert.deepEqual(edit3.content[0], { type: "text", text: "not found" });
  assert.match(edit3.content[1].text, /WORKFLOW_REPEATED_TOOL_ERROR.*read.*blockReason.*approachesTried/);
  assert.equal("isError" in edit3, false);
  assert.equal(await f.read({ path: "src/secret.ts", edits: [{ oldText: "g", newText: "h" }] }, "still failing", "edit", true), undefined);
  assert.equal(f.pauses(), 0);
  assert.equal(f.diagnostics.length, 1);
  assert.equal(f.diagnostics[0].name, "workflow.suspected_loop");
  assert.equal(f.diagnostics[0].code, "WORKFLOW_REPEATED_TOOL_ERROR");
  assert.equal(f.diagnostics[0].toolName, "edit");
  assert.ok(!JSON.stringify(f.diagnostics).includes("src/secret.ts"));
  assert.ok(!JSON.stringify(f.diagnostics).includes("not found"));

  // A successful read resets the failure streak.
  assert.equal(await f.read({ path: "src/secret.ts" }, "fresh contents", "read", false), undefined);
  assert.equal(await f.read({ path: "src/secret.ts", edits: [{ oldText: "x", newText: "y" }] }, "err1", "edit", true), undefined);
  assert.equal(await f.read({ path: "src/secret.ts", edits: [{ oldText: "x", newText: "z" }] }, "err2", "edit", true), undefined);
  const editAfterRead = await f.read({ path: "src/secret.ts", edits: [{ oldText: "x", newText: "w" }] }, "err3", "edit", true);
  assert.ok(editAfterRead);
  assert.match(editAfterRead.content[1].text, /WORKFLOW_REPEATED_TOOL_ERROR/);

  // Different edit path resets without sharing counts.
  assert.equal(await f.read({ path: "src/other.ts", edits: [{ oldText: "a", newText: "b" }] }, "err", "edit", true), undefined);

  // Different bash errors do not match, whereas 3 identical bash errors emit general hint.
  assert.equal(await f.read({ command: "pnpm test" }, "fail-1", "bash", true), undefined);
  assert.equal(await f.read({ command: "pnpm test" }, "fail-2", "bash", true), undefined);
  assert.equal(await f.read({ command: "pnpm test" }, "fail-2", "bash", true), undefined);
  const bash3 = await f.read({ command: "pnpm test" }, "fail-2", "bash", true);
  assert.ok(bash3);
  assert.match(bash3.content[1].text, /WORKFLOW_REPEATED_TOOL_ERROR.*相同工具调用连续返回相同错误.*approachesTried/);
  assert.equal(f.pauses(), 0);
});

test("ordinary sessions emit soft read and error hints without auto-pausing, and respect isolation gates", async () => {
  const f = fixture();
  f.state.workflowState = undefined;
  f.branch.splice(0, f.branch.length, { id: "user-1", type: "message", message: { role: "user" } });

  for (let i = 0; i < 10; i++) {
    const result = await f.read();
    assert.equal(Boolean(result), i === 3);
    if (result) {
      assert.match(result.content[1].text, /WORKFLOW_REPEATED_READ.*approachesTried/);
    }
  }
  assert.equal(f.pauses(), 0);
  assert.equal(f.diagnostics.length, 1);
  assert.equal(f.diagnostics[0].code, "WORKFLOW_REPEATED_READ");

  // Consecutive same-path edit errors hint once in ordinary session without pausing.
  assert.equal(await f.read({ path: "a.ts", edits: [{ oldText: "1", newText: "2" }] }, "e1", "edit", true), undefined);
  assert.equal(await f.read({ path: "a.ts", edits: [{ oldText: "2", newText: "3" }] }, "e2", "edit", true), undefined);
  const ordinaryEdit = await f.read({ path: "a.ts", edits: [{ oldText: "3", newText: "4" }] }, "e3", "edit", true);
  assert.ok(ordinaryEdit);
  assert.match(ordinaryEdit.content[1].text, /WORKFLOW_REPEATED_TOOL_ERROR/);
  assert.equal(f.pauses(), 0);

  // Role changes, recovery gates, untrusted projects, missing anchors, and branch changes isolate counts.
  for (const mutate of [
    s => { s.state.activeRole.model = "other"; },
    s => { s.state.roleRecoveryPending = true; },
    s => { s.ctx.isProjectTrusted = () => false; },
    s => { s.branch.splice(0); },
    s => { s.emit("session_tree", { oldLeafId: "user-1", newLeafId: "user-2" }); },
    s => { s.state.workflowState = { workflowId: "w", sessionId: "s", planVersion: 1, recoveryGeneration: 0, status: "paused", plan: { summary: "paused", constraints: [] }, tasks: [] }; },
  ]) {
    const isolated = fixture();
    isolated.state.workflowState = undefined;
    isolated.branch.splice(0, isolated.branch.length, { id: "user-1", type: "message", message: { role: "user" } });
    await isolated.read({ path: "a.ts", edits: [] }, "e1", "edit", true);
    await isolated.read({ path: "a.ts", edits: [] }, "e2", "edit", true);
    mutate(isolated);
    assert.equal(await isolated.read({ path: "a.ts", edits: [] }, "e3", "edit", true), undefined);
    assert.equal(isolated.pauses(), 0);
  }
});

test("status queries preserve failure streaks while parallel calls and nested calls do not trigger false error hints", async () => {
  const f = fixture();
  await f.read({ command: "npm test" }, "err", "bash", true);
  await f.read({ action: "status" }, "status", "task_workflow");
  await f.read({ command: "npm test" }, "err", "bash", true);
  const third = await f.read({ command: "npm test" }, "err", "bash", true);
  assert.ok(third);
  assert.match(third.content[1].text, /WORKFLOW_REPEATED_TOOL_ERROR/);

  // Parallel overlapping errors are ignored.
  await f.read({ path: "reset" }, "ok", "read", false);
  await f.read({ command: "npm test" }, "err", "bash", true);
  for (const id of ["p1", "p2"]) await f.emit("tool_call", { toolName: "bash", toolCallId: id, input: { command: "npm test" } });
  for (const id of ["p2", "p1"]) {
    assert.equal(await f.emit("tool_result", { toolName: "bash", toolCallId: id, content: [{ type: "text", text: "err" }], isError: true }), undefined);
  }
  assert.equal(await f.read({ command: "npm test" }, "err", "bash", true), undefined);

  // Nested sub-calls (with parentToolCallId) do not count as top-level failures or reset outer streaks.
  await f.read({ path: "reset2" }, "ok", "read", false);
  await f.read({ command: "npm test" }, "err", "bash", true);
  await f.read({ command: "npm test" }, "err", "bash", true);
  await f.emit("tool_call", { toolName: "read", toolCallId: "parent/1", parentToolCallId: "parent", input: { path: "x" } });
  await f.emit("tool_result", { toolName: "read", toolCallId: "parent/1", parentToolCallId: "parent", content: [{ type: "text", text: "ok" }], isError: false });
  const afterNested = await f.read({ command: "npm test" }, "err", "bash", true);
  assert.ok(afterNested);
  assert.match(afterNested.content[1].text, /WORKFLOW_REPEATED_TOOL_ERROR/);
});
