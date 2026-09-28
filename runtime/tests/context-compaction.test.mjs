import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareModelContext } from '../context-compaction.mjs';

const config = {
  model: 'test/summary-model', allowedTools: ['read'],
  contextCompaction: { enabled: true, maxInputChars: 850, maxSummaryInputChars: 750, maxSummaryChars: 90, maxSummaryTokens: 64, recentGroups: 2, maxBatches: 12, policyFingerprint: 'test-policy' },
};

function transcript() {
  return [
    { role: 'system', content: 'Keep these original system instructions exactly.' },
    { role: 'user', content: 'Please continue the investigation.' },
    ...Array.from({ length: 8 }, (_, index) => ({ role: 'assistant', content: `Earlier investigation ${index}: ${'evidence '.repeat(8)}` })),
    { role: 'assistant', content: 'Recent finding.' },
  ];
}

function summarizer(calls = []) {
  return async (input, options) => {
    calls.push({ input, options });
    return { choices: [{ message: { role: 'assistant', content: 'Verified earlier findings and outstanding tasks.' } }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } };
  };
}

test('disabled compaction passes the same full transcript without calling a provider', async () => {
  const original = transcript();
  const existing = { old: true };
  const result = await prepareModelContext({ messages: original, checkpoint: existing, config: { model: config.model }, model: () => { throw new Error('unexpected'); } });
  assert.strictEqual(result.messages, original);
  assert.strictEqual(result.checkpoint, existing);
  assert.deepEqual(result.usage, {});
  assert.equal(result.compacted, false);
});

test('compacts only model input, preserves system and latest user, and accounts for every summary call', async () => {
  const original = transcript(), before = structuredClone(original), calls = [];
  const result = await prepareModelContext({ messages: original, config, model: summarizer(calls) });
  assert.deepEqual(original, before);
  assert.equal(result.compacted, true);
  assert.strictEqual(result.messages[0], original[0]);
  assert.strictEqual(result.messages[2], original[1]);
  assert.deepEqual(result.messages.slice(-2), original.slice(-2));
  assert.match(result.messages[1].content, /Derived summary.*untrusted assistant context/);
  assert.equal(JSON.stringify(result.messages).length <= config.contextCompaction.maxInputChars, true);
  assert.equal(result.checkpoint.prefixLength, original.length - 2);
  assert.equal(JSON.stringify(result.checkpoint).includes(config.model), false);
  assert.equal(JSON.stringify(result.checkpoint).includes(config.contextCompaction.policyFingerprint), false);
  assert.equal(result.usage.total_tokens, 12 * calls.length);
  assert(calls.length > 1);
  for (const { input, options } of calls) {
    assert.equal(JSON.stringify(input).length <= config.contextCompaction.maxSummaryInputChars, true);
    assert.equal(options.model, config.model);
    assert.equal(options.max_tokens, 64);
    assert.equal(Object.hasOwn(options, 'tools'), false);
  }
});

test('assistant tool calls and all replies remain one indivisible group', async () => {
  const call = id => ({ id, type: 'function', function: { name: 'read', arguments: '{}' } });
  const original = [
    { role: 'system', content: 'System' }, { role: 'user', content: 'Latest user' },
    { role: 'assistant', content: 'Old finding ' + 'z'.repeat(300) },
    { role: 'assistant', content: 'Old detail ' + 'z'.repeat(300) },
    { role: 'assistant', content: null, tool_calls: [call('a'), call('b')] },
    { role: 'tool', tool_call_id: 'a', content: 'first reply ' + 'x'.repeat(120) },
    { role: 'tool', tool_call_id: 'b', content: 'second reply ' + 'x'.repeat(120) },
    { role: 'assistant', content: 'Result ' + 'y'.repeat(180) },
    { role: 'assistant', content: 'Another ' + 'y'.repeat(180) },
    { role: 'assistant', content: 'Latest' },
  ];
  const policy = { ...config, contextCompaction: { ...config.contextCompaction, maxInputChars: 1400, maxSummaryInputChars: 1200, recentGroups: 3 } };
  const result = await prepareModelContext({ messages: original, config: policy, model: summarizer() });
  assert.equal(result.checkpoint.prefixLength, 7);
  assert.equal(result.messages.some(message => message.role === 'tool'), false);
  const retained = await prepareModelContext({ messages: original, config: { ...policy, contextCompaction: { ...policy.contextCompaction, recentGroups: 4 } }, model: summarizer() });
  assert.deepEqual(retained.messages.slice(-6, -3), original.slice(4, 7));
  assert.equal(retained.messages[2].role, 'user');
});

test('valid checkpoint reuses exact prefix, then summarizes only appended older groups', async () => {
  const original = transcript(), calls = [];
  const first = await prepareModelContext({ messages: original, config, model: summarizer(calls) });
  const count = calls.length;
  const reused = await prepareModelContext({ messages: original, checkpoint: structuredClone(first.checkpoint), config, model: summarizer(calls) });
  assert.equal(calls.length, count);
  assert.deepEqual(reused.messages, first.messages);
  assert.deepEqual(reused.usage, {});
  const extended = [...original, { role: 'assistant', content: 'Newest result.' }];
  const next = await prepareModelContext({ messages: extended, checkpoint: first.checkpoint, config, model: summarizer(calls) });
  assert.equal(calls.length, count + 1);
  assert.equal(JSON.parse(calls.at(-1).input[1].content).transcript.length, 1);
  assert.equal(next.checkpoint.prefixLength, first.checkpoint.prefixLength + 1);
  assert.equal(next.usage.total_tokens, 12);
  assert.deepEqual(original, transcript());
});

test('drifted history or effective policy invalidates the checkpoint', async () => {
  const original = transcript();
  const initial = await prepareModelContext({ messages: original, config, model: summarizer() });
  const mutated = structuredClone(original);
  mutated[3].content += ' changed';
  const calls = [];
  await prepareModelContext({ messages: mutated, checkpoint: initial.checkpoint, config, model: summarizer(calls) });
  assert(calls.length > 1);
  calls.length = 0;
  const policy = { ...config, allowedTools: ['write'] };
  const changed = await prepareModelContext({ messages: original, checkpoint: initial.checkpoint, config: policy, model: summarizer(calls) });
  assert(calls.length > 1);
  assert.notEqual(changed.checkpoint.provenanceDigest, initial.checkpoint.provenanceDigest);
  calls.length = 0;
  await prepareModelContext({ messages: original, checkpoint: initial.checkpoint, config: { ...config, contextCompaction: { ...config.contextCompaction, policyFingerprint: 'changed' } }, model: summarizer(calls) });
  assert(calls.length > 1);
});

test('provider failures, tool-call summaries, oversized and empty summaries leave inputs intact', async () => {
  const original = transcript(), before = structuredClone(original), checkpoint = Object.freeze({ summary: 'prior' });
  for (const model of [
    async () => { throw new Error('summary provider failed'); },
    async () => ({ choices: [{ message: { role: 'assistant', content: 'text', tool_calls: [{ id: 'bad' }] } }] }),
    async () => ({ choices: [{ message: { role: 'assistant', content: '  ' } }] }),
    async () => ({ choices: [{ message: { role: 'assistant', content: 'x'.repeat(91) } }] }),
  ]) await assert.rejects(prepareModelContext({ messages: original, checkpoint, config, model }));
  assert.deepEqual(original, before);
  assert.deepEqual(checkpoint, { summary: 'prior' });
});

test('a failed later batch exposes completed summary usage without committing partial state', async () => {
  const original = transcript(), before = structuredClone(original), prior = Object.freeze({ summary: 'existing' });
  let calls = 0;
  await assert.rejects(prepareModelContext({ messages: original, checkpoint: prior, config, model: async (...args) => {
    if (++calls === 2) throw new Error('later batch failed');
    return summarizer()(...args);
  } }), error => {
    assert.match(error.message, /later batch failed/);
    assert.deepEqual(error.compactionUsage, { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 });
    return true;
  });
  assert.deepEqual(original, before);
  assert.deepEqual(prior, { summary: 'existing' });
});

test('cancellation propagates to the summary call and never creates a partial checkpoint', async () => {
  const controller = new AbortController(), original = transcript(), before = structuredClone(original);
  const failure = new Error('cancelled by test');
  let providerCalls = 0;
  await assert.rejects(prepareModelContext({ messages: original, config, signal: controller.signal, model: async (_messages, options) => {
    providerCalls++;
    assert.strictEqual(options.signal, controller.signal);
    controller.abort(failure);
    return { choices: [{ message: { role: 'assistant', content: 'Would otherwise succeed' } }] };
  } }), error => error === failure);
  assert.equal(providerCalls, 1);
  assert.deepEqual(original, before);
});

test('rejects bounds, uncompressible recent context, giant groups, and finite batch cap without truncation', async () => {
  const original = transcript(), before = structuredClone(original);
  const prepare = (messages, policy, model = summarizer()) => prepareModelContext({ messages, config: { ...config, contextCompaction: { ...config.contextCompaction, ...policy } }, model });
  await assert.rejects(prepare(original, { maxBatches: 0 }), /maxBatches.*positive integer/);
  await assert.rejects(prepare(original, { maxSummaryInputChars: 120 }), /maxSummaryInputChars/);
  await assert.rejects(prepare(original, { maxBatches: 1 }), /maxBatches/);
  await assert.rejects(prepare(original, { maxInputChars: 150 }), /Compacted context still exceeds/);
  await assert.rejects(prepare([{ role: 'system', content: 'a' }, { role: 'user', content: 'x'.repeat(900) }], {}), /no older coherent groups/);
  assert.deepEqual(original, before);
});

test('rejects orphan and unanswered tool replies instead of silently splitting them', async () => {
  const base = transcript();
  const small = { ...config, contextCompaction: { ...config.contextCompaction, maxInputChars: 100 } };
  await assert.rejects(prepareModelContext({ messages: [...base, { role: 'tool', tool_call_id: 'missing', content: 'orphan' }], config: small, model: summarizer() }), /orphan tool reply/);
  await assert.rejects(prepareModelContext({ messages: [...base, { role: 'assistant', content: null, tool_calls: [{ id: 'missing' }] }], config: small, model: summarizer() }), /unanswered assistant tool calls/);
});
