import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';
import { createRuntimeServer } from '../server.mjs';
import { createStorage } from '../storage.mjs';

test('every included tool has a handler and excluded families are absent', async () => {
  const runtime = createRuntime({ store: createStore(':memory:') });
  try {
    const session = runtime.allocate();
    const coverage = runtime.coverage(session.id);
    assert.equal(coverage.required, 97);
    assert.deepEqual(coverage.missing, []);
    assert.ok(!coverage.registered.includes('ask_question'));
    await assert.rejects(runtime.invoke(session.id, 'write', {}), /Invalid write arguments/);
    await assert.rejects(runtime.invoke(session.id, 'end_voice_call', {}), /not in the configured/);
  } finally { await runtime.close(); }
});

test('durable SQLite records survive restart without marking interrupted work complete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-state-'));
  try {
    const first = createStore(join(dir, 'state.db'));
    first.put('sessions', 'old', { status: 'running' });
    first.put('knowledge', 'note', { content: 'preserved' });
    first.close();
    const runtime = createRuntime({ store: createStore(join(dir, 'state.db')) });
    assert.equal(runtime.store.get('sessions', 'old').status, 'interrupted');
    assert.equal(runtime.store.get('knowledge', 'note').content, 'preserved');
    await runtime.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('agent loop invokes validated real handlers and persists its output', async () => {
  let calls = 0;
  const runtime = createRuntime({ store: createStore(':memory:'), model: async () => ({ choices: [{ message: ++calls === 1
    ? { role: 'assistant', content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'devin_playbook_manage', arguments: JSON.stringify({ action: 'create', title: 'Test', content: 'Instructions' }) } }] }
    : { role: 'assistant', content: 'Saved' } }] }) });
  try {
    const session = await runtime.startSession({ prompt: 'Create a test playbook' });
    const final = await runtime.waitSession(session.id);
    assert.equal(final.status, 'completed');
    assert.equal(final.output, 'Saved');
    assert.equal(runtime.store.list('playbooks').length, 1);
    assert.equal(calls, 2);
    assert.equal(runtime.store.list('events').filter(row => row.type === 'tool_finished')[0].data.ok, true);
  } finally { await runtime.close(); }
});

test('agent stop tool ends the turn and does not continue generating', async () => {
  let calls = 0;
  const runtime = createRuntime({ store: createStore(':memory:'), model: async () => {
    calls++;
    return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'stop', type: 'function', function: { name: 'stop', arguments: '{}' } }] } }] };
  } });
  try {
    const session = await runtime.startSession({ prompt: 'Stop' });
    assert.equal((await runtime.waitSession(session.id)).status, 'sleeping');
    assert.equal(calls, 1);
  } finally { await runtime.close(); }
});

test('HTTP server requires authorization and keeps scoped script calls isolated', async () => {
  const runtime = createRuntime({ store: createStore(':memory:') });
  const session = runtime.allocate();
  const token = 'test-runtime-token-with-at-least-32-characters';
  const server = createRuntimeServer(runtime, { token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/tools`)).status, 401);
    const result = await fetch(`${base}/tools`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await result.json()).coverage.missing.length, 0);
    const scoped = runtime.context(session.id).config.scriptToken;
    const headers = { Authorization: `Bearer ${scoped}`, 'Content-Type': 'application/json' };
    const response = await fetch(`${base}/sessions/${session.id}/tools`, { method: 'POST', headers, body: JSON.stringify({ name: 'list_knowledge_notes', args: {} }) });
    assert.deepEqual(await response.json(), { result: [] });
    const denied = await fetch(`${base}/sessions/${session.id}/tools`, { method: 'POST', headers, body: JSON.stringify({ name: 'request_secret', args: { secret_name: 'secret' } }) });
    assert.equal(denied.status, 400);
    const indirect = await fetch(`${base}/sessions/${session.id}/tools`, { method: 'POST', headers, body: JSON.stringify({ name: 'devin_mcp', args: { command: 'call_tool', tool_name: 'request_secret', tool_args: JSON.stringify({ secret_name: 'secret' }) } }) });
    assert.equal(indirect.status, 400);
    const other = runtime.allocate();
    const cross = await fetch(`${base}/sessions/${other.id}/tools`, { method: 'POST', headers, body: JSON.stringify({ name: 'list_knowledge_notes', args: {} }) });
    assert.equal(cross.status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); await runtime.close(); }
});

test('storage writes real SDK commits and refuses secret-bearing paths', async () => {
  const commits = [];
  const storage = createStorage({ storageRepo: 'test', authorName: 'Test runtime', authorEmail: 'runtime@example.invalid' }, { repo: () => ({
    createCommit: options => {
      const files = {};
      const builder = { addFile: (path, bytes) => { files[path] = bytes; return builder; }, send: async () => { commits.push({ options, files }); return { commitSha: 'abc123' }; } };
      return builder;
    },
    getFileStream: async () => new Response('restored'),
  }) });
  assert.equal(await storage.saveFiles({ repoId: 'test', branch: 'main', message: 'Save artifact', files: { 'artifacts/test.txt': 'hello' } }), 'abc123');
  assert.equal(commits[0].files['artifacts/test.txt'], 'hello');
  assert.equal((await storage.readFile({ repoId: 'test', ref: 'abc123', path: 'artifacts/test.txt' })).toString(), 'restored');
  await assert.rejects(storage.saveFiles({ repoId: 'test', branch: 'main', message: 'unsafe', files: { '.env': 'secret' } }), /Credential files/);
  await assert.rejects(storage.readFile({ repoId: 'other', ref: 'abc', path: 'file' }), /not configured or allowed/);
});

test('session secrets reach only sandbox calls and cannot become results or Git artifacts', async () => {
  let received;
  const sandbox = { sandboxId: 'test', files: { makeDir: async () => {} }, commands: { run: async (_, options) => { received = options.envs; return { stdout: options.envs.DEMO_SECRET }; } }, kill: async () => {} };
  const runtime = createRuntime({ store: createStore(':memory:'), provision: async () => sandbox, storage: { saveFiles: async () => { throw new Error('must not write'); } } });
  try {
    const session = runtime.allocate();
    const ctx = runtime.context(session.id);
    await ctx.injectSessionSecret({ sessionId: session.id, name: 'DEMO_SECRET', value: 'private-test-value' });
    ctx.tools.read = async () => ctx.sandbox.commands.run('controlled test command');
    const result = await runtime.invoke(session.id, 'read', { file_path: 'test.txt' });
    assert.equal(received.DEMO_SECRET, 'private-test-value');
    assert.equal(result.stdout, '[redacted]');
    await assert.rejects(ctx.storage.saveFiles({ files: { 'file.txt': 'private-test-value' } }), /cannot be committed/);
    assert.ok(!JSON.stringify(runtime.store.list('events')).includes('private-test-value'));
  } finally { await runtime.close(); }
});

test('resumed desktop checks the existing daemon instead of replacing its token', async () => {
  let bootstraps = 0, readyChecks = 0, calls = 0;
  const sandbox = { sandboxId: 'desktop', files: { makeDir: async () => {} }, pause: async () => {}, kill: async () => {} };
  const runtime = createRuntime({ store: createStore(':memory:'), provision: async () => sandbox, connect: async () => sandbox,
    computerFactory: () => ({ bootstrap: async () => { bootstraps++; }, ready: async () => { readyChecks++; }, action: async () => ({ ok: true }) }),
    model: async () => ({ choices: [{ message: ++calls % 2 ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${calls}`, type: 'function', function: { name: 'computer', arguments: JSON.stringify({ actions: [{ action: 'screenshot' }] }) } }] } : { role: 'assistant', content: 'Complete' } }] }),
  });
  try {
    const session = await runtime.startSession({ prompt: 'Observe' });
    assert.equal((await runtime.waitSession(session.id)).status, 'completed');
    await runtime.messageSession(session.id, 'Observe again');
    assert.equal((await runtime.waitSession(session.id)).status, 'completed');
    assert.equal(bootstraps, 1);
    assert.equal(readyChecks, 1);
  } finally { await runtime.close(); }
});
