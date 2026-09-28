import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../store.mjs';
import { redact } from '../security.mjs';
import { createTools } from '../tools/files.mjs';
import { normalizeOverflowRead, persistToolResultOverflow } from '../tool-result-overflow.mjs';

const runFileHelper = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-overflow-test-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const store = createStore(':memory:');
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const sandbox = {
    files: {
      write: async entries => { for (const entry of entries) await writeFile(entry.path, entry.data); },
      remove: path => rm(path, { force: true }),
    },
    commands: {
      run: async command => {
        const match = /^python3 (\/tmp\/runtime-files-[\w-]+\.py) (\/tmp\/runtime-files-[\w-]+\.json)$/.exec(command);
        assert.ok(match);
        const { stdout } = await runFileHelper('python3', match.slice(1));
        return { stdout };
      },
    },
  };
  let provisioned = 0;
  const ensureSandbox = async ctx => { provisioned++; ctx.sandbox = sandbox; };
  return { root, workspace, store, ensureSandbox, provisionCount: () => provisioned };
}

function largeResult(middle = 'm'.repeat(90_000)) {
  return JSON.stringify({ head: 'HEAD', middle, tail: 'TAIL' });
}

function decodeChunks(content) {
  return content.trimEnd().split('\n').map(line => JSON.parse(line)).join('');
}

test('preserves the full scrubbed JSON including its middle and tail in session-owned records and the sandbox', async t => {
  const f = await fixture(t);
  const scrubbedSerialized = largeResult();
  const ctx = { sessionId: 'session-one', workspace: f.workspace };
  const metadata = await persistToolResultOverflow({ ctx, store: f.store, ensureSandbox: f.ensureSandbox, scrubbedSerialized, canRead: true });

  assert.match(metadata.overflow_path, /^\.opulent-tool-results\/[\da-f-]+\.json$/);
  assert.equal(metadata.sha256, createHash('sha256').update(scrubbedSerialized).digest('hex'));
  assert.equal(metadata.characters, scrubbedSerialized.length);
  assert.equal(metadata.encoding, 'jsonl-string-chunks');
  assert.ok(metadata.lines > 1);
  assert.deepEqual(metadata.recommended_reads.head, { file_path: metadata.overflow_path, offset: 1, limit: 2 });
  assert.deepEqual(metadata.recommended_reads.tail, { file_path: metadata.overflow_path, offset: metadata.lines - 1, limit: 2 });
  assert.match(metadata.retrieval_instruction, /only the head or tail.*limit: 2.*JSON\.parse.*concatenate/);
  assert.equal(f.provisionCount(), 1);
  const file = await readFile(join(f.workspace, metadata.overflow_path), 'utf8');
  assert.equal(file.trimEnd().split('\n').length, metadata.lines);
  assert.equal(decodeChunks(file), scrubbedSerialized);
  const tools = createTools(ctx);
  let retrieved = '';
  for (let offset = 1; offset <= metadata.lines; offset += 2) {
    const page = await tools.read({ file_path: metadata.overflow_path, offset, limit: 2 });
    assert.equal(page.total_lines, metadata.lines);
    assert.ok(JSON.stringify(page).length < 80_000);
    retrieved += decodeChunks(page.content);
  }
  assert.equal(retrieved, scrubbedSerialized);
  assert.ok(JSON.parse((await tools.read({ file_path: metadata.overflow_path, offset: metadata.lines, limit: 1 })).content).includes('TAIL'));
  assert.deepEqual(JSON.parse(scrubbedSerialized), { head: 'HEAD', middle: 'm'.repeat(90_000), tail: 'TAIL' });
  const [record] = f.store.list('tool_result_overflows');
  assert.equal(record.session_id, ctx.sessionId);
  assert.equal(record.status, 'available');
  assert.equal(record.scrubbed_serialized, scrubbedSerialized);
  assert.equal(record.overflow_path, metadata.overflow_path);
  assert.equal(record.sha256, metadata.sha256);
  assert.equal(record.characters, metadata.characters);
  assert.equal(record.encoding, metadata.encoding);
  assert.equal(record.lines, metadata.lines);
});

test('caps owned overflow reads but leaves unregistered and cross-session reads alone', async t => {
  const f = await fixture(t);
  const scrubbedSerialized = largeResult();
  const owner = { sessionId: 'owner', workspace: f.workspace };
  const result = await persistToolResultOverflow({ ctx: owner, store: f.store, ensureSandbox: f.ensureSandbox, scrubbedSerialized, canRead: true });
  const absoluteAlias = join(f.workspace, '.opulent-tool-results', '..', '.opulent-tool-results', result.overflow_path.split('/')[1]);
  const oversized = normalizeOverflowRead({ ctx: owner, store: f.store, args: { file_path: absoluteAlias, offset: 2, limit: 2_000 } });
  assert.deepEqual(oversized.args, { file_path: absoluteAlias, offset: 2, limit: 2 });
  assert.deepEqual(oversized.paging, {
    overflow_path: result.overflow_path, encoding: result.encoding, total_lines: result.lines,
    offset: 2, limit: 2, requested_limit: 2_000, limit_capped: true, next_offset: 4,
  });
  const page = await createTools(owner).read(oversized.args);
  assert.equal(page.content.trimEnd().split('\n').length, 2);
  assert.ok(JSON.stringify({ ...page, overflow_paging: oversized.paging }).length < 80_000);

  const defaultLimit = normalizeOverflowRead({ ctx: owner, store: f.store, args: { file_path: `./${result.overflow_path}` } });
  assert.equal(defaultLimit.args.limit, 2);
  assert.equal(defaultLimit.paging.limit_capped, true);
  assert.equal(defaultLimit.paging.next_offset, 3);
  const tail = normalizeOverflowRead({ ctx: owner, store: f.store, args: result.recommended_reads.tail });
  assert.equal(tail.paging.next_offset, null);
  assert.equal(tail.paging.limit_capped, false);
  const oneLine = normalizeOverflowRead({ ctx: owner, store: f.store, args: { file_path: result.overflow_path, offset: 1, limit: 1 } });
  assert.equal(oneLine.args.limit, 1);
  assert.equal(oneLine.paging.next_offset, 2);

  assert.equal(normalizeOverflowRead({ ctx: { ...owner, sessionId: 'other' }, store: f.store, args: { file_path: result.overflow_path, limit: 2_000 } }), null);
  assert.equal(normalizeOverflowRead({ ctx: owner, store: f.store, args: { file_path: '.opulent-tool-results/00000000-0000-4000-8000-000000000000.json', limit: 2_000 } }), null);
  assert.equal(normalizeOverflowRead({ ctx: owner, store: f.store, args: { file_path: '../outside.json', limit: 2_000 } }), null);
  assert.equal(normalizeOverflowRead({ ctx: owner, store: f.store, args: { file_path: 'ordinary.txt', limit: 2_000 } }), null);
});

test('preserves Unicode and escaped content across chunk boundaries and bounds worst-case read pages', async t => {
  const f = await fixture(t);
  const scrubbedSerialized = JSON.stringify({ text: `${'a'.repeat(2_046)}🧑🏽‍💻\u0085\u2028\u2029${'\0'.repeat(90_000)}\nTAIL\\"` });
  const ctx = { sessionId: 'unicode-session', workspace: f.workspace };
  const result = await persistToolResultOverflow({ ctx, store: f.store, ensureSandbox: f.ensureSandbox, scrubbedSerialized, canRead: true });
  const tools = createTools(ctx);
  const file = await readFile(join(f.workspace, result.overflow_path), 'utf8');
  assert.equal(file.trimEnd().split('\n').length, result.lines);
  assert.doesNotMatch(file, /[\u0085\u2028\u2029]/);
  let reconstructed = '';
  for (let offset = 1; offset <= result.lines; offset += 2) {
    const page = await tools.read({ file_path: result.overflow_path, offset, limit: 2 });
    assert.ok(JSON.stringify(page).length < 80_000);
    for (const line of page.content.trimEnd().split('\n')) {
      const chunk = JSON.parse(line);
      assert.ok(Array.from(chunk).length <= 2_048);
      reconstructed += chunk;
    }
  }
  assert.equal(reconstructed, scrubbedSerialized);
  assert.deepEqual(JSON.parse(reconstructed), JSON.parse(scrubbedSerialized));
});

test('allocates distinct non-model-selected paths with separate session ownership', async t => {
  const f = await fixture(t);
  const scrubbedSerialized = largeResult();
  const first = await persistToolResultOverflow({ ctx: { sessionId: 'first', workspace: f.workspace }, store: f.store, ensureSandbox: f.ensureSandbox, scrubbedSerialized, canRead: true, overflow_path: '../outside' });
  const second = await persistToolResultOverflow({ ctx: { sessionId: 'second', workspace: f.workspace }, store: f.store, ensureSandbox: f.ensureSandbox, scrubbedSerialized, canRead: true });
  assert.notEqual(first.overflow_path, second.overflow_path);
  assert.equal(f.store.list('tool_result_overflows').filter(record => record.status === 'available').length, 2);
  assert.deepEqual(new Set(f.store.list('tool_result_overflows').map(record => record.session_id)), new Set(['first', 'second']));
  assert.deepEqual((await readdir(join(f.workspace, '.opulent-tool-results'))).sort(), [first, second].map(result => result.overflow_path.split('/')[1]).sort());
});

test('small and unreadable results do not persist or provision', async t => {
  const f = await fixture(t);
  const ctx = { sessionId: 'session-one', workspace: f.workspace };
  assert.equal(await persistToolResultOverflow({ ctx, store: f.store, ensureSandbox: f.ensureSandbox, scrubbedSerialized: '{}', canRead: true }), null);
  assert.equal(await persistToolResultOverflow({ ctx, store: f.store, ensureSandbox: f.ensureSandbox, scrubbedSerialized: 'x'.repeat(80_000), canRead: true }), null);
  assert.equal(await persistToolResultOverflow({ ctx, store: f.store, ensureSandbox: f.ensureSandbox, scrubbedSerialized: largeResult(), canRead: false }), null);
  assert.equal(f.provisionCount(), 0);
  assert.deepEqual(f.store.list('tool_result_overflows'), []);
  assert.deepEqual(await readdir(f.workspace), []);
});

test('failed writes and provisioning report bounded errors without a usable pointer', async t => {
  const f = await fixture(t);
  const ctx = { sessionId: 'session-one', workspace: f.workspace };
  const scrubbedSerialized = largeResult();
  const refused = await persistToolResultOverflow({ ctx, store: f.store, ensureSandbox: async () => { throw new Error('sensitive provision detail'); }, scrubbedSerialized, canRead: true });
  assert.deepEqual(refused, { overflow_error: 'sandbox_unavailable' });
  const failed = await persistToolResultOverflow({ ctx, store: f.store, ensureSandbox: async context => { context.sandbox = { files: { write: async () => { throw new Error('sensitive write detail'); } } }; }, scrubbedSerialized, canRead: true });
  assert.deepEqual(failed, { overflow_error: 'sandbox_write_failed' });
  assert.ok(f.store.list('tool_result_overflows').every(record => record.status === 'unavailable' && !record.overflow_path));
  const storeFailure = await persistToolResultOverflow({ ctx, store: { put: () => { throw new Error('sensitive storage detail'); } }, ensureSandbox: f.ensureSandbox, scrubbedSerialized, canRead: true });
  assert.deepEqual(storeFailure, { overflow_error: 'persistence_failed' });
  assert.equal(f.provisionCount(), 0);
});

test('a persistence failure after a real write still withholds the pointer', async t => {
  const f = await fixture(t);
  const scrubbedSerialized = largeResult();
  let writes = 0;
  const store = { put: (...args) => {
    if (++writes === 2) throw new Error('sensitive database detail');
    return f.store.put(...args);
  } };
  const result = await persistToolResultOverflow({ ctx: { sessionId: 'session-one', workspace: f.workspace }, store, ensureSandbox: f.ensureSandbox, scrubbedSerialized, canRead: true });
  assert.deepEqual(result, { overflow_error: 'persistence_failed' });
  assert.equal(writes, 2);
  assert.equal(f.store.list('tool_result_overflows')[0].status, 'unavailable');
  const [artifact] = await readdir(join(f.workspace, '.opulent-tool-results'));
  assert.equal(decodeChunks(await readFile(join(f.workspace, '.opulent-tool-results', artifact), 'utf8')), scrubbedSerialized);
});

test('stores only the caller-provided already-scrubbed JSON', async t => {
  const f = await fixture(t);
  const secret = 'private-test-value';
  const scrubbedSerialized = JSON.stringify(redact({ text: `${'x'.repeat(90_000)} ${secret}` }, [secret]));
  const ctx = { sessionId: 'session-one', workspace: f.workspace };
  const result = await persistToolResultOverflow({ ctx, store: f.store, ensureSandbox: f.ensureSandbox, scrubbedSerialized, canRead: true });
  const file = await readFile(join(f.workspace, result.overflow_path), 'utf8');
  const record = f.store.list('tool_result_overflows')[0];
  assert.ok(file.includes('[redacted]'));
  assert.ok(!file.includes(secret));
  assert.ok(!JSON.stringify(record).includes(secret));
  assert.equal(decodeChunks(file), record.scrubbed_serialized);
});

test('real file handler confines the generated artifact against workspace symlinks and traversal', async t => {
  const f = await fixture(t);
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(f.workspace, '.opulent-tool-results'));
  const ctx = { sessionId: 'session-one', workspace: f.workspace };
  const result = await persistToolResultOverflow({ ctx, store: f.store, ensureSandbox: f.ensureSandbox, scrubbedSerialized: largeResult(), canRead: true });
  assert.deepEqual(result, { overflow_error: 'sandbox_write_failed' });
  assert.deepEqual(await readdir(outside), []);
  assert.equal(f.store.list('tool_result_overflows')[0].status, 'unavailable');
  await assert.rejects(createTools(ctx).write({ file_path: '../outside/escape.json', content: 'forbidden' }), /escapes workspace/);
  assert.deepEqual(await readdir(outside), []);
});
