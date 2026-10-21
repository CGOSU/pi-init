import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextBudgetChecker, registerContextBudgetMonitor } from '../extensions/context-budget-monitor.ts';
import { createExtensionRuntimeState } from '../extensions/runtime-state.ts';

function fixture() {
  const state = createExtensionRuntimeState();
  const traces = [];
  state.traceHandoff = (_ctx, event, data) => traces.push({ event, ...data });
  let usage = { tokens: 90000, contextWindow: 100000, percent: 90 };
  const branch = [{ id: 'a', type: 'message' }];
  const ctx = { model: { provider: 'test', id: 'model', contextWindow: 100000, maxTokens: 1000 },
    sessionManager: { getSessionId: () => 'session', getBranch: () => branch },
    getContextUsage: () => usage, hasPendingMessages: () => false,
    signal: undefined };
  let starts = 0;
  const check = createContextBudgetChecker({ getThinkingLevel: () => 'off' }, state, {
    mode: async () => 'auto', activeRole: () => state.activeRole,
    start: () => { starts++; state.pendingRoleCompaction = undefined; return true; },
  });
  return { state, ctx, traces, check, branch, setUsage: value => { usage = value; }, starts: () => starts };
}

test('normal high-budget task without explicit role uses existing manager, no continuation', async () => {
  const f = fixture();
  assert.equal(await f.check(f.ctx), true);
  assert.equal(f.starts(), 1);
  assert.equal(f.traces.at(-1).decision, 'started');
  await f.check(f.ctx);
  assert.equal(f.starts(), 1);
  assert.equal(f.traces.at(-1).decision, 'cooldown');
});

test('missing usage is unavailable, never fake zero; stop and inflight fail closed', async () => {
  const f = fixture();
  f.setUsage({ tokens: null, contextWindow: 100000, percent: null });
  await f.check(f.ctx);
  assert.equal(f.traces.at(-1).decision, 'unavailable');
  assert.equal(f.traces.at(-1).tokens, null);
  f.setUsage({ tokens: 90000, contextWindow: 100000, percent: 90 });
  f.state.userStopRequested = true;
  await f.check(f.ctx);
  assert.equal(f.traces.at(-1).reason, 'user-stop');
  f.state.userStopRequested = false;
  f.state.roleCompactionInFlight = true;
  await f.check(f.ctx);
  assert.equal(f.traces.at(-1).decision, 'inflight');
  assert.equal(f.starts(), 0);
});

test('register only checks complete successful tool groups; never returns continuation', async () => {
  let hook, checks = 0;
  const state = createExtensionRuntimeState();
  registerContextBudgetMonitor({ on: (name, cb) => { assert.equal(name, 'turn_end'); hook = cb; } }, state,
    { checkContextBudget: async () => { checks++; } });
  const event = { outcome: 'completed', message: { role: 'assistant', content: [{ type: 'toolCall', id: 't' }] },
    toolResults: [], toolResultEntryIds: [] };
  assert.equal(await hook(event, {}), undefined);
  assert.equal(checks, 0);
  event.toolResults = [{ toolCallId: 't' }]; event.toolResultEntryIds = ['r'];
  assert.equal(await hook(event, {}), undefined);
  assert.equal(checks, 1);
  state.userStopRequested = true;
  await hook(event, {});
  assert.equal(checks, 1);
});

test('manual and confirm modes preserve configuration; low usage and queue guards trace decisions', async () => {
  for (const mode of ['manual', 'confirm']) {
    const f = fixture();
    const check = createContextBudgetChecker({ getThinkingLevel: () => 'off' }, f.state,
      { mode: async () => mode, activeRole: () => undefined, start: () => assert.fail('must not compact') });
    await check(f.ctx);
    assert.equal(f.traces.at(-1).decision, 'mode');
  }
  const f = fixture();
  f.setUsage({ tokens: 100, contextWindow: 100000, percent: 0.1 });
  await f.check(f.ctx);
  assert.equal(f.traces.at(-1).decision, 'threshold');
  f.ctx.hasPendingMessages = () => true;
  await f.check(f.ctx);
  assert.equal(f.traces.at(-1).reason, 'queued-continuation');
});

test('no-gain/failed attempts require cooldown AND measured growth, then stop at a hard cap', async () => {
  const f = fixture();
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    await f.check(f.ctx);
    now += 60001;
    await f.check(f.ctx);
    assert.equal(f.starts(), 1, 'time alone cannot rearm');
    for (const tokens of [100000, 110000, 120000]) {
      now += 60001;
      f.setUsage({ tokens, contextWindow: 100000, percent: tokens / 1000 });
      await f.check(f.ctx);
    }
    assert.equal(f.starts(), 3);
    assert.equal(f.traces.at(-1).reason, 'attempt-limit');
  } finally { Date.now = originalNow; }
});

test('same-role long executing workflow compacts only with full verified identity', async () => {
  const f = fixture();
  f.state.activeRole = { role: 'developer', provider: 'test', model: 'model', thinkingLevel: 'off' };
  const identity = { workflowId: 'w', planVersion: 1, sessionId: 'session', recoveryGeneration: 0,
    taskId: 'task', attemptId: 'attempt', handoffId: 'handoff' };
  f.state.workflowState = { ...identity, version: 2, executor: 'local', status: 'running',
    currentTaskId: 'task', tasks: [{ id: 'task', role: 'developer', status: 'in_progress' }],
    handoff: { ...identity, phase: 'executing' }, plan: { summary: '', constraints: [] }, revisions: [] };
  assert.equal(await f.check(f.ctx), true);
  f.state.workflowState.tasks[0].outcomeUnknown = true;
  assert.equal(await f.check(f.ctx), false);
  assert.equal(f.traces.at(-1).reason, 'task-identity-unverified');
});

test('terminal workflow history does not disable budget checks for later normal tasks', async () => {
  const f = fixture();
  f.state.workflowState = { workflowId: 'old', planVersion: 1, sessionId: 'session', recoveryGeneration: 0,
    status: 'completed', tasks: [] };
  assert.equal(await f.check(f.ctx), true);
});

test('asynchronous configuration cannot compact a changed context', async () => {
  const f = fixture();
  const check = createContextBudgetChecker({ getThinkingLevel: () => 'off' }, f.state, {
    mode: async () => { f.state.roleContextGeneration++; return 'auto'; },
    activeRole: () => undefined, start: () => assert.fail('stale context'),
  });
  assert.equal(await check(f.ctx), false);
  assert.equal(f.traces.at(-1).reason, 'context-changed');
});

test("productive measured reductions rearm long tasks beyond three successful compactions", async () => {
  const f = fixture();
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    for (let i = 0; i < 5; i++) {
      now += 60001;
      f.setUsage({ tokens: 90000, contextWindow: 100000, percent: 90 });
      await f.check(f.ctx);
      f.setUsage({ tokens: 30000, contextWindow: 100000, percent: 30 });
      await f.check(f.ctx);
    }
    assert.equal(f.starts(), 5);
  } finally { Date.now = originalNow; }
});
