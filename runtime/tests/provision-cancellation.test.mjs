import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';

for (const phase of ['provision', 'workspace']) test(`cancellation during ${phase} destroys late sandbox before persisting it`, async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let kills = 0, clones = 0, modelCalls = 0;
  const sandbox = {
    sandboxId: `late-${phase}`,
    files: { makeDir: async () => { if (phase === 'workspace') { started(); await blocked; } } },
    git: { clone: async () => { clones++; } },
    kill: async () => { kills++; }, pause: async () => {},
  };
  const runtime = createRuntime({ store: createStore(':memory:'), config: { allowedRepos: ['owner/repo'] },
    provision: async () => { if (phase === 'provision') { started(); await blocked; } return sandbox; },
    model: async () => { modelCalls++; return { choices: [{ message: { role: 'assistant', content: 'done' } }] }; },
  });
  try {
    const session = await runtime.startSession({ prompt: 'Work', repos: ['owner/repo'] });
    await entered;
    const cancellation = runtime.cancelSession(session.id);
    release();
    await cancellation;
    await runtime.waitSession(session.id);
    assert.equal(runtime.store.get('sessions', session.id).status, 'cancelled');
    assert.equal(runtime.store.get('sessions', session.id).sandbox_id, null);
    assert.equal(runtime.context(session.id).sandbox, undefined);
    assert.equal(kills, 1);
    assert.equal(clones, 0);
    assert.equal(modelCalls, 0);
  } finally { await runtime.close(); }
  assert.equal(kills, 1);
});

test('failed late sandbox cleanup retains its ID for recovery instead of claiming it was destroyed', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let kills = 0;
  const sandbox = { sandboxId: 'leaked-for-recovery', files: { makeDir: async () => {} },
    kill: async () => { kills++; throw new Error('provider kill failed'); },
  };
  const runtime = createRuntime({ store: createStore(':memory:'), provision: async () => { started(); await blocked; return sandbox; },
    connect: async () => sandbox, model: async () => ({ choices: [{ message: { role: 'assistant', content: 'done' } }] }),
  });
  try {
    const session = await runtime.startSession({ prompt: 'Work', repos: [] });
    const pending = runtime.invoke(session.id, 'read', { file_path: '/home/user/workspace/file.txt' }).catch(() => {});
    await entered;
    const cancellation = runtime.cancelSession(session.id);
    release();
    await assert.rejects(cancellation, /provider kill failed/);
    await pending;
    await runtime.waitSession(session.id);
    assert.equal(runtime.store.get('sessions', session.id).status, 'cancelled');
    assert.equal(runtime.store.get('sessions', session.id).sandbox_id, sandbox.sandboxId);
    assert(kills >= 2);
    assert(runtime.store.list('events').some(event => event.type === 'sandbox_kill_failed'));
  } finally { await runtime.close(); }
});
