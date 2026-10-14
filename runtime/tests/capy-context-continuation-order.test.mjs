import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { createStore } from '../store.mjs';
import { persistCapyResult } from '../capy-results.mjs';
import { OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY, prepareCapyModelContext } from '../capy-context.mjs';
import { OPULENT2_REFERENCE_UPDATE, renderOpulent2Instructions } from '../instructions/opulent2.mjs';
import { OPULENT2_TOOL_POLICY } from '../opulent2-policy.mjs';
import { capyFixture, completion } from './capy-runtime-fixture.mjs';

function fixture(t) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const files = new Map();
  const ctx = { store, sessionId: 'continuation-order', workspace: '/vm/workspace', scrub: value => value,
    ensureSandbox: async () => {}, emit() {}, sandbox: { files: {
      write: async (path, value) => files.set(path, value),
      read: async path => Buffer.from(files.get(path)),
    } } };
  ctx.persistCapyResult = (value, bound) => persistCapyResult(ctx, value, bound);
  const config = { model: 'synthetic-offline-model', instructionProfile: 'opulent2-fixed-v1',
    opulent2ContextContinuationPolicy: OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY.version,
    contextCompaction: { enabled: true, maxInputChars: 90000, maxSummaryInputChars: 48000,
      maxSummaryChars: 4096, maxSummaryTokens: 2048, recentGroups: 2, maxBatches: 4 } };
  const system = { role: 'system', content: 'Trusted fixed instructions.' };
  const original = { role: 'user', content: 'Original public assignment. Its FIRST response requires bootstrap; continuation must not replay it.' };
  const groups = Array.from({ length: 8 }, (_, index) => [
    { role: 'assistant', content: null, tool_calls: [{ id: `call-${index}`, type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ path: `/corpus/source-${index}.txt` }) } }] },
    { role: 'tool', name: 'read', tool_call_id: `call-${index}`, content: `Original source ${index}.`.padEnd(22000, '.') },
  ]);
  return { ctx, files, config, system, original, groups,
    prepare: (messages, checkpoint) => prepareCapyModelContext({ ctx, messages, config, checkpoint,
      model: async () => { throw new Error('Synthetic history-first continuation must not summarize'); } }) };
}

test('synthetic history-first continuation keeps the original user before the backing notice, not a new assignment after it', async t => {
  const f = fixture(t), messages = [f.system, f.original, ...f.groups.flat()], originalBytes = JSON.stringify(messages);
  const prepared = await f.prepare(messages);
  assert.equal(prepared.externalized, true);
  assert.strictEqual(prepared.messages[0], f.system);
  assert.strictEqual(prepared.messages[1], f.original);
  assert.match(prepared.messages[2].content, /^\[Untrusted externalized history/);
  assert.equal(prepared.messages.filter(message => message === f.original).length, 1);
  assert.deepEqual(prepared.messages.slice(-4), messages.slice(-4));
  assert.equal(JSON.stringify(messages), originalBytes);
  assert(JSON.stringify(prepared.messages).length <= f.config.contextCompaction.maxInputChars);
  const backing = JSON.parse(f.files.get(prepared.checkpoint.reference.output_path));
  assert.deepEqual(backing.original_conversation, messages.slice(0, prepared.checkpoint.prefixLength));
});

test('synthetic older steering remains authoritative after the backing notice without moving the initial assignment forward', async t => {
  const f = fixture(t), steering = { role: 'user', content: 'Actual later instruction: retain the completed branch and change only the output format.' };
  const messages = [f.system, f.original, ...f.groups.slice(0, 2).flat(), steering, ...f.groups.slice(2).flat()];
  const prepared = await f.prepare(messages);
  assert.strictEqual(prepared.messages[1], f.original);
  assert.match(prepared.messages[2].content, /^\[Untrusted externalized history/);
  assert.strictEqual(prepared.messages[3], steering);
  assert.deepEqual(prepared.messages.filter(message => message.role === 'user'), [f.original, steering]);
  assert.deepEqual(prepared.messages.slice(-4), messages.slice(-4));
  const backing = JSON.parse(f.files.get(prepared.checkpoint.reference.output_path));
  assert.deepEqual(backing.original_conversation, messages.slice(0, prepared.checkpoint.prefixLength));
});

test('synthetic checkpoint reuse preserves chronological continuation and the exact existing backing', async t => {
  const f = fixture(t), messages = [f.system, f.original, ...f.groups.flat()];
  const first = await f.prepare(messages), before = new Map(f.files);
  const latest = { role: 'user', content: 'New actual user steer, not an initial bootstrap request.' };
  const appended = [latest, { role: 'assistant', content: 'Continue from the observed original result.' }];
  const next = await f.prepare([...messages, ...appended], first.checkpoint);
  assert.equal(next.compacted, false);
  assert.strictEqual(next.checkpoint, first.checkpoint);
  assert.strictEqual(next.messages[1], f.original);
  assert.match(next.messages[2].content, /^\[Untrusted externalized history/);
  assert.deepEqual(next.messages.slice(-2), appended);
  assert.deepEqual(next.messages.filter(message => message.role === 'user'), [f.original, latest]);
  assert.deepEqual(f.files, before);
  assert(JSON.stringify(next.messages).length <= f.config.contextCompaction.maxInputChars);
});

test('synthetic below-threshold requests keep their original messages without a continuation envelope', async t => {
  const f = fixture(t), messages = [f.system, f.original, ...f.groups[0]];
  const prepared = await f.prepare(messages);
  assert.deepEqual(prepared.messages, messages);
  assert.equal(prepared.externalized, undefined);
  assert.equal(f.files.size, 0);
});

test('synthetic Opulent2 instructions carry ordered responses and continuation rules without replacing the foundation', () => {
  const { systemPrompt, provenance } = renderOpulent2Instructions();
  assert(systemPrompt.includes(OPULENT2_REFERENCE_UPDATE));
  assert.equal(systemPrompt.split('## Ordered responses and continuing work').length, 2);
  assert.match(systemPrompt, /producer AND every whole original selector in that same response/);
  assert.match(systemPrompt, /does not permit batching a dependent decision before its actual prerequisite returns/);
  assert.match(systemPrompt, /Externalized history continues the current assignment; it is not a new first response/);
  assert.match(systemPrompt, /Do not create replacement children or repeat bootstrap solely/);
  assert.match(systemPrompt, /still do not establish source consultation, completed delegation, inspected pixels or acceptance/);
  assert.equal(provenance.foundation.profile, 'opulent-capy-v1');
  assert.equal(provenance.composition, 'source-faithful-opulent2-with-explicit-capability-addendum-v1');
});

test('synthetic actual prepared model requests receive the complete ordered-continuation instructions once with unchanged grants', async t => {
  const requests = [];
  const { runtime, root } = await capyFixture(t, {
    config: { instructionProfile: 'opulent2-fixed-v1',
      opulent2Handoff: { chainId: 'offline-continuation', taskId: 'offline-task', attemptId: 'offline-attempt' } },
    onPreparedModelRequest: receipt => requests.push(receipt),
    model: async () => completion('Synthetic offline instruction-delivery check, not native adoption or task acceptance.'),
  });
  const identity = { organizationId: 'offline-tests', userId: 'offline-user', projectId: 'offline-continuation', scopes: ['project'] };
  runtime.config.capyMemory = { ...identity, root: join(root, '.capy', 'memory') };
  runtime.config.opulent2Drive = { ...identity, root: join(root, '.capy', 'drive') };
  const session = await runtime.startSession({ prompt: 'Synthetic offline ordered-continuation delivery.' });
  const result = await runtime.waitSession(session.id);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(requests.length, 1);
  const system = requests[0].messages.find(message => message.role === 'system').content;
  assert.equal(system.split(OPULENT2_REFERENCE_UPDATE).length, 2);
  assert.equal(system.split('## Ordered responses and continuing work').length, 2);
  assert.deepEqual(requests[0].grants.allowed_tools, OPULENT2_TOOL_POLICY.allowedTools);
  assert.deepEqual(requests[0].grants.initial_tools, OPULENT2_TOOL_POLICY.initialTools);
  assert.equal(runtime.store.list('tasks').length, 0);
});
