import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../store.mjs';
import { prepareCapyModelContext } from '../capy-context.mjs';
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
