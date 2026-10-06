import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStore } from '../store.mjs';
import { prepareCapyModelContext, OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY } from '../capy-context.mjs';
import { persistCapyResult } from '../capy-results.mjs';

function fixture(t) {
  const store = createStore(':memory:'), files = new Map();
  t.after(() => store.close());
  const ctx = { store, sessionId: 'recovery-root', workspace: '/vm/workspace', scrub: value => value,
    ensureSandbox: async () => {}, emit: () => {}, sandbox: { files: {
      write: async (path, content) => files.set(path, content), read: async path => Buffer.from(files.get(path)),
    } } };
  ctx.persistCapyResult = (value, bound) => persistCapyResult(ctx, value, bound);
  const config = { model: 'same-native-model', instructionProfile: 'opulent2-fixed-v1',
    opulent2ContextContinuationPolicy: OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY.version,
    contextCompaction: { enabled: true, maxInputChars: 80000, maxSummaryInputChars: 40000,
      maxSummaryChars: 10000, maxSummaryTokens: 8192, recentGroups: 2, maxBatches: 32 } };
  const messages = [{ role: 'system', content: 'Fixed source instructions' }, { role: 'user', content: 'Original task, not a fresh restart.' },
    ...Array.from({ length: 4 }, (_, index) => [
      { role: 'assistant', content: null, tool_calls: [{ id: `call-${index}`, type: 'function', function: { name: 'read', arguments: '{"path":"source.txt"}' } }] },
      { role: 'tool', tool_call_id: `call-${index}`, content: 'SOURCE'.repeat(6000) },
    ]).flat()];
  const prepare = extra => prepareCapyModelContext({ ctx, messages, config,
    model: async () => { throw new Error('No summary inference permitted'); }, ...extra });
  const process = (values = {}) => {
    const id = values.id ?? randomUUID();
    return store.put('capy_operations', id, { kind: 'process', session_id: ctx.sessionId,
      status: 'completed', description: 'Generate private synthetic fixtures once', exit_code: 0,
      output_directory: `${ctx.workspace}/.capy/operations/${id}`, created_at: '2026-10-06T17:00:00.000Z',
      transport_uncertain: false, ...values });
  };
  const recovery = prepared => {
    const message = prepared.messages.find(row => row.content?.startsWith('[Owned execution recovery metadata'));
    return message ? { text: message.content, value: JSON.parse(message.content.slice(message.content.indexOf('\n') + 1)) } : null;
  };
  return { ctx, config, messages, files, prepare, process, recovery };
}

test('history-first continuation retains actual fixture execution and binding recovery candidates without replay or acceptance claims', async t => {
  const f = fixture(t), operation = f.process();
  f.ctx.store.put('capy_bindings', f.ctx.sessionId, { bindings: { documentWorkflowBatch: ['PRIVATE_BINDING_VALUES'], checkpoint: { notEvidence: true } } });
  f.ctx.store.put('tasks', 'task', { owner_session_id: f.ctx.sessionId, subject: 'Coverage', status: 'pending', description: 'Stale cursor: next generate fixtures.' });
  const before = JSON.stringify(f.messages), prepared = await f.prepare(), recovery = f.recovery(prepared);
  assert.deepEqual(recovery.value.bindings, ['checkpoint', 'documentWorkflowBatch']);
  assert.deepEqual(recovery.value.processes, [{ operation_id: operation.id, status: 'completed',
    description: operation.description, exit_code: 0, transport_uncertain: false, output_directory: operation.output_directory }]);
  assert.match(recovery.text, /not restarting its initial request/);
  assert.match(recovery.text, /not source consultation/);
  assert.match(recovery.text, /reopen the actual process stdout\/stderr/);
  assert.match(recovery.text, /not stale checkpoint prose/);
  assert(!recovery.text.includes('PRIVATE_BINDING_VALUES'));
  assert(prepared.messages.some(row => row.content?.includes('Stale cursor: next generate fixtures.')));
  assert.equal(JSON.stringify(f.messages), before);
  assert(JSON.stringify(prepared.messages).length <= f.config.contextCompaction.maxInputChars);
  assert.equal(prepared.checkpoint.provenance.workStateRetention, 'opulent2-owned-work-recovery-v1');
  assert.deepEqual(JSON.parse([...f.files.values()][0]).original_conversation, f.messages.slice(0, prepared.checkpoint.prefixLength));
});

test('recovery metadata keeps running failed and uncertain effects distinct and emits no command output or arbitrary payload', async t => {
  const f = fixture(t);
  for (const status of ['running', 'failed', 'cancelled', 'interrupted']) f.process({ status, exit_code: undefined, transport_uncertain: status === 'interrupted',
    command: 'PRIVATE_COMMAND', stdout: 'PRIVATE_STDOUT', stderr: 'PRIVATE_STDERR', error: 'PRIVATE_ERROR', headers: { authorization: 'PRIVATE_HEADER' } });
  const recovery = f.recovery(await f.prepare());
  assert.deepEqual(recovery.value.processes.map(row => row.status).sort(), ['cancelled', 'failed', 'interrupted', 'running']);
  assert(recovery.value.processes.every(row => row.exit_code === null));
  assert.equal(recovery.value.processes.find(row => row.status === 'interrupted').transport_uncertain, true);
  for (const value of ['PRIVATE_COMMAND', 'PRIVATE_STDOUT', 'PRIVATE_STDERR', 'PRIVATE_ERROR', 'PRIVATE_HEADER']) assert(!recovery.text.includes(value));
  assert.match(recovery.text, /effects remain unknown/);
});

test('recovery rejects other-session malformed and noncanonical process pointers and never projects other-session binding values', async t => {
  const f = fixture(t), good = f.process();
  f.process({ session_id: 'other-session', description: 'OTHER_SESSION' });
  f.process({ output_directory: '/outside/credential-bearing-path', description: 'OUTSIDE_PATH' });
  f.process({ kind: 'execute', description: 'NOT_PROCESS' });
  f.process({ id: 'invalid-id', description: 'INVALID_ID' });
  f.process({ status: 'invented-completion', description: 'INVALID_STATUS' });
  f.ctx.store.put('capy_bindings', 'other-session', { bindings: { OTHER_BINDING: 'PRIVATE' } });
  const recovery = f.recovery(await f.prepare());
  assert.deepEqual(recovery.value.bindings, []);
  assert.deepEqual(recovery.value.processes.map(row => row.operation_id), [good.id]);
  for (const value of ['OTHER_SESSION', 'OUTSIDE_PATH', 'NOT_PROCESS', 'INVALID_ID', 'INVALID_STATUS', 'OTHER_BINDING']) assert(!recovery.text.includes(value));
});

test('description scrubbing precedes clipping so a secret crossing the preview boundary is not exposed in fragments', async t => {
  const f = fixture(t), secret = 'LOCAL_TEST_SECRET_BOUNDARY_VALUE';
  f.ctx.scrub = value => JSON.parse(JSON.stringify(value).replaceAll(secret, '[REDACTED]'));
  f.process({ description: `${'x'.repeat(150)}${secret} trailing` });
  const recovery = f.recovery(await f.prepare());
  assert(!recovery.text.includes(secret));
  assert(!recovery.text.includes(secret.slice(0, 10)));
  assert(recovery.value.processes[0].description.includes('[REDACTED]'));
  assert(recovery.value.processes[0].description.length <= 160);
});

test('reused exact history backing refreshes only actual live recovery state without changing history or asserting completion', async t => {
  const f = fixture(t), operation = f.process({ status: 'running', exit_code: undefined });
  f.ctx.store.put('capy_bindings', f.ctx.sessionId, { bindings: { checkpoint: {} } });
  const first = await f.prepare(), originalFiles = JSON.stringify([...f.files]);
  f.ctx.store.put('capy_operations', operation.id, { ...operation, status: 'interrupted', transport_uncertain: true });
  f.ctx.store.put('capy_bindings', f.ctx.sessionId, { bindings: { checkpoint: {}, runtimeSource: 'PRIVATE_SOURCE_VALUE' } });
  const next = await f.prepare({ checkpoint: first.checkpoint }), recovery = f.recovery(next);
  assert.equal(next.compacted, false);
  assert.deepEqual(next.checkpoint, first.checkpoint);
  assert.equal(JSON.stringify([...f.files]), originalFiles);
  assert.equal(recovery.value.processes[0].status, 'interrupted');
  assert.equal(recovery.value.processes[0].exit_code, null);
  assert.deepEqual(recovery.value.bindings, ['checkpoint', 'runtimeSource']);
  assert(!recovery.text.includes('PRIVATE_SOURCE_VALUE'));
});

test('recovery selection stays bounded and omits unsupported names without changing context limits', async t => {
  const f = fixture(t);
  f.ctx.store.put('capy_bindings', f.ctx.sessionId, { bindings: Object.fromEntries([
    ...Array.from({ length: 100 }, (_, i) => [`binding${i}`, `PRIVATE_${i}`]), ['invalid-name', 'PRIVATE_BAD'], ['x'.repeat(65), 'PRIVATE_LONG'],
  ]) });
  for (let i = 0; i < 80; i++) f.process({ description: '"'.repeat(5000), created_at: new Date(1791306000000 + i * 1000).toISOString() });
  const prepared = await f.prepare(), recovery = f.recovery(prepared);
  assert.equal(recovery.value.bindings.length, 64);
  assert(recovery.value.processes.length > 0 && recovery.value.processes.length <= 24);
  assert(JSON.stringify(recovery.value).length <= 6000);
  assert(!recovery.text.includes('PRIVATE_'));
  assert(recovery.value.bindings.every(name => name.length <= 64 && !name.includes('-')));
  assert(JSON.stringify(prepared.messages).length <= f.config.contextCompaction.maxInputChars);
});

test('no history backing or no recorded work creates no synthetic recovery claims', async t => {
  const f = fixture(t);
  assert.equal(f.recovery(await f.prepare()), null);
  f.process();
  const messages = f.messages.slice(0, 2), prepared = await f.prepare({ messages });
  assert.deepEqual(prepared.messages, messages);
  assert.equal(f.recovery(prepared), null);
  assert.equal(f.ctx.store.list('capy_operations').length, 1);
});

test('immutable scrubbed metadata and expanding redactions cannot bypass the recovery bound', async t => {
  const f = fixture(t);
  f.process({ description: 'Fixture once' });
  f.ctx.scrub = value => Object.freeze(structuredClone(value));
  assert.equal(f.recovery(await f.prepare()).value.processes[0].description, 'Fixture once');
  f.ctx.scrub = value => value.version === 'opulent2-owned-work-recovery-v1'
    ? { ...value, bindings: ['EXPANDED_REDACTION'.repeat(1000)] } : value;
  assert.equal(f.recovery(await f.prepare()), null);
});

test('unselected summary-first fallback does not expose the selected work-recovery projection or change its provenance', async t => {
  const f = fixture(t);
  f.process();
  const { opulent2ContextContinuationPolicy, ...config } = f.config;
  const messages = [...f.messages.slice(0, 2), ...Array.from({ length: 10 }, () => ({ role: 'assistant', content: 'SOURCE'.repeat(2000) }))];
  const prepared = await f.prepare({ config, messages, model: async () => ({ choices: [{ message: { role: 'assistant', content: null,
    tool_calls: [{ id: 'invalid-summary-call', type: 'function', function: { name: 'read', arguments: '{}' } }] } }] }) });
  assert.equal(f.recovery(prepared), null);
  assert.equal(prepared.checkpoint.provenance.workStateRetention, undefined);
});
