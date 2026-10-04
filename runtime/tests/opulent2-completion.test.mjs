import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import '../../eval/opulent2-fixed/offline-guard.mjs';
import { createCapyFileTools } from '../capy-files.mjs';
import { checkOpulent2DriveReadback } from '../opulent2-completion.mjs';
import { createOpulent2DriveTools, exportOpulent2Drive, importOpulent2Drive, opulent2DriveDescriptors } from '../tools/opulent2-drive.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const body = 'OFFLINE_ARTIFACT_BODY_SENTINEL\n' + 'Source text, not metadata.\n'.repeat(100);

async function fixture(t, files = [{ path: 'notes/source.md', content: body }]) {
  const audit = join(homedir(), '.capy/work/opulent2-fixed-audit');
  await mkdir(audit, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(audit, 'opulent2-completion-tests-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tables = new Map();
  let sequence = 0;
  const store = {
    get: (table, id) => tables.get(table)?.get(id),
    list: table => [...(tables.get(table)?.values() ?? [])],
    put: (table, id, data) => {
      if (!tables.has(table)) tables.set(table, new Map());
      const row = { ...structuredClone(data), id };
      tables.get(table).set(id, row);
      return row;
    },
  };
  const blocked = () => { throw new Error('Offline guard must not invoke a model, VM, tool or emit source contents'); };
  const ctx = { sessionId: 'root', store, secrets: new Map(), config: { stateDir: join(root, 'state'), opulent2Drive: {
    organizationId: 'test-org', userId: 'test-user', projectId: 'test-project', scopes: ['project'], root: join(root, 'vm/.capy/drive'),
  } }, model: blocked, ensureSandbox: blocked, invoke: blocked, emit: blocked };
  store.put('sessions', 'root', { parent_session_id: null, sandbox_id: 'owned-root-vm', status: 'running' });
  const transfer = await exportOpulent2Drive(ctx);
  transfer.scopes[0].files = files.map(file => ({ ...file, bytes: Buffer.byteLength(file.content), sha256: sha256(file.content) }));
  transfer.scopes[0].revision = files.length ? 1 : 0;
  await importOpulent2Drive(ctx, transfer, { materialize: false });
  const mount = opulent2DriveDescriptors(ctx)[0];
  const filePath = path => `${mount.mountPath}/${path}`;
  const put = (table, row) => store.put(table, row.id ?? `fixture-${++sequence}`, row);
  const saved = file => ({ kind: 'drive_write', backing: 'local-sqlite', cloudService: false, scope: 'project', path: file.path,
    filePath: filePath(file.path), bytes: file.bytes, sha256: file.sha256, revision: 1 });
  const acknowledge = (file = transfer.scopes[0].files[0], sessionId = 'root') => {
    const result = saved(file);
    return put('capy_tool_results', { session_id: sessionId, name: 'drive_write', tool_call_id: `write-${++sequence}`,
      complete_result: result, returned_result: result, created_at: new Date().toISOString() });
  };
  const receipt = (sessionId, callId, value, overrides = {}) => put('capy_model_requests', { session_id: sessionId, phase: 'answerer', status: 'completed',
    messages: [{ role: 'tool', tool_call_id: callId, content: JSON.stringify(value) }], ...overrides });
  const readRecord = (name, result, sessionId = 'root') => put('capy_tool_results', { session_id: sessionId, name,
    tool_call_id: `read-${++sequence}`, complete_result: result, returned_result: result, created_at: new Date().toISOString() });
  const driveRead = async (path = transfer.scopes[0].files[0].path, sessionId = 'root') => readRecord('drive_read',
    await createOpulent2DriveTools(ctx).drive_read({ scope: 'project', path }), sessionId);
  const executeRead = async payload => {
    const read = await driveRead();
    delete read.tool_call_id;
    Object.assign(read, { execute_run_id: `run-${++sequence}`, execute_call_id: 1 });
    put('capy_execute_calls', { session_id: read.session_id, run_id: read.execute_run_id, call_id: 1, name: read.name, status: 'completed' });
    const value = { run_id: read.execute_run_id, status: 'completed', value: payload(read.complete_result), logs: [], effects: [] };
    const outer = put('capy_tool_results', { session_id: read.session_id, name: 'execute', tool_call_id: `execute-${++sequence}`, complete_result: value, returned_result: value });
    store.put('capy_operations', read.execute_run_id, { session_id: read.session_id, kind: 'execute', status: 'completed', model_visible_result: value });
    receipt(read.session_id, outer.tool_call_id, value);
    return { read, outer };
  };
  const rewrite = (path, content) => {
    const db = new DatabaseSync(join(ctx.config.stateDir, 'opulent2-drive/drive.sqlite'));
    try {
      const row = db.prepare('SELECT id,state FROM scopes').get();
      const state = JSON.parse(row.state);
      state.files = state.files.filter(file => file.path !== path);
      if (content !== undefined) state.files.push({ path, content, bytes: Buffer.byteLength(content), sha256: sha256(content) });
      state.files.sort((left, right) => left.path.localeCompare(right.path));
      state.revision++;
      db.prepare('UPDATE scopes SET state=? WHERE id=?').run(JSON.stringify(state), row.id);
    } finally { db.close(); }
  };
  return { ctx, store, put, files: transfer.scopes[0].files, filePath, acknowledge, receipt, readRecord, driveRead, executeRead, rewrite,
    expected: file => ({ scope: 'project', path: file.path, sha256: file.sha256 }) };
}

function page(content, path, { offset = 1, limit = 2000, character_offset = 0 } = {}) {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const window = lines.slice(offset - 1, offset - 1 + limit).join('');
  const visible = window.slice(character_offset, character_offset + 60000);
  return { kind: 'read', path, content: visible, offset, limit, total_lines: lines.length, character_offset, window_characters: window.length,
    next_character_offset: character_offset + visible.length < window.length ? character_offset + visible.length : null,
    next_offset: offset - 1 + limit < lines.length ? offset + limit : null };
}

test('a genuine full Drive result in a completed same-session prepared input passes without requiring response IDs', async t => {
  const f = await fixture(t);
  f.acknowledge();
  const read = await f.driveRead();
  f.receipt('root', read.tool_call_id, read.returned_result);
  const before = sha256(JSON.stringify(f.store.list('capy_model_requests')));
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [], checked: 1 });
  assert.equal(sha256(JSON.stringify(f.store.list('capy_model_requests'))), before);
});

test('execute can return the full result or exact contents, but a head/tail/hash return does not count', async t => {
  for (const payload of [result => result, result => result.content]) {
    const f = await fixture(t);
    f.acknowledge();
    await f.executeRead(payload);
    assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [], checked: 1 });
  }
  const f = await fixture(t);
  f.acknowledge();
  await f.executeRead(result => ({ bytes: result.bytes, sha256: result.sha256, head: result.content.slice(0, 500), tail: result.content.slice(-500) }));
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [f.expected(f.files[0])], checked: 1 });
});

test('missing, failed, interrupted, summary-only, foreign-session, wrong-call and user-role receipts remain pending', async t => {
  for (const overrides of [null, { status: 'failed' }, { status: 'interrupted' }, { status: 'started' }, { phase: 'context_compaction' },
    { session_id: 'foreign' }, { messages: [] }, { wrongCall: true }, { userRole: true }]) {
    const f = await fixture(t);
    f.acknowledge();
    const read = await f.driveRead();
    if (overrides) {
      const receipt = f.receipt('root', read.tool_call_id, read.returned_result, overrides);
      if (overrides.wrongCall) receipt.messages[0].tool_call_id = 'unrelated-call';
      if (overrides.userRole) receipt.messages[0].role = 'user';
    }
    assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [f.expected(f.files[0])], checked: 1 });
  }
});

test('successful internal tool execution alone, foreign execute linkage and failed nested calls cannot establish observation', async t => {
  for (const mutate of [
    f => { f.store.list('capy_model_requests')[0].messages = [] },
    f => { f.store.list('capy_tool_results').find(record => record.name === 'execute').session_id = 'foreign' },
    f => { f.store.list('capy_tool_results').find(record => record.name === 'execute').failed = true },
    f => { f.store.list('capy_tool_results').find(record => record.name === 'execute').complete_result.status = 'interrupted' },
    f => { f.store.list('capy_execute_calls')[0].status = 'failed' },
    f => { f.store.list('capy_execute_calls')[0].session_id = 'foreign' },
    f => { f.store.list('capy_execute_calls')[0].run_id = 'unrelated-run' },
  ]) {
    const f = await fixture(t);
    f.acknowledge();
    await f.executeRead(result => result);
    mutate(f);
    assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [f.expected(f.files[0])], checked: 1 });
  }
});

test('metadata fields cannot masquerade as returned text even when the file itself contains a relative path', async t => {
  const f = await fixture(t, [{ path: 'notes/source.md', content: 'notes/source.md' }]);
  f.acknowledge();
  await f.executeRead(result => ({ scope: result.scope, path: result.path, sha256: result.sha256, bytes: result.bytes }));
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [f.expected(f.files[0])], checked: 1 });
});

test('rewritten contents invalidate stale acknowledgments and readbacks, then a genuine correction can clear the guard', async t => {
  const f = await fixture(t);
  f.acknowledge();
  const stale = await f.driveRead();
  f.receipt('root', stale.tool_call_id, stale.returned_result);
  f.rewrite(f.files[0].path, 'New authoritative contents\né🙂\r\n');
  const current = (await exportOpulent2Drive(f.ctx)).scopes[0].files[0];
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [f.expected(current)], checked: 1 });
  f.acknowledge(current);
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [f.expected(current)], checked: 1 });
  const fresh = await f.driveRead();
  f.receipt('root', fresh.tool_call_id, fresh.returned_result);
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [], checked: 1 });
});

test('same-byte rewrites preserve a genuine current-content readback without a revision-only requirement', async t => {
  const f = await fixture(t);
  f.acknowledge();
  const read = await f.driveRead();
  f.receipt('root', read.tool_call_id, read.returned_result);
  f.rewrite(f.files[0].path, f.files[0].content);
  f.acknowledge((await exportOpulent2Drive(f.ctx)).scopes[0].files[0]);
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [], checked: 1 });
});

test('deleted files, untouched imports and files written only by unrelated sessions do not falsely block', async t => {
  const imported = await fixture(t);
  assert.deepEqual(await checkOpulent2DriveReadback(imported.ctx), { pending: [], checked: 0 });
  imported.acknowledge(imported.files[0], 'foreign');
  assert.deepEqual(await checkOpulent2DriveReadback(imported.ctx), { pending: [], checked: 0 });
  const deleted = await fixture(t);
  deleted.acknowledge();
  deleted.rewrite(deleted.files[0].path);
  assert.deepEqual(await checkOpulent2DriveReadback(deleted.ctx), { pending: [], checked: 0 });
});

test('owned child readbacks pass only with an actual owned sandbox and completed input from that same child', async t => {
  for (const sandbox of [true, false]) {
    const f = await fixture(t);
    f.acknowledge();
    f.store.put('sessions', 'child', { parent_session_id: 'root', status: 'completed', ...(sandbox ? { sandbox_id: 'owned-child-vm' } : {}) });
    const read = await f.driveRead(f.files[0].path, 'child');
    f.receipt('child', read.tool_call_id, read.returned_result);
    assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: sandbox ? [] : [f.expected(f.files[0])], checked: 1 });
  }
  const f = await fixture(t);
  f.acknowledge();
  f.store.put('sessions', 'other-root', { parent_session_id: null, sandbox_id: 'foreign-root-vm' });
  f.store.put('sessions', 'foreign-child', { parent_session_id: 'other-root', sandbox_id: 'foreign-child-vm' });
  const read = await f.driveRead(f.files[0].path, 'foreign-child');
  f.receipt('foreign-child', read.tool_call_id, read.returned_result);
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [f.expected(f.files[0])], checked: 1 });
});

test('full bash stdout and exact mounted-file reads pass, but headers, failed processes and wrong paths do not', async t => {
  for (const name of ['bash', 'read']) {
    const f = await fixture(t);
    f.acknowledge();
    const result = name === 'bash' ? { status: 'completed', exit_code: 0, stdout: body, stderr: '' } : page(body, f.filePath(f.files[0].path));
    const read = f.readRecord(name, result);
    f.receipt('root', read.tool_call_id, read.returned_result);
    assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [], checked: 1 });
  }
  for (const result of [{ status: 'completed', exit_code: 0, stdout: body.slice(0, 500) }, { status: 'failed', exit_code: 1, stdout: body },
    page(body, '/foreign/notes/source.md')]) {
    const f = await fixture(t);
    f.acknowledge();
    const read = f.readRecord(result.kind === 'read' ? 'read' : 'bash', result);
    f.receipt('root', read.tool_call_id, read.returned_result);
    assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [f.expected(f.files[0])], checked: 1 });
  }
});

test('paged mounted-file readbacks preserve UTF-8 contents and require complete same-session coverage without gaps', async t => {
  const content = 'é🙂\r\n' + 'x'.repeat(125000);
  const f = await fixture(t, [{ path: 'notes/large.md', content }]);
  f.acknowledge();
  const path = f.filePath(f.files[0].path);
  const first = f.readRecord('read', page(content, path, { character_offset: 0 }));
  f.receipt('root', first.tool_call_id, first.returned_result);
  const last = f.readRecord('read', page(content, path, { character_offset: 120000 }));
  f.receipt('root', last.tool_call_id, last.returned_result);
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [f.expected(f.files[0])], checked: 1 });
  const middle = f.readRecord('read', page(content, path, { character_offset: 60000 }));
  f.receipt('root', middle.tool_call_id, middle.returned_result);
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [], checked: 1 });
  middle.complete_result.content = 'A stale or fabricated window';
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [f.expected(f.files[0])], checked: 1 });
});

test('line-paged readbacks cannot be assembled from unobserved or different-session fragments', async t => {
  const f = await fixture(t);
  f.acknowledge();
  f.store.put('sessions', 'child', { parent_session_id: 'root', sandbox_id: 'owned-child-vm' });
  const first = f.readRecord('read', page(body, f.filePath(f.files[0].path), { offset: 1, limit: 50 }));
  f.receipt('root', first.tool_call_id, first.returned_result);
  const last = f.readRecord('read', page(body, f.filePath(f.files[0].path), { offset: 51, limit: 2000 }), 'child');
  f.receipt('child', last.tool_call_id, last.returned_result);
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [f.expected(f.files[0])], checked: 1 });
  const rootLast = f.readRecord('read', last.complete_result);
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [f.expected(f.files[0])], checked: 1 });
  f.receipt('root', rootLast.tool_call_id, rootLast.returned_result);
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [], checked: 1 });
});

test('actual Capy file-tool UTF-16 windows handle a non-BMP character across the 60000-character boundary', async t => {
  const content = 'x'.repeat(59999) + '🙂' + 'y'.repeat(70000);
  const f = await fixture(t, [{ path: 'notes/non-bmp.md', content }]);
  f.acknowledge();
  const path = f.filePath(f.files[0].path);
  const tools = createCapyFileTools({ ...f.ctx, workspace: '/workspace', sandbox: { files: { read: async (file, options) => {
    assert.equal(file, path);
    assert.equal(options.format, 'bytes');
    return Buffer.from(content);
  } } } });
  for (let character_offset = 0; character_offset < content.length; character_offset += 60000) {
    const result = await tools.read({ path, character_offset });
    const read = f.readRecord('read', result);
    f.receipt('root', read.tool_call_id, read.returned_result);
  }
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [], checked: 1 });
  f.store.list('capy_tool_results').find(record => record.name === 'read').complete_result.content = Array.from(content).slice(0, 60000).join('');
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [f.expected(f.files[0])], checked: 1 });
});

test('a file-backed full Drive result needs actual completed paged observations, not its preview or digest', async t => {
  const content = 'x'.repeat(140000) + '\né🙂\r\n';
  const f = await fixture(t, [{ path: 'notes/large.md', content }]);
  f.acknowledge();
  const read = await f.driveRead();
  const serialized = JSON.stringify(read.complete_result);
  const outputPath = '/workspace/.capy/results/full-drive-result.json';
  const retained = f.put('capy_results', { id: 'persisted-drive-result', session_id: 'root', status: 'available', serialized,
    sha256: sha256(serialized), characters: serialized.length, output_path: outputPath });
  read.returned_result = { kind: 'file_backed_result', result_id: retained.id, truncated: true, preview: serialized.slice(0, 16000),
    characters: serialized.length, sha256: retained.sha256, output_path: outputPath };
  f.receipt('root', read.tool_call_id, read.returned_result);
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [f.expected(f.files[0])], checked: 1 });
  for (let character_offset = 0; character_offset < serialized.length; character_offset += 60000) {
    const window = f.readRecord('read', page(serialized, outputPath, { character_offset }));
    f.receipt('root', window.tool_call_id, window.returned_result);
  }
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [], checked: 1 });
  retained.session_id = 'foreign';
  assert.deepEqual(await checkOpulent2DriveReadback(f.ctx), { pending: [f.expected(f.files[0])], checked: 1 });
});

test('empty files require a real read, and diagnostics contain only scoped path/hash metadata', async t => {
  const empty = await fixture(t, [{ path: 'notes/empty.md', content: '' }]);
  empty.acknowledge();
  assert.deepEqual(await checkOpulent2DriveReadback(empty.ctx), { pending: [empty.expected(empty.files[0])], checked: 1 });
  const read = await empty.driveRead();
  empty.receipt('root', read.tool_call_id, read.returned_result);
  assert.deepEqual(await checkOpulent2DriveReadback(empty.ctx), { pending: [], checked: 1 });
  const f = await fixture(t);
  f.acknowledge();
  const result = await checkOpulent2DriveReadback(f.ctx);
  assert.deepEqual(Object.keys(result.pending[0]).sort(), ['path', 'scope', 'sha256']);
  assert(!JSON.stringify(result).includes('OFFLINE_ARTIFACT_BODY_SENTINEL'));
  f.ctx.sessionId = 'foreign';
  await assert.rejects(checkOpulent2DriveReadback(f.ctx), /owned lead session/);
});
