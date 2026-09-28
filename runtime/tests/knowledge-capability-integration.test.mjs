import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, catalog } from '../core.mjs';

const answer = (content, tool_calls) => ({ choices: [{ message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) } }] });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vXcAAAAASUVORK5CYII=';
const directory = () => mkdtempSync(join(tmpdir(), 'knowledge-capabilities-'));

test('capabilities remain separate from the baseline catalog and obey both visibility and dispatcher policy', async () => {
  const dir = directory();
  const baseline = createRuntime({ config: { stateDir: dir } });
  try {
    const id = baseline.allocate().id;
    assert.equal(baseline.tools().length, Object.keys(catalog.tools).length);
    assert.equal(baseline.coverage(id).required, Object.keys(catalog.tools).length);
    assert(!baseline.tools().some(tool => tool.name === 'browser' || tool.name === 'wait_for_operations'));
    await assert.rejects(baseline.invoke(id, 'browser', { actions: [{ action: 'read' }] }), /not in the configured runtime/);
  } finally { await baseline.close(); rmSync(dir, { recursive: true, force: true }); }
  assert.throws(() => createRuntime({ config: { runtimeCapabilities: ['unknown-v1'] } }), /Unknown or duplicate runtime capability/);
  assert.throws(() => createRuntime({ config: { allowedTools: ['browser'] } }), /Unknown or noncanonical allowed tool/);
  const next = directory();
  const runtime = createRuntime({ config: { stateDir: next, runtimeCapabilities: ['browser-v1', 'operation-waits-v1'],
    allowedTools: ['browser', 'wait_for_operations'], initialTools: ['browser'], browserAllowedOrigins: ['https://example.com'] } });
  try {
    const id = runtime.allocate().id;
    assert.deepEqual(runtime.tools().map(tool => tool.name), ['browser']);
    assert.deepEqual(runtime.context(id).availableToolDefinitions().map(tool => tool.name), ['browser', 'wait_for_operations']);
    assert.equal(runtime.coverage(id).required, Object.keys(catalog.tools).length);
    assert.deepEqual(runtime.coverage(id).missing, []);
    assert.equal(runtime.runtimeCapabilityProvenance.version, 'runtime-capabilities-v1');
    assert.deepEqual(runtime.runtimeCapabilityProvenance.effectiveTools, ['browser', 'wait_for_operations']);
    assert.equal(runtime.runtimeCapabilityProvenance.definitions.length, 2);
    assert.match(runtime.runtimeCapabilityProvenance.definitionsSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(runtime.runtimeCapabilityProvenance.settings.browserAllowedOrigins, ['https://example.com']);
    assert(!JSON.stringify(runtime.runtimeCapabilityProvenance).includes('scriptToken'));
    assert.deepEqual((await runtime.context(id).tools.tool_search_tool_bm25({ query: 'browser' })).map(tool => tool.name), ['browser']);
    await assert.rejects(runtime.invoke(id, 'read', {}), /forbidden by execution policy/);
  } finally { await runtime.close(); rmSync(next, { recursive: true, force: true }); }
});

test('browser preflights before provisioning and a real adapter result carries screenshots into model input', async () => {
  const dir = directory();
  let provisions = 0, batches = 0, calls = 0;
  const sandbox = { sandboxId: 'browser-integration', files: { makeDir: async () => {}, write: async () => {} },
    commands: { run: async command => {
      if (command.includes('/health')) return { stdout: JSON.stringify({ ready: true, version: 1 }) };
      if (command === 'curl -fsS --max-time 2 http://127.0.0.1:9222/json/version >/dev/null') return { stdout: '' };
      assert(command.includes('/batch'));
      batches++;
      return { stdout: JSON.stringify({ version: 1, executed: 1, results: [{ action: 'screenshot', ok: true, mime_type: 'image/png', image_base64: png }] }) };
    } }, pause: async () => {}, kill: async () => {} };
  const runtime = createRuntime({ config: { stateDir: dir, runtimeCapabilities: ['browser-v1'], allowedTools: ['browser'],
    browserAllowedOrigins: ['https://example.com'] }, provision: async () => { provisions++; return sandbox; },
    computerFactory: () => ({ bootstrap: async () => {}, ready: async () => {} }),
    model: async (messages, options) => {
      if (++calls === 1) {
        assert.deepEqual(options.tools.map(tool => tool.function.name), ['browser']);
        return answer(null, [call('shot', 'browser', { actions: [{ action: 'screenshot' }] })]);
      }
      const image = messages.at(-1);
      assert.equal(image.role, 'user');
      assert.equal(image.content[1].image_url.url, `data:image/png;base64,${png}`);
      const tool = JSON.parse(messages.at(-2).content);
      assert.match(tool.results[0].image_observation, /provided separately/);
      assert.equal(tool.results[0].image_base64, undefined);
      return answer('Saw the screenshot');
    } });
  try {
    const id = runtime.allocate().id;
    await assert.rejects(runtime.invoke(id, 'browser', { actions: [] }), /Invalid browser arguments/);
    assert.equal((await runtime.invoke(id, 'browser', { actions: [{ action: 'click', ref: 'bogus', epoch: 1 }] })).failure.code, 'InvalidAction');
    assert.equal((await runtime.invoke(id, 'browser', { actions: [{ action: 'navigate', url: 'https://other.example/' }] })).failure.code, 'SecurityRefusal');
    assert.equal(provisions, 0);
    await runtime.messageSession(id, 'Capture a screenshot');
    assert.equal((await runtime.waitSession(id)).output, 'Saw the screenshot');
    assert.equal(provisions, 1);
    assert.equal(batches, 1);
    assert(!JSON.stringify(runtime.store.get('conversations', id).messages.find(message => message.role === 'tool')).includes(png));
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('timer wait checkpoints unstarted batch calls, releases its worker, then wakes exactly once', async () => {
  const dir = directory();
  let calls = 0;
  const runtime = createRuntime({ config: { stateDir: dir, runtimeCapabilities: ['operation-waits-v1'], allowedTools: ['wait_for_operations', 'list_knowledge_notes'] },
    model: async messages => {
      if (++calls === 1) return answer(null, [call('wait', 'wait_for_operations', { duration_seconds: 3600 }), call('unstarted', 'list_knowledge_notes', {})]);
      assert(messages.some(message => message.role === 'user' && /Operation wait .*timed_out/.test(message.content)));
      return answer('Woken');
    } });
  try {
    const session = await runtime.startSession({ prompt: 'Wait' });
    assert.equal((await runtime.waitSession(session.id)).status, 'sleeping');
    assert.equal(calls, 1);
    const [wait] = runtime.store.list('operation_waits');
    assert.equal(wait.status, 'waiting');
    const toolMessages = runtime.store.get('conversations', session.id).messages.filter(message => message.role === 'tool');
    assert.equal(toolMessages.length, 2);
    assert.match(toolMessages[1].content, /not started/);
    assert.equal(runtime.store.list('events').filter(event => event.type === 'tool_started' && event.data.name === 'list_knowledge_notes').length, 0);
    await runtime.tick(session.id, new Date(Date.parse(wait.deadline_at) - 1));
    assert.equal(calls, 1);
    await runtime.tick(session.id, new Date(wait.deadline_at));
    assert.equal((await runtime.waitSession(session.id)).output, 'Woken');
    assert.equal(calls, 2);
    await runtime.tick(session.id);
    assert.equal(runtime.store.get('operation_waits', wait.id).status, 'delivered');
    assert.equal(runtime.store.list('orchestration_messages').filter(message => message.id === `operation-wait:${wait.id}`).length, 1);
    await runtime.tick(session.id);
    assert.equal(calls, 2);
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('terminal child and concurrent waits reconcile across sessions; slots defer but do not lose a notification', async () => {
  const dir = directory();
  let release;
  const blocker = new Promise(resolve => { release = resolve; });
  const calls = new Map();
  const runtime = createRuntime({ config: { stateDir: dir, runtimeCapabilities: ['operation-waits-v1'], maxConcurrentSessions: 2,
    allowedTools: ['wait_for_operations'] }, model: async (messages, options) => {
    const prompt = messages.find(message => message.role === 'user')?.content;
    const count = (calls.get(prompt) ?? 0) + 1;
    calls.set(prompt, count);
    if (prompt === 'Block') { await blocker; return answer('Released'); }
    if (count === 1) return answer(null, [call(`wait-${prompt}`, 'wait_for_operations', { duration_seconds: 1 })]);
    assert(options.tools);
    return answer('Wake ' + prompt);
  } });
  try {
    const first = runtime.allocate({ prompt: 'TimerA' });
    const second = runtime.allocate({ prompt: 'TimerB' });
    await runtime.messageSession(first.id, 'TimerA');
    await runtime.messageSession(second.id, 'TimerB');
    await Promise.all([runtime.waitSession(first.id), runtime.waitSession(second.id)]);
    const block = await runtime.startSession({ prompt: 'Block' });
    await runtime.tick(first.id, new Date(Date.now() + 5000));
    const woken = [first, second].filter(row => runtime.store.get('sessions', row.id).status !== 'sleeping');
    assert.equal(woken.length, 1);
    await runtime.waitSession(woken[0].id);
    await runtime.tick(first.id, new Date(Date.now() + 5000));
    assert.equal(runtime.store.get('sessions', first.id).status, 'completed');
    assert.equal(runtime.store.get('sessions', second.id).status, 'completed');
    release();
    await runtime.waitSession(block.id);
    assert.equal(runtime.store.list('operation_waits').length, 2);
  } finally { release(); await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('already-terminal child wakes on the next tick without spinning a worker during registration', async () => {
  const dir = directory();
  let calls = 0;
  let childId;
  const runtime = createRuntime({ config: { stateDir: dir, runtimeCapabilities: ['operation-waits-v1'], allowedTools: ['wait_for_operations'] },
    model: async messages => {
      if (++calls === 1) return answer(null, [call('wait-child', 'wait_for_operations', { operations: [{ kind: 'session', id: childId }] })]);
      assert(messages.some(message => message.role === 'user' && message.content.includes('"status":"completed"')));
      return answer('Child completed');
    } });
  try {
    const parent = runtime.allocate();
    childId = runtime.allocate({ parent_session_id: parent.id }).id;
    runtime.store.put('sessions', childId, { ...runtime.store.get('sessions', childId), status: 'completed' });
    await runtime.messageSession(parent.id, 'Wait for terminal child');
    assert.equal((await runtime.waitSession(parent.id)).status, 'sleeping');
    assert.equal(calls, 1);
    await runtime.tick(parent.id);
    assert.equal((await runtime.waitSession(parent.id)).output, 'Child completed');
    await runtime.tick(parent.id);
    assert.equal(runtime.store.list('operation_waits')[0].status, 'delivered');
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a wake arriving during sandbox cleanup queues one continuation after the worker releases its slot', async () => {
  const dir = directory();
  let enterPause;
  const paused = new Promise(resolve => { enterPause = resolve; });
  let releasePause;
  const holdPause = new Promise(resolve => { releasePause = resolve; });
  let calls = 0;
  const sandbox = { sandboxId: 'cleanup-sandbox', files: { makeDir: async () => {}, write: async () => {} },
    commands: { run: async command => command.includes('/health') ? { stdout: '{"ready":true,"version":1}' } : { stdout: '{"version":1,"executed":1,"results":[{"action":"read","ok":true}]}' } },
    pause: async () => { enterPause(); await holdPause; }, kill: async () => {} };
  const runtime = createRuntime({ config: { stateDir: dir, maxConcurrentSessions: 1,
    runtimeCapabilities: ['browser-v1', 'operation-waits-v1'], allowedTools: ['browser', 'wait_for_operations'],
    browserAllowedOrigins: ['https://example.com'] }, provision: async () => sandbox,
    computerFactory: () => ({ bootstrap: async () => {}, ready: async () => {} }),
    model: async () => ++calls === 1 ? answer(null, [call('browse', 'browser', { actions: [{ action: 'read' }] }),
      call('wait', 'wait_for_operations', { duration_seconds: 1 })]) : answer('Resumed after cleanup') });
  try {
    const session = await runtime.startSession({ prompt: 'Read and wait' });
    await paused;
    assert.equal(runtime.store.get('sessions', session.id).status, 'sleeping');
    const wait = runtime.store.list('operation_waits')[0];
    await runtime.tick(session.id, new Date(Date.parse(wait.deadline_at) + 1));
    assert.equal(runtime.store.get('operation_waits', wait.id).status, 'notified');
    assert.equal(calls, 1);
    releasePause();
    assert.equal((await runtime.waitSession(session.id)).output, 'Resumed after cleanup');
    await runtime.tick(session.id);
    assert.equal(runtime.store.get('operation_waits', wait.id).status, 'delivered');
    assert.equal(calls, 2);
  } finally { releasePause(); await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('user continuation cancels pending wake and cancellation refuses relaunch', async () => {
  const dir = directory();
  let calls = 0;
  const runtime = createRuntime({ config: { stateDir: dir, runtimeCapabilities: ['operation-waits-v1'], allowedTools: ['wait_for_operations'] },
    model: async () => ++calls === 1 ? answer(null, [call('wait', 'wait_for_operations', { duration_seconds: 3600 })]) : answer('User override') });
  try {
    const session = await runtime.startSession({ prompt: 'Wait' });
    await runtime.waitSession(session.id);
    const [wait] = runtime.store.list('operation_waits');
    await runtime.messageSession(session.id, 'Continue now');
    assert.equal((await runtime.waitSession(session.id)).output, 'User override');
    assert.equal(runtime.store.get('operation_waits', wait.id).status, 'cancelled');
    await runtime.tick(session.id, new Date(wait.deadline_at));
    assert.equal(calls, 2);
    const other = runtime.allocate();
    runtime.store.put('operation_waits', 'cancelled-wait', { session_id: other.id, status: 'waiting', operations: [], return_when: 'any', deadline_at: new Date(0).toISOString() });
    await runtime.cancelSession(other.id);
    await runtime.tick(session.id);
    assert.equal(runtime.store.get('operation_waits', 'cancelled-wait').status, 'cancelled');
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('restart resumes checkpointed notification before inference and only acknowledges after assistant response', async () => {
  const dir = directory();
  const config = { stateDir: dir, runtimeCapabilities: ['operation-waits-v1'], allowedTools: ['wait_for_operations'] };
  let runtime = createRuntime({ config, model: async () => answer(null, [call('wait', 'wait_for_operations', { duration_seconds: 3600 })]) });
  try {
    const session = await runtime.startSession({ prompt: 'Wait' });
    await runtime.waitSession(session.id);
    const [wait] = runtime.store.list('operation_waits');
    const notificationId = `operation-wait:${wait.id}`;
    const text = `Operation wait ${wait.id}: ${JSON.stringify({ outcome: 'timed_out', operations: [] })}`;
    runtime.store.put('operation_waits', wait.id, { ...wait, status: 'notified', notification_id: notificationId, notification_text: text });
    runtime.store.put('orchestration_messages', notificationId, { session_id: session.id, source: 'operation_wait', body: text });
    const conversation = runtime.store.get('conversations', session.id);
    runtime.store.put('conversations', session.id, { ...conversation, delivered: [...conversation.delivered, notificationId], messages: [...conversation.messages, { role: 'user', content: text }] });
    runtime.store.put('sessions', session.id, { ...runtime.store.get('sessions', session.id), status: 'running' });
    await runtime.close();
    let calls = 0;
    runtime = createRuntime({ config, model: async messages => {
      calls++;
      assert.equal(messages.filter(message => message.role === 'user' && message.content === text).length, 1);
      return answer('Recovered');
    } });
    assert.equal(runtime.store.get('sessions', session.id).status, 'interrupted');
    await runtime.tick(session.id);
    assert.equal((await runtime.waitSession(session.id)).output, 'Recovered');
    assert.equal(runtime.store.get('operation_waits', wait.id).status, 'notified');
    await runtime.tick(session.id);
    assert.equal(runtime.store.get('operation_waits', wait.id).status, 'delivered');
    assert.equal(calls, 1);
    assert.equal(runtime.store.list('orchestration_messages').filter(message => message.id === notificationId).length, 1);
  } finally { await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});
