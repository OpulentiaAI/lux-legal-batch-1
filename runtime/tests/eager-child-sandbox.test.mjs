import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';

function fixture(options = {}) {
  const store = createStore(':memory:');
  const order = [], sandboxes = new Map();
  const runtime = createRuntime({ store,
    config: { workspace: '/tmp/child-work', allowedTools: ['opulent_session_create'], ...options.config },
    provision: async () => {
      order.push('provision');
      if (options.failure) throw new Error('Corpus provisioning failed');
      const sandbox = { sandboxId: `vm-${sandboxes.size + 1}`,
        files: { makeDir: async () => order.push('workspace-ready') },
        pause: async () => {}, kill: async () => {} };
      sandboxes.set(sandbox.sandboxId, sandbox);
      return sandbox;
    },
    connect: async id => sandboxes.get(id),
    model: async () => {
      order.push('model');
      return { choices: [{ message: { role: 'assistant', content: 'Completed bounded research' } }] };
    },
  });
  return { runtime, store, order, sandboxes };
}

test('opt-in child provisioning allocates distinct VMs before any child inference', async t => {
  const { runtime, store, order, sandboxes } = fixture({ config: { eagerChildSandbox: true } });
  t.after(() => runtime.close());
  const parent = runtime.allocate({ prompt: 'Coordinate research' });
  const reply = await runtime.invoke(parent.id, 'opulent_session_create', {
    sessions: [{ prompt: 'Read the approved corpus', title: 'Authority' }, { prompt: 'Check another source', title: 'Context' }],
  });
  for (const child of reply.sessions) {
    const result = await runtime.waitSession(child.session_id);
    assert.equal(result.status, 'completed');
    assert.equal(store.get('sessions', child.session_id).sandbox_ids.length, 1);
  }
  assert.equal(sandboxes.size, 2);
  assert.equal(new Set(reply.sessions.map(child => store.get('sessions', child.session_id).sandbox_id)).size, 2);
  assert.equal(order.indexOf('model') > order.indexOf('workspace-ready'), true);
  assert.equal(store.get('sessions', parent.id).sandbox_id, undefined);
});

test('failed eager child provisioning never starts a model call or claims completion', async t => {
  const { runtime, order } = fixture({ config: { eagerChildSandbox: true }, failure: true });
  t.after(() => runtime.close());
  const parent = runtime.allocate({ prompt: 'Coordinate research' });
  const reply = await runtime.invoke(parent.id, 'opulent_session_create', { sessions: [{ prompt: 'Read sources', title: 'Authority' }] });
  const result = await runtime.waitSession(reply.sessions[0].session_id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Corpus provisioning failed/);
  assert.deepEqual(order, ['provision']);
});

test('historical children remain lazy when eager provisioning is not configured', async t => {
  const { runtime, order, sandboxes } = fixture();
  t.after(() => runtime.close());
  const parent = runtime.allocate({ prompt: 'Coordinate research' });
  const reply = await runtime.invoke(parent.id, 'opulent_session_create', { sessions: [{ prompt: 'Answer from returned host evidence', title: 'Authority' }] });
  assert.equal((await runtime.waitSession(reply.sessions[0].session_id)).status, 'completed');
  assert.deepEqual(order, ['model']);
  assert.equal(sandboxes.size, 0);
});

test('eager child provisioning rejects nonboolean configuration', () => {
  assert.throws(() => fixture({ config: { eagerChildSandbox: 'true' } }), /eagerChildSandbox must be a boolean/);
});
