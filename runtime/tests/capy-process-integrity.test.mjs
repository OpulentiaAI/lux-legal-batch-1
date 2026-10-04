import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { CommandExitError } from 'e2b';
import { createCapyProcesses } from '../capy-processes.mjs';
import { createCapyControlTools, tickCapyWaits } from '../capy-control.mjs';
import { createStore } from '../store.mjs';
import { capyFixture } from './capy-runtime-fixture.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t, overrides = {}) {
  const store = createStore(':memory:'), finished = deferred(), events = [], commands = [];
  const output = { directory_available: true, backing_available: true, stdout: '', stderr: '', stdout_available: true,
    stderr_available: true, identity: '12345:6789', process_alive: true };
  const ctx = { sessionId: 'process-integrity', store, workspace: '/mock-only', config: { sandboxTimeoutMs: 120000 },
    emit: (type, data) => events.push({ type, data }), ensureSandbox: async () => {},
    scrub: value => JSON.parse(JSON.stringify(value).replaceAll('synthetic-process-secret', '[redacted]')),
    sandbox: { files: { makeDir: async () => {} }, commands: { async run(command, options) {
      commands.push({ command, options });
      if (options.background) return overrides.launch ? overrides.launch() : {
        pid: 12345, wait: () => overrides.wait ? overrides.wait() : finished.promise,
        kill: async () => { throw new Error('PID-only handle cancellation is forbidden'); },
      };
      if (command.includes('def members():')) {
        if (overrides.cancel) return overrides.cancel();
        output.process_alive = false;
        finished.resolve({ exitCode: 137 });
        return { exitCode: 0, stdout: JSON.stringify({ outcome: 'confirmed' }) };
      }
      return overrides.read ? overrides.read(output) : { exitCode: 0, stdout: JSON.stringify(output) };
    } } } };
  store.put('sessions', ctx.sessionId, { status: 'running' });
  const processes = createCapyProcesses(ctx);
  t.after(async () => { finished.resolve({ exitCode: 0 }); await processes.drain(); store.close(); });
  return { ctx, store, processes, output, finished, events, commands,
    start: (args = {}) => processes.bash({ command: 'mock-only', description: 'Process integrity fixture', execution: 'background', ...args }) };
}

test('lost launch acknowledgement retains an owned live operation without reporting a failed process', async t => {
  const f = fixture(t, { launch: async () => { throw new Error('Launch transport disconnected'); } });
  const running = await f.start();
  assert.equal(running.status, 'running');
  assert.equal(running.transport_uncertain, true);
  assert.equal(running.transport_error.phase, 'launch');
  assert.equal(running.process_alive, true);
  assert.match(running.process_identity, /^\d+:\d+$/);
  assert.equal(f.events.length, 0);
  await f.processes.close();
  assert.equal(f.store.get('capy_operations', running.operation_id).status, 'cancelled');
  assert.equal(f.events.length, 1);
});

test('wait stream failure cannot finish a durable wait while its verified identity remains live', async t => {
  const f = fixture(t);
  const running = await f.start();
  const tools = createCapyControlTools({ ...f.ctx, getCapyProcess: (_, id) => f.processes.get(id) });
  const wait = await tools.wait({ description: 'Wait for the actual process', operation_ids: [running.operation_id] });
  f.finished.reject(new Error('Wait transport disconnected'));
  await f.processes.drain();
  const notifications = [];
  const tick = () => tickCapyWaits({ store: f.store, operation: (_, id) => f.processes.get(id),
    wakeSession: async (...args) => notifications.push(args) });
  await tick();
  assert.equal(f.store.get('capy_operations', running.operation_id).status, 'running');
  assert.equal(f.store.get('capy_waits', wait.wait_id).status, 'waiting');
  assert.equal(notifications.length, 0);
  assert.equal(f.events.filter(event => event.type === 'capy_process_finished').length, 0);
  await f.processes.close();
  await tick();
  assert.equal(f.store.get('capy_operations', running.operation_id).status, 'cancelled');
  assert.equal(f.store.get('capy_waits', wait.wait_id).status, 'notified');
  assert.equal(notifications.length, 1);
  assert.equal(f.events.filter(event => event.type === 'capy_process_finished').length, 1);
});

test('a reader transport failure cannot finish a durable wait or claim missing backing', async t => {
  const f = fixture(t), running = await f.start();
  const tools = createCapyControlTools({ ...f.ctx, getCapyProcess: (_, id) => f.processes.get(id) });
  const wait = await tools.wait({ description: 'Wait through reader uncertainty', operation_ids: [running.operation_id] });
  f.ctx.sandbox.commands.run = async () => { throw new Error('Reader transport unavailable'); };
  const notifications = [];
  await tickCapyWaits({ store: f.store, operation: (_, id) => f.processes.get(id), wakeSession: async (...args) => notifications.push(args) });
  const result = await f.processes.get(running.operation_id);
  assert.equal(result.status, 'running');
  assert.equal(result.backing_available, null);
  assert.equal(result.process_alive, null);
  assert.equal(result.transport_error.phase, 'read');
  assert.equal(f.store.get('capy_waits', wait.wait_id).status, 'waiting');
  assert.equal(notifications.length, 0);
  assert.equal(f.events.filter(event => event.type === 'capy_process_finished').length, 0);
});

test('a stream ending without an exit result stays uncertain rather than becoming a terminal failure', async t => {
  const f = fixture(t, { wait: async () => ({}) });
  const running = await f.start();
  await f.processes.drain();
  assert.equal(running.status, 'running');
  assert.equal(running.transport_error.phase, 'wait');
  assert.equal(f.events.length, 0);
  await f.processes.close();
});

for (const phase of ['launch', 'wait']) test(`${phase} exit-code errors are real terminal evidence and notify only once`, async t => {
  const error = new CommandExitError({ exitCode: 7, error: 'synthetic-process-secret exit error', stdout: '', stderr: '' });
  const f = fixture(t, { [phase]: async () => { throw error; } });
  const result = await f.start();
  await f.processes.drain();
  assert.equal(result.status, 'failed');
  assert.equal(result.exit_code, 7);
  assert.equal(result.error, '[redacted] exit error');
  await f.processes.get(result.operation_id);
  await f.processes.cancel(result.operation_id);
  assert.equal(f.events.length, 1);
  assert(!JSON.stringify(f.store.list('capy_operations')).includes('synthetic-process-secret'));
});

test('a successful completion during cancellation wins immutably and is not duplicate-notified', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { cancel: () => { entered.resolve(); return release.promise; } });
  const running = await f.start();
  const cancelling = f.processes.cancel(running.operation_id);
  await entered.promise;
  f.finished.resolve({ exitCode: 0 });
  await f.processes.drain();
  assert.equal(f.store.get('capy_operations', running.operation_id).status, 'completed');
  f.output.process_alive = false;
  release.resolve({ exitCode: 0, stdout: JSON.stringify({ outcome: 'confirmed' }) });
  const final = await cancelling;
  assert.equal(final.status, 'completed');
  assert.equal(final.exit_code, 0);
  assert.deepEqual(f.events.map(event => event.data.status), ['completed']);
});

test('a signal exit observed during verified cancellation remains cancelled without overwriting a failure terminal', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { cancel: () => { entered.resolve(); return release.promise; } });
  const running = await f.start();
  const cancelling = f.processes.cancel(running.operation_id);
  await entered.promise;
  f.finished.reject(new CommandExitError({ exitCode: 137, error: 'Signal exit', stdout: '', stderr: '' }));
  await f.processes.drain();
  assert.equal(f.store.get('capy_operations', running.operation_id).status, 'running');
  assert.equal(f.store.get('capy_operations', running.operation_id).exit_code, 137);
  f.output.process_alive = false;
  release.resolve({ exitCode: 0, stdout: JSON.stringify({ outcome: 'confirmed' }) });
  assert.equal((await cancelling).status, 'cancelled');
  assert.deepEqual(f.events.map(event => event.data.status), ['cancelled']);
});

test('an unconfirmed cancellation still preserves an independently observed nonzero exit', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { cancel: () => { entered.resolve(); return release.promise; } });
  const running = await f.start();
  const cancelling = f.processes.cancel(running.operation_id);
  await entered.promise;
  f.finished.resolve({ exitCode: 7 });
  await f.processes.drain();
  release.resolve({ exitCode: 0, stdout: JSON.stringify({ outcome: 'unknown' }) });
  const final = await cancelling;
  assert.equal(final.status, 'failed');
  assert.equal(final.exit_code, 7);
  assert.match(final.cancellation_error, /could not be confirmed/);
  assert.deepEqual(f.events.map(event => event.data.status), ['failed']);
});

test('a reader failure racing successful completion returns a scrubbed diagnostic without rewriting the terminal', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  const running = await f.start();
  f.ctx.sandbox.commands.run = async () => { entered.resolve(); return release.promise; };
  const reading = f.processes.get(running.operation_id);
  await entered.promise;
  f.finished.resolve({ exitCode: 0 });
  await f.processes.drain();
  release.reject(new Error('synthetic-process-secret reader transport error'));
  const result = await reading;
  assert.equal(result.status, 'completed');
  assert.equal(result.exit_code, 0);
  assert.equal(result.backing_available, null);
  assert.equal(result.process_alive, null);
  assert.match(result.output_error, /\[redacted\] reader transport error/);
  assert.deepEqual(f.events.map(event => event.data.status), ['completed']);
  assert(!JSON.stringify(f.store.list('capy_operations')).includes('synthetic-process-secret'));
});

test('reader completion and SDK completion use the same first-terminal notification', async t => {
  const f = fixture(t), running = await f.start();
  f.output.exit_code = '0';
  f.output.process_alive = false;
  assert.equal((await f.processes.get(running.operation_id)).status, 'completed');
  f.finished.resolve({ exitCode: 0 });
  await f.processes.drain();
  await f.processes.cancel(running.operation_id);
  assert.deepEqual(f.events.map(event => event.data.status), ['completed']);
});

test('concurrent cancellation requests share one verified group cancellation and one terminal event', async t => {
  const f = fixture(t), running = await f.start();
  const results = await Promise.all([f.processes.cancel(running.operation_id), f.processes.cancel(running.operation_id)]);
  assert(results.every(result => result.status === 'cancelled'));
  assert.equal(f.commands.filter(call => call.command.includes('def members():')).length, 1);
  assert.equal(f.events.length, 1);
});

test('uncertain launch without an identity remains honest until its fixed deadline and never uses a PID-only kill', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const f = fixture(t, { launch: async () => { throw new Error('Launch acknowledgement unavailable'); } });
  delete f.output.identity;
  Object.assign(f.output, { process_alive: null, backing_available: false });
  const running = await f.start({ timeout: 1 });
  assert.equal(running.status, 'running');
  assert.equal(running.backing_available, false);
  assert.equal(running.process_alive, null);
  await assert.rejects(f.processes.cancel(running.operation_id), /identity is not established/);
  assert.equal(f.events.length, 0);
  const deadline = running.deadline_at;
  t.mock.timers.tick(1001);
  const expired = await f.processes.get(running.operation_id);
  assert.equal(expired.status, 'interrupted');
  assert.equal(expired.deadline_at, deadline);
  assert.match(expired.error, /deadline.*uncertain/);
  assert.equal(f.commands.filter(call => call.command.includes('def members():')).length, 0);
  assert.equal(f.events.length, 1);
});

test('a verified-live overdue process retains its immutable deadline and remains cleanup-addressable', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const f = fixture(t), running = await f.start({ timeout: 1 });
  f.finished.reject(new Error('Lost SDK stream'));
  await f.processes.drain();
  t.mock.timers.tick(1001);
  const overdue = await f.processes.get(running.operation_id);
  assert.equal(overdue.status, 'running');
  assert.equal(overdue.transport_error.phase, 'deadline');
  assert.equal(overdue.deadline_at, running.deadline_at);
  assert.equal(overdue.effective_timeout_seconds, 1);
  assert.equal(f.events.length, 0);
  await f.processes.close();
  assert.equal(f.store.get('capy_operations', running.operation_id).status, 'cancelled');
});

test('untrusted PID identities are refused before any process cancellation command', async t => {
  const f = fixture(t), running = await f.start();
  f.store.put('capy_operations', running.operation_id, { ...f.store.get('capy_operations', running.operation_id), process_identity: '1:2' });
  await assert.rejects(f.processes.cancel(running.operation_id), /identity is invalid/);
  assert.equal(f.commands.filter(call => call.command.includes('def members():')).length, 0);
  assert.equal(f.events.length, 0);
});

for (const phase of ['launch', 'wait', 'read', 'cancel']) test(`${phase} diagnostics and durable descriptions use the current synchronous session scrubber`, async t => {
  const f = fixture(t);
  f.ctx.scrub = value => JSON.parse(JSON.stringify(value).replaceAll('synthetic-process-secret', '[active scrubber]'));
  if (phase === 'launch') f.ctx.sandbox.commands.run = async (command, options) => {
    if (options.background) throw new Error('synthetic-process-secret launch error');
    return { exitCode: 0, stdout: JSON.stringify(f.output) };
  };
  const running = await f.start({ description: 'synthetic-process-secret description' });
  if (phase === 'wait') { f.finished.reject(new Error('synthetic-process-secret wait error')); await f.processes.drain(); }
  if (phase === 'read' || phase === 'cancel') {
    f.ctx.sandbox.commands.run = async command => {
      if (phase === 'read' || command.includes('def members():')) throw new Error(`synthetic-process-secret ${phase} error`);
      return { exitCode: 0, stdout: JSON.stringify(f.output) };
    };
  }
  const result = phase === 'cancel' ? await f.processes.cancel(running.operation_id) : await f.processes.get(running.operation_id);
  assert.equal(result.status, 'running');
  assert.equal(result.description, '[active scrubber] description');
  assert.equal(result.transport_error.phase, phase);
  assert.match(result.transport_error.message, /\[active scrubber\]/);
  assert(!JSON.stringify([result, f.store.list('capy_operations'), f.events]).includes('synthetic-process-secret'));
  assert.equal(f.events.length, 0);
});

async function liveIdentity(runtime, id) {
  for (let index = 0; index < 100; index++) {
    const result = await runtime.invoke(id.session, 'operation_get', { operation_id: id.operation });
    if (result.process_alive === true && result.process_identity) return result;
    await delay(10);
  }
  throw new Error('Local Linux process did not establish a live group identity');
}

for (const phase of ['launch', 'wait']) test(`local Linux ${phase} stream loss preserves the real live identity and close kills only its verified group`, async t => {
  const { runtime, sandboxes } = await capyFixture(t);
  const row = runtime.allocate();
  await runtime.invoke(row.id, 'write', { path: 'ready.txt', content: 'Ready' });
  const sandbox = sandboxes[0], original = sandbox.commands.run, stream = deferred();
  sandbox.commands.run = async (command, options) => {
    const result = await original(command, options);
    if (!options.background) return result;
    if (phase === 'launch') throw new Error('Local fixture lost launch acknowledgement');
    return { ...result, wait: () => stream.promise,
      kill: async () => { throw new Error('SDK PID-only kill must not be used'); } };
  };
  const command = `/usr/bin/python3 -I -c 'import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print(os.getpid(),flush=True); time.sleep(30)'`;
  const running = await runtime.invoke(row.id, 'bash', { command, description: 'Local Linux transport fixture', execution: 'background' });
  const before = await liveIdentity(runtime, { session: row.id, operation: running.operation_id });
  if (phase === 'wait') { stream.reject(new Error('Local fixture lost wait stream')); await runtime.context(row.id).capyProcesses.drain(); }
  let descendant;
  for (let index = 0; index < 100 && !descendant; index++) {
    descendant = (await readFile(`${before.output_directory}/stdout`, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim();
    if (!descendant) await delay(10);
  }
  assert.match(descendant, /^\d+$/);
  assert.equal((await runtime.invoke(row.id, 'operation_get', { operation_id: running.operation_id })).status, 'running');
  assert.equal(runtime.store.list('events').filter(event => event.type === 'capy_process_finished').length, 0);
  await runtime.context(row.id).capyProcesses.close();
  const after = await runtime.invoke(row.id, 'operation_get', { operation_id: running.operation_id });
  assert.equal(after.status, 'cancelled');
  assert.equal(after.process_alive, false);
  const stat = await readFile(`/proc/${descendant}/stat`, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  assert(stat === null || ['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]));
  assert.equal(after.deadline_at, before.deadline_at);
  assert.equal(runtime.store.list('events').filter(event => event.type === 'capy_process_finished').length, 1);
});

test('a local stale start-time identity never signals the running process and can be repaired for safe cleanup', async t => {
  const { runtime } = await capyFixture(t);
  const row = runtime.allocate();
  const running = await runtime.invoke(row.id, 'bash', { command: 'sleep 30', description: 'Local stale identity fixture', execution: 'background' });
  const before = await liveIdentity(runtime, { session: row.id, operation: running.operation_id });
  const [pid, started] = before.process_identity.split(':').map(Number);
  runtime.store.put('capy_operations', running.operation_id, { ...runtime.store.get('capy_operations', running.operation_id), process_identity: `${pid}:${started + 1}` });
  const refused = await runtime.invoke(row.id, 'operation_cancel', { operation_id: running.operation_id });
  assert.equal(refused.status, 'running');
  assert.match(refused.cancellation_error, /could not be confirmed/);
  const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
  const stat = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  assert.equal(Number(stat[19]), started);
  assert(!['Z', 'X'].includes(stat[0]));
  assert.equal(runtime.store.list('events').filter(event => event.type === 'capy_process_finished').length, 0);
  runtime.store.put('capy_operations', running.operation_id, { ...runtime.store.get('capy_operations', running.operation_id), process_identity: before.process_identity });
  await runtime.context(row.id).capyProcesses.close();
  assert.equal((await runtime.invoke(row.id, 'operation_get', { operation_id: running.operation_id })).status, 'cancelled');
});
