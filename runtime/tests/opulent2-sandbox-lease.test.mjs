import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as flush } from 'node:timers/promises';
import '../../eval/opulent2-fixed/offline-guard.mjs';
import { createOpulent2SandboxLease, OPULENT2_SANDBOX_LEASE_POLICY } from '../opulent2-sandbox-lease.mjs';
import { createCapyProcesses } from '../capy-processes.mjs';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';
import { OPULENT2_PROFILE } from '../instructions/opulent2.mjs';

const WINDOW = 3_600_000;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const completion = content => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: {} });

function fixture(t, { setTimeout: renew, pause, kill } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const requests = [], events = [], controller = new AbortController();
  const sandbox = { sandboxId: 'owned-fixture', files: { makeDir: async () => {} },
    async setTimeout(timeoutMs, options) {
      requests.push({ timeoutMs, options, at: Date.now() });
      options.signal.throwIfAborted();
      await renew?.(timeoutMs, options);
    }, pause: pause ?? (async () => {}), kill: kill ?? (async () => {}) };
  const ctx = { sessionId: 'owner', sandbox, config: { sandboxTimeoutMs: WINDOW }, signal: controller.signal, controller,
    emit: (type, data) => events.push({ type, data }), workspace: '/vm/workspace', store: createStore(':memory:') };
  ctx.sandboxLease = createOpulent2SandboxLease(ctx);
  ctx.ensureSandbox = () => ctx.sandboxLease.ensure();
  t.after(async () => { await ctx.sandboxLease?.stop(); ctx.store.close(); });
  return { ctx, lease: ctx.sandboxLease, sandbox, requests, events };
}

async function runtimeFixture(t, { model = async () => completion('Actual offline completion'), profile = OPULENT2_PROFILE, pause, leaseRenewal } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'opulent2-lease-'));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const requests = [], sandboxes = [], connections = [];
  const provision = async () => {
    const sandbox = { sandboxId: `owned-${sandboxes.length + 1}`, files: {},
      commands: { async run(command, options) {
        assert.equal(options.user, 'user');
        assert.match(command, /setpriv --no-new-privs/);
        const result = { exitCode: 0, stdout: JSON.stringify({ result: true, ok: true }) };
        return options.background ? { pid: 1, wait: async () => result, sendStdin: async () => {}, kill: async () => {} } : result;
      } },
      async setTimeout(timeoutMs, options) {
        requests.push({ sandboxId: sandbox.sandboxId, timeoutMs, options, at: Date.now() });
        options.signal.throwIfAborted();
        await leaseRenewal?.(timeoutMs, options);
      },
      async pause() { await pause?.(sandbox); }, async kill() { sandbox.killed = true; },
    };
    sandboxes.push(sandbox);
    return sandbox;
  };
  const runtime = createRuntime({ storage: {}, model, provision, connect: async id => {
    connections.push(id);
    const sandbox = sandboxes.find(row => row.sandboxId === id);
    if (!sandbox || sandbox.killed) throw new Error('Owned sandbox not found; previous VM files are unavailable');
    return sandbox;
  }, config: { stateDir: join(root, 'state'), workspace: '/vm/workspace', instructionProfile: profile,
    sandboxTimeoutMs: WINDOW, maxSteps: 1000, model: 'offline-native-fixture', contextCompaction: { enabled: false },
    opulent2Drive: { organizationId: 'offline', userId: 'offline', projectId: 'lease', scopes: ['project'], root: '/home/user/.capy/drive' } } });
  let closing;
  const close = () => closing ??= runtime.close();
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  const parent = runtime.allocate();
  const child = runtime.allocate({ parent_session_id: parent.id, prompt: 'Actual offline lease assignment' });
  return { runtime, child, requests, sandboxes, connections, close };
}

function compactionHistory({ runtime, child }) {
  runtime.config.contextCompaction = { enabled: true, maxInputChars: 300000, maxSummaryInputChars: 160000, maxSummaryChars: 24000,
    maxSummaryTokens: 8192, recentGroups: 3, maxBatches: 8 };
  const messages = [{ role: 'system', content: 'Actual offline system' }, { role: 'user', content: 'Actual offline task' },
    ...Array.from({ length: 55 }, (_, index) => [
      { role: 'assistant', content: null, tool_calls: [{ id: `read-${index}`, type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: `read-${index}`, content: 'Actual offline source result'.padEnd(6000, '.') },
    ]).flat()];
  runtime.store.put('conversations', child.id, { messages, delivered: [] });
}

test('the configured one-hour lease renews before the former cutoff without enlarging its window', async t => {
  const f = fixture(t);
  await f.lease.renew();
  assert.equal(f.ctx.sandboxDeadlineAt, 1000 + WINDOW);
  for (let step = 0; step < 3; step++) { t.mock.timers.tick(WINDOW / 2); await flush(); }
  await f.lease.ensure();
  assert.equal(f.requests.length, 4);
  assert(f.requests.every(request => request.timeoutMs === WINDOW && request.options.requestTimeoutMs === 30_000));
  assert.equal(f.ctx.sandboxDeadlineAt, Date.now() + WINDOW);
  assert(f.events.every(event => event.data.version === OPULENT2_SANDBOX_LEASE_POLICY.version));
});

test('concurrent renewals coalesce and advance a conservative expiry only after successful acknowledgement', async t => {
  const confirmation = deferred();
  const f = fixture(t, { setTimeout: () => confirmation.promise });
  const first = f.lease.renew(), second = f.lease.renew();
  assert.equal(first, second);
  await flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.ctx.sandboxDeadlineAt, undefined);
  t.mock.timers.tick(5000);
  confirmation.resolve();
  await Promise.all([first, second]);
  assert.equal(f.ctx.sandboxDeadlineAt, 1000 + WINDOW);
  assert.equal(f.events.length, 1);
});

test('lease failure is visible, aborts active work and neither advances expiry nor schedules another renewal', async t => {
  let rejected = false;
  const providerFailure = Object.assign(new Error('private provider details'), { name: 'SandboxNotFoundError' });
  const f = fixture(t, { setTimeout: () => { if (rejected) throw providerFailure; } });
  await f.lease.renew();
  const before = f.ctx.sandboxDeadlineAt;
  rejected = true;
  t.mock.timers.tick(WINDOW / 2);
  await flush();
  assert.equal(f.ctx.sandboxDeadlineAt, before);
  assert.equal(f.ctx.signal.aborted, true);
  assert.equal(f.lease.failure.cause, providerFailure);
  await assert.rejects(f.lease.ensure(), /lease renewal failed \(SandboxNotFoundError\)/);
  const requests = f.requests.length;
  t.mock.timers.tick(WINDOW * 3);
  await flush();
  assert.equal(f.requests.length, requests);
  assert.equal(f.events.filter(event => event.type === 'opulent2_sandbox_lease_failed').length, 1);
  assert(!JSON.stringify(f.events).includes('private provider details'));
});

test('an unresponsive SDK renewal is bounded and cancellable even if its mock ignores cancellation', async t => {
  const acknowledgement = deferred();
  const f = fixture(t, { setTimeout: () => acknowledgement.promise });
  const renewal = f.lease.renew(), rejected = assert.rejects(renewal, /lease renewal failed/);
  await flush();
  t.mock.timers.tick(OPULENT2_SANDBOX_LEASE_POLICY.requestTimeoutMs);
  await rejected;
  assert.equal(f.requests[0].options.signal.aborted, true);
  assert.equal(f.lease.failure.cause.name, 'TimeoutError');
  assert.equal(f.ctx.sandboxDeadlineAt, undefined);
  acknowledgement.resolve();
  await flush();
  assert.equal(f.ctx.sandboxDeadlineAt, undefined);
  assert.equal(f.lease.active, false);
});

test('expired leases fail closed without treating a new request as proof of preserved VM backing', async t => {
  const f = fixture(t);
  await f.lease.renew();
  t.mock.timers.tick(WINDOW + 1);
  await flush();
  await assert.rejects(f.lease.ensure(), /lease expired.*must not be replaced silently/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.ctx.signal.aborted, true);
});

test('stop cancels an in-flight request and a late response cannot update a released owner', async t => {
  const confirmation = deferred();
  const f = fixture(t, { setTimeout: () => confirmation.promise });
  const renewal = f.lease.renew(), rejected = assert.rejects(renewal, /renewal stopped/);
  await flush();
  await f.lease.stop();
  await rejected;
  assert.equal(f.requests[0].options.signal.aborted, true);
  confirmation.resolve();
  await flush();
  assert.equal(f.ctx.sandboxDeadlineAt, undefined);
  assert.equal(f.events.length, 0);
  assert.equal(f.ctx.signal.aborted, false);
});

test('cancellation before SDK dispatch prevents a lease call after release', async t => {
  const f = fixture(t);
  const renewal = f.lease.renew(), rejected = assert.rejects(renewal, /renewal stopped/);
  await f.lease.stop();
  await rejected;
  assert.equal(f.requests.length, 0);
});

test('pause and kill serialize after renewal, refresh the collection window and leave no renewal behind', async t => {
  const confirmation = deferred(), collected = deferred(), effects = [];
  let delay = false;
  const f = fixture(t, { setTimeout: () => delay ? confirmation.promise : undefined,
    pause: async () => { effects.push('collection'); assert.equal(f.lease.active, false); await collected.promise; effects.push('pause'); },
    kill: async () => { effects.push('kill'); } });
  await f.lease.renew();
  delay = true;
  t.mock.timers.tick(WINDOW / 2);
  await flush();
  const paused = f.sandbox.pause(), killed = f.sandbox.kill();
  await flush();
  assert.deepEqual(effects, []);
  confirmation.resolve();
  await flush();
  assert.deepEqual(effects, ['collection']);
  assert.equal(f.ctx.sandboxDeadlineAt, Date.now() + WINDOW);
  const requests = f.requests.length;
  t.mock.timers.tick(WINDOW * 0.75);
  await flush();
  assert.equal(f.requests.length, requests);
  collected.resolve();
  await Promise.all([paused, killed]);
  assert.deepEqual(effects, ['collection', 'pause', 'kill']);
  t.mock.timers.tick(WINDOW);
  await flush();
  assert.equal(f.requests.length, requests);
});

test('an aborted owner can still release its VM without another renewal or unsafe resurrection', async t => {
  let kills = 0;
  const f = fixture(t, { kill: async () => { kills++; } });
  await f.lease.renew();
  f.ctx.controller.abort(new Error('Explicit cancellation'));
  await f.sandbox.kill();
  assert.equal(kills, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.lease.failure, undefined);
});

test('resume binds a fresh controller to the same owned VM without stacked lease renewals', async t => {
  let pauses = 0;
  const f = fixture(t, { pause: async () => { pauses++; } });
  await f.lease.renew();
  await f.sandbox.pause();
  t.mock.timers.tick(WINDOW);
  f.ctx.sandboxLease = createOpulent2SandboxLease(f.ctx);
  await f.ctx.sandboxLease.renew();
  t.mock.timers.tick(WINDOW / 2);
  await flush();
  await f.sandbox.pause();
  assert.equal(pauses, 2);
  assert.equal(f.requests.length, 5);
});

for (const execution of ['foreground', 'background', 'detached']) test(`${execution} command deadlines remain immutable across renewal and preserve declared limits`, async t => {
  const f = fixture(t), finished = deferred(), commands = [];
  let exitCode;
  f.sandbox.commands = { async run(command, options) {
    if (!command.startsWith('exec setsid')) return { exitCode: 0, stdout: JSON.stringify({ backing_available: true, stdout: '', stderr: '', process_alive: true,
      ...(exitCode === undefined ? {} : { exit_code: String(exitCode) }) }) };
    commands.push(options);
    setTimeout(() => { exitCode = 137; finished.resolve({ exitCode }); }, options.timeoutMs);
    return { pid: 1, wait: () => finished.promise, kill: async () => {} };
  } };
  await f.lease.renew();
  const processes = createCapyProcesses(f.ctx);
  const timeout = execution === 'foreground' ? 3600 : 21600;
  const pending = processes.bash({ command: 'actual bounded fixture command', description: 'Testing immutable command timeout', execution, timeout });
  await flush();
  const before = f.ctx.store.list('capy_operations')[0];
  assert.equal(before.effective_timeout_seconds, timeout);
  assert.equal(commands[0].timeoutMs, timeout * 1000);
  for (let step = 0; step < timeout / 1800; step++) {
    t.mock.timers.tick(WINDOW / 2);
    await flush();
    assert.equal(f.ctx.store.get('capy_operations', before.id).deadline_at, before.deadline_at);
  }
  await pending;
  await processes.drain();
  assert.equal(f.ctx.store.get('capy_operations', before.id).exit_code, 137);
  assert.equal(f.ctx.store.get('capy_operations', before.id).deadline_at, before.deadline_at);
  await assert.rejects(processes.bash({ command: 'true', description: 'Checking foreground cap', timeout: 3601 }), /cannot exceed 3600/);
});

test('legacy process defaults and fixed-lifecycle rejection remain unchanged', async t => {
  const f = fixture(t);
  await f.lease.stop();
  delete f.ctx.sandboxLease;
  f.ctx.sandboxDeadlineAt = Date.now() - 1;
  await assert.rejects(createCapyProcesses(f.ctx).bash({ command: 'true', description: 'Checking historical lifecycle', timeout: 120 }), /Sandbox lifecycle deadline exceeded/);
  assert.equal(f.requests.length, 0);
});

test('new commands after the former cutoff retain foreground and background default budgets', async t => {
  const f = fixture(t), commands = [];
  f.sandbox.commands = { async run(command, options) {
    if (command.startsWith('exec setsid')) {
      commands.push(options);
      return { pid: 1, wait: async () => ({ exitCode: 0 }), kill: async () => {} };
    }
    return { exitCode: 0, stdout: JSON.stringify({ backing_available: true, stdout: '', stderr: '', process_alive: false, exit_code: '0' }) };
  } };
  await f.lease.renew();
  for (let step = 0; step < 3; step++) { t.mock.timers.tick(WINDOW / 2); await flush(); }
  const processes = createCapyProcesses(f.ctx);
  for (const execution of ['foreground', 'background', 'detached']) {
    const result = await processes.bash({ command: 'true', description: 'Checking actual default timeout', execution });
    assert.equal(result.effective_timeout_seconds, execution === 'foreground' ? 120 : 1800);
  }
  await processes.drain();
  assert.deepEqual(commands.map(options => options.timeoutMs), [120000, 1800000, 1800000]);
});

test('missing renewal APIs and changes to the attached owner are refused without a provider fallback', async t => {
  assert.throws(() => createOpulent2SandboxLease({ sandbox: { sandboxId: 'unsupported' }, config: { sandboxTimeoutMs: WINDOW } }), /real lease renewal API/);
  const f = fixture(t);
  await f.lease.renew();
  f.ctx.sandbox = { sandboxId: 'unowned-fixture', setTimeout: () => { throw new Error('Unowned renewal must not run'); } };
  await assert.rejects(f.lease.ensure(), /owned sandbox lease is not active/);
  assert.equal(f.requests.length, 1);
});

test('long native answerer calls retain their VM through the former one-hour cutoff and release it on completion', async t => {
  const entered = deferred(), answer = deferred();
  let modelSignal;
  const f = await runtimeFixture(t, { model: async (messages, options) => { modelSignal = options.signal; entered.resolve(); return answer.promise; } });
  await f.runtime.messageSession(f.child.id, 'Actual offline native request');
  try {
    await entered.promise;
    const ctx = f.runtime.context(f.child.id), firstExpiry = ctx.sandboxDeadlineAt;
    for (let step = 0; step < 3; step++) { t.mock.timers.tick(WINDOW / 2); await flush(); }
    assert(Date.now() > firstExpiry);
    assert.equal(modelSignal.aborted, false);
    assert.equal(f.runtime.store.get('sessions', f.child.id).steps, 1);
    assert.equal(f.runtime.config.maxSteps, 1000);
    assert(f.requests.every(request => request.timeoutMs === WINDOW));
    answer.resolve(completion('Actual offline answer'));
    assert.equal((await f.runtime.waitSession(f.child.id)).status, 'completed');
    assert.equal(ctx.sandboxLease.active, false);
    const requests = f.requests.length;
    t.mock.timers.tick(WINDOW * 2);
    await flush();
    assert.equal(f.requests.length, requests);
    await f.runtime.messageSession(f.child.id, 'Explicit continuation');
    assert.equal((await f.runtime.waitSession(f.child.id)).status, 'completed');
    assert.deepEqual(f.connections, ['owned-1']);
    assert.equal(f.sandboxes.length, 1);
  } finally { answer.resolve(completion('Actual offline cleanup answer')); }
});

test('core does not publish a new Opulent2 lease expiry before provider acknowledgement', async t => {
  const entered = deferred(), acknowledged = deferred();
  const f = await runtimeFixture(t, { leaseRenewal: () => { entered.resolve(); return acknowledged.promise; } });
  await f.runtime.messageSession(f.child.id, 'Actual offline initial lease request');
  try {
    await entered.promise;
    const ctx = f.runtime.context(f.child.id);
    assert.equal(ctx.sandboxDeadlineAt, undefined);
    t.mock.timers.tick(5000);
    assert.equal(ctx.sandboxDeadlineAt, undefined);
    acknowledged.resolve();
    assert.equal((await f.runtime.waitSession(f.child.id)).status, 'completed');
    assert.equal(f.requests[0].at + WINDOW, 1000 + WINDOW);
    assert.equal(ctx.sandboxDeadlineAt, Date.now() + WINDOW);
  } finally { acknowledged.resolve(); }
});

test('long native compaction calls retain the VM and keep the original token and context budgets', async t => {
  const entered = deferred(), summary = deferred(), requests = [];
  const f = await runtimeFixture(t, { model: async (messages, options) => {
    requests.push(options);
    if (options.phase === 'context_compaction') { entered.resolve(options); return summary.promise; }
    return completion('Actual offline final');
  } });
  compactionHistory(f);
  await f.runtime.messageSession(f.child.id, 'Continue the actual offline task');
  try {
    const options = await entered.promise;
    assert.equal(options.max_tokens, 8192);
    const firstExpiry = f.runtime.context(f.child.id).sandboxDeadlineAt;
    for (let step = 0; step < 3; step++) { t.mock.timers.tick(WINDOW / 2); await flush(); }
    assert(Date.now() > firstExpiry);
    assert.equal(options.signal.aborted, false);
    summary.resolve(completion('Actual offline compacted source history'));
    const result = await f.runtime.waitSession(f.child.id);
    assert.equal(result.status, 'completed');
    assert(requests.filter(request => request.phase === 'context_compaction').every(request => request.max_tokens === 8192));
    assert.equal(f.runtime.config.contextCompaction.maxSummaryChars, 24000);
    assert.equal(f.runtime.config.contextCompaction.maxBatches, 8);
  } finally { summary.resolve(completion('Actual offline cleanup summary')); }
});

test('renewal failure aborts a native request and reports infrastructure failure instead of explicit cancellation', async t => {
  const entered = deferred();
  const f = await runtimeFixture(t, { model: (messages, options) => new Promise((resolve, reject) => {
    entered.resolve();
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }) });
  await f.runtime.messageSession(f.child.id, 'Actual offline failure request');
  await entered.promise;
  f.sandboxes[0].setTimeout = async () => { throw new Error('Offline provider rejection'); };
  t.mock.timers.tick(WINDOW / 2);
  await flush();
  const result = await f.runtime.waitSession(f.child.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /lease renewal failed/);
  assert.equal(f.sandboxes.length, 1);
  assert.equal(f.runtime.store.list('events').filter(row => row.type === 'opulent2_sandbox_lease_failed').length, 1);
});

test('a failed lease during native compaction preserves already-consumed summary usage', async t => {
  const entered = deferred();
  let batches = 0;
  const usage = { prompt_tokens: 17, completion_tokens: 19, total_tokens: 36 };
  const f = await runtimeFixture(t, { model: (messages, options) => {
    assert.equal(options.phase, 'context_compaction');
    assert.equal(options.max_tokens, 8192);
    if (++batches === 1) return { ...completion('Actual offline first batch'), usage };
    return new Promise((resolve, reject) => {
      entered.resolve();
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  } });
  compactionHistory(f);
  await f.runtime.messageSession(f.child.id, 'Continue the actual offline task');
  await entered.promise;
  f.sandboxes[0].setTimeout = async () => { throw new Error('Offline renewal failure'); };
  t.mock.timers.tick(WINDOW / 2);
  await flush();
  const result = await f.runtime.waitSession(f.child.id);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.usage, usage);
  assert.equal(batches, 2);
});

test('quiesce and close cancel native work, drain renewal and release only the owned VM', async t => {
  const entered = deferred();
  const f = await runtimeFixture(t, { model: (messages, options) => new Promise((resolve, reject) => {
    entered.resolve();
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }) });
  await f.runtime.messageSession(f.child.id, 'Actual offline cancellation request');
  await entered.promise;
  await f.runtime.quiesce();
  assert.equal(f.runtime.context(f.child.id).sandboxLease.active, false);
  assert.equal(f.sandboxes[0].killed, true);
  const requests = f.requests.length;
  t.mock.timers.tick(WINDOW * 2);
  await flush();
  assert.equal(f.requests.length, requests);
  assert.equal((await f.close()).cleanup_succeeded, true);
});

test('failed pause preserves the original owned ID and never provisions a replacement with invented prior files', async t => {
  const f = await runtimeFixture(t, { pause: async () => { throw new Error('Original VM unavailable'); } });
  await f.runtime.messageSession(f.child.id, 'Actual offline initial request');
  await f.runtime.waitSession(f.child.id);
  assert.equal(f.runtime.store.get('sessions', f.child.id).sandbox_id, 'owned-1');
  await f.runtime.messageSession(f.child.id, 'Explicit inspection after failed pause');
  const result = await f.runtime.waitSession(f.child.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /previous VM files are unavailable/);
  assert.deepEqual(f.connections, ['owned-1']);
  assert.equal(f.sandboxes.length, 1);
});

test('historical profiles do not call the new lease API', async t => {
  const f = await runtimeFixture(t, { profile: 'opulent-capy-v1' });
  await f.runtime.messageSession(f.child.id, 'Actual offline historical request');
  assert.equal((await f.runtime.waitSession(f.child.id)).status, 'completed');
  assert.equal(f.requests.length, 0);
  assert.equal(f.runtime.context(f.child.id).sandboxLease, undefined);
});
