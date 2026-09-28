import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../store.mjs';
import { tick, dispatchEvent } from '../tools/operations.mjs';
import { createRuntimeServer } from '../server.mjs';

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-recovery-'));
  const file = join(dir, 'state.sqlite');
  return Promise.resolve().then(() => fn(file)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function context(store, calls) {
  return { sessionId: 'root', config: { allowedRepos: ['owner/repo'] }, store,
    startSession: async args => {
      calls.push(args);
      return store.put('sessions', `child-${calls.length}`, { status: 'queued', tags: args.tags });
    } };
}

const due = '2026-09-28T00:00:00.000Z';
const source = { id: 'daily', repo: 'owner/repo', name: 'Daily', enabled: true, schedule_type: 'one_time', next_due: due, prompt: 'Run checks' };
const occurrenceId = `schedule:schedules:daily:0:${due}`;

test('schedule occurrence survives crash before cursor advance, never replays', async () => fixture(async file => {
  const first = createStore(file);
  first.put('schedules', source.id, source);
  first.put('operation_occurrences', occurrenceId, { source_id: source.id, due, status: 'received', expected_actions: [{ source_id: source.id, index: 0, type: 'start_session' }] });
  first.close();
  const store = createStore(file), calls = [];
  try {
    const result = await tick(context(store, calls), due);
    assert.equal(result[0].recovery.status, 'uncertain');
    assert.equal(store.get('schedules', source.id).enabled, false);
    assert.equal(store.get('operation_occurrences', occurrenceId).resolution_required, true);
    assert.deepEqual(await tick(context(store, calls), due), []);
    assert.equal(calls.length, 0);
  } finally { store.close(); }
}));

test('fault after durable occurrence write leaves cursor intact for restart reconciliation', async () => fixture(async file => {
  const first = createStore(file), calls = [];
  first.put('schedules', source.id, source);
  const injected = { ...first, put(collection, id, value) {
    if (collection === 'schedules') throw new Error('simulated process death before cursor advance');
    return first.put(collection, id, value);
  } };
  await assert.rejects(tick(context(injected, calls), due), /simulated process death/);
  assert.equal(first.get('operation_occurrences', occurrenceId).status, 'received');
  assert.equal(first.get('schedules', source.id).next_due, due);
  first.close();
  const reopened = createStore(file);
  try {
    assert.equal((await tick(context(reopened, calls), due))[0].recovery.status, 'uncertain');
    assert.equal(calls.length, 0);
  } finally { reopened.close(); }
}));

test('schedule child association survives crash after cursor advance and before run update', async () => fixture(async file => {
  const first = createStore(file);
  first.put('schedules', source.id, { ...source, enabled: false, next_due: null, last_due: due });
  first.put('operation_occurrences', occurrenceId, { source_id: source.id, due, status: 'received', expected_actions: [{ source_id: source.id, index: 0, type: 'start_session' }] });
  first.put('operation_runs', 'run', { kind: 'schedules', source_id: source.id, status: 'starting', dispatch_tag: `dispatch:${occurrenceId}:daily:0` });
  first.put('sessions', 'child', { status: 'interrupted', tags: [`dispatch:${occurrenceId}:daily:0`] });
  first.close();
  const store = createStore(file), calls = [];
  try {
    assert.deepEqual(await tick(context(store, calls), due), []);
    assert.equal(store.get('operation_occurrences', occurrenceId).status, 'accepted');
    assert.deepEqual(store.get('operation_occurrences', occurrenceId).session_ids, ['child']);
    assert.equal(store.get('operation_runs', 'run').session_id, 'child');
    assert.equal(store.get('operation_runs', 'run').status, 'running');
    assert.equal(calls.length, 0);
  } finally { store.close(); }
}));

test('reopened starting run attaches completed child and releases concurrency for next due', async () => fixture(async file => {
  const next = '2026-09-29T00:00:00.000Z';
  const first = createStore(file);
  first.put('schedules', source.id, { ...source, cron: '0 0 * * *', schedule_type: 'recurring', next_due: next });
  first.put('operation_occurrences', occurrenceId, { source_id: source.id, due, status: 'received', expected_actions: [{ source_id: source.id, index: 0, type: 'start_session' }] });
  first.put('operation_runs', 'run', { kind: 'schedules', source_id: source.id, repo: source.repo, status: 'starting',
    dispatch_tag: `dispatch:${occurrenceId}:daily:0`, created_at: due });
  first.put('sessions', 'old-child', { status: 'completed', tags: [`dispatch:${occurrenceId}:daily:0`] });
  first.close();
  const store = createStore(file), calls = [];
  try {
    const fired = await tick(context(store, calls), next);
    assert.equal(store.get('operation_runs', 'run').session_id, 'old-child');
    assert.equal(store.get('operation_runs', 'run').status, 'running');
    assert.equal(fired[0].result.session_id, 'child-1');
    assert.equal(calls.length, 1);
  } finally { store.close(); }
}));

test('normal schedule dispatch and caught worker failure retain historical behavior', async () => fixture(async file => {
  const store = createStore(file), calls = [];
  try {
    store.put('schedules', source.id, source);
    const result = await tick(context(store, calls), due);
    assert.equal(result[0].result.session_id, 'child-1');
    assert.equal(store.get('operation_occurrences', occurrenceId).status, 'completed');
    assert.deepEqual(await tick(context(store, calls), due), []);
    assert.equal(calls.length, 1);
    store.put('schedules', 'failed', { ...source, id: 'failed' });
    const ctx = context(store, calls);
    ctx.startSession = async () => { throw new Error('worker unavailable'); };
    assert.match((await tick(ctx, due))[0].error, /worker unavailable/);
    assert.equal(store.get('operation_occurrences', `schedule:schedules:failed:0:${due}`).status, 'failed');
    assert.deepEqual(await tick(ctx, due), []);
  } finally { store.close(); }
}));

test('partial multi-action failure records child association as uncertain', async () => fixture(async file => {
  const store = createStore(file), calls = [];
  try {
    store.put('automations', 'multi', { id: 'multi', name: 'Multi', repo: 'owner/repo', enabled: true, next_due: [due],
      triggers: [{ event_type: 'schedule:recurring', conditions: { any: [{ all: [{ field: 'rrule', operator: 'recurrence', value: 'DTSTART;TZID=UTC:20260928T000000\nRRULE:FREQ=DAILY;COUNT=2' }] }] } }],
      actions: [{ type: 'start_session', prompt: 'First' }, { type: 'start_session', prompt: 'Second' }] });
    const ctx = context(store, calls);
    ctx.startSession = async args => {
      if (calls.length) throw new Error('second child refused');
      return context(store, calls).startSession(args);
    };
    assert.match((await tick(ctx, due))[0].error, /second child refused/);
    const occurrence = store.list('operation_occurrences')[0];
    assert.equal(occurrence.status, 'uncertain');
    assert.deepEqual(occurrence.session_ids, ['child-1']);
    assert.equal(calls.length, 1);
  } finally { store.close(); }
}));

const event = { type: 'github:push', repo: 'owner/repo' };
const body = JSON.stringify(event);
const token = 'test-runtime-token-with-at-least-32-characters';
const secret = 'test-webhook-secret';
function request(base, delivery = 'delivery', payload = body) {
  return fetch(`${base}/webhooks`, { method: 'POST', headers: { 'x-runtime-delivery': delivery, 'x-runtime-signature': `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}` }, body: payload });
}
async function serverFor(store, calls, gate) {
  const ctx = context(store, calls);
  if (gate) ctx.startSession = async args => { await gate.promise; return context(store, calls).startSession(args); };
  const runtime = { store, context: () => ctx, tick: async () => [], dispatchEvent: (id, event, delivery) => {
    assert.equal(id, 'root');
    return dispatchEvent(ctx, event, delivery);
  } };
  const server = createRuntimeServer(runtime, { token, webhookSecret: secret, rootSessionId: 'root' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
function rule(store) {
  store.put('automations', 'rule', { id: 'rule', name: 'Rule', repo: 'owner/repo', enabled: true, max_concurrent: 1,
    triggers: [{ event_type: 'github:push' }], actions: [{ type: 'start_session', prompt: 'Investigate' }] });
}

test('webhook redelivery after reopen returns accepted child, and missing child requires resolution', async () => fixture(async file => {
  const first = createStore(file);
  rule(first);
  first.put('webhook_receipts', 'delivery', { status: 'received', expected_actions: [{ source_id: 'rule', index: 0, type: 'start_session' }] });
  first.put('sessions', 'child', { status: 'interrupted', tags: ['dispatch:delivery:rule:0'] });
  first.put('webhook_receipts', 'missing', { status: 'received' });
  first.close();
  const store = createStore(file), calls = [], server = await serverFor(store, calls);
  try {
    const accepted = await request(server.base);
    assert.equal(accepted.status, 200);
    assert.deepEqual((await accepted.json()).receipt.session_ids, ['child']);
    const uncertain = await request(server.base, 'missing');
    assert.equal(uncertain.status, 409);
    assert.equal((await uncertain.json()).status, 'uncertain');
    const list = await fetch(`${server.base}/dispatch-recovery`, { headers: { Authorization: `Bearer ${token}` } });
    assert.ok((await list.json()).receipts.some(receipt => receipt.id === 'missing' && receipt.status === 'uncertain'));
    const resolution = await fetch(`${server.base}/dispatch-recovery`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ collection: 'webhook_receipts', id: 'missing', note: 'Reviewed downstream logs' }) });
    assert.equal((await resolution.json()).status, 'acknowledged');
    assert.equal(calls.length, 0);
  } finally { await server.close(); store.close(); }
}));

test('signed concurrent duplicate is not dispatched twice; completed receipt persists', async () => fixture(async file => {
  const store = createStore(file), calls = [];
  rule(store);
  let release;
  const gate = { promise: new Promise(resolve => { release = resolve; }) };
  const server = await serverFor(store, calls, gate);
  try {
    const first = request(server.base);
    while (!store.get('webhook_receipts', 'delivery')) await new Promise(resolve => setTimeout(resolve, 5));
    const concurrent = await request(server.base);
    assert.equal(concurrent.status, 202);
    release();
    assert.equal((await first).status, 200);
    assert.equal((await request(server.base)).status, 200);
    assert.equal(calls.length, 1);
    assert.equal(store.get('webhook_receipts', 'delivery').status, 'completed');
    assert.equal((await request(server.base, 'delivery', JSON.stringify({ ...event, branch: 'other' }))).status, 409);
  } finally { release(); await server.close(); store.close(); }
}));

test('failed signed delivery retains uncertain receipt instead of silently retrying', async () => fixture(async file => {
  const store = createStore(file), calls = [], server = await serverFor(store, calls);
  try {
    assert.equal((await request(server.base, 'bad', '{invalid')).status, 400);
    assert.equal(store.get('webhook_receipts', 'bad').status, 'uncertain');
    assert.equal((await request(server.base, 'bad', '{invalid')).status, 409);
    assert.equal(calls.length, 0);
  } finally { await server.close(); store.close(); }
}));

test('receipt result, operator note, and occurrence errors redact session secrets before SQLite persistence', async () => fixture(async file => {
  const secretValue = 'session-secret-abcdef';
  const store = createStore(file);
  store.put('schedules', source.id, source);
  const ctx = context(store, []);
  ctx.secrets = new Map([['credential', secretValue]]);
  ctx.config.scriptToken = 'script-token-abcdef';
  ctx.startSession = async () => { throw new Error(`worker failure: ${secretValue}`); };
  const failed = await tick(ctx, due);
  assert.match(failed[0].error, /worker failure/);
  assert.doesNotMatch(JSON.stringify(store.get('operation_occurrences', occurrenceId)), /session-secret-abcdef/);
  assert.doesNotMatch(JSON.stringify(store.list('operation_runs')), /session-secret-abcdef/);
  const runtime = { store, context: () => ctx, tick: async () => [], dispatchEvent: async () => [{ error: secretValue }] };
  const server = createRuntimeServer(runtime, { token, webhookSecret: secret, rootSessionId: 'root' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await request(base)).status, 200);
    assert.doesNotMatch(JSON.stringify(store.get('webhook_receipts', 'delivery')), /session-secret-abcdef/);
    const response = await fetch(`${base}/dispatch-recovery`, { method: 'POST', headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ collection: 'webhook_receipts', id: 'delivery', note: `Investigated ${secretValue}` }) });
    assert.equal(response.status, 200);
    assert.doesNotMatch(JSON.stringify(store.get('webhook_receipts', 'delivery')), /session-secret-abcdef/);
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
}));

test('unsigned requests cannot claim delivery IDs or resolve uncertain receipts', async () => fixture(async file => {
  const store = createStore(file), server = await serverFor(store, []);
  try {
    assert.equal((await fetch(`${server.base}/webhooks`, { method: 'POST', headers: { 'x-runtime-delivery': 'delivery' }, body })).status, 401);
    assert.equal(store.get('webhook_receipts', 'delivery'), undefined);
    assert.equal((await fetch(`${server.base}/dispatch-recovery`)).status, 401);
  } finally { await server.close(); store.close(); }
}));
