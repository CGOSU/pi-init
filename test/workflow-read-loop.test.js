import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowProgressObserver } from '../extensions/workflow-status-polling.ts';
import { createExtensionRuntimeState } from '../extensions/runtime-state.ts';

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
