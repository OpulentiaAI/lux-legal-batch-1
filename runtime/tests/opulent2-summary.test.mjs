import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import '../../eval/opulent2-fixed/offline-guard.mjs';
import { CAPY_CONTEXT_POLICY_VERSION, prepareCapyModelContext } from '../capy-context.mjs';
import { createStore } from '../store.mjs';

const policy = Object.freeze({ enabled: true, maxInputChars: 300000, maxSummaryInputChars: 300000, maxSummaryChars: 24000,
  maxSummaryTokens: 8192, recentGroups: 3, maxBatches: 32 });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const originalUsage = { prompt_tokens: 17, completion_tokens: 8192, total_tokens: 8209 };
const repairUsage = { prompt_tokens: 19, completion_tokens: 6, total_tokens: 25 };
const totalUsage = { prompt_tokens: 36, completion_tokens: 8198, total_tokens: 8234 };
const response = (content, finish_reason = 'stop', usage = repairUsage) => ({ choices: [{ finish_reason, message: { role: 'assistant', content } }], usage });
const truncated = () => response('Native truncation', 'length', originalUsage);

function fixture(t, overrides = {}, count = 5) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const requests = [];
  const ctx = { store, sessionId: 'summary-test', persistCapyResult: () => { throw new Error('Unexpected projection or VM operation'); }, emit: () => {} };
  const config = { model: 'same-native-model', allowedTools: ['read'], initialTools: ['read'], contextCompaction: policy,
    instructionProfile: 'opulent2-fixed-v1', ...overrides };
  const messages = [{ role: 'system', content: 'Fixed summary system instructions.' },
    { role: 'user', content: 'Resolve conditional alternatives without inventing whether the exception is satisfied.' },
    ...Array.from({ length: count }, (_, index) => [
      { role: 'assistant', content: null, tool_calls: [{ id: `source-${index}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: `corpus/source-${index}.md` }) } }] },
      { role: 'tool', tool_call_id: `source-${index}`, content: `Source ${index} allows X only if approval is confirmed; another source conflicts. Approval is unknown. Refer to corpus/source-${index}.md.`.padEnd(60000, '.') },
    ]).flat()];
  const model = generate => async (input, request) => {
    requests.push({ messages: structuredClone(input), request: { ...request } });
    assert.equal(request.model, config.model);
    assert.equal(request.max_tokens, 8192);
    assert.equal(request.tools, undefined);
    assert.equal(request.reasoning_effort, undefined);
    assert.ok(JSON.stringify(input).length <= config.contextCompaction.maxSummaryInputChars);
    return generate(requests.length, input);
  };
  return { ctx, config, messages, requests, model };
}

test('Opulent2 requests a preferred-size repair with the original hard limit and full unchanged input', async t => {
  const f = fixture(t), before = JSON.stringify(f.messages), configBefore = JSON.stringify(f.config);
  const completed = 'Alternatives depend on unknown approval; conflicting sources remain unresolved, see corpus/source-0.md.'.padEnd(12000, '.');
  const prepared = await prepareCapyModelContext({ ...f, model: f.model(call => call === 1 ? truncated() : response(completed)) });
  assert.equal(f.requests.length, 2);
  const first = JSON.parse(f.requests[0].messages[1].content), repair = JSON.parse(f.requests[1].messages[1].content);
  assert.equal(first.capySummaryContract.maximumCharacters, 24000);
  assert.equal(first.capySummaryContract.targetCharacters, 12000);
  assert.equal(first.capySummaryContract.preferredMaximumCharacters, undefined);
  assert.equal(first.capySummaryContract.repair, null);
  assert.equal(repair.capySummaryContract.maximumCharacters, 24000);
  assert.equal(repair.capySummaryContract.preferredMaximumCharacters, 12000);
  assert.equal(repair.capySummaryContract.targetCharacters, 6000);
  assert.equal(repair.capySummaryContract.repair.reason, 'truncated');
  assert.match(repair.capySummaryContract.repair.instruction, /preferences, not hard limits/);
  assert.match(repair.capySummaryContract.repair.instruction, /maximumCharacters remains the hard limit/);
  for (const request of f.requests) {
    const contract = JSON.parse(request.messages[1].content).capySummaryContract;
    assert.equal(contract.maximumOutputTokens, 8192);
    assert.match(contract.instruction, /decisive alternatives, conditions, explicit conflicts and uncertainty/);
    assert.match(contract.instruction, /Unknown facts must remain unknown, not become negative facts/);
    assert.match(contract.instruction, /evidence references and unresolved source questions to invented resolutions/);
  }
  assert.deepEqual(repair.transcript, first.transcript);
  assert.deepEqual(first.transcript, f.messages.slice(1, 6));
  assert.equal(first.previousSummary, null);
  assert.equal(repair.previousSummary, first.previousSummary);
  assert.deepEqual(f.requests[1].messages[0], f.requests[0].messages[0]);
  assert.deepEqual(f.requests[1].request, f.requests[0].request);
  assert.deepEqual(prepared.usage, totalUsage);
  assert.equal(prepared.checkpoint.summary, completed);
  assert.equal(prepared.compacted, true);
  assert.equal(JSON.stringify(f.messages), before);
  assert.equal(JSON.stringify(f.config), configBefore);
  assert.equal(f.ctx.store.list('capy_context_groups').length, 0);
});

test('Opulent2 still fails closed after exactly two attempts when the repair violates original safety bounds', async t => {
  for (const [reason, invalid] of [
    ['truncated', response('A short but still truncated repair', 'length')],
    ['oversized', response('x'.repeat(24001))],
    ['empty', response('  ')],
    ['invalid_message', response(null)],
    ['invalid_message', { choices: [{ finish_reason: 'stop', message: { role: 'user', content: 'Wrong role' } }], usage: repairUsage }],
    ['forbidden_tool_call', { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Unsafe', tool_calls: [{ id: 'unsafe' }] } }], usage: repairUsage }],
    ['forbidden_tool_call', { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Unsafe', function_call: { name: 'read' } } }], usage: repairUsage }],
  ]) await t.test(reason, async t => {
    const f = fixture(t), before = JSON.stringify(f.messages);
    const checkpoint = Object.freeze({ summary: 'Untouched invalid prior checkpoint' });
    await assert.rejects(prepareCapyModelContext({ ...f, checkpoint, model: f.model(call => call === 1 ? truncated() : invalid) }), error => {
      assert.match(error.message, new RegExp(`repair exhausted after 2 attempts \\(${reason}\\)`));
      assert.deepEqual(error.compactionUsage, totalUsage);
      return true;
    });
    assert.equal(f.requests.length, 2);
    assert.equal(JSON.stringify(f.messages), before);
    assert.deepEqual(checkpoint, { summary: 'Untouched invalid prior checkpoint' });
  });
});

test('every rejected first-attempt shape selects the preferred Opulent2 repair contract', async t => {
  for (const [reason, invalid] of [
    ['empty', response('')], ['oversized', response('x'.repeat(24001))], ['invalid_message', response(null)],
    ['forbidden_tool_call', { choices: [{ message: { role: 'assistant', content: 'Unsafe', tool_calls: [{ id: 'unsafe' }] } }], usage: repairUsage }],
  ]) await t.test(reason, async t => {
    const f = fixture(t);
    const prepared = await prepareCapyModelContext({ ...f, model: f.model(call => call === 1 ? invalid : response('Complete concise summary.')) });
    const contract = JSON.parse(f.requests[1].messages[1].content).capySummaryContract;
    assert.equal(contract.maximumCharacters, 24000);
    assert.equal(contract.preferredMaximumCharacters, 12000);
    assert.equal(contract.targetCharacters, 6000);
    assert.equal(contract.repair.reason, reason);
    assert.equal(f.requests.length, 2);
    assert.equal(prepared.checkpoint.summary, 'Complete concise summary.');
  });
});

test('completed Opulent2 repairs above the preferred maximum remain valid through the original hard limit', async t => {
  for (const length of [12001, 16911, 24000]) await t.test(String(length), async t => {
    const f = fixture(t), completed = 'Complete conditional summary with source references and unresolved conflicts.'.padEnd(length, '.');
    const prepared = await prepareCapyModelContext({ ...f, model: f.model(call => call === 1 ? truncated() : response(completed)) });
    assert.equal(f.requests.length, 2);
    assert.equal(prepared.checkpoint.summary, completed);
    assert.equal(prepared.checkpoint.summary.length, length);
    assert.deepEqual(prepared.usage, totalUsage);
    const cached = await prepareCapyModelContext({ ...f, checkpoint: prepared.checkpoint, model: f.model(() => {
      throw new Error('A valid complete summary above the preference must remain reusable');
    }) });
    assert.equal(f.requests.length, 2);
    assert.strictEqual(cached.checkpoint, prepared.checkpoint);
    assert.deepEqual(cached.usage, {});
  });
});

test('the first completed Opulent2 attempt retains its original full summary bound', async t => {
  const f = fixture(t), completed = 'A'.repeat(24000);
  const prepared = await prepareCapyModelContext({ ...f, model: f.model(() => response(completed)) });
  assert.equal(f.requests.length, 1);
  assert.equal(prepared.checkpoint.summary, completed);
  assert.deepEqual(prepared.usage, repairUsage);
});

test('Opulent2 keeps all earlier and rejected usage while resetting first-attempt bounds for each complete batch', async t => {
  const f = fixture(t, { contextCompaction: { ...policy, maxSummaryInputChars: 160000 } }, 7);
  const before = JSON.stringify(f.messages);
  await assert.rejects(prepareCapyModelContext({ ...f, model: f.model(call => response(call === 2 ? 'Valid intermediate summary.' : 'Truncated',
    call === 2 ? 'stop' : 'length', { prompt_tokens: call, completion_tokens: 2 * call, total_tokens: 3 * call })) }), error => {
    assert.match(error.message, /repair exhausted after 2 attempts \(truncated\)/);
    assert.deepEqual(error.compactionUsage, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
    return true;
  });
  assert.equal(f.requests.length, 4);
  const inputs = f.requests.map(request => JSON.parse(request.messages[1].content));
  const contracts = inputs.map(input => input.capySummaryContract);
  assert.deepEqual(contracts.map(contract => contract.maximumCharacters), [24000, 24000, 24000, 24000]);
  assert.deepEqual(contracts.map(contract => contract.preferredMaximumCharacters), [undefined, 12000, undefined, 12000]);
  assert.deepEqual(contracts.map(contract => contract.targetCharacters), [12000, 6000, 12000, 6000]);
  assert.deepEqual(contracts.map(contract => contract.repair?.reason ?? null), [null, 'truncated', null, 'truncated']);
  assert.deepEqual(inputs[1].transcript, inputs[0].transcript);
  assert.deepEqual(inputs[3].transcript, inputs[2].transcript);
  assert.equal(inputs[2].previousSummary, 'Valid intermediate summary.');
  assert.equal(inputs[3].previousSummary, inputs[2].previousSummary);
  assert.equal(JSON.stringify(f.messages), before);
});

test('historical and nonexact profiles retain their proved pre-change request bytes, cache digest and repair behavior', async t => {
  for (const instructionProfile of [undefined, 'opulent-capy-v1', 'opulent-delivery-v12', 'opulent2-fixed-v2', 'opulent2-fixed-v1-extra']) await t.test(String(instructionProfile), async t => {
    const f = fixture(t, { instructionProfile, runtimeCapabilities: ['capy-v1'] });
    const completed = 'H'.repeat(18000);
    const prepared = await prepareCapyModelContext({ ...f, model: f.model(call => call === 1 ? truncated() : response(completed)) });
    assert.equal(f.requests.length, 2);
    assert.equal(hash(f.requests), 'acadb70d59c8689167aa0e50a054bc2929fe9825bf088323226e11e51aeb5992');
    assert.deepEqual(f.requests.map(hash), ['ad46a2223d1dce948ca576d9fc060f38897a5a56c7c68f34881fad181903708e',
      'f8ef076a6a0d72203696e0cb7d3ac5a87f164c63ea5717086df56522bf2e5f4d']);
    assert.equal(prepared.checkpoint.capyPolicyDigest, '47f2d2568e647a36a2dc0e6b6fde793141dc0f500891f8dcad5384e7a15490e9');
    for (const request of f.requests) {
      const contract = JSON.parse(request.messages[1].content).capySummaryContract;
      assert.equal(contract.maximumCharacters, 24000);
      assert.equal(contract.preferredMaximumCharacters, undefined);
      assert.equal(contract.targetCharacters, 12000);
      assert.doesNotMatch(contract.instruction, /decisive alternatives|negative facts/);
    }
    assert.equal(prepared.checkpoint.summary, completed);
    assert.deepEqual(prepared.usage, totalUsage);
  });
});

test('Opulent2 cache provenance includes its chosen repair policy and cannot reuse a historical summary', async t => {
  const f = fixture(t, { instructionProfile: 'opulent-capy-v1' });
  const model = f.model(() => response('Complete conditional summary.'));
  const historical = await prepareCapyModelContext({ ...f, model });
  const count = f.requests.length;
  const config = { ...f.config, instructionProfile: 'opulent2-fixed-v1' };
  const current = await prepareCapyModelContext({ ...f, config, model, checkpoint: historical.checkpoint });
  assert.equal(f.requests.length, count + 1);
  assert.equal(JSON.parse(f.requests[count].messages[1].content).previousSummary, null);
  assert.notEqual(current.checkpoint.capyPolicyDigest, historical.checkpoint.capyPolicyDigest);
  assert.equal(current.checkpoint.capyPolicyDigest, hash({ version: CAPY_CONTEXT_POLICY_VERSION, policy, allowedTools: config.allowedTools,
    initialTools: config.initialTools, model: config.model, providerOnly: config.providerOnly, corpusWorkspace: config.corpusWorkspace,
    systemPrompt: config.systemPrompt, summaryRepairPolicy: { version: 'opulent2-summary-repair-v2', attempts: 2, preferredMaximumCharacters: 12000,
      targetCharacters: 6000, instruction: 'Preserve decisive alternatives, conditions, explicit conflicts and uncertainty. Unknown facts must remain unknown, not become negative facts. Prefer evidence references and unresolved source questions to invented resolutions.' } }));
  const cached = await prepareCapyModelContext({ ...f, config, model, checkpoint: current.checkpoint });
  assert.equal(f.requests.length, count + 1);
  assert.strictEqual(cached.checkpoint, current.checkpoint);
  assert.deepEqual(cached.usage, {});
});

test('transport failure on Opulent2 repair preserves observed usage and the actual provider error without a third attempt', async t => {
  const f = fixture(t), failure = Object.assign(new Error('Offline fixture transport failure'), { inferenceAttempts: [{ outcome: 'connection_lost', usage: null }] });
  await assert.rejects(prepareCapyModelContext({ ...f, model: f.model(call => {
    if (call === 2) throw failure;
    return truncated();
  }) }), error => {
    assert.strictEqual(error, failure);
    assert.deepEqual(error.compactionUsage, originalUsage);
    assert.deepEqual(error.inferenceAttempts, [{ outcome: 'connection_lost', usage: null }]);
    return true;
  });
  assert.equal(f.requests.length, 2);
});
