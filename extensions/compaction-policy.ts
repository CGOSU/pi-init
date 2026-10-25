import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { DEFAULT_COMPACTION_SETTINGS, type ExtensionAPI, type ExtensionContext, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { decideCompaction, type CompactionDecision, type CompactionEstimate } from '../src/compaction-economics.ts';
import type { ExtensionRuntimeState, WorkflowState } from './runtime-state.ts';
import { getNextWorkflowTask } from '../src/workflow.ts';
import { estimateProjectedCompactionTokens } from './compaction-projection.ts';

type Model = NonNullable<ExtensionContext['model']>;
type Request = { index: number; timestamp: number; model: string; tokens: number };
const SUMMARY_TOKENS = 4096;
const modelKey = (model: { provider: string; id: string }) => JSON.stringify([model.provider, model.id]);
const failure = (code: string, message: string) => ({ ok: false as const, code, message });

function requests(entries: readonly SessionEntry[]): Request[] {
  return entries.flatMap((entry, index) => {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') return [];
    const message = entry.message;
    if (message.stopReason === 'error' || message.stopReason === 'aborted') return [];
    const { input, cacheRead, cacheWrite } = message.usage;
    if (![input, cacheRead, cacheWrite].every(n => Number.isSafeInteger(n) && n >= 0)) return [];
    const tokens = input + cacheRead + cacheWrite;
    if (!Number.isSafeInteger(tokens) || tokens <= 0 || !Number.isFinite(message.timestamp)) return [];
    return [{ index, timestamp: message.timestamp, tokens, model: modelKey({ provider: message.provider, id: message.model }) }];
  });
}

/** Forecast only the confirmed same-role prefix, using the real dependency and
 * priority scheduler. A future role/model transition is not a cache-read promise.
 */
function remainingSameRoleTasks(workflow: WorkflowState, role: string | undefined): number | null {
  if (!role || workflow.pendingRevision || workflow.status !== 'running') return null;
  const future = { ...workflow, currentTaskId: undefined, tasks: workflow.tasks.map(task => ({ ...task })) };
  let remaining = 0;
  const running = future.tasks.find(task => task.id === workflow.currentTaskId);
  if (running) {
    if (running.status !== 'in_progress' || running.role !== role) return null;
    running.status = 'completed';
    remaining++;
  }
  for (let next = getNextWorkflowTask(future); next && next.role === role; next = getNextWorkflowTask(future)) {
    next.status = 'completed';
    remaining++;
  }
  return remaining;
}

function history(entries: readonly SessionEntry[], state: ExtensionRuntimeState, key: string, sessionId: string) {
  const observed = requests(entries);
  const workflow = state.workflowState;
  const active = workflow && workflow.sessionId === sessionId && ['running', 'replanning'].includes(workflow.status);
  const samples = active ? workflow.tasks.flatMap(task => {
    const start = task.executionStartedAt ?? task.startedAt;
    const end = task.completedAt;
    if (task.status !== 'completed' || task.role !== state.activeRole?.role || start === undefined || end === undefined
      || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
    const taskRequests = observed.filter(request => request.timestamp >= start && request.timestamp <= end);
    if (!taskRequests.length || taskRequests.some(request => request.model !== key)) return [];
    return [taskRequests.length];
  }).slice(-8) : [];
  // Replanning and other roles do not supply a confirmed cache-read horizon.
  const remaining = active ? remainingSameRoleTasks(workflow, state.activeRole?.role) : null;
  const deltas = observed.flatMap((request, index) => {
    const previous = observed[index - 1];
    return previous?.model === key && request.model === key && request.tokens > previous.tokens
      ? [request.tokens - previous.tokens] : [];
  });
  return { observed, samples, remaining, growth: deltas.length ? deltas.reduce((sum, n) => sum + n, 0) / deltas.length : null };
}

/** Recover cooldown and conservative unpaid cost from actual branch compactions,
 * including native/manual compactions. No second persistent plan or continuation.
 */
function previousCompaction(entries: readonly SessionEntry[], observed: Request[], key: string, writeRatio: number | null, outputRatio: number | null) {
  const index = entries.findLastIndex(entry => entry.type === 'compaction');
  if (index < 0) return { ok: true as const, value: undefined };
  const entry = entries[index];
  if (entry.type !== 'compaction') return failure('COMPACTION_HISTORY_INVALID', 'Compaction history is inconsistent');
  const after = observed.filter(request => request.index > index);
  // Changing model makes old cache economics incomparable, not evidence of savings.
  if (!after.length || after.some(request => request.model !== key) || writeRatio === null || outputRatio === null) {
    return failure('COMPACTION_HISTORY_UNAVAILABLE', 'Post-compaction request/model prices are not yet comparable');
  }
  const first = after[0];
  const summary = Math.ceil(Buffer.byteLength(entry.summary, 'utf8') / 4);
  const saved = Math.max(0, entry.tokensBefore - first.tokens);
  const cost = first.tokens * Math.max(0, writeRatio - 1)
    + entry.tokensBefore * writeRatio + summary * outputRatio;
  return { ok: true as const, value: { requests: after.length, unpaidCostTokens: Math.max(0, cost - saved * after.length) } };
}

/** Cost policy only. Execution, identity, stopping and continuation stay in the
 * existing compaction manager. Observations never dispatch a model turn.
 */
export function createCompactionPolicy(pi: ExtensionAPI, state: ExtensionRuntimeState) {
  let candidate: { messages: AgentMessage[]; sessionId: string; generation: number; transition: number; model: string; ids: string[] } | undefined;
  let observed: typeof candidate;
  pi.on('context_with_system', (event, ctx) => {
    candidate = ctx.model ? { messages: [...event.messages], sessionId: ctx.sessionManager.getSessionId(),
      generation: state.roleContextGeneration, transition: state.roleTransitionGeneration, model: modelKey(ctx.model), ids: ctx.sessionManager.getBranch().map(entry => entry.id) } : undefined;
  });
  pi.on('before_provider_request', (_event, ctx) => {
    if (candidate && !ctx.signal?.aborted) observed = candidate;
    candidate = undefined;
  });
  const reset = () => { candidate = undefined; observed = undefined; };
  pi.on('session_start', reset);
  pi.on('session_tree', reset);
  pi.on('session_compact', reset);
  pi.on('session_shutdown', reset);
  pi.on('model_select', reset);

  function evaluate(ctx: ExtensionContext, targetModel: Model | undefined = ctx.model): CompactionDecision {
    if (state.roleModeStatus !== 'auto') return failure('COMPACTION_MODE_DISABLED', 'Automatic compaction requires auto mode');
    const usage = ctx.getContextUsage();
    if (!ctx.model || !targetModel || usage?.tokens == null) return failure('COMPACTION_USAGE_UNAVAILABLE', 'Model or token usage is unavailable');
    const window = targetModel.contextWindow;
    if (!Number.isSafeInteger(targetModel.maxTokens) || targetModel.maxTokens < 0) {
      return failure('COMPACTION_MODEL_BUDGET_INVALID', 'Model output budget is unavailable or invalid');
    }
    const reserve = Math.min(targetModel.maxTokens, Math.floor(window / 4)) + 4096;
    const base: CompactionEstimate = { contextTokens: usage.tokens, contextWindow: window, reserveTokens: reserve,
      archiveTokens: null, summaryTokens: SUMMARY_TOKENS, completedRequestCounts: [], remainingTasks: null,
      averageGrowthTokens: null, writeReadRatio: null, outputReadRatio: null };
    // Check native-capacity safety even if no price/history/projection is known.
    const capacity = decideCompaction(base);
    if (!capacity.ok || capacity.compact) return capacity;
    if (modelKey(ctx.model) !== modelKey(targetModel)) return { ...capacity, reason: 'model-change' };
    const entries = ctx.sessionManager.getBranch();
    const sessionId = ctx.sessionManager.getSessionId();
    const key = modelKey(ctx.model);
    const source = observed;
    if (!source || source.sessionId !== sessionId || source.generation !== state.roleContextGeneration
      || source.transition !== state.roleTransitionGeneration || source.model !== key
      || source.ids.some((id, index) => entries[index]?.id !== id)) return capacity;
    const settings = pi.getSettings?.().compaction;
    const keep = settings?.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
    if (!Number.isSafeInteger(keep) || keep < 1) return failure('COMPACTION_KEEP_RECENT_INVALID', 'keepRecentTokens must be a positive safe integer');
    try {
      // Bound the removable estimate by actual provider-reported input, never by raw logs alone.
      const archive = Math.min(usage.tokens, estimateProjectedCompactionTokens(entries, keep, source.messages));
      const cost = ctx.model.cost;
      const validPrices = cost && [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(n => Number.isFinite(n) && n >= 0)
        && cost.cacheRead > 0 && cost.input > 0 && cost.output > 0;
      const write = validPrices ? Math.max(cost.input, cost.cacheWrite) / cost.cacheRead : null;
      const output = validPrices ? cost.output / cost.cacheRead : null;
      const { observed: requestHistory, samples, remaining, growth } = history(entries, state, key, sessionId);
      const previous = previousCompaction(entries, requestHistory, key, write, output);
      if (!previous.ok) return previous;
      return decideCompaction({ ...base, archiveTokens: archive, completedRequestCounts: samples, remainingTasks: remaining,
        averageGrowthTokens: growth, writeReadRatio: write, outputReadRatio: output, previous: previous.value });
    } catch (error) {
      return failure('COMPACTION_ESTIMATE_FAILED', error instanceof Error ? error.message : String(error));
    }
  }

  return {
    evaluate(ctx: ExtensionContext, targetModel?: Model) {
      const result = evaluate(ctx, targetModel);
      state.traceHandoff?.(ctx, 'compaction.economics', result);
      return result;
    },
  };
}
