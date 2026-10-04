import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';
import { createModel } from '../model.mjs';
import { createBroadHarness } from '../broad-legal-eval.mjs';
import { renderInstructions } from '../instructions/render.mjs';
import { rlmDefinitionsFor } from '../rlm.mjs';
import { checkpointFor, parseOptions } from '../../eval/complex-v1/run.mjs';

const profile = 'opulent-delivery-v11';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const schema = { type: 'object', additionalProperties: false, required: ['finding'], properties: { finding: { type: 'string', minLength: 1 } } };
const workspace = resolve(new URL('../..', import.meta.url).pathname);
const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, cost: 0.01, completion_tokens_details: { reasoning_tokens: 3 } };
const response = (content, finish_reason = 'stop') => ({ id: 'offline-provider-response', model: 'mimo-v2.6-pro', usage,
  inferenceAttempts: [{ status: 200, elapsedMs: 1 }], choices: [{ finish_reason, message: { role: 'assistant', content } }] });

test('delivery v11 inherits the exact v10 layer and binds only its small operational addition', () => {
  const old = renderInstructions({ profile: 'opulent-delivery-v10' });
  const current = renderInstructions({ profile });
  const addition = readFileSync(new URL('../instructions/opulent-delivery-v11.md', import.meta.url), 'utf8').trimEnd();
  assert.equal(current.systemPrompt, `${old.systemPrompt}\n\n${addition}`);
  assert.equal(current.provenance.inheritedV10EffectivePromptSha256, old.provenance.effectivePromptSha256);
  assert.equal(current.provenance.inheritedV10ManifestSha256, old.provenance.manifestSha256);
  assert.equal(current.provenance.addendumSha256, sha256(addition));
  assert.equal(current.provenance.effectivePromptSha256, sha256(current.systemPrompt));
  assert.equal(current.provenance.manifestSha256, sha256(readFileSync(new URL('../instructions/manifest-opulent-delivery-v11.json', import.meta.url))));
  assert.equal(current.provenance.handoffPolicy, old.provenance.handoffPolicy);
  assert.equal(current.provenance.scriptPolicy, old.provenance.scriptPolicy);
  assert.match(current.systemPrompt, /requirement-to-deliverable matrix/);
  assert.match(addition, /no provider fallback/);
  const appended = renderInstructions({ profile, appendix: 'Only public fixture data' });
  assert(appended.systemPrompt.startsWith(`${current.systemPrompt}\n\n`));
  assert.equal(appended.systemPrompt.match(/Only public fixture data/g).length, 1);
});

test('delivery v11 retains native MiMo, v10 tools, retrieval, handoff and budgets', async () => {
  const config = { workspace, corpus: { directory: '/safe/export', hash: 'test-corpus', count: 1,
    sources: [{ id: 'law:a', doc: 'law', text: 'Public fixture text.', path: 'chunks/law:a.txt' }] },
    instructionProfile: profile, inferenceProvider: 'runanywhere', model: 'xiaomi/mimo-v2.6-pro', providerModel: 'mimo-v2.6-pro',
    semanticSurface: 'toolbox', toolSurface: 'initial-scripted-v1', sandboxTemplate: 'approved-template',
    computerImageSha256: 'a'.repeat(64), workProduct: { maxCompletionTokens: 32768 }, maxSteps: 1000 };
  const captured = [];
  const halt = new Error('Stop before any live tool or provider call');
  const runtimeFactory = options => { captured.push(options.config); throw halt; };
  const currentHarness = createBroadHarness({ ...config, runtimeFactory });
  const oldHarness = createBroadHarness({ ...config, runtimeFactory, instructionProfile: 'opulent-delivery-v10' });
  const current = currentHarness.provenance;
  const old = oldHarness.provenance;
  assert.equal(current.policy, 'broad-legal-native-delivery-v11');
  assert.equal(current.delivery.version, profile);
  assert.equal(current.delivery.emptyFinalRecovery, 'same-session-empty-final-v1');
  assert.equal(old.delivery.emptyFinalRecovery, undefined);
  assert.equal(current.maxSteps, old.maxSteps);
  assert.equal(current.maxCompletionTokens, old.maxCompletionTokens);
  assert.equal(current.sandboxTimeoutMs, old.sandboxTimeoutMs);
  assert.equal(current.modelRequestTimeoutMs, old.modelRequestTimeoutMs);
  for (const key of ['inference', 'allowedTools', 'initialTools', 'runtimeCapabilities', 'retrieval', 'excludedCategories', 'networkPolicy']) assert.deepEqual(current[key], old[key]);
  assert.deepEqual(current.rlm.settings, old.rlm.settings);
  assert.deepEqual(current.delivery.handoff, old.delivery.handoff);
  assert.deepEqual(current.delivery.computer, old.delivery.computer);
  assert.deepEqual(rlmDefinitionsFor({ instructionProfile: profile, rlmHandoffPolicy: 'rlm-handoff-v1' }),
    rlmDefinitionsFor({ instructionProfile: 'opulent-delivery-v10', rlmHandoffPolicy: 'rlm-handoff-v1' }));
  assert.throws(() => createBroadHarness({ ...config, inferenceProvider: 'gateway', providerModel: undefined }), /requires native/);
  assert.throws(() => createBroadHarness({ ...config, computerImageSha256: undefined }), /approved prepared desktop/);
  await assert.rejects(currentHarness.preflight(), error => error === halt);
  await assert.rejects(oldHarness.preflight(), error => error === halt);
  assert.equal(captured[0].instructionProfile, profile);
  assert.equal(captured[1].instructionProfile, 'opulent-delivery-v10');
  assert.equal(captured[0].rlmHandoffPolicy, 'rlm-handoff-v1');
  assert.equal(captured[0].scriptTopLevelAwait, true);
  const { instructionProfile: currentProfile, systemPrompt: currentPrompt, stateDir: currentState, ...currentConfig } = captured[0];
  const { instructionProfile: oldProfile, systemPrompt: oldPrompt, stateDir: oldState, ...oldConfig } = captured[1];
  assert.deepEqual(currentConfig, oldConfig);
});

test('delivery v11 runner is explicit, native-only and cannot resume a v10 checkpoint', () => {
  const args = ['--tasks', 'task-03', '--output', '/tmp/v11-output', '--harvey-root', '/tmp/harvey', '--python', '/tmp/python',
    '--native-module', '/tmp/native.mjs', '--broker-origin', 'https://broker.example.org', '--broker-port', '8788',
    '--sandbox-template', 'prepared-template', '--computer-image-sha256', 'a'.repeat(64)];
  const defaults = parseOptions(args);
  const current = parseOptions([...args, '--instruction-profile', profile, '--model-profile', 'runanywhere-mimo-v2.6-pro', '--semantic-surface', 'toolbox']);
  assert.equal(defaults.instructionProfile, 'opulent-prepared-v2');
  assert.equal(current.instructionProfile, profile);
  assert.equal(current.modelProfile, 'runanywhere-mimo-v2.6-pro');
  assert.equal(current.maxSteps, defaults.maxSteps);
  assert.equal(current.concurrency, defaults.concurrency);
  assert.throws(() => parseOptions([...args, '--instruction-profile', profile]), /requires native/);
  const old = { selectedTasks: current.tasks, instructionProfile: 'opulent-delivery-v10', maxSteps: current.maxSteps,
    instructions: renderInstructions({ profile: 'opulent-delivery-v10' }).provenance };
  const next = { ...old, instructionProfile: profile, instructions: renderInstructions({ profile }).provenance };
  assert.throws(() => checkpointFor(next, checkpointFor(old)), /resume rejected/);
  assert.throws(() => checkpointFor(old, checkpointFor(next)), /resume rejected/);
});

for (const instructionProfile of [undefined, 'opulent-delivery-v9', 'opulent-delivery-v10']) {
  for (const content of [null, '', ' \t\n ']) {
    test(`${instructionProfile ?? 'default'} still fails a stopped empty final (${JSON.stringify(content)})`, async () => {
      let calls = 0;
      const runtime = createRuntime({ store: createStore(':memory:'), config: { instructionProfile, maxSteps: 3 }, model: async () => {
        calls++;
        return response(content);
      } });
      try {
        const session = await runtime.startSession({ prompt: 'Complete generic fixture work' });
        const result = await runtime.waitSession(session.id);
        assert.equal(result.status, 'failed');
        assert.equal(result.error, 'Model provider returned an empty final response');
        assert.equal(result.output, undefined);
        assert.equal(result.steps, 1);
        assert.equal(calls, 1);
        assert.equal(runtime.store.get('conversations', session.id).messages.at(-1).content, content);
        assert.deepEqual(runtime.store.list('events').find(e => e.type === 'model_usage').data.usage, usage);
        assert.equal(runtime.store.list('events').some(e => e.type === 'empty_final_response_rejected' || e.type === 'session_completed'), false);
      } finally { await runtime.close(); }
    });
  }
}

for (const content of [null, '', ' \t\n ']) {
  test(`delivery v11 recovers ${JSON.stringify(content)} without losing the response, conversation or usage`, async () => {
    const seen = [];
    const original = response(content);
    original.choices[0].message.tool_calls = [];
    original.choices[0].message.reasoning_content = 'Already completed the generic fixture work';
    const runtime = createRuntime({ store: createStore(':memory:'), config: { instructionProfile: profile, maxSteps: 2 }, model: async messages => {
      seen.push(structuredClone(messages));
      return seen.length === 1 ? original : response('Completed generic fixture work\n');
    } });
    try {
      const session = await runtime.startSession({ prompt: 'Complete generic fixture work' });
      const result = await runtime.waitSession(session.id);
      assert.equal(result.status, 'completed');
      assert.equal(result.output, 'Completed generic fixture work\n');
      assert.equal(result.steps, 2);
      assert.equal(result.usage.prompt_tokens, 22);
      assert.equal(result.usage.completion_tokens, 14);
      assert.equal(result.usage.total_tokens, 36);
      assert.equal(result.usage.cost, 0.02);
      assert.equal(runtime.store.list('sessions').length, 1);
      assert.deepEqual(seen[1].slice(0, seen[0].length), seen[0]);
      assert.deepEqual(seen[1].at(-2), original.choices[0].message);
      assert.equal(seen[1].at(-1).role, 'user');
      assert.match(seen[1].at(-1).content, /empty and was not accepted/);
      assert.match(seen[1].at(-1).content, /do not restart work or repeat completed tool actions/);
      assert(seen[1].at(-1).content.length < 1024);
      const events = runtime.store.list('events');
      assert.deepEqual(events.filter(e => e.type === 'model_usage').map(e => e.data.usage), [usage, usage]);
      assert.deepEqual(events.find(e => e.type === 'empty_final_response_rejected').data.response, original);
      assert.equal(events.filter(e => e.type === 'session_completed').length, 1);
      assert.equal(events.some(e => e.type === 'session_failed'), false);
      assert.deepEqual(runtime.store.get('conversations', session.id).messages, [...seen[1], response(result.output).choices[0].message]);
    } finally { await runtime.close(); }
  });
}

test('delivery v11 repeated empties exhaust the existing step budget without any output', async () => {
  let calls = 0;
  const runtime = createRuntime({ store: createStore(':memory:'), config: { instructionProfile: profile, maxSteps: 3 }, model: async () => response(++calls % 2 ? null : ' ') });
  try {
    const session = await runtime.startSession({ prompt: 'Return a completed response' });
    const result = await runtime.waitSession(session.id);
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'Agent step budget exhausted');
    assert.equal(result.output, undefined);
    assert.equal(result.steps, 3);
    assert.equal(calls, 3);
    assert.equal(result.usage.completion_tokens, 21);
    assert.equal(runtime.store.list('sessions').length, 1);
    const events = runtime.store.list('events');
    assert.equal(events.filter(e => e.type === 'model_usage').length, 3);
    assert.equal(events.filter(e => e.type === 'empty_final_response_rejected').length, 3);
    assert.equal(events.some(e => e.type === 'session_completed'), false);
    const messages = runtime.store.get('conversations', session.id).messages;
    assert.equal(messages.filter(m => m.role === 'assistant').length, 3);
    assert.equal(messages.filter(m => m.role === 'user').length, 4);
    assert(messages.filter(m => m.role === 'user').every(m => m.content.length < 1024));
  } finally { await runtime.close(); }
});

test('cancellation aborts the same-session recovery instead of completing or retrying', async () => {
  let entered;
  const recovering = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const runtime = createRuntime({ store: createStore(':memory:'), config: { instructionProfile: profile, maxSteps: 3 }, model: async (_messages, { signal }) => {
    if (++calls === 1) return response(null);
    entered();
    await delay(10000, undefined, { signal });
    return response('Must not complete after cancellation');
  } });
  try {
    const session = await runtime.startSession({ prompt: 'Complete the work' });
    await recovering;
    await runtime.cancelSession(session.id);
    const result = await runtime.waitSession(session.id);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.output, undefined);
    assert.equal(result.steps, 2);
    assert.equal(calls, 2);
    assert.equal(result.usage.completion_tokens, 7);
    assert.equal(runtime.store.list('events').filter(e => e.type === 'empty_final_response_rejected').length, 1);
    assert.equal(runtime.store.list('events').some(e => e.type === 'session_completed'), false);
  } finally { await runtime.close(); }
});

test('native request timeout still fails recovery with no provider or authentication retry', async () => {
  const previous = process.env.RUNA_CLOUD_KEY;
  process.env.RUNA_CLOUD_KEY = 'offline-empty-final-test-key';
  const config = { instructionProfile: profile, inferenceProvider: 'runanywhere', model: 'xiaomi/mimo-v2.6-pro', providerModel: 'mimo-v2.6-pro', modelRequestTimeoutMs: 30, maxSteps: 3 };
  let calls = 0;
  const model = createModel(config, async (_url, request) => {
    if (++calls === 1) return { status: 200, ok: true, json: async () => response(null) };
    await delay(10000, undefined, { signal: request.signal });
    throw new Error('Request timeout must abort this fixture');
  });
  const runtime = createRuntime({ store: createStore(':memory:'), config, model });
  try {
    const session = await runtime.startSession({ prompt: 'Complete the work' });
    const result = await runtime.waitSession(session.id);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /abort/i);
    assert.equal(result.output, undefined);
    assert.equal(result.steps, 2);
    assert.equal(calls, 2);
    assert.equal(result.usage.completion_tokens, 7);
    const failure = runtime.store.list('events').find(e => e.type === 'model_failed');
    assert.equal(failure.data.request_attempts.length, 1);
    assert.equal(failure.data.usage_unknown, true);
  } finally {
    await runtime.close();
    if (previous === undefined) delete process.env.RUNA_CLOUD_KEY;
    else process.env.RUNA_CLOUD_KEY = previous;
  }
});

for (const candidate of ['Not JSON', '{"wrong":"field"}']) {
  test(`delivery v11 rejects a schema-invalid follow-up after recovery (${candidate})`, async () => {
    const seen = [];
    const runtime = createRuntime({ store: createStore(':memory:'), config: { instructionProfile: profile, maxSteps: 3 }, model: async messages => {
      seen.push(structuredClone(messages));
      return response([null, candidate, '{"finding":"Complete evidence"}'][seen.length - 1]);
    } });
    try {
      const session = await runtime.startSession({ prompt: 'Return bounded evidence', schema });
      const result = await runtime.waitSession(session.id);
      assert.equal(result.status, 'completed');
      assert.deepEqual(result.output, { finding: 'Complete evidence' });
      assert.equal(result.steps, 3);
      assert.equal(runtime.store.list('sessions').length, 1);
      assert.equal(runtime.store.list('events').filter(e => e.type === 'empty_final_response_rejected').length, 1);
      const rejected = runtime.store.list('events').filter(e => e.type === 'structured_output_rejected');
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].data.reason, candidate === 'Not JSON' ? 'invalid_json' : 'schema_mismatch');
      assert.equal(runtime.store.list('events').filter(e => e.type === 'session_completed').length, 1);
      assert(seen[2].some(m => m.role === 'assistant' && m.content === candidate));
      assert.match(seen[2].at(-1).content, /was not accepted/);
    } finally { await runtime.close(); }
  });
}

test('delivery v11 cannot accept an invalid schema follow-up at the existing budget boundary', async () => {
  let calls = 0;
  const runtime = createRuntime({ store: createStore(':memory:'), config: { instructionProfile: profile, maxSteps: 2 }, model: async () => response(++calls === 1 ? null : '{"wrong":"field"}') });
  try {
    const session = await runtime.startSession({ prompt: 'Return bounded evidence', schema });
    const result = await runtime.waitSession(session.id);
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'Agent step budget exhausted');
    assert.equal(result.output, undefined);
    assert.equal(result.steps, 2);
    assert.equal(runtime.store.list('events').some(e => e.type === 'session_completed'), false);
  } finally { await runtime.close(); }
});

test('delivery v11 retains v10 schema-bearing length repair in the same session', async () => {
  let calls = 0;
  const runtime = createRuntime({ store: createStore(':memory:'), config: { instructionProfile: profile, maxSteps: 2 }, model: async () => ++calls === 1
    ? response('{"finding":', 'length') : response('{"finding":"Complete evidence"}') });
  try {
    const session = await runtime.startSession({ prompt: 'Return bounded evidence', schema });
    const result = await runtime.waitSession(session.id);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.output, { finding: 'Complete evidence' });
    assert.equal(result.steps, 2);
    assert.equal(runtime.store.list('events').find(e => e.type === 'structured_output_rejected').data.reason, 'completion_token_budget_exhausted');
    assert(runtime.store.get('conversations', session.id).messages.some(m => m.role === 'assistant' && m.content === '{"finding":'));
  } finally { await runtime.close(); }
});

for (const content of [null, '', 'Partial answer']) {
  test(`delivery v11 keeps length exhaustion without a schema fatal (${JSON.stringify(content)})`, async () => {
    const runtime = createRuntime({ store: createStore(':memory:'), config: { instructionProfile: profile, maxSteps: 3 }, model: async () => response(content, 'length') });
    try {
      const session = await runtime.startSession({ prompt: 'Return a complete answer' });
      const result = await runtime.waitSession(session.id);
      assert.equal(result.status, 'failed');
      assert.match(result.error, /completion token budget/);
      assert.equal(result.output, undefined);
      assert.equal(result.steps, 1);
      assert.equal(runtime.store.list('events').some(e => e.type === 'empty_final_response_rejected' || e.type === 'session_completed'), false);
      assert.equal(runtime.store.get('conversations', session.id).messages.at(-1).content, content);
    } finally { await runtime.close(); }
  });
}

for (const content of [undefined, 42, []]) {
  test(`delivery v11 does not recover malformed non-string content (${JSON.stringify(content)})`, async () => {
    const runtime = createRuntime({ store: createStore(':memory:'), config: { instructionProfile: profile, maxSteps: 3 }, model: async () => response(content) });
    try {
      const session = await runtime.startSession({ prompt: 'Return a complete answer' });
      const result = await runtime.waitSession(session.id);
      assert.equal(result.status, 'failed');
      assert.equal(result.error, 'Model provider returned an empty final response');
      assert.equal(result.output, undefined);
      assert.equal(result.steps, 1);
    } finally { await runtime.close(); }
  });
}

test('delivery v11 keeps a recovering delegated child on its bounded schema', async () => {
  const seen = [];
  const runtime = createRuntime({ store: createStore(':memory:'), config: { instructionProfile: profile, maxSteps: 3 }, model: async messages => {
    seen.push(structuredClone(messages));
    return response(seen.length === 1 ? 'Lead work' : seen.length === 2 ? null : '{"finding":"Bounded evidence"}');
  } });
  try {
    const parent = await runtime.startSession({ prompt: 'Lead work' });
    assert.equal((await runtime.waitSession(parent.id)).status, 'completed');
    const child = await runtime.context(parent.id).startSession({ prompt: 'One bounded assignment', schema });
    const result = await runtime.waitSession(child.id);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.output, { finding: 'Bounded evidence' });
    assert.equal(result.steps, 2);
    assert.equal(runtime.store.list('sessions').length, 2);
    assert.match(seen[1][0].content, /You are a delegated child, not the lead coordinator/);
    assert(seen[1][0].content.endsWith(`Return final output as JSON matching: ${JSON.stringify(schema)}`));
    assert.equal(seen[2][0].content, seen[1][0].content);
  } finally { await runtime.close(); }
});
