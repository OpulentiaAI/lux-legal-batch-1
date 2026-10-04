import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBroadHarness } from '../broad-legal-eval.mjs';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';
import { renderInstructions } from '../instructions/render.mjs';
import { parseOptions } from '../../eval/complex-v1/run.mjs';
import { rlmDefinitionsFor } from '../rlm.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const workspace = resolve(new URL('../..', import.meta.url).pathname);
const corpus = { directory: '/safe/export', hash: 'test-corpus', count: 1,
  sources: [{ id: 'law:a', doc: 'law', text: 'Legal text.', path: 'chunks/law:a.txt' }] };

test('delivery v10 adds an audited optimization layer without changing v9', () => {
  const old = renderInstructions({ profile: 'opulent-delivery-v9' });
  const current = renderInstructions({ profile: 'opulent-delivery-v10' });
  assert(current.systemPrompt.startsWith(`${old.systemPrompt}\n\n`));
  assert.equal(current.provenance.inheritedV9EffectivePromptSha256, old.provenance.effectivePromptSha256);
  assert.equal(current.provenance.inheritedV9ManifestSha256, old.provenance.manifestSha256);
  assert.equal(current.provenance.effectivePromptSha256, sha256(current.systemPrompt));
  assert.equal(current.provenance.manifestSha256, sha256(readFileSync(new URL('../instructions/manifest-opulent-delivery-v10.json', import.meta.url))));
  assert.equal(current.provenance.handoffPolicy, old.provenance.handoffPolicy);
  assert.match(current.systemPrompt, /requirement-to-deliverable matrix/);
  assert.match(current.systemPrompt, /There is no new tool, child, concurrency or research quota/);
});

test('delivery v10 retains native inference, full tools and prepared desktop protections', () => {
  const config = { workspace, corpus, instructionProfile: 'opulent-delivery-v10', inferenceProvider: 'runanywhere',
    model: 'xiaomi/mimo-v2.6-pro', providerModel: 'mimo-v2.6-pro', semanticSurface: 'toolbox',
    toolSurface: 'initial-scripted-v1', sandboxTemplate: 'approved-template', computerImageSha256: 'a'.repeat(64),
    workProduct: { maxCompletionTokens: 32768 }, maxSteps: 1000 };
  const harness = createBroadHarness(config);
  const previous = createBroadHarness({ ...config, instructionProfile: 'opulent-delivery-v9' });
  assert.equal(harness.provenance.policy, 'broad-legal-native-delivery-v10');
  assert.equal(harness.provenance.delivery.version, 'opulent-delivery-v10');
  assert.equal(harness.provenance.delivery.rlmHandoffPolicy, 'rlm-handoff-v1');
  assert.deepEqual(harness.provenance.rlm.settings, previous.provenance.rlm.settings);
  assert.equal(harness.provenance.maxCompletionTokens, 32768);
  assert.throws(() => createBroadHarness({ ...config, inferenceProvider: 'gateway', providerModel: undefined }), /requires native/);
  assert.throws(() => createBroadHarness({ ...config, computerImageSha256: undefined }), /approved prepared desktop/);
});

test('delivery v10 keeps a delegated child on its bounded schema', async () => {
  const seen = [];
  const runtime = createRuntime({ store: createStore(':memory:'), config: { instructionProfile: 'opulent-delivery-v10' }, model: async messages => {
    seen.push(messages);
    return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: messages[0].content.includes('Return final output as JSON matching:') ? '{"finding":"Bounded research"}' : 'Lead work' } }] };
  } });
  try {
    const parent = await runtime.startSession({ prompt: 'Lead assignment' });
    assert.equal((await runtime.waitSession(parent.id)).status, 'completed');
    const schema = { type: 'object', additionalProperties: false, required: ['finding'], properties: { finding: { type: 'string' } } };
    const child = await runtime.context(parent.id).startSession({ prompt: 'Bounded question', schema });
    assert.deepEqual((await runtime.waitSession(child.id)).output, { finding: 'Bounded research' });
    assert.match(seen[1][0].content, /You are a delegated child, not the lead coordinator/);
    assert(seen[1][0].content.endsWith(`Return final output as JSON matching: ${JSON.stringify(schema)}`));
  } finally { await runtime.close(); }
});

test('delivery v10 runner accepts only its native comparison model', () => {
  const args = ['--tasks', 'task-03', '--output', '/tmp/v10-output', '--harvey-root', '/tmp/harvey', '--python', '/tmp/python',
    '--native-module', '/tmp/native.mjs', '--broker-origin', 'https://broker.example.org', '--broker-port', '8788',
    '--sandbox-template', 'prepared-template', '--computer-image-sha256', 'a'.repeat(64),
    '--instruction-profile', 'opulent-delivery-v10', '--model-profile', 'modal-deepseek-v4.1-flash'];
  assert.throws(() => parseOptions(args), /requires native/);
});

test('delivery v10 advertises actual async, wait and snapshot contracts without changing v9 definitions', () => {
  const current = rlmDefinitionsFor({ instructionProfile: 'opulent-delivery-v10', rlmHandoffPolicy: 'rlm-handoff-v1' });
  assert.match(current.ipython.description, /asynchronous methods require await/);
  assert.match(current.ipython.description, /nonblocking status\/output read/);
  assert.match(current.ipython.description, /exact snapshot_id readback/);
  assert(!current.ipython.description.includes('Long output is saved to the returned overflow_path'));
  assert.deepEqual(rlmDefinitionsFor({ instructionProfile: 'opulent-delivery-v9', rlmHandoffPolicy: 'rlm-handoff-v1' }), rlmDefinitionsFor({ rlmHandoffPolicy: 'rlm-handoff-v1' }));
});

for (const candidate of ['Prose before ```json\n{"finding":"Exact quotation"}\n```', '{"wrong":"field"}']) {
  test('delivery v10 repairs a rejected schema candidate in the same child and preserves its audit', async () => {
    const seen = [];
    const runtime = createRuntime({ store: createStore(':memory:'), config: { instructionProfile: 'opulent-delivery-v10', maxSteps: 3 }, model: async messages => {
      seen.push(structuredClone(messages));
      return { usage: { completion_tokens: 7 }, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: seen.length === 1 ? candidate : '{"finding":"Exact quotation"}' } }] };
    } });
    try {
      const schema = { type: 'object', additionalProperties: false, required: ['finding'], properties: { finding: { type: 'string' } } };
      const session = await runtime.startSession({ prompt: 'Return bounded evidence', schema });
      const result = await runtime.waitSession(session.id);
      assert.equal(result.status, 'completed');
      assert.deepEqual(result.output, { finding: 'Exact quotation' });
      assert.equal(result.steps, 2);
      assert.equal(result.usage.completion_tokens, 14);
      assert.equal(runtime.store.list('sessions').length, 1);
      assert.equal(runtime.store.list('events').filter(e => e.type === 'structured_output_rejected').length, 1);
      assert(seen[1].some(m => m.role === 'assistant' && m.content === candidate));
      assert.equal(seen[1].at(-1).role, 'user');
      assert.match(seen[1].at(-1).content, /was not accepted/);
    } finally { await runtime.close(); }
  });
}

test('delivery v10 never accepts token-exhausted partial schema output', async () => {
  let calls = 0;
  const runtime = createRuntime({ store: createStore(':memory:'), config: { instructionProfile: 'opulent-delivery-v10', maxSteps: 2 }, model: async () => ({
    choices: [{ finish_reason: ++calls === 1 ? 'length' : 'stop', message: { role: 'assistant', content: calls === 1 ? '{"finding":' : '{"finding":"Complete evidence"}' } }],
  }) });
  try {
    const schema = { type: 'object', required: ['finding'], properties: { finding: { type: 'string' } } };
    const session = await runtime.startSession({ prompt: 'Return evidence', schema });
    const result = await runtime.waitSession(session.id);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.output, { finding: 'Complete evidence' });
    assert.equal(result.steps, 2);
    assert.equal(runtime.store.list('events').filter(e => e.type === 'structured_output_rejected').length, 1);
  } finally { await runtime.close(); }
});

test('delivery v10 schema recovery cannot extend the existing step budget', async () => {
  const runtime = createRuntime({ store: createStore(':memory:'), config: { instructionProfile: 'opulent-delivery-v10', maxSteps: 1 }, model: async () => ({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Not JSON' } }],
  }) });
  try {
    const session = await runtime.startSession({ prompt: 'Return evidence', schema: { type: 'object' } });
    const result = await runtime.waitSession(session.id);
    assert.notEqual(result.status, 'completed');
    assert.equal(result.steps, 1);
    assert.equal(result.output, undefined);
  } finally { await runtime.close(); }
});
