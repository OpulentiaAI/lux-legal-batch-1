import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createStore } from '../store.mjs';
import { CAPY_CONTEXT_POLICY_VERSION, prepareCapyModelContext } from '../capy-context.mjs';
import { prepareModelContext } from '../context-compaction.mjs';
import { persistCapyResult } from '../capy-results.mjs';

const policy = { enabled: true, maxInputChars: 300000, maxSummaryInputChars: 160000, maxSummaryChars: 24000, maxSummaryTokens: 8192, recentGroups: 6, maxBatches: 32 };
const group = (id, calls = 1, size = 60000) => [
  { role: 'assistant', content: null, tool_calls: Array.from({ length: calls }, (_, index) => ({ id: `${id}-${index}`, type: 'function', function: { name: 'read', arguments: '{"path":"corpus/chunk.txt"}' } })) },
  ...Array.from({ length: calls }, (_, index) => ({ role: 'tool', tool_call_id: `${id}-${index}`, content: 'E'.repeat(size) })),
];

function fixture(t) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const files = new Map();
  const ctx = { store, sessionId: 'context-test', workspace: '/vm/workspace', scrub: value => value,
    ensureSandbox: async () => {}, sandbox: { files: { write: async (path, content) => files.set(path, content) } }, emit: () => {} };
  ctx.persistCapyResult = (value, bound) => persistCapyResult(ctx, value, bound);
  let calls = 0;
  const model = async (messages, request) => {
    calls++;
    assert.equal(request.model, 'same-native-model');
    assert.equal(request.max_tokens, 8192);
    assert.ok(JSON.stringify(messages).length <= 160000);
    return { choices: [{ message: { role: 'assistant', content: 'Derived source outcomes and unresolved work, not canonical quotations.' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };
  return { ctx, files, config: { model: 'same-native-model', allowedTools: ['read'], initialTools: ['read'], contextCompaction: policy }, model, count: () => calls };
}

test('oversized parallel result group is file-backed intact before any summary call', async t => {
  const { ctx, files, config, model } = fixture(t);
  const messages = [{ role: 'system', content: 'Trusted fixed instructions' }, { role: 'user', content: 'Legal assignment' }, ...group('parallel', 3), ...Array.from({ length: 6 }, (_, index) => group(`later-${index}`, 1, 30000)).flat()];
  const original = JSON.stringify(messages);
  const prepared = await prepareCapyModelContext({ ctx, messages, config, model });
  assert.ok(JSON.stringify(prepared.messages).length <= 300000);
  assert.equal(JSON.stringify(messages), original);
  assert.equal(files.size, 1);
  assert.deepEqual(JSON.parse([...files.values()][0]).original_conversation_group, group('parallel', 3));
  assert.match(JSON.stringify(prepared.messages), /file-backed projection/);
  assert.equal(prepared.messages.filter(row => row.role === 'tool').length, 6);
});

test('seven large valid groups adapt retention instead of paying for a doomed summary', async t => {
  const { ctx, config, model, count } = fixture(t);
  const messages = [{ role: 'system', content: 'Trusted fixed instructions' }, { role: 'user', content: 'Legal assignment' }, ...Array.from({ length: 7 }, (_, index) => group(`large-${index}`)).flat()];
  const prepared = await prepareCapyModelContext({ ctx, messages, config, model });
  assert.ok(prepared.compacted);
  assert.ok(JSON.stringify(prepared.messages).length <= 300000);
  assert.ok(count() > 0);
  const assistantIds = new Set(prepared.messages.filter(row => row.role === 'assistant').flatMap(row => row.tool_calls ?? []).map(call => call.id));
  assert.ok(prepared.messages.filter(row => row.role === 'tool').every(row => assistantIds.has(row.tool_call_id)));
  assert.equal(prepared.usage.prompt_tokens, count() * 10);
});

test('immutable projection pointers and summary checkpoints survive another turn and new context', async t => {
  const { ctx, files, config, model, count } = fixture(t);
  const messages = [{ role: 'system', content: 'Fixed system' }, { role: 'user', content: 'Goal' }, ...group('parallel', 3), ...Array.from({ length: 7 }, (_, index) => group(`large-${index}`)).flat()];
  const first = await prepareCapyModelContext({ ctx, messages, config, model });
  const before = count();
  const projection = ctx.store.list('capy_context_groups')[0];
  const restartedCtx = { ...ctx, persistCapyResult: (value, bound) => persistCapyResult(ctx, value, bound) };
  const second = await prepareCapyModelContext({ ctx: restartedCtx, messages, checkpoint: first.checkpoint, config, model });
  assert.equal(count(), before);
  assert.equal(files.size, 1);
  assert.deepEqual(second.checkpoint, first.checkpoint);
  assert.deepEqual(ctx.store.list('capy_context_groups')[0], projection);
});

test('changing adaptive retention reuses eligible old summarized groups instead of paying twice', async t => {
  const { ctx, config } = fixture(t);
  const visited = new Set();
  const model = async messages => {
    const { transcript } = JSON.parse(messages[1].content);
    for (const id of transcript.filter(row => row.role === 'assistant').flatMap(row => row.tool_calls ?? []).map(row => row.id)) {
      assert.ok(!visited.has(id), `Old group ${id} was summarized again`);
      visited.add(id);
    }
    return { choices: [{ message: { role: 'assistant', content: 'Derived safe summary' } }], usage: {} };
  };
  const firstMessages = [{ role: 'system', content: 'Fixed system' }, { role: 'user', content: 'Goal' }, ...Array.from({ length: 7 }, (_, index) => group(`old-${index}`)).flat()];
  const first = await prepareCapyModelContext({ ctx, messages: firstMessages, config, model });
  const nextMessages = [...firstMessages, ...Array.from({ length: 6 }, (_, index) => group(`new-${index}`, 1, 10000)).flat()];
  const next = await prepareCapyModelContext({ ctx, messages: nextMessages, config, checkpoint: first.checkpoint, model });
  assert.notEqual(next.checkpoint.provenance.recentGroups, first.checkpoint.provenance.recentGroups);
  assert.ok(JSON.stringify(next.messages).length <= 300000);
  assert.equal(visited.size, 7);
});

test('a validated cached summary keeps small new coherent results and latest user rules without a summary request', async t => {
  const { ctx, config, model, count } = fixture(t);
  const messages = [{ role: 'system', content: 'Fixed system' }, { role: 'user', content: 'Original goal' }, ...Array.from({ length: 7 }, (_, index) => group(`old-${index}`)).flat()];
  const first = await prepareCapyModelContext({ ctx, messages, config, model });
  const before = count();
  const latestUser = { role: 'user', content: 'Keep the new jurisdiction rule and unresolved work.' };
  const extended = [...messages, latestUser, ...group('small-new-result', 1, 1000)];
  const original = JSON.stringify(extended);
  const next = await prepareCapyModelContext({ ctx, messages: extended, checkpoint: first.checkpoint, config, model });
  assert.equal(count(), before);
  assert.strictEqual(next.checkpoint, first.checkpoint);
  assert.deepEqual(next.usage, {});
  assert.equal(next.compacted, false);
  assert.strictEqual(next.messages[0], messages[0]);
  assert.deepEqual(next.messages.filter(row => row.role === 'user'), [latestUser]);
  assert.deepEqual(next.messages.slice(-2), extended.slice(-2));
  assert.ok(JSON.stringify(next.messages).length <= policy.maxInputChars);
  assert.equal(JSON.stringify(extended), original);
});

test('effective prepared context, not raw history size, triggers incremental compaction at the actual bound', async t => {
  const { ctx, config } = fixture(t);
  const visited = new Set(), inputs = [];
  const model = async input => {
    const payload = JSON.parse(input[1].content);
    inputs.push(payload);
    for (const id of payload.transcript.flatMap(row => row.tool_calls ?? []).map(call => call.id)) {
      assert.ok(!visited.has(id), `Already summarized group ${id} was charged again`);
      visited.add(id);
    }
    return { choices: [{ message: { role: 'assistant', content: 'Derived safe summary' } }], usage: { total_tokens: 12 } };
  };
  const messages = [{ role: 'system', content: 'Fixed system' }, { role: 'user', content: 'Goal' }, ...Array.from({ length: 7 }, (_, index) => group(`old-${index}`)).flat()];
  const first = await prepareCapyModelContext({ ctx, messages, config, model });
  const before = inputs.length, suffix = [];
  let quietTurns = 0, crossed = false;
  for (let index = 0; index < 10; index++) {
    suffix.push(...group(`new-${index}`, 1, 10000));
    const extended = [...messages, ...suffix];
    assert.ok(JSON.stringify(extended).length > policy.maxInputChars);
    const next = await prepareCapyModelContext({ ctx, messages: extended, checkpoint: first.checkpoint, config, model });
    assert.ok(JSON.stringify(next.messages).length <= policy.maxInputChars);
    if (JSON.stringify([...first.messages, ...suffix]).length <= policy.maxInputChars) {
      assert.equal(inputs.length, before);
      assert.strictEqual(next.checkpoint, first.checkpoint);
      assert.deepEqual(next.messages, [...first.messages, ...suffix]);
      assert.deepEqual(next.usage, {});
      quietTurns++;
      continue;
    }
    assert.ok(inputs.length > before);
    assert.ok(next.checkpoint.prefixLength > first.checkpoint.prefixLength);
    assert.equal(inputs[before].previousSummary, first.checkpoint.summary);
    assert.equal(next.usage.total_tokens, (inputs.length - before) * 12);
    assert.equal(visited.size, 7);
    crossed = true;
    break;
  }
  assert.equal(quietTurns, 5);
  assert.equal(crossed, true);
});

test('Capy validates version, complete provenance and source policy before any cached-summary shortcut', async t => {
  const { ctx, config, model } = fixture(t);
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const messages = [{ role: 'system', content: 'Fixed system' }, { role: 'user', content: 'Goal' }, ...Array.from({ length: 7 }, (_, index) => group(`old-${index}`)).flat()];
  const first = await prepareCapyModelContext({ ctx, messages, config, model });
  assert.equal(CAPY_CONTEXT_POLICY_VERSION, 'capy-coherent-context-v2');
  assert.equal(first.checkpoint.provenance.policyFingerprintDigest, null);
  const oldDigest = hash({ policy: config.contextCompaction, allowedTools: config.allowedTools, initialTools: config.initialTools, model: config.model });
  const oldVersionDigest = hash({ version: 'capy-coherent-context-v1', policy: config.contextCompaction, allowedTools: config.allowedTools, initialTools: config.initialTools, model: config.model });
  const changedProvenance = { ...first.checkpoint.provenance, policyDigest: 'incompatible-source-policy' };
  const cases = [
    { checkpoint: { ...first.checkpoint, capyPolicyDigest: oldDigest } },
    { checkpoint: { ...first.checkpoint, capyPolicyDigest: oldVersionDigest } },
    { checkpoint: { ...first.checkpoint, provenance: { ...first.checkpoint.provenance, recentGroups: 1 } } },
    { checkpoint: { ...first.checkpoint, provenance: changedProvenance, provenanceDigest: hash(changedProvenance) } },
    { checkpoint: { ...first.checkpoint, prefixDigest: 'changed-history' } },
    { checkpoint: { ...first.checkpoint, summary: ' ' } },
    { checkpoint: { ...first.checkpoint, summary: 'x'.repeat(policy.maxSummaryChars + 1) } },
    { config: { ...config, allowedTools: ['write'] } },
    { config: { ...config, initialTools: [] } },
    { config: { ...config, model: 'different-model' } },
    { config: { ...config, providerOnly: 'different-provider' } },
    { config: { ...config, corpusWorkspace: '/different-corpus' } },
    { config: { ...config, systemPrompt: 'Changed source instructions' } },
    { config: { ...config, contextCompaction: { ...policy, policyFingerprint: 'new-source-fingerprint' } } },
  ];
  for (const item of cases) {
    const checkpoint = item.checkpoint ?? first.checkpoint, original = JSON.stringify(checkpoint), inputs = [];
    const prepared = await prepareCapyModelContext({ ctx, messages, checkpoint, config: item.config ?? config, model: async input => {
      inputs.push(JSON.parse(input[1].content));
      return { choices: [{ message: { role: 'assistant', content: 'Fresh policy-bound summary' } }] };
    } });
    assert.ok(inputs.length > 0);
    assert.equal(inputs[0].previousSummary, null);
    assert.equal(prepared.compacted, true);
    assert.equal(JSON.stringify(checkpoint), original);
  }
});

test('Capy repairs invalid summaries once with bounded direct instructions and the unchanged historical system array', async t => {
  const { ctx, config } = fixture(t);
  const messages = [{ role: 'system', content: 'Fixed system' }, { role: 'user', content: 'Goal' }, ...Array.from({ length: 7 }, (_, index) => group(`old-${index}`)).flat()];
  let historicalSystem;
  await prepareModelContext({ messages, config: { ...config, contextCompaction: { ...policy, recentGroups: 4 } }, model: async input => {
    historicalSystem = input.filter(row => row.role === 'system');
    return { choices: [{ message: { role: 'assistant', content: 'Historical summary' } }] };
  } });
  for (const [reason, message, finish_reason] of [
    ['empty', { role: 'assistant', content: '  ' }, 'stop'],
    ['truncated', { role: 'assistant', content: 'A short but truncated native summary' }, 'length'],
    ['oversized', { role: 'assistant', content: 'x'.repeat(policy.maxSummaryChars + 1) }, 'stop'],
    ['invalid_message', { role: 'user', content: 'Wrong role' }, 'stop'],
    ['forbidden_tool_call', { role: 'assistant', content: 'Unsafe', tool_calls: [{ id: 'invalid' }] }, 'stop'],
  ]) await t.test(reason, async () => {
    const inputs = [], responses = [];
    const original = JSON.stringify(messages);
    const prepared = await prepareCapyModelContext({ ctx, messages, config, model: async (input, request) => {
      inputs.push(input);
      assert.deepEqual(input.filter(row => row.role === 'system'), historicalSystem);
      assert.ok(JSON.stringify(input).length <= policy.maxSummaryInputChars);
      assert.equal(request.max_tokens, policy.maxSummaryTokens);
      assert.equal(request.reasoning_effort, undefined);
      assert.equal(request.tools, undefined);
      const response = responses.length ? { id: `fixture-accepted-${responses.length}`, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Complete concise summary' } }], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } }
        : { id: 'fixture-rejected', choices: [{ finish_reason, message }], usage: { prompt_tokens: 17, completion_tokens: 8192, total_tokens: 8209, completion_tokens_details: { reasoning_tokens: 7845 } } };
      responses.push(response);
      return response;
    } });
    const first = JSON.parse(inputs[0][1].content), repair = JSON.parse(inputs[1][1].content);
    assert.equal(first.capySummaryContract.repair, null);
    assert.equal(first.capySummaryContract.maximumCharacters, policy.maxSummaryChars);
    assert.equal(first.capySummaryContract.targetCharacters, policy.maxSummaryChars / 2);
    assert.match(first.capySummaryContract.instruction, /directly, without analysis/);
    assert.equal(repair.capySummaryContract.repair.reason, reason);
    assert.deepEqual(repair.transcript, first.transcript);
    assert.equal(repair.previousSummary, first.previousSummary);
    assert.equal(inputs.length, 3);
    assert.deepEqual(prepared.usage, { prompt_tokens: 39, completion_tokens: 8202, total_tokens: 8241 });
    assert.equal(prepared.checkpoint.summary, 'Complete concise summary');
    assert.equal(responses[0].usage.total_tokens, 8209);
    assert.equal(responses[1].usage.total_tokens, 16);
    assert.equal(JSON.stringify(messages), original);
  });
});

test('exhausted Capy repair preserves earlier successful and rejected usage without a partial checkpoint', async t => {
  const { ctx, config } = fixture(t);
  const messages = [{ role: 'system', content: 'Fixed system' }, { role: 'user', content: 'Goal' }, ...Array.from({ length: 7 }, (_, index) => group(`old-${index}`)).flat()];
  const checkpoint = Object.freeze({ summary: 'Unchanged invalid prior checkpoint' }), original = JSON.stringify(messages);
  let calls = 0;
  await assert.rejects(prepareCapyModelContext({ ctx, messages, checkpoint, config, model: async () => {
    calls++;
    return { id: `fixture-${calls}`, choices: [{ finish_reason: calls === 2 ? 'stop' : 'length', message: { role: 'assistant', content: calls === 2 ? 'Valid intermediate summary' : 'Truncated' } }], usage: { prompt_tokens: calls, completion_tokens: 2 * calls, total_tokens: 3 * calls } };
  } }), error => {
    assert.match(error.message, /repair exhausted after 2 attempts \(truncated\)/);
    assert.deepEqual(error.compactionUsage, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
    return true;
  });
  assert.equal(calls, 4);
  assert.equal(JSON.stringify(messages), original);
  assert.deepEqual(checkpoint, { summary: 'Unchanged invalid prior checkpoint' });
});

test('transport failure after a rejected summary keeps only observed usage and the real failure', async t => {
  const { ctx, config } = fixture(t);
  const messages = [{ role: 'system', content: 'Fixed system' }, { role: 'user', content: 'Goal' }, ...Array.from({ length: 7 }, (_, index) => group(`old-${index}`)).flat()];
  const failure = Object.assign(new Error('Actual provider failure'), { inferenceAttempts: [{ outcome: 'connection_lost', usage: null }] });
  let calls = 0;
  await assert.rejects(prepareCapyModelContext({ ctx, messages, config, model: async () => {
    if (++calls === 2) throw failure;
    return { choices: [{ message: { role: 'assistant', content: '' } }], usage: { total_tokens: 8192 } };
  } }), error => {
    assert.strictEqual(error, failure);
    assert.deepEqual(error.compactionUsage, { total_tokens: 8192 });
    assert.deepEqual(error.inferenceAttempts, [{ outcome: 'connection_lost', usage: null }]);
    return true;
  });
  assert.equal(calls, 2);
});
