/*
 * Adapted from NVIDIA SoL-Pi online-context-compact/economics.ts (2195680).
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 * See THIRD-PARTY-NOTICES. Unlike upstream, use model prices, a conservative
 * request horizon, and charge summary generation as well as cache rebuilding.
 */

export type CompactionEstimate = {
  contextTokens: number;
  contextWindow: number;
  reserveTokens: number;
  archiveTokens: number | null;
  summaryTokens: number;
  completedRequestCounts: readonly number[];
  remainingTasks: number | null;
  averageGrowthTokens: number | null;
  writeReadRatio: number | null;
  outputReadRatio: number | null;
  previous?: { unpaidCostTokens: number; requests: number };
};

export type CompactionDecision = {
  ok: true;
  compact: boolean;
  reason: string;
  expectedRequests: number | null;
  breakEvenRequests: number | null;
  savedTokensPerRequest: number;
  estimatedCostTokens: number;
} | { ok: false; code: string; message: string };

export function decideCompaction(input: CompactionEstimate): CompactionDecision {
  const invalid = (code: string, message: string): CompactionDecision => ({ ok: false, code, message });
  const integers = { contextTokens: input.contextTokens, contextWindow: input.contextWindow,
    reserveTokens: input.reserveTokens, summaryTokens: input.summaryTokens,
    archiveTokens: input.archiveTokens, remainingTasks: input.remainingTasks,
    previousRequests: input.previous?.requests ?? null };
  for (const [name, value] of Object.entries(integers)) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      return invalid('COMPACTION_ESTIMATE_RANGE', name + ' must be a non-negative safe integer');
    }
  }
  if (input.contextWindow === 0 || input.summaryTokens === 0 || input.reserveTokens >= input.contextWindow
    || (input.archiveTokens !== null && input.archiveTokens > input.contextTokens)) {
    return invalid('COMPACTION_ESTIMATE_RANGE', 'Invalid context window, reserve, summary or removable prefix');
  }
  for (const [name, value] of Object.entries({ writeReadRatio: input.writeReadRatio,
    outputReadRatio: input.outputReadRatio, averageGrowthTokens: input.averageGrowthTokens,
    unpaidCostTokens: input.previous?.unpaidCostTokens ?? null })) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      return invalid('COMPACTION_ESTIMATE_NUMBER', name + ' must be finite and non-negative');
    }
  }
  if (!Array.isArray(input.completedRequestCounts) || input.completedRequestCounts.some(n => !Number.isSafeInteger(n) || n <= 0)) {
    return invalid('COMPACTION_HISTORY_INVALID', 'Completed task request counts must be positive safe integers');
  }
  const decision = (reason: string, compact = false, expectedRequests: number | null = null,
    breakEvenRequests: number | null = null, savedTokensPerRequest = 0, estimatedCostTokens = 0): CompactionDecision =>
    ({ ok: true, compact, reason, expectedRequests, breakEvenRequests, savedTokensPerRequest, estimatedCostTokens });

  // Capacity safety is not a speculative cost optimization and never needs a
  // fabricated task horizon or price. Pi's native overflow protection also stays enabled.
  if (input.contextTokens + input.reserveTokens >= input.contextWindow) return decision('window-protection', true);
  if (input.remainingTasks === 0) return decision('no-remaining-work');
  if (input.archiveTokens === null) return decision('projection-unavailable');
  const saved = input.archiveTokens - input.summaryTokens;
  if (saved <= 0) return decision('native-not-compactable');
  if (input.remainingTasks === null || input.completedRequestCounts.length === 0) return decision('horizon-unavailable');
  if (input.writeReadRatio === null || input.outputReadRatio === null
    || input.writeReadRatio === 0 || input.outputReadRatio === 0) return decision('prices-unavailable');

  const counts = input.completedRequestCounts;
  const mean = counts.reduce((sum, n) => sum + n, 0) / counts.length;
  const deviation = Math.sqrt(counts.reduce((sum, n) => sum + (n - mean) ** 2, 0) / counts.length);
  // One standard deviation below the observed mean; no optimistic first-compact multiplier.
  let expected = Math.floor(Math.max(0, mean - deviation) * input.remainingTasks);
  if (input.averageGrowthTokens !== null && input.averageGrowthTokens > 0) {
    expected = Math.min(expected, Math.max(0,
      Math.floor((input.contextWindow - input.reserveTokens - input.contextTokens) / input.averageGrowthTokens)));
  }
  const postTokens = input.contextTokens - saved;
  const rewriteCost = postTokens * Math.max(0, input.writeReadRatio - 1);
  // Conservatively price a full-context summary input with no assumed cache hit.
  const summaryCost = input.contextTokens * input.writeReadRatio + input.summaryTokens * input.outputReadRatio;
  const cost = rewriteCost + summaryCost;
  const breakEven = Math.ceil(cost / saved);
  if (!Number.isSafeInteger(expected) || !Number.isFinite(cost) || !Number.isSafeInteger(breakEven)) {
    return invalid('COMPACTION_ESTIMATE_OVERFLOW', 'Compaction cost or horizon overflowed');
  }
  if (input.previous && input.previous.requests < 3) return decision('post-compaction-cooldown', false, expected, breakEven, saved, cost);
  if (input.previous && input.previous.unpaidCostTokens > 0) return decision('unpaid-compaction-debt', false, expected, breakEven, saved, cost);
  // Subsequent compactions need an extra margin, not merely a second near-tie.
  const margin = input.previous ? 1.25 : 1;
  return decision(expected > breakEven * margin ? 'economic' : 'deferred-economic',
    expected > breakEven * margin, expected, breakEven, saved, cost);
}
