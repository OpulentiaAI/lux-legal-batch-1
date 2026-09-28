import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

const answer = (content, tool_calls) => ({ choices: [{ message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) } }] });
const call = (id, title) => ({ id, type: 'function', function: { name: 'devin_playbook_manage', arguments: JSON.stringify({ action: 'create', title, content: 'Instructions' }) } });

test('file-backed checkpoints survive SQLite close/reopen; unresolved effects are uncertain, never replayed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-restart-'));
  const file = join(directory, 'state.sqlite');
  const started = deferred(), release = deferred();
  let calls = 0, reconnects = 0;
  const sandbox = { sandboxId: 'persistent-sandbox', files: { makeDir: async () => {} },
    commands: { run: async () => ({ wait: async () => ({ exitCode: 0 }), kill: async () => {} }) },
    pause: async () => {}, kill: async () => {}, git: { clone: async () => {} } };
  const first = createRuntime({ store: createStore(file), model: async () => answer(null, [call('first', 'First'), call('second', 'Second')]),
    provision: async () => sandbox, connect: async () => { reconnects++; return sandbox; } });
  let session;
  try {
    session = await first.startSession({ prompt: 'Create two' });
    const ctx = first.context(session.id);
    const original = ctx.tools.opulent_playbook_manage;
    ctx.tools.opulent_playbook_manage = async args => {
      calls++;
      if (args.title === 'Second') { started.resolve(); await release.promise; ctx.signal.throwIfAborted(); }
      return original(args);
    };
    await started.promise;
    assert.equal(first.store.get('conversations', session.id).pending_tool_call_id, 'second');
    assert.equal(first.store.list('playbooks').length, 1);
    await first.cancelSession(session.id);
    release.resolve();
    await first.waitSession(session.id);
  } finally { release.resolve(); await first.close(); }
  const persisted = createStore(file);
  persisted.put('sessions', session.id, { ...persisted.get('sessions', session.id), status: 'running', sandbox_id: sandbox.sandboxId });
  persisted.close();
  const reopened = createStore(file);
  const resumed = createRuntime({ store: reopened, connect: async () => { reconnects++; return sandbox; },
    model: async messages => {
      const replies = messages.filter(message => message.role === 'tool');
      assert.deepEqual(replies.map(reply => reply.tool_call_id), ['first', 'second']);
      assert.match(replies[1].content, /side effects are uncertain/);
      return answer('Inspected after interruption');
    } });
  try {
    assert.equal(reopened.get('sessions', session.id).status, 'interrupted');
    await resumed.messageSession(session.id, 'Resume and inspect');
    const settled = await resumed.waitSession(session.id);
    assert.equal(settled.output, 'Inspected after interruption', JSON.stringify(settled));
    assert.equal(reopened.list('playbooks').length, 1);
    assert.equal(calls, 2);
    assert.equal((await resumed.invoke(session.id, 'exec', { command: 'true' })).exit_code, 0);
    assert.equal(reconnects, 1);
  } finally { await resumed.close(); rmSync(directory, { recursive: true, force: true }); }
});
