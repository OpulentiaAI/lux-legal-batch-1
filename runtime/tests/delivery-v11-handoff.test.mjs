import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';
import { RLM_HANDOFF_LIMITS } from '../rlm.mjs';

const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = (content, tool_calls) => ({ usage: { completion_tokens: 7 }, choices: [{ finish_reason: tool_calls ? 'tool_calls' : 'stop',
  message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) } }] });

function fixture(model) {
  const directory = mkdtempSync(join(tmpdir(), 'delivery-v11-handoff-'));
  const processes = new Set(), handles = [];
  const sandbox = { sandboxId: 'local-v11-handoff-fixture', files: {
    async makeDir(path) { mkdirSync(path, { recursive: true }); },
    async write(files) { for (const { path, data } of files) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); } },
    async read(path) { return readFileSync(path, 'utf8'); },
    async remove(path) { rmSync(path, { force: true }); },
  }, commands: { async run(command, options) {
    assert.match(command, /^python3 /);
    const process = spawn('python3', command.split(' ').slice(1), { cwd: options.cwd ?? directory, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: globalThis.process.env.PATH, HOME: globalThis.process.env.HOME, ...options.envs } });
    processes.add(process);
    process.once('exit', () => processes.delete(process));
    process.stdin.on('error', () => {});
    let stdout = '', stderr = '';
    process.stdout.on('data', value => { stdout += value; options.onStdout?.(value.toString()); });
    process.stderr.on('data', value => { stderr += value; options.onStderr?.(value.toString()); });
    const exited = new Promise((resolve, reject) => {
      process.once('error', reject);
      process.once('exit', code => resolve({ exitCode: code ?? -1, stdout, stderr }));
    });
    const handle = { sendStdin: async value => process.stdin.write(value), kill: async () => process.kill('SIGKILL'), wait: () => exited };
    handles.push(handle);
    return options.background ? handle : exited;
  } }, async kill() { for (const process of processes) process.kill('SIGKILL'); },
  async pause() { throw new Error('A resident handoff fixture must not pause'); } };
  let provisions = 0;
  const runtime = createRuntime({ store: createStore(':memory:'), provision: async () => { provisions++; return sandbox; },
    config: { workspace: directory, instructionProfile: 'opulent-delivery-v11', maxSteps: 8,
      runtimeCapabilities: ['rlm-v1'], rlmHandoffPolicy: 'rlm-handoff-v1', allowedTools: ['ipython', 'write', 'read'] }, model });
  return { runtime, directory, handles, provisions: () => provisions, async close() {
    await runtime.close();
    await sandbox.kill();
    await Promise.all(handles.map(handle => handle.wait()));
    assert.equal(processes.size, 0);
    rmSync(directory, { recursive: true, force: true });
  } };
}

test('empty-final recovery preserves completed file work and the handoff seal exactly once', async () => {
  let calls = 0, seal, preserved;
  const f = fixture(async messages => {
    calls++;
    if (calls === 1) return response(null, [
      tool('write-once', 'write', { file_path: 'result.txt', content: 'Completed generic work\n' }),
      tool('invalid-write', 'write', { file_path: `${f.directory}-forbidden.txt`, content: 'Must remain forbidden' }),
      tool('read-once', 'read', { file_path: 'result.txt' }),
      tool('seal-once', 'ipython', { code: 'await rlm.handoff.finish()' }),
    ]);
    const session = f.runtime.store.list('sessions')[0];
    const handoff = f.runtime.context(session.id).rlm.completionCheck();
    assert.equal(handoff.ready, true);
    assert.equal(readFileSync(join(f.directory, 'result.txt'), 'utf8'), 'Completed generic work\n');
    assert.equal(existsSync(`${f.directory}-forbidden.txt`), false);
    const receipt = f.runtime.store.get('rlm_handoff_states', session.id).finish_receipt;
    assert(receipt);
    if (calls === 2) {
      seal = receipt;
      preserved = structuredClone(messages);
      assert.match(JSON.parse(messages.find(m => m.tool_call_id === 'invalid-write').content).error, /escapes workspace/);
      return response(null);
    }
    assert.equal(calls, 3);
    assert.equal(receipt, seal);
    assert.deepEqual(messages.slice(0, preserved.length), preserved);
    assert.equal(messages.at(-2).content, null);
    assert.match(messages.at(-1).content, /empty and was not accepted/);
    return response('Completed generic work; result.txt is saved and verified.');
  });
  try {
    const session = await f.runtime.startSession({ prompt: 'Save result.txt and verify the handoff' });
    const result = await f.runtime.waitSession(session.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.steps, 3);
    assert.equal(result.usage.completion_tokens, 21);
    assert.equal(f.runtime.store.list('sessions').length, 1);
    assert.equal(f.provisions(), 1);
    assert.equal(f.runtime.store.get('rlm_handoff_states', session.id).finish_receipt, seal);
    assert.equal(f.runtime.store.list('rlm_handoff_receipts').filter(r => r.body.kind === 'finish').length, 1);
    const events = f.runtime.store.list('events');
    for (const id of ['write-once', 'invalid-write', 'read-once', 'seal-once']) assert.equal(events.filter(e => e.type === 'tool_finished' && e.data.tool_call_id === id).length, 1);
    assert.equal(events.find(e => e.type === 'tool_finished' && e.data.tool_call_id === 'invalid-write').data.ok, false);
    assert.equal(events.filter(e => e.type === 'empty_final_response_rejected').length, 1);
    assert.equal(events.filter(e => e.type === 'rlm_handoff_completion_checked').length, 1);
    assert.equal(events.filter(e => e.type === 'session_completed').length, 1);
  } finally { await f.close(); }
});

test('a nonempty follow-up still needs protected readback and the existing completion seal', async () => {
  let calls = 0, source;
  const f = fixture(async messages => {
    calls++;
    if (calls === 1) return response(null, [tool('capture', 'ipython', { code: 'ref = await rlm.handoff.capture(value="Preserved resident contribution")' })]);
    const session = f.runtime.store.list('sessions')[0];
    const handoff = f.runtime.context(session.id).rlm.completionCheck();
    if (calls === 2) {
      source = f.runtime.store.list('rlm_handoff_snapshots').find(row => row.origin.kind === 'parent-value');
      assert(source);
      assert.equal(handoff.ready, false);
      return response(' \t\n ');
    }
    assert.equal(f.runtime.store.get('rlm_handoff_snapshots', source.id).raw, source.raw);
    if (calls === 3) {
      assert.equal(handoff.ready, false);
      assert.equal(f.runtime.store.list('rlm_handoff_receipts').length, 0);
      return response('Premature nonempty completion');
    }
    if (calls === 4) {
      assert.equal(handoff.ready, false);
      assert.equal(f.runtime.store.get('sessions', session.id).output, undefined);
      assert.match(messages.at(-1).content, /contributing RLM handoff is not complete/);
      return response(null, [tool('blocked-finish', 'ipython', { code: 'await rlm.handoff.finish()' }),
        tool('read-protected-page', 'ipython', { code: 'await rlm.handoff.read(ref, view="raw")' })]);
    }
    if (calls === 5) {
      const blocked = JSON.parse(messages.find(m => m.tool_call_id === 'blocked-finish').content);
      assert.equal(blocked.ok, false);
      assert.equal(blocked.handoff_status.ready, false);
      assert.equal(blocked.handoff_status.receipt_id, null);
      assert(blocked.handoff_status.diagnostics.length > 0);
      assert(Buffer.byteLength(JSON.stringify(blocked)) <= RLM_HANDOFF_LIMITS.toolEnvelopeBytes);
      assert.equal(handoff.ready, false);
      return response(null, [tool('finish', 'ipython', { code: 'await rlm.handoff.finish()' })]);
    }
    assert.equal(calls, 6);
    assert.equal(handoff.ready, true);
    return response('Completed after actual protected readback and sealing');
  });
  try {
    const session = await f.runtime.startSession({ prompt: 'Preserve the contribution and complete its handoff' });
    const result = await f.runtime.waitSession(session.id);
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.output, 'Completed after actual protected readback and sealing');
    assert.equal(result.steps, 6);
    assert.equal(result.usage.completion_tokens, 42);
    assert.equal(f.provisions(), 1);
    assert.equal(f.handles.length, 1);
    const events = f.runtime.store.list('events');
    assert.equal(events.filter(e => e.type === 'rlm_handoff_completion_deferred').length, 1);
    assert.equal(events.filter(e => e.type === 'rlm_handoff_completion_checked').length, 1);
    assert.equal(events.filter(e => e.type === 'empty_final_response_rejected').length, 1);
    assert.equal(f.runtime.store.list('rlm_handoff_receipts').filter(row => row.confirmed && row.body.kind === 'page').length, 1);
    assert.equal(f.runtime.store.list('rlm_handoff_receipts').filter(row => row.confirmed && row.body.kind === 'finish').length, 1);
  } finally { await f.close(); }
});
