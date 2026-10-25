import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSessionProjection, estimateTokens } from '@earendil-works/pi-coding-agent';
import { estimateProjectedCompactionTokens } from '../extensions/compaction-projection.ts';
import { createCompactionPolicy } from '../extensions/compaction-policy.ts';
import { createContextBudgetChecker } from '../extensions/context-budget-monitor.ts';
import { createExtensionRuntimeState } from '../extensions/runtime-state.ts';

function fixture() {
  const entries = [];
  const model = { provider: 'test', id: 'model', contextWindow: 1000000, maxTokens: 8192,
    cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 } };
  const usage = tokens => ({ input: tokens, cacheRead: 0, cacheWrite: 0, output: 1, totalTokens: tokens + 1,
    cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 } });
  for (let i = 0; i < 20; i++) {
    const timestamp = i * 20 + 1;
    entries.push({ type: 'message', id: 'user-' + i, parentId: entries.at(-1)?.id ?? null,
      timestamp: new Date(timestamp).toISOString(), message: { role: 'user', content: 'x'.repeat(40000), timestamp } });
    entries.push({ type: 'message', id: 'assistant-' + i, parentId: entries.at(-1).id,
      timestamp: new Date(timestamp + 1).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }],
        timestamp: timestamp + 1, provider: 'test', model: 'model', api: 'test', usage: usage(300000), stopReason: 'stop' } });
  }
  const state = createExtensionRuntimeState();
  const identity = { workflowId: 'w', planVersion: 1, sessionId: 's', recoveryGeneration: 0,
    taskId: 'live', attemptId: 'attempt', handoffId: 'handoff' };
  state.activeRole = { role: 'developer', provider: 'test', model: 'model', thinkingLevel: 'off' };
  state.workflowState = { ...identity, version: 2, executor: 'local', status: 'running', currentTaskId: 'live',
    tasks: [{ id: 'done', role: 'developer', status: 'completed', dependsOn: [], executionStartedAt: 0, completedAt: 1000 },
      { id: 'live', role: 'developer', status: 'in_progress', dependsOn: [] },
      ...Array.from({ length: 9 }, (_, i) => ({ id: 'next-' + i, role: 'developer', status: 'pending', dependsOn: [] }))],
    handoff: { ...identity, phase: 'executing' }, plan: { summary: '', constraints: [] }, revisions: [] };
  const hooks = new Map();
  const api = { on: (name, fn) => hooks.set(name, fn), getThinkingLevel: () => 'off',
    getSettings: () => ({ compaction: { keepRecentTokens: 20000 } }) };
  const ctx = { model, getContextUsage: () => ({ tokens: 300000, contextWindow: 1000000, percent: 30 }),
    sessionManager: { getSessionId: () => 's', getBranch: () => entries }, hasPendingMessages: () => false };
  const policy = createCompactionPolicy(api, state);
  const publish = messages => {
    hooks.get('context_with_system')({ messages: messages ?? buildSessionProjection(entries).entries.flatMap(entry => entry.messages) }, ctx);
    hooks.get('before_provider_request')({}, ctx);
  };
  publish();
  return { entries, state, ctx, policy, publish, hooks, api, usage };
}

test('real workflow/request observations can trigger below 50% through the existing budget manager boundary', async () => {
  const f = fixture();
  const decision = f.policy.evaluate(f.ctx);
  assert.equal(decision.reason, 'economic');
  assert.equal(decision.compact, true);
  let operation;
  const check = createContextBudgetChecker(f.api, f.state, {
    mode: async () => 'auto', activeRole: () => f.state.activeRole, decide: f.policy.evaluate,
    start: () => { operation = f.state.pendingRoleCompaction; return true; },
  });
  assert.equal(await check(f.ctx), true);
  assert.equal(operation.budget.identity.taskId, 'live');
  assert.equal(operation.budget.identity.attemptId, 'attempt');
  assert.equal(operation.continuation, undefined);
  assert.equal(f.state.workflowState.tasks.find(task => task.id === 'live').status, 'in_progress');
});

test('unknown future work, missing prices, mixed-model history and transformed projections fail conservatively', () => {
  for (const modify of [
    f => { f.state.workflowState = undefined; },
    f => { delete f.ctx.model.cost; },
    f => { f.entries[1].message.model = 'other'; },
    f => { f.state.workflowState.status = 'replanning'; },
    f => { f.state.workflowState.tasks[2].role = 'docs-commit'; },
    f => { Object.assign(f.state.workflowState.tasks.at(-1), { role: 'docs-commit', priority: 100 }); },
    f => { f.state.workflowState.tasks.filter(task => task.status === 'pending').forEach(task => { task.dependsOn = ['unavailable']; }); },
    f => { f.publish(f.entries.slice(-2).map(entry => entry.message)); },
  ]) {
    const f = fixture();
    modify(f);
    assert.equal(f.policy.evaluate(f.ctx).compact, false);
  }
});

test('branch/generation/model changes cannot borrow stale projection evidence', () => {
  for (const change of [f => { f.state.roleContextGeneration++; }, f => { f.state.roleTransitionGeneration++; },
    f => { f.entries[0] = { ...f.entries[0], id: 'different' }; }]) {
    const f = fixture(); change(f);
    assert.equal(f.policy.evaluate(f.ctx).reason, 'projection-unavailable');
  }
  const f = fixture();
  assert.equal(f.policy.evaluate(f.ctx, { ...f.ctx.model, id: 'different' }).reason, 'model-change');
  f.hooks.get('session_start')();
  assert.equal(f.policy.evaluate(f.ctx).compact, false);
});

test('successful compaction evidence restores cooldown/debt without a second persistent state machine', () => {
  const f = fixture();
  f.entries.push({ id: 'compact', parentId: f.entries.at(-1).id, type: 'compaction', timestamp: new Date(1500).toISOString(),
    summary: 'summary', firstKeptEntryId: 'user-5', tokensBefore: 300000 });
  const request = structuredClone(f.entries[1]);
  request.id = 'after'; request.parentId = 'compact'; request.message.timestamp = 2000;
  request.message.usage = f.usage(100000);
  f.entries.push(request);
  f.publish();
  assert.equal(f.policy.evaluate(f.ctx).reason, 'post-compaction-cooldown');
  for (let i = 0; i < 2; i++) f.entries.push({ ...structuredClone(request), id: 'after-' + i });
  f.publish();
  assert.equal(f.policy.evaluate(f.ctx).reason, 'unpaid-compaction-debt');
  for (let i = 2; i < 40; i++) f.entries.push({ ...structuredClone(request), id: 'after-' + i });
  f.publish();
  assert.equal(f.policy.evaluate(f.ctx).compact, true, 'observed repayment permits a later profitable compaction');
  f.entries.at(-1).message.model = 'other';
  f.publish();
  const unknown = f.policy.evaluate(f.ctx);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'COMPACTION_HISTORY_UNAVAILABLE');
});

test('native removable prefix does not assume OCC added a trailing abort marker', () => {
  const user = { role: 'user', content: 'x'.repeat(80000), timestamp: 1 };
  const entries = [user,
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'check' } }],
      timestamp: 2, provider: 'test', model: 'model', api: 'test', stopReason: 'toolUse',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    { role: 'toolResult', toolCallId: 'call', toolName: 'bash', content: [{ type: 'text', text: 'y'.repeat(300000) }], timestamp: 3, isError: false },
  ].map((message, i) => ({ type: 'message', id: 'entry-' + i, parentId: i ? 'entry-' + (i - 1) : null,
    timestamp: new Date(i).toISOString(), message }));
  const removed = estimateProjectedCompactionTokens(entries, 20000, entries.map(entry => entry.message));
  assert.ok(removed > 0);
  assert.ok(removed <= estimateTokens(user), 'the retained tool-call/result group cannot be priced as removable');
});

test('a profitable decision never overrides stop/recovery guards or invents a standalone continuation', async () => {
  for (const field of ['userStopRequested', 'roleRecoveryPending', 'roleRecoveryPersistenceFailed']) {
    const f = fixture(); f.state[field] = true;
    const check = createContextBudgetChecker(f.api, f.state, { mode: async () => 'auto',
      activeRole: () => f.state.activeRole, decide: f.policy.evaluate, start: () => assert.fail('guard bypass') });
    assert.equal(await check(f.ctx), false);
    assert.equal(f.state.pendingRoleCompaction, undefined);
  }
});
