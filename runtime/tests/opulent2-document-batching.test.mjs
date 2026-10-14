import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapyExecutor } from '../capy-execute.mjs';
import { CAPY_TOOL_DEFINITIONS } from '../capy-policy.mjs';
import { createStore } from '../store.mjs';

test('synthetic independent bash outcomes overlap and persist for separate full returns without repeating work', { timeout: 10000 }, async t => {
  const store = createStore(':memory:');
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const outcomes = [0, 1, 2].map(index => ({ operation_id: `synthetic-offline-operation-${index}`, status: 'completed',
    stdout: JSON.stringify({ synthetic: true, observation: `offline-result-${index}` }), stderr: '', exit_code: 0,
    output_paths: { stdout: `/synthetic-not-live/${index}/stdout`, stderr: `/synthetic-not-live/${index}/stderr` } }));
  let active = 0, maximum = 0, calls = 0;
  const executor = createCapyExecutor({ sessionId: 'synthetic-document-batch', store,
    capyCatalog: [CAPY_TOOL_DEFINITIONS.bash],
    async invoke(name, args) {
      assert.equal(name, 'bash');
      assert.equal(args.description, 'Synthetic offline parallel result test, not a document helper');
      const index = Number(args.command.split('-').at(-1));
      assert(index >= 0 && index < outcomes.length);
      calls++;
      maximum = Math.max(maximum, ++active);
      if (calls === outcomes.length) started.resolve();
      await release.promise;
      active--;
      return outcomes[index];
    } });
  t.after(async () => { release.resolve(); await executor.close(); store.close(); });
  const first = executor.execute({ code: `var documentWorkflowBatch = await Promise.all([0,1,2].map(index =>
    tools.capy.bash({command: "synthetic-offline-" + index, description: "Synthetic offline parallel result test, not a document helper"})));
    return documentWorkflowBatch[0];` });
  await started.promise;
  assert.equal(maximum, 3);
  release.resolve();
  const results = [await first, await executor.execute({ code: 'return documentWorkflowBatch[1];' }),
    await executor.execute({ code: 'return documentWorkflowBatch[2];' })];
  assert(results.every(result => result.status === 'completed'));
  assert.deepEqual(results.map(result => result.value), outcomes);
  assert.equal(calls, 3);
  assert.equal(store.list('capy_execute_calls').length, 3);
  assert.deepEqual(store.get('capy_bindings', 'synthetic-document-batch').bindings.documentWorkflowBatch, outcomes);
  assert.equal(active, 0);
});
