import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { persistCapyResult, OPULENT2_RESULT_PREVIEW_POLICY } from '../capy-results.mjs';

function fixture(profile = 'opulent2-fixed-v1', writeFailure = false) {
  const rows = new Map(), files = new Map();
  const ctx = {
    config: { instructionProfile: profile }, sessionId: 'preview-test', workspace: '/vm/workspace',
    store: { put: (table, id, row) => rows.set(id, row), get: (table, id) => rows.get(id) },
    ensureSandbox: async () => {},
    sandbox: { files: { write: async (path, content) => {
      if (writeFailure) throw new Error('Backing write failed');
      files.set(path, content);
    } } },
  };
  return { ctx, rows, files };
}

test('Opulent2 head/tail previews retain the complete scrubbed backing and exact identity', async () => {
  const { ctx, rows, files } = fixture();
  const value = { start: 'SOURCE HEADER', content: 'M'.repeat(100000), end: 'DECISIVE TAIL' };
  const serialized = JSON.stringify(value);
  const result = await persistCapyResult(ctx, value);
  assert.equal(OPULENT2_RESULT_PREVIEW_POLICY, 'opulent2-file-backed-head-tail-v1');
  assert.equal(result.preview_policy, OPULENT2_RESULT_PREVIEW_POLICY);
  assert.equal(result.kind, 'file_backed_result');
  assert.equal(result.truncated, true);
  assert.ok(result.preview.startsWith('{"start":"SOURCE HEADER"'));
  assert.ok(result.preview.endsWith('"end":"DECISIVE TAIL"}'));
  assert.match(result.preview, /\n\[\d+ characters omitted\]\n/);
  assert.ok(result.preview.length <= 16000);
  assert.equal(files.get(result.output_path), serialized);
  assert.equal(result.characters, serialized.length);
  assert.equal(result.sha256, createHash('sha256').update(serialized).digest('hex'));
  assert.equal(rows.get(result.result_id).serialized, serialized);
  assert.equal(rows.get(result.result_id).status, 'available');
  assert.match(result.consultation, /Unreturned file content is not consulted evidence/);
});

test('Opulent2 preview boundaries do not split supplementary Unicode characters', async () => {
  const { ctx, files } = fixture();
  const value = { content: '😀'.repeat(50000) };
  const result = await persistCapyResult(ctx, value);
  assert.ok(result.preview.isWellFormed());
  assert.ok(result.preview.length <= 16000);
  assert.equal(files.get(result.output_path), JSON.stringify(value));
  const [head, omitted, tail] = result.preview.split(/\n\[(\d+) characters omitted\]\n/);
  assert.equal(head.length + Number(omitted) + tail.length, result.characters);
});

test('tiny metadata-only backing budgets and unspilled values retain their existing contracts', async () => {
  const { ctx, files } = fixture();
  const value = { content: 'complete history' };
  assert.deepEqual(await persistCapyResult(ctx, value), value);
  const result = await persistCapyResult(ctx, value, 1);
  assert.equal(result.preview, '');
  assert.equal(files.get(result.output_path), JSON.stringify(value));
});

test('historical profiles retain prefix-only previews', async () => {
  const { ctx } = fixture('opulent-capy-v1');
  const value = { content: 'M'.repeat(100000), end: 'TAIL' };
  const result = await persistCapyResult(ctx, value);
  assert.equal(result.preview, JSON.stringify(value).slice(0, 16000));
  assert.equal(result.preview_policy, undefined);
});

test('a failed backing write stays explicit and does not return a usable recovery path', async () => {
  const { ctx, rows, files } = fixture('opulent2-fixed-v1', true);
  const result = await persistCapyResult(ctx, { content: 'M'.repeat(100000), end: 'TAIL' });
  assert.equal(result.file_error, 'Backing write failed');
  assert.equal(result.output_path, undefined);
  assert.equal(files.size, 0);
  assert.equal(rows.get(result.result_id).status, 'persisted');
});

test('scrubbing occurs before preview selection, hashing and backing persistence', async () => {
  const { ctx, rows, files } = fixture();
  ctx.scrub = value => ({ ...value, end: '[redacted]' });
  const value = { content: 'M'.repeat(100000), end: 'fixture-private-value' };
  const result = await persistCapyResult(ctx, value);
  const serialized = JSON.stringify({ ...value, end: '[redacted]' });
  assert.ok(!result.preview.includes(value.end));
  assert.equal(files.get(result.output_path), serialized);
  assert.equal(rows.get(result.result_id).serialized, serialized);
  assert.equal(result.sha256, createHash('sha256').update(serialized).digest('hex'));
});
