import assert from 'node:assert/strict';
import test from 'node:test';
import { nextWorkflowAction } from '../extensions/workflow-action-policy.ts';
import { createExtensionRuntimeState } from '../extensions/runtime-state.ts';
import { createRoleHandoff } from '../extensions/role-handoff.ts';
import { createWorkflowState, startWorkflowTask, requestWorkflowReplan, completeWorkflowTask, createExtensionHarness, emitExtensionEvent, withTempDirectory } from './helpers.js';
import { createRuntimeRoutingContext } from '../extensions/runtime-routing-context.ts';
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { blockWorkflowTask } from "../src/workflow.ts";

function running() {
    const workflow = startWorkflowTask(createWorkflowState({ sessionId: 'test-session', summary: 'rust-crossfile', tasks: [{ id: 'rust-crossfile', role: 'developer-test', task: 'implement', files: ['src'], acceptanceCriteria: ['tested'] }] }), 'rust-crossfile');
    workflow.handoff.phase = 'executing';
    return workflow;
}
function handoff(state) {
  return createRoleHandoff({}, state, { getActiveRole: () => undefined, requireRecovery() { throw Error('unexpected effect'); } });
}
test('running task retains executor authority with and without pending replan', () => {
  for (const workflow of [running(), requestWorkflowReplan(running(), { direction: 'new direction' })]) {
    const state = { ...createExtensionRuntimeState(), workflowState: workflow };
    const before = JSON.stringify(state);
    const step = nextWorkflowAction(state);
    assert.equal(step.action, 'finish-current-task');
    assert.equal(step.requiredRole, 'developer-test');
    const denied = handoff(state).checkSwitchRole('architect');
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, 'WORKFLOW_TASK_BOUNDARY_REQUIRED');
    assert.match(denied.nextAction, /block/);
    assert.equal(handoff(state).checkSwitchRole('developer-test').allowed, true);
    assert.equal(JSON.stringify(state), before);
  }
});
test('safe completion uses existing scheduler replan; ordinary switching stays valid', () => {
  const workflow = requestWorkflowReplan(running(), { direction: 'new direction' });
  const completed = completeWorkflowTask(workflow, { taskId: 'rust-crossfile', completionSummary: 'done', implementationRationale: 'verified', verification: ['tests pass'] });
  const state = { ...createExtensionRuntimeState(), workflowState: completed };
  assert.equal(nextWorkflowAction(state).action, 'schedule-replan');
  assert.equal(handoff(state).checkSwitchRole('docs-commit').allowed, true);
  assert.equal(handoff(createExtensionRuntimeState()).checkSwitchRole('architect').allowed, true);
});
test('recovery and unknown outcomes never recommend executor replay', () => {
  const state = { ...createExtensionRuntimeState(), workflowState: running(), roleRecoveryPending: true };
  assert.equal(nextWorkflowAction(state).action, 'recover');
  assert.equal(handoff(state).checkSwitchRole('architect').allowed, false);
  state.roleRecoveryPending = false;
  state.workflowState.tasks[0].outcomeUnknown = true;
  assert.equal(nextWorkflowAction(state).action, 'recover');
});
test('runtime section uses same boundary guidance rather than architect ping-pong', () => {
  const state = { ...createExtensionRuntimeState(), workflowState: requestWorkflowReplan(running(), { direction: 'new direction' }) };
  const event = { systemPromptOptions: { sections: {} } };
  createRuntimeRoutingContext(state, { getActiveRole: () => ({ role: 'developer-test' }), getThinkingLevel: () => 'high' }).beforeAgentStart(event, {});
  assert.match(event.systemPromptOptions.sections.pi_init_runtime, /finish-current-task/);
  assert.match(event.systemPromptOptions.sections.pi_init_runtime, /block/);
});

test('request and application reject premature replan with stable executor guidance', async () => {
  const { createWorkflowActions } = await import('../extensions/workflow-actions.ts');
  const { createExtensionHarness } = await import('./helpers.js');
  const { workflowActionIdentity } = await import('../src/workflow.ts');
  const harness = createExtensionHarness([], { trusted: true });
  const workflow = requestWorkflowReplan(running(), { direction: 'new direction' });
  const state = { ...createExtensionRuntimeState(), workflowState: workflow };
  let role = 'developer-test';
  const actions = createWorkflowActions(state, {
    report: {}, coordination: {}, dispatch: {},
    roleRuntime: { activeRoleFor: () => ({ role }) },
  });
  for (const action of ['replan']) {
    for (const activeRole of action === 'replan' ? ['developer-test', 'architect'] : ['developer-test']) {
      role = activeRole;
      await assert.rejects(actions.runTaskWorkflowAction({ action, summary: 'new plan', ...workflowActionIdentity(workflow) }, undefined, harness.context), (error) => {
        assert.equal(error.code, 'WORKFLOW_TASK_BOUNDARY_REQUIRED', error.stack);
        assert.equal(error.details.requiredRole, 'developer-test');
        assert.match(error.details.nextAction, /block/);
        return true;
      });
    }
  }
  assert.equal(state.workflowState, workflow);
  assert.equal(workflow.currentTaskId, 'rust-crossfile');
});

test('switch_role refuses premature role handoff before model, recovery or dispatch side effects', async () => {
  await withTempDirectory(async cwd => {
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await writeFile(join(cwd, '.pi', 'role-models.json'), JSON.stringify({ schemaVersion: 2, mode: 'auto', workflowMode: 'on', roleModels: {} }));
    const initial = createWorkflowState({ summary: 'owned task', sessionId: 'test-session', tasks: [{ id: 'owned', role: 'developer-test', task: 'implement', files: ['src'], acceptanceCriteria: ['done'] }] });
    const harness = createExtensionHarness([{ type: 'custom', customType: 'pi-init-workflow', data: initial }], { cwd, trusted: true, deferSendMessagePersistence: true });
    await emitExtensionEvent(harness, 'session_start');
    const task = harness.sentMessages.findLast(({ message }) => message.customType === 'pi-init-workflow-task').message;
    await emitExtensionEvent(harness, 'agent_start');
    await emitExtensionEvent(harness, 'message_start', { message: { ...task, role: 'custom', timestamp: Date.now() } });
    harness.persistSentMessage(task);
    const model = harness.context.model;
    const before = structuredClone(harness.entries);
    const messages = harness.sentMessages.length;
    const result = await harness.tools.find(tool => tool.name === 'switch_role').execute('premature-switch', { role: 'architect' }, undefined, undefined, harness.context);
    assert.equal(result.details.ok, false);
    assert.equal(result.details.code, 'WORKFLOW_TASK_BOUNDARY_REQUIRED');
    assert.equal(result.terminate, undefined);
    assert.equal(harness.context.model, model);
    assert.deepEqual(harness.entries, before);
    assert.equal(harness.sentMessages.length, messages);
    const workflow = harness.tools.find(tool => tool.name === 'task_workflow');
    const requested = await workflow.execute('request-change', { ...task.details, action: 'request-replan', summary: 'Change unfinished plan safely' }, undefined, undefined, harness.context);
    assert.equal(requested.details.currentTaskId, 'owned');
    assert.equal(requested.details.status, 'running');
    assert.equal(requested.terminate, false);
    await workflow.execute('block-for-change', { ...task.details, action: 'block', taskId: 'owned', reason: 'Need revised plan' }, undefined, undefined, harness.context);
    await emitExtensionEvent(harness, 'agent_end');
    await emitExtensionEvent(harness, 'agent_settled');
    assert.ok(harness.sentMessages.some(({ message }) => message.customType === 'pi-init-workflow-replan'));
    await emitExtensionEvent(harness, 'session_shutdown');
  });
});

test('complete and block require the assigned role before changing lifecycle state', async () => {
  const { createWorkflowActions } = await import('../extensions/workflow-actions.ts');
  const { workflowHandoffIdentity } = await import('../src/workflow-handoff.ts');
  const harness = createExtensionHarness([], { trusted: true });
  const workflow = running();
  const identity = workflowHandoffIdentity(workflow);
  harness.persistSentMessage({ role: 'assistant', customType: 'pi-init-workflow-task', details: identity });
  const state = { ...createExtensionRuntimeState(), workflowState: workflow };
  let persisted = 0;
  let markedStarted = 0;
  const actions = createWorkflowActions(state, {
    report: { persistWorkflowState() { persisted++; } },
    coordination: {},
    dispatch: { markCurrentTaskStarted() { markedStarted++; } },
    roleRuntime: {
      activeRoleFor: () => ({ role: 'architect' }),
      retireWorkflowContinuation() {},
    },
  });
  const before = JSON.stringify(workflow);
  for (const action of ['complete', 'block']) {
    await assert.rejects(actions.runTaskWorkflowAction({
      action,
      ...identity,
      reason: 'cannot block from another role',
      completionSummary: 'cannot complete from another role',
      implementationRationale: 'role guard regression',
      verification: ['not run'],
    }, undefined, harness.context), (error) => {
      assert.equal(error.code, 'WORKFLOW_TASK_ROLE_MISMATCH');
      assert.equal(error.details.requiredRole, 'developer-test');
      assert.equal(error.details.activeRole, 'architect');
      return true;
    });
  }
  assert.equal(JSON.stringify(workflow), before);
  assert.equal(persisted, 0);
  assert.equal(markedStarted, 0);
  assert.equal(state.workflowState, workflow);
});

test('blocked task reaches requested replan without becoming completed or replaying unknown outcomes', () => {
  const workflow = requestWorkflowReplan(running(), { direction: 'change safely' });
  const next = blockWorkflowTask(workflow, { taskId: 'rust-crossfile', reason: 'Need revised plan' });
  assert.equal(next.status, 'replanning');
  assert.equal(next.tasks[0].status, 'blocked');
  assert.equal(next.tasks[0].blockReason, 'Need revised plan');
  assert.equal(next.tasks[0].completedAt, undefined);
  assert.equal(next.continuation.kind, 'replan');
  workflow.tasks[0].outcomeUnknown = true;
  const unknown = blockWorkflowTask(workflow, { taskId: 'rust-crossfile', reason: 'Unconfirmed effect' });
  assert.equal(unknown.status, 'paused');
  assert.equal(unknown.continuation, undefined);
});
