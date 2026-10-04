import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';

test('simultaneous cold execute calls share one executor and preserve both persistent bindings', async () => {
  const store = createStore(':memory:');
  const neverLive = async () => { throw new Error('This offline initialization test must not invoke a model or VM'); };
  const runtime = createRuntime({ store, storage: {}, model: neverLive, provision: neverLive,
    connect: neverLive, config: { runtimeCapabilities: ['capy-v1'] } });
  try {
    const row = runtime.allocate();
    const ctx = runtime.context(row.id);
    let executor;
    const constructed = [];
    Object.defineProperty(ctx, 'capyExecutor', { get: () => executor, set: value => { constructed.push(value); executor = value; } });
    const results = await Promise.all([
      runtime.invoke(row.id, 'execute', { code: 'let leftBinding = 1; return leftBinding;' }),
      runtime.invoke(row.id, 'execute', { code: 'let rightBinding = 2; return rightBinding;' }),
    ]);
    assert.deepEqual(results.map(result => result.value), [1, 2]);
    assert.equal(constructed.length, 1);
    assert.deepEqual(store.get('capy_bindings', row.id).bindings, { leftBinding: 1, rightBinding: 2 });
    const subsequent = await runtime.invoke(row.id, 'execute', { code: 'return leftBinding + rightBinding;' });
    assert.equal(subsequent.value, 3);
  } finally {
    await runtime.close();
  }
});
