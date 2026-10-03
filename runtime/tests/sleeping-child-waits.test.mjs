import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { createStore } from '../store.mjs';
import { createRuntime } from '../core.mjs';
import { createTools as waitTools, tickOperationWaits } from '../operation-waits.mjs';
import { createTools as orchestrationTools } from '../tools/orchestration.mjs';

function fixture(t, status) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  store.put('sessions', 'lead', { status: 'running' });
  store.put('sessions', 'child', { parent_session_id: 'lead', status: 'sleeping' });
  store.put('sessions', 'grandchild', { parent_session_id: 'child', status: 'running' });
  if (status) store.put('operation_waits', 'child-wait', { session_id: 'child', status,
    operations: [{ kind: 'session', id: 'grandchild' }], return_when: 'all', deadline_at: null,
    notification_id: 'operation-wait:child-wait', notification_text: 'Operation wait child-wait: {}' });
  const ctx = { store, sessionId: 'lead', emit: () => {} };
  return { store, ctx };
}

for (const status of ['waiting', 'notified']) for (const return_when of ['any', 'all']) {
  test(`${return_when} does not finish on a sleeping child with a ${status} resume source`, async t => {
    const { store, ctx } = fixture(t, status);
    const registration = waitTools(ctx).wait_for_operations({ operations: [{ kind: 'session', id: 'child' }], return_when });
    const notifications = [];
    const tickCtx = { store, wakeSession: async (id, notificationId, text) => { notifications.push({ id, notificationId, text }); } };
    await tickOperationWaits(tickCtx);
    assert.equal(store.get('operation_waits', registration.wait_id).status, 'waiting');
    assert.equal(notifications.filter(row => row.id === 'lead').length, 0);
    store.put('sessions', 'child', { ...store.get('sessions', 'child'), status: 'completed', output: 'Bounded findings' });
    await tickOperationWaits(tickCtx);
    assert.equal(store.get('operation_waits', registration.wait_id).outcome, 'operations_finished');
    assert.match(notifications.find(row => row.id === 'lead').text, /"status":"completed"/);
  });
}

for (const status of [undefined, 'cancelled', 'delivered', 'responded']) {
  test(`sleeping child retains legacy terminal behavior with ${status ?? 'no'} operation wait`, async t => {
    const { store, ctx } = fixture(t, status === 'responded' ? 'notified' : status);
    if (status === 'responded') store.put('conversations', 'child', {
      delivered: ['operation-wait:child-wait'], messages: [
        { role: 'user', content: 'Operation wait child-wait: {}' }, { role: 'assistant', content: 'Wait handled; stopped intentionally' },
      ],
    });
    const registration = waitTools(ctx).wait_for_operations({ operations: [{ kind: 'session', id: 'child' }] });
    const notifications = [];
    await tickOperationWaits({ store, wakeSession: async (id, _, text) => { notifications.push({ id, text }); } });
    assert.equal(store.get('operation_waits', registration.wait_id).outcome, 'operations_finished');
    assert.match(notifications.find(row => row.id === 'lead').text, /"status":"sleeping"/);
    const started = Date.now();
    assert.equal((await orchestrationTools(ctx).read_subagent({ agent_id: 'child', block: true, timeout: 1 })).status, 'sleeping');
    assert(Date.now() - started < 500);
  });
}

for (const status of ['waiting', 'notified']) test(`blocking child read waits through ${status} sleep until actual output`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { store, ctx } = fixture(t, status);
  let settled = false;
  const pending = orchestrationTools(ctx).read_subagent({ agent_id: 'child', block: true, timeout: 30 }).finally(() => { settled = true; });
  await flush();
  assert.equal(settled, false);
  setTimeout(() => store.put('sessions', 'child', { ...store.get('sessions', 'child'), status: 'completed', output: 'Actual research' }), 1000);
  t.mock.timers.tick(1000);
  assert.deepEqual(await pending, { agent_id: 'child', status: 'completed', response: 'Actual research' });
});

test('blocking child read still honors its own timeout while the child wait remains pending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { ctx } = fixture(t, 'waiting');
  const pending = orchestrationTools(ctx).read_subagent({ agent_id: 'child', block: true, timeout: 1 });
  t.mock.timers.tick(1000);
  assert.deepEqual(await pending, { agent_id: 'child', status: 'sleeping', response: null });
});

test('root tick resumes a delegated timer wait without prematurely completing the lead wait', async t => {
  let childCalls = 0, childEntered, finishChild;
  const entered = new Promise(resolve => { childEntered = resolve; });
  const done = new Promise(resolve => { finishChild = resolve; });
  const runtime = createRuntime({ store: createStore(':memory:'), config: { runtimeCapabilities: ['operation-waits-v1'] }, model: async messages => {
    if (messages.some(message => message.role === 'user' && message.content === 'Child')) {
      if (++childCalls === 1) return { choices: [{ message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'timer', type: 'function', function: { name: 'wait_for_operations', arguments: '{"duration_seconds":1}' } }] } }] };
      childEntered();
      await done;
      return { choices: [{ message: { role: 'assistant', content: 'Bounded findings' } }] };
    }
    return { choices: [{ message: { role: 'assistant', content: 'Integrated response' } }] };
  } });
  t.after(async () => { finishChild(); await runtime.close(); });
  const lead = runtime.allocate({ prompt: 'Lead' });
  const child = await runtime.context(lead.id).startSession({ prompt: 'Child' });
  assert.equal((await runtime.waitSession(child.id)).status, 'sleeping');
  const registration = await runtime.invoke(lead.id, 'wait_for_operations', { operations: [{ kind: 'session', id: child.id }] });
  runtime.store.put('sessions', lead.id, { ...runtime.store.get('sessions', lead.id), status: 'sleeping' });
  let readFinished = false;
  const pending = runtime.invoke(lead.id, 'read_subagent', { agent_id: child.id, block: true, timeout: 3 }).finally(() => { readFinished = true; });
  await runtime.tick(lead.id, new Date(Date.now() + 2000));
  await entered;
  assert.equal(runtime.store.get('operation_waits', registration.wait_id).status, 'waiting');
  assert.equal(runtime.store.get('sessions', lead.id).status, 'sleeping');
  assert.equal(readFinished, false);
  finishChild();
  assert.equal((await runtime.waitSession(child.id)).status, 'completed');
  assert.equal((await pending).response, 'Bounded findings');
  await runtime.tick(lead.id);
  assert.equal((await runtime.waitSession(lead.id)).output, 'Integrated response');
});
