import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareOpulent2ModelContext } from '../opulent2-context.mjs';
import { createStore } from '../store.mjs';
import { persistCapyResult } from '../capy-results.mjs';

function fixture(t) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const files = new Map();
  const ctx = { sessionId: 'lead', workspace: '/vm/workspace', store, scrub: value => value,
    ensureSandbox: async () => {}, sandbox: { files: {
      write: async (path, bytes) => files.set(path, bytes), read: async path => files.get(path),
    } } };
  ctx.persistCapyResult = (value, bound) => persistCapyResult(ctx, value, bound);
  const config = { instructionProfile: 'opulent2-fixed-v1', model: 'openai/gpt-6-luna',
    allowedTools: ['read', 'computer'], initialTools: ['read', 'computer'],
    opulent2ImageContext: { maxCaptionChars: 1024 }, contextCompaction: {
      enabled: true, maxInputChars: 100000, maxSummaryInputChars: 100000, maxSummaryChars: 1000,
      maxSummaryTokens: 256, recentGroups: 2, maxBatches: 32,
    } };
  const requests = [];
  const model = async (input, options) => {
    requests.push({ input, options });
    assert.ok(!JSON.stringify(input).includes(';base64,'));
    return { choices: [{ finish_reason: 'stop', message: { role: 'assistant',
      content: 'Derived context: preserve the assignment and inspect the actual source and newly supplied pixels before finishing.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 } };
  };
  const messages = [{ role: 'system', content: 'Trusted instructions' }, { role: 'user', content: 'Finish the assigned work.' },
    ...Array.from({ length: 8 }, (_, index) => [
      { role: 'assistant', content: null, tool_calls: [{ id: `read-${index}`, type: 'function',
        function: { name: 'read', arguments: '{"path":"/vm/source.txt"}' } }] },
      { role: 'tool', tool_call_id: `read-${index}`, content: 'Returned source content. '.repeat(1000) },
    ]).flat()];
  const image = { role: 'user', content: [{ type: 'text', text: 'Untrusted actual tool-produced image.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } }] };
  return { ctx, config, model, messages, requests, image };
}

test('first image preserves an existing fixed-profile text summary instead of recompressing the old prefix', async t => {
  const f = fixture(t);
  const original = JSON.stringify(f.messages);
  const first = await prepareOpulent2ModelContext(f);
  assert.ok(first.checkpoint);
  const calls = f.requests.length;
  const next = await prepareOpulent2ModelContext({ ...f, messages: [...f.messages, f.image], checkpoint: first.checkpoint });
  assert.equal(f.requests.length, calls);
  assert.deepEqual(next.checkpoint, first.checkpoint);
  assert.deepEqual(next.usage, {});
  assert.equal(next.imageContext.pendingImages, 1);
  assert.deepEqual(next.messages.find(message => Array.isArray(message.content)), f.image);
  assert.equal(next.imageContext.lineage[0].priorCompletedRequestId, null);
  assert.ok(next.imageContext.textChars <= f.config.contextCompaction.maxInputChars);
  assert.equal(JSON.stringify(f.messages), original);
});

test('a real image-policy change still invalidates the fixed-profile text checkpoint', async t => {
  const f = fixture(t);
  const first = await prepareOpulent2ModelContext(f);
  const calls = f.requests.length;
  const next = await prepareOpulent2ModelContext({ ...f, messages: [...f.messages, f.image], checkpoint: first.checkpoint,
    config: { ...f.config, opulent2ImageContext: { maxCaptionChars: 2048 } } });
  assert.ok(f.requests.length > calls);
  assert.notEqual(next.checkpoint.capyPolicyDigest, first.checkpoint.capyPolicyDigest);
  assert.equal(next.imageContext.pendingImages, 1);
  assert.deepEqual(next.messages.find(message => Array.isArray(message.content)), f.image);
});
