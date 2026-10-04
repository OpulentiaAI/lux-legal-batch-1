import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';
import { createBroadHarness } from '../broad-legal-eval.mjs';
import { renderInstructions } from '../instructions/render.mjs';
import { rlmDefinitionsFor, RLM_HANDOFF_LIMITS } from '../rlm.mjs';
import { checkpointFor, parseOptions } from '../../eval/complex-v1/run.mjs';

const profile = 'opulent-delivery-v12';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const workspace = resolve(new URL('../..', import.meta.url).pathname);

test('delivery v12 retains the complete professional foundation and binds its operational layers', () => {
  const foundation = renderInstructions({ profile: 'opulent-professional-v1' });
  const current = renderInstructions({ profile });
  assert(current.systemPrompt.startsWith(`${foundation.systemPrompt}\n\n`));
  assert.equal(current.provenance.foundationProfile, 'opulent-professional-v1');
  assert.equal(current.provenance.foundationEffectivePromptSha256, foundation.provenance.effectivePromptSha256);
  assert.equal(current.provenance.foundationManifestSha256, foundation.provenance.manifestSha256);
  assert.equal(current.provenance.handoffPolicy, 'rlm-handoff-packed-v1');
  assert.equal(current.provenance.effectivePromptSha256, sha256(current.systemPrompt));
  for (const layer of current.provenance.operationalLayers) {
    const text = readFileSync(new URL(`../instructions/${layer.file}`, import.meta.url), 'utf8').trimEnd();
    assert.equal(sha256(text), layer.sha256);
    assert(current.systemPrompt.includes(text));
  }
  assert.match(current.systemPrompt, /one protected receipt per cell/i);
  const withAppendix = renderInstructions({ profile, appendix: 'Synthetic task attachment boundary' });
  assert(withAppendix.systemPrompt.startsWith(`${current.systemPrompt}\n\n`));
  assert.equal(withAppendix.systemPrompt.match(/Synthetic task attachment boundary/g).length, 1);
});

test('delivery v12 wires identical capabilities and budgets with explicitly packed handoff config', async () => {
  const input = { workspace, corpus: { directory: '/safe/export', hash: 'fixture-corpus', count: 1,
    sources: [{ id: 'fixture:one', doc: 'fixture', text: 'Synthetic source.', path: 'chunks/fixture:one.txt' }] },
    instructionProfile: profile, inferenceProvider: 'runanywhere', model: 'xiaomi/mimo-v2.6-pro', providerModel: 'mimo-v2.6-pro',
    semanticSurface: 'toolbox', toolSurface: 'initial-scripted-v1', sandboxTemplate: 'fixture-approved-template',
    computerImageSha256: 'b'.repeat(64), workProduct: { maxCompletionTokens: 32768 }, maxSteps: 1000 };
  const configs = [];
  const halt = new Error('Fixture stops before a provider call');
  const runtimeFactory = options => { configs.push(options.config); throw halt; };
  const current = createBroadHarness({ ...input, runtimeFactory });
  const previous = createBroadHarness({ ...input, runtimeFactory, instructionProfile: 'opulent-delivery-v11' });
  assert.equal(current.provenance.delivery.rlmHandoffPolicy, 'rlm-handoff-packed-v1');
  assert.equal(current.provenance.delivery.emptyFinalRecovery, 'same-session-empty-final-v1');
  assert.deepEqual(current.provenance.delivery.handoff.limits, RLM_HANDOFF_LIMITS);
  for (const key of ['allowedTools', 'initialTools', 'runtimeCapabilities', 'retrieval', 'excludedCategories', 'networkPolicy',
    'maxSteps', 'maxCompletionTokens', 'sandboxTimeoutMs', 'modelRequestTimeoutMs', 'inference']) {
    assert.deepEqual(current.provenance[key], previous.provenance[key], key);
  }
  assert.deepEqual(current.provenance.delivery.computer, previous.provenance.delivery.computer);
  await assert.rejects(current.preflight(), error => error === halt);
  await assert.rejects(previous.preflight(), error => error === halt);
  assert.equal(configs[0].rlmHandoffPolicy, 'rlm-handoff-packed-v1');
  assert.equal(configs[1].rlmHandoffPolicy, 'rlm-handoff-v1');
  assert.equal(configs[0].instructionProfile, profile);
  assert.equal(configs[0].scriptTopLevelAwait, true);
  assert.match(rlmDefinitionsFor(configs[0]).ipython.description, /records array/);
  assert.match(rlmDefinitionsFor(configs[0]).ipython.description, /wait_for_operations/);
  assert.throws(() => createBroadHarness({ ...input, inferenceProvider: 'gateway', providerModel: undefined }), /requires native/);
});

test('delivery v12 remains an explicit native experiment with incompatible prior checkpoints', () => {
  const args = ['--tasks', 'task-03', '--output', '/tmp/synthetic-v12', '--harvey-root', '/tmp/harvey',
    '--python', '/tmp/python', '--native-module', '/tmp/native.mjs', '--broker-origin', 'https://broker.example.org',
    '--broker-port', '8788', '--sandbox-template', 'fixture-approved-template', '--computer-image-sha256', 'b'.repeat(64)];
  assert.equal(parseOptions(args).instructionProfile, 'opulent-prepared-v2');
  assert.throws(() => parseOptions([...args, '--instruction-profile', profile]), /requires native/);
  const current = parseOptions([...args, '--instruction-profile', profile, '--model-profile', 'runanywhere-mimo-v2.6-pro']);
  assert.equal(current.instructionProfile, profile);
  const original = { selectedTasks: ['task-03'], instructionProfile: 'opulent-delivery-v11',
    deliveryPolicy: { rlmHandoffPolicy: 'rlm-handoff-v1' } };
  const checkpoint = checkpointFor(original);
  assert.throws(() => checkpointFor({ ...original, instructionProfile: profile,
    deliveryPolicy: { rlmHandoffPolicy: 'rlm-handoff-packed-v1' } }, checkpoint), /provenance|config|mismatch/i);
});

test('delivery v12 rejects empty finals and invalid schema candidates before real completion', async () => {
  let requests = 0;
  const values = [null, 'invalid-json', '{"result":"completed"}'];
  const schema = { type: 'object', required: ['result'], additionalProperties: false, properties: { result: { type: 'string' } } };
  const runtime = createRuntime({ store: createStore(':memory:'), config: { instructionProfile: profile, maxSteps: 3 },
    model: async () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: values[requests++] } }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }) });
  try {
    const session = await runtime.startSession({ prompt: 'Synthetic complete structured response', schema });
    const result = await runtime.waitSession(session.id);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.output, { result: 'completed' });
    assert.equal(result.steps, 3);
    assert.equal(requests, 3);
    assert.equal(result.usage.prompt_tokens, 21);
    assert.equal(runtime.store.list('sessions').length, 1);
    assert.equal(runtime.store.list('events').filter(event => event.type === 'empty_final_response_rejected').length, 1);
    assert.equal(runtime.store.list('events').filter(event => event.type === 'structured_output_rejected').length, 1);
  } finally { await runtime.close(); }
});
