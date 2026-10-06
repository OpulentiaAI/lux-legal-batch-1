import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareCapyModelContext } from '../capy-context.mjs';

const policy = { enabled: true, maxInputChars: 300000, maxSummaryInputChars: 160000,
  maxSummaryChars: 24000, maxSummaryTokens: 8192, recentGroups: 3, maxBatches: 8 };
const config = { instructionProfile: 'opulent2-fixed-v1', model: 'same-native-model', contextCompaction: policy };
const hash = value => createHash('sha256').update(value).digest('hex');
const messages = () => [{ role: 'system', content: 'Fixed system' }, { role: 'user', content: 'Original assignment' },
  ...Array.from({ length: 6 }, (_, i) => [
    { role: 'assistant', content: `Decision ${i}`, reasoning: `Plain reasoning ${i}`,
      reasoning_details: [{ type: 'reasoning.summary', summary: `Plain summary ${i}` },
        { type: 'reasoning.encrypted', format: 'openai-responses-v1', data: `${i}${'cipher'.repeat(6000)}`, id: `rs-${i}`, index: 0 }],
      provider_metadata: { openai: { responseId: `response-${i}` }, gateway: { routing: 'routing'.repeat(1400) }, other: { retained: true } },
      tool_calls: [{ id: `call-${i}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: `/source-${i}` }) } }] },
    { role: 'tool', tool_call_id: `call-${i}`, content: `Actual source ${i}: ${'evidence'.repeat(1500)}` },
  ]).flat()];
const fixture = () => {
  const inputs = [];
  const model = async (input, request) => {
    assert.equal(request.max_tokens, 8192);
    assert(JSON.stringify(input).length <= policy.maxSummaryInputChars);
    inputs.push(input);
    return { choices: [{ message: { role: 'assistant', content: 'Derived summary; reopen decisive sources.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };
  return { ctx: { sessionId: 'summary-test', workspace: '/vm/workspace' }, model, inputs };
};

test('Opulent2 summary view omits only known opaque reasoning and routing, retaining complete observations', async () => {
  const { ctx, model, inputs } = fixture();
  const original = messages(), bytes = JSON.stringify(original);
  const result = await prepareCapyModelContext({ ctx, messages: original, config, model });
  assert.equal(inputs.length, 1);
  const transcript = JSON.parse(inputs[0][1].content).transcript;
  for (const message of transcript) {
    const source = original.find(row => row.role === message.role && (row.tool_call_id
      ? row.tool_call_id === message.tool_call_id : row.content === message.content));
    assert(source);
    if (message.role !== 'assistant') { assert.deepEqual(message, source); continue; }
    assert.deepEqual(message.tool_calls, source.tool_calls);
    assert.equal(message.reasoning, source.reasoning);
    assert.deepEqual(message.reasoning_details[0], source.reasoning_details[0]);
    assert.deepEqual(message.provider_metadata.openai, source.provider_metadata.openai);
    assert.deepEqual(message.provider_metadata.other, source.provider_metadata.other);
    assert.equal(message.provider_metadata.gateway, undefined);
    const detail = message.reasoning_details[1], originalDetail = source.reasoning_details[1];
    assert.equal(detail.data_sha256, hash(originalDetail.data));
    assert.equal(detail.data_characters, originalDetail.data.length);
    assert.match(detail.data, /Opaque provider reasoning omitted/);
    assert.equal(detail.id, originalDetail.id);
  }
  assert.deepEqual(result.messages.slice(-6), original.slice(-6));
  assert.equal(JSON.stringify(original), bytes);
  assert.equal(result.checkpoint.prefixDigest, hash(JSON.stringify(original.slice(0, result.checkpoint.prefixLength))));
  assert(JSON.stringify(result.messages).length <= policy.maxInputChars);
  assert.equal(result.usage.prompt_tokens, 10);
});

test('historical compaction retains its exact input view and requires more batches for the same synthetic history', async () => {
  const { ctx, model, inputs } = fixture();
  await prepareCapyModelContext({ ctx, messages: messages(), config: { ...config, instructionProfile: 'historical-profile' }, model });
  assert(inputs.length > 1);
  const transcript = inputs.flatMap(input => JSON.parse(input[1].content).transcript);
  assert(transcript.some(row => row.provider_metadata?.gateway));
  assert(transcript.some(row => row.reasoning_details?.some(detail => detail.data?.includes('cipher'))));
});

test('unknown reasoning formats and provider metadata outside the known routing field remain intact', async () => {
  const { ctx, model, inputs } = fixture();
  const original = messages();
  original[2].reasoning_details.push({ type: 'reasoning.encrypted', format: 'unknown-provider', data: 'retain-exactly' });
  original[3].provider_metadata = { gateway: { legalEvidence: 'tool data must remain' } };
  await prepareCapyModelContext({ ctx, messages: original, config, model });
  const transcript = JSON.parse(inputs[0][1].content).transcript;
  assert.deepEqual(transcript.find(row => row.role === 'assistant').reasoning_details[2], original[2].reasoning_details[2]);
  assert.deepEqual(transcript.find(row => row.tool_call_id === 'call-0'), original[3]);
});

test('changing original opaque bytes invalidates the summary checkpoint despite an unchanged semantic view', async () => {
  const { ctx, model, inputs } = fixture();
  const original = messages();
  const first = await prepareCapyModelContext({ ctx, messages: original, config, model });
  await prepareCapyModelContext({ ctx, messages: original, checkpoint: first.checkpoint, config, model });
  assert.equal(inputs.length, 1);
  original[2].reasoning_details[1].data = original[2].reasoning_details[1].data.replace('cipher', 'change');
  await prepareCapyModelContext({ ctx, messages: original, checkpoint: first.checkpoint, config, model });
  assert.equal(inputs.length, 2);
});

test('a summary transport failure remains fatal instead of becoming an externalized success', async () => {
  const failure = new Error('Actual transport failure');
  await assert.rejects(prepareCapyModelContext({ ctx: fixture().ctx, messages: messages(), config,
    model: async () => { throw failure; } }), error => error === failure);
});
