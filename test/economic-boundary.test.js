import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSessionProjection } from '@earendil-works/pi-coding-agent';
import { createExtensionHarness, createWorkflowState, emitExtensionEvent, workflowMessageIdentity,
  withTempDirectory, mkdir, path, writeFile } from './helpers.js';

test('completed task/request history drives economic boundary compaction through the real role runtime and resumes once', async () => {
  await withTempDirectory(async cwd => {
    await mkdir(path.join(cwd, '.pi'), { recursive: true });
    await writeFile(path.join(cwd, '.pi', 'role-models.json'), JSON.stringify({ schemaVersion: 2, mode: 'auto', workflowMode: 'on', roleModels: {} }));
    const model = { provider: 'test', id: 'model', contextWindow: 1000000, maxTokens: 8192,
      cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 } };
    const tasks = Array.from({ length: 11 }, (_, i) => ({ id: 'task-' + i, role: 'developer-test',
      task: 'implement ' + i, files: ['src'], acceptanceCriteria: ['verified'] }));
    const workflow = createWorkflowState({ summary: 'economic boundary', tasks });
    const h = createExtensionHarness([{ type: 'custom', id: 'initial', customType: 'pi-init-workflow', data: workflow }],
      { cwd, trusted: true, model, availableModels: [model], deferSendMessagePersistence: true });
    // The shared harness omits metadata IDs; the native projection follows real
    // parent-linked session entries, so provide the actual SDK storage shape here.
    h.context.sessionManager.getBranch = () => {
      h.branch.forEach((entry, index) => {
        entry.id ??= 'metadata-' + index;
        entry.parentId = index ? h.branch[index - 1].id : null;
        entry.timestamp ??= new Date().toISOString();
      });
      return h.branch;
    };
    h.context.getContextUsage = () => ({ tokens: 300000, contextWindow: 1000000, percent: 30 });
    let callbacks;
    h.context.compact = options => { callbacks = options; };
    await emitExtensionEvent(h, 'session_start');
    const taskMessage = h.sentMessages.find(({ message }) => message.customType === 'pi-init-workflow-task').message;
    await emitExtensionEvent(h, 'agent_start');
    await emitExtensionEvent(h, 'message_start', { message: { role: 'custom', ...taskMessage } });
    h.persistSentMessage(taskMessage);
    const latest = () => h.entries.findLast(entry => entry.type === 'pi-init-workflow').data;
    for (let i = 0; i < 20; i++) {
      const timestamp = Date.now();
      const base = { parentId: h.branch.at(-1)?.id ?? null, timestamp: new Date(timestamp).toISOString(), type: 'message' };
      h.branch.push({ ...base, id: 'user-' + i, message: { role: 'user', content: 'x'.repeat(40000), timestamp } });
      h.branch.push({ ...base, id: 'assistant-' + i, parentId: 'user-' + i, message: { role: 'assistant',
        content: [{ type: 'text', text: 'work' }], provider: 'test', model: 'model', api: 'test', timestamp, stopReason: 'stop',
        usage: { input: 300000, cacheRead: 0, cacheWrite: 0, output: 1, totalTokens: 300001,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
    }
    const projectedMessages = buildSessionProjection(h.context.sessionManager.getBranch()).messages;
    await emitExtensionEvent(h, 'context_with_system', { messages: projectedMessages });
    await emitExtensionEvent(h, 'before_provider_request', { payload: {} });
    await h.tools.find(tool => tool.name === 'task_workflow').execute('complete-first', {
      ...workflowMessageIdentity(h), action: 'complete', taskId: 'task-0', completionSummary: 'implemented',
      implementationRationale: 'verified task boundary', verification: ['targeted checks passed'],
    }, undefined, undefined, h.context);
    await emitExtensionEvent(h, 'agent_settled');
    assert.ok(callbacks, 'profitable boundary below 50% must reach the existing manager');
    assert.equal(latest().tasks[0].status, 'completed');
    assert.equal(latest().tasks[1].status, 'pending');
    assert.equal(latest().continuation.phase, 'compacting');
    await h.completeCompaction(callbacks);
    const deadline = Date.now() + 2000;
    while (latest().currentTaskId !== 'task-1' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(latest().currentTaskId, 'task-1');
    const attempt = latest().handoff.attemptId;
    callbacks.onComplete({});
    await emitExtensionEvent(h, 'agent_settled');
    assert.equal(latest().handoff.attemptId, attempt);
    assert.equal(h.sentMessages.filter(({ message }) => message.customType === 'pi-init-workflow-task').length, 2);
    await emitExtensionEvent(h, 'session_shutdown');
  });
});
