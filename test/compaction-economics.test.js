import assert from 'node:assert/strict';
import test from 'node:test';
import { decideCompaction } from '../src/compaction-economics.ts';

const estimate = overrides => ({ contextTokens: 100000, contextWindow: 1000000, reserveTokens: 10000,
  archiveTokens: 80000, summaryTokens: 1000, completedRequestCounts: [20, 20], remainingTasks: 10,
  averageGrowthTokens: 100, writeReadRatio: 10, outputReadRatio: 40, ...overrides });

test('economic benefit must pay for summary generation and cache rebuilding', () => {
  const profitable = decideCompaction(estimate());
  assert.equal(profitable.compact, true);
  assert.equal(profitable.reason, 'economic');
  assert.equal(profitable.estimatedCostTokens, 1229000);
  assert.equal(decideCompaction(estimate({ remainingTasks: 0 })).compact, false);
  assert.equal(decideCompaction(estimate({ remainingTasks: 1, completedRequestCounts: [1, 1] })).compact, false);
  assert.equal(decideCompaction(estimate({ archiveTokens: 1000 })).compact, false);
  assert.equal(decideCompaction(estimate({ outputReadRatio: 100000 })).compact, false);
});

test('unknown horizon, prices and projection never manufacture savings', () => {
  for (const override of [{ remainingTasks: null }, { completedRequestCounts: [] }, { archiveTokens: null },
    { writeReadRatio: null }, { outputReadRatio: null }, { writeReadRatio: 0 }]) {
    const result = decideCompaction(estimate({ contextTokens: 600000, ...override }));
    assert.equal(result.ok, true);
    assert.equal(result.compact, false);
  }
  assert.equal(decideCompaction(estimate({ completedRequestCounts: [1, 100], remainingTasks: 1 })).compact, false);
  assert.equal(decideCompaction(estimate({ averageGrowthTokens: 100000 })).compact, false);
});

test('invalid estimates fail explicitly instead of returning a successful no-op', () => {
  for (const override of [{ contextTokens: NaN }, { summaryTokens: -1 }, { contextWindow: 0 },
    { archiveTokens: 200000 }, { remainingTasks: 0.5 }, { writeReadRatio: Infinity },
    { completedRequestCounts: [0] }, { previous: { requests: -1, unpaidCostTokens: 0 } },
    { outputReadRatio: Number.MAX_VALUE }, { completedRequestCounts: [Number.MAX_SAFE_INTEGER], averageGrowthTokens: null }]) {
    const result = decideCompaction(estimate(override));
    assert.equal(result.ok, false);
    assert.ok(result.code);
    assert.ok(result.message);
  }
});

test('repeated compaction waits for both measured requests and debt repayment', () => {
  assert.equal(decideCompaction(estimate({ previous: { requests: 2, unpaidCostTokens: 0 } })).compact, false);
  assert.equal(decideCompaction(estimate({ previous: { requests: 50, unpaidCostTokens: 1 } })).compact, false);
  assert.equal(decideCompaction(estimate({ previous: { requests: 50, unpaidCostTokens: 0 } })).compact, true);
});

test('capacity protection is independent of speculative savings and replaces no 50% fallback', () => {
  const unknown = estimate({ contextTokens: 40000, contextWindow: 32000, reserveTokens: 12000,
    archiveTokens: null, completedRequestCounts: [], remainingTasks: null, writeReadRatio: null });
  assert.equal(decideCompaction(unknown).reason, 'window-protection');
  assert.equal(decideCompaction(unknown).compact, true);
  assert.equal(decideCompaction(estimate({ contextTokens: 600000, completedRequestCounts: [] })).compact, false);
});
