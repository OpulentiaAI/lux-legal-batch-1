import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStore } from '../store.mjs';
import { persistCapyResult } from '../capy-results.mjs';
import { OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY, prepareCapyModelContext } from '../capy-context.mjs';

function fixture(t, crowded) {
  const store = createStore(':memory:'), files = new Map();
  t.after(() => store.close());
  const config = { model: 'synthetic-offline-model', instructionProfile: 'opulent2-fixed-v1', allowedTools: ['read', 'execute'],
    initialTools: ['read', 'execute'], corpusWorkspace: '/approved-corpus', systemPrompt: 'Original pinned instructions',
    opulent2ContextContinuationPolicy: OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY.version,
    contextCompaction: { enabled: true, maxInputChars: 80000, maxSummaryInputChars: 60000,
      maxSummaryChars: 4000, maxSummaryTokens: 8192, recentGroups: 2, maxBatches: 32 } };
  const ctx = { store, sessionId: 'owned-recency-session', workspace: '/vm/workspace', scrub: value => value,
    ensureSandbox: async () => {}, emit: () => {}, sandbox: { files: {
      write: async (path, content) => files.set(path, content), read: async path => Buffer.from(files.get(path)),
    } } };
  ctx.persistCapyResult = (value, bound) => persistCapyResult(ctx, value, bound);
  if (crowded) {
    store.put('capy_bindings', ctx.sessionId, { bindings: { checkpoint: 'PRIVATE_BINDING_VALUE', delegation: 'PRIVATE_CHILD_VALUE' } });
    for (let index = 0; index < 10; index++) {
      const id = randomUUID();
      store.put('capy_operations', id, { session_id: ctx.sessionId, kind: 'process', status: 'completed',
        description: `Owned process ${index} `.repeat(12), exit_code: 0, transport_uncertain: false,
        output_directory: `${ctx.workspace}/.capy/operations/${id}`, created_at: '2026-10-06T17:00:00.000Z' });
    }
  }
  const messages = [{ role: 'system', content: 'Original fixed instructions' }, { role: 'user', content: 'Complete the original assignment.' },
    ...Array.from({ length: crowded ? 40 : 6 }, (_, index) => [
      { role: 'assistant', content: null, tool_calls: [{ id: `receipt-${index}`, type: 'function',
        function: { name: 'execute', arguments: JSON.stringify({ code: `PRIVATE_PROGRAM_${index}` }) } }],
        reasoning_details: [{ type: 'reasoning.encrypted', data: `PRIVATE_REASONING_${index}` }] },
      { role: 'tool', tool_call_id: `receipt-${index}`, content: `PRIVATE_COMPLETE_RECEIPT_${index} é🙂\r\n`.padEnd(22000, '.') },
    ]).flat()];
  const prepare = extra => prepareCapyModelContext({ ctx, config, messages,
    model: async () => { throw new Error('No native inference is permitted in these synthetic tests'); }, ...extra });
  return { files, messages, prepare };
}

function navigation(prepared) {
  const message = prepared.messages.find(row => typeof row.content === 'string'
    && (row.content.startsWith('[Original history JSON format/navigation metadata') || row.content.startsWith('[Owned execution recovery metadata')));
  assert.ok(message);
  return JSON.parse(message.content.slice(message.content.indexOf('\n') + 1));
}

test('bounded owned recovery indexes the newest verified receipts rather than filling navigation with bootstrap descriptors', async t => {
  const f = fixture(t, true), original = JSON.stringify(f.messages), prepared = await f.prepare(), metadata = navigation(prepared);
  const n = metadata.history_navigation, prefix = f.messages.slice(0, prepared.checkpoint.prefixLength), last = prefix.length - 1;
  assert(n.omitted_messages > 0);
  assert.equal(n.described_messages + n.omitted_messages, prefix.length);
  assert(JSON.stringify(metadata).length <= 6000);
  assert.equal(metadata.processes.length, 10);
  assert.deepEqual(n.descriptors.at(-1), { message_index: last, role: 'tool', tool_name: 'execute', tool_call_id: prefix[last].tool_call_id });
  assert(!n.descriptors.some(row => row.message_index === 0));
  assert.deepEqual(n.descriptors.map(row => row.message_index), n.descriptors.map(row => row.message_index).sort((a, b) => a - b));
  assert.equal(JSON.stringify(JSON.parse(f.files.get(prepared.checkpoint.reference.output_path)).original_conversation), JSON.stringify(prefix));
  assert.equal(JSON.stringify(f.messages), original);
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE_BINDING_VALUE|PRIVATE_CHILD_VALUE|PRIVATE_PROGRAM_|PRIVATE_REASONING_|PRIVATE_COMPLETE_RECEIPT_/);
  const appended = [...f.messages, { role: 'user', content: 'Later steering stays later.' }];
  const reused = await f.prepare({ messages: appended, checkpoint: prepared.checkpoint });
  assert.deepEqual(navigation(reused).history_navigation, n);
  assert.deepEqual(reused.checkpoint.reference, prepared.checkpoint.reference);
});

test('when every descriptor fits, recent-first selection retains the complete chronological navigation schema', async t => {
  const f = fixture(t, false), prepared = await f.prepare(), n = navigation(prepared).history_navigation;
  assert.equal(n.omitted_messages, 0);
  assert.equal(n.described_messages, prepared.checkpoint.prefixLength);
  assert.deepEqual(n.descriptors.map(row => row.message_index), Array.from({ length: prepared.checkpoint.prefixLength }, (_, index) => index));
  assert.equal(JSON.stringify(JSON.parse(f.files.get(prepared.checkpoint.reference.output_path)).original_conversation), JSON.stringify(f.messages.slice(0, prepared.checkpoint.prefixLength)));
});
