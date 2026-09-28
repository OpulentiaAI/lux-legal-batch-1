import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../store.mjs';
import { definitions, createTools, tickOperationWaits, cancelOperationWaits, acknowledgeOperationWait } from '../operation-waits.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'operation-waits-'));
  const file = join(directory, 'state.sqlite');
  let store = createStore(file);
  store.put('sessions', 'caller', { status: 'running' });
  store.put('sessions', 'child-a', { parent_session_id: 'caller', status: 'running' });
  store.put('sessions', 'child-b', { parent_session_id: 'caller', status: 'running' });
  store.put('sessions', 'grandchild', { parent_session_id: 'child-a', status: 'running' });
  store.put('sessions', 'foreign', { parent_session_id: 'other', status: 'completed' });
  store.put('workflows', 'wfr-own', { owner_session_id: 'caller', status: 'running' });
  store.put('workflows', 'wfr-other', { owner_session_id: 'other', status: 'completed' });
  const events = [];
  const messages = [];
  const launches = [];
  const ctx = () => ({ sessionId: 'caller', store, emit: (type, data) => {
    events.push({ type, data });
    if (type === 'operation_wait_requested') store.put('sessions', 'caller', { ...store.get('sessions', 'caller'), status: 'sleeping' });
  }, wakeSession: async (sessionId, notificationId, text) => {
    assert.equal(sessionId, 'caller');
    if (!store.get('orchestration_messages', notificationId)) {
      store.put('orchestration_messages', notificationId, { session_id: sessionId, source: 'operation_wait', body: text });
      messages.push(text);
    }
    if (!launches.includes(notificationId)) launches.push(notificationId);
    store.put('conversations', sessionId, { delivered: [notificationId], messages: [
      { role: 'user', content: text }, { role: 'assistant', content: 'Wake handled' },
    ] });
    acknowledgeOperationWait({ store }, sessionId, notificationId);
  } });
  return {
    ctx, events, messages, launches, get store() { return store; },
    reopen() { store.close(); store = createStore(file); },
    close() { store.close(); rmSync(directory, { force: true, recursive: true }); },
  };
}

test('definition exposes only explicit owned persisted operations and deadline fields', () => {
  assert.equal(definitions.wait_for_operations.name, 'wait_for_operations');
  assert.deepEqual(definitions.wait_for_operations.inputSchema.properties.operations.items.properties.kind.enum, ['session', 'workflow']);
});

test('any completes on a failed child, keeps pending target statuses, and does not redeliver', async () => {
  const f = fixture();
  try {
    const registered = createTools(f.ctx()).wait_for_operations({ operations: [{ kind: 'session', id: 'child-a' }, { kind: 'workflow', id: 'wfr-own' }], return_when: 'any' });
    assert.equal(registered.status, 'waiting');
    assert.equal(f.events[0].type, 'operation_wait_requested');
    await tickOperationWaits(f.ctx());
    assert.equal(f.messages.length, 0);
    f.store.put('sessions', 'child-a', { parent_session_id: 'caller', status: 'failed', error: 'provider failed' });
    await tickOperationWaits(f.ctx());
    await tickOperationWaits(f.ctx());
    assert.equal(f.messages.length, 1);
    assert.match(f.messages[0], /"status":"failed","error":"provider failed"/);
    assert.match(f.messages[0], /"status":"running"/);
    assert.equal(f.store.get('operation_waits', registered.wait_id).status, 'delivered');
  } finally { f.close(); }
});

test('already-complete target still registers and wakes after tool-result checkpoint', async () => {
  const f = fixture();
  try {
    f.store.put('sessions', 'child-a', { parent_session_id: 'caller', status: 'completed' });
    const { wait_id } = createTools(f.ctx()).wait_for_operations({ operations: [{ kind: 'session', id: 'child-a' }] });
    assert.equal(f.store.get('operation_waits', wait_id).status, 'waiting');
    assert.equal(f.messages.length, 0);
    await tickOperationWaits(f.ctx());
    assert.match(f.messages[0], /"status":"completed"/);
  } finally { f.close(); }
});

test('all waits across file-backed reopen, includes cancellation honestly and handles deleted target', async () => {
  const f = fixture();
  try {
    const { wait_id } = createTools(f.ctx()).wait_for_operations({ operations: [{ kind: 'session', id: 'child-a' }, { kind: 'workflow', id: 'wfr-own' }], return_when: 'all' });
    f.store.put('sessions', 'child-a', { parent_session_id: 'caller', status: 'completed', output: 'done' });
    f.reopen();
    await tickOperationWaits(f.ctx());
    assert.equal(f.messages.length, 0);
    f.store.put('workflows', 'wfr-own', { owner_session_id: 'caller', status: 'cancelled', error: 'operator cancelled' });
    await tickOperationWaits(f.ctx());
    assert.match(f.messages[0], /"status":"completed"/);
    assert.match(f.messages[0], /"status":"cancelled","error":"operator cancelled"/);
    assert.equal(f.store.get('operation_waits', wait_id).status, 'delivered');
    f.store.put('sessions', 'caller', { status: 'running' });
    createTools(f.ctx()).wait_for_operations({ operations: [{ kind: 'session', id: 'child-b' }] });
    f.store.delete('sessions', 'child-b');
    await tickOperationWaits(f.ctx());
    assert.match(f.messages[1], /"status":"missing"/);
  } finally { f.close(); }
});

test('timer-only wakes after deadline and reports a timeout', async () => {
  const f = fixture();
  try {
    const now = Date.now();
    const { wait_id } = createTools(f.ctx()).wait_for_operations({ wake_at: new Date(now + 5000).toISOString() });
    await tickOperationWaits(f.ctx(), now + 4999);
    assert.equal(f.messages.length, 0);
    f.reopen();
    await tickOperationWaits(f.ctx(), now + 5000);
    assert.match(f.messages[0], /"outcome":"timed_out","operations":\[\]/);
    assert.equal(f.store.get('operation_waits', wait_id).status, 'delivered');
  } finally { f.close(); }
});

test('rejects missing, foreign, grandchild, stale and malformed registrations before persisting', () => {
  const f = fixture();
  try {
    const tool = createTools(f.ctx()).wait_for_operations;
    for (const operations of [
      [{ kind: 'session', id: 'missing' }], [{ kind: 'session', id: 'foreign' }],
      [{ kind: 'session', id: 'grandchild' }], [{ kind: 'workflow', id: 'wfr-other' }],
      [{ kind: 'session', id: 'child-a' }, { kind: 'workflow', id: 'wfr-other' }],
      [{ kind: 'session', id: 'child-a' }, { kind: 'session', id: 'child-a' }],
    ]) assert.throws(() => tool({ operations }));
    for (const args of [
      {}, { operations: [] }, { duration_seconds: 0 }, { duration_seconds: 604801 },
      { duration_seconds: 1.2 }, { wake_at: 'not a date' },
      { wake_at: new Date(Date.now() - 1000).toISOString() },
      { wake_at: new Date(Date.now() + 604801000).toISOString() },
      { duration_seconds: 1, wake_at: new Date().toISOString() },
      { operations: [{ kind: 'session', id: 'child-a' }], return_when: 'neither' },
      { operations: [{ kind: 'session', id: 'child-a', extra: true }] },
    ]) assert.throws(() => tool(args), JSON.stringify(args));
    assert.equal(f.store.list('operation_waits').length, 0);
    assert.throws(() => createTools({ ...f.ctx(), emit: () => { throw new Error('event failed'); } }).wait_for_operations({ duration_seconds: 1 }), /event failed/);
    assert.equal(f.store.list('operation_waits').length, 0);
    tool({ operations: [{ kind: 'session', id: 'child-a' }] });
    assert.throws(() => tool({ duration_seconds: 1 }), /already has an active/);
  } finally { f.close(); }
});

test('explicit cancellation and user continuation discard stale waits', async () => {
  const f = fixture();
  try {
    const first = createTools(f.ctx()).wait_for_operations({ operations: [{ kind: 'session', id: 'child-a' }] });
    cancelOperationWaits(f.ctx(), 'caller', 'user_continuation');
    f.store.put('sessions', 'child-a', { parent_session_id: 'caller', status: 'completed' });
    await tickOperationWaits(f.ctx());
    assert.equal(f.messages.length, 0);
    assert.equal(f.store.get('operation_waits', first.wait_id).cancellation_reason, 'user_continuation');
    const second = createTools(f.ctx()).wait_for_operations({ duration_seconds: 1 });
    cancelOperationWaits(f.ctx(), 'caller');
    await tickOperationWaits(f.ctx(), Date.now() + 2000);
    assert.equal(f.store.get('operation_waits', second.wait_id).status, 'cancelled');
    assert.equal(f.messages.length, 0);
    const third = createTools(f.ctx()).wait_for_operations({ duration_seconds: 1 });
    const failing = f.ctx();
    failing.wakeSession = async () => { throw new Error('unavailable'); };
    await assert.rejects(tickOperationWaits(failing, Date.now() + 2000), /unavailable/);
    cancelOperationWaits(f.ctx(), 'caller', 'user_continuation');
    await tickOperationWaits(f.ctx(), Date.now() + 2000);
    assert.equal(f.store.get('operation_waits', third.wait_id).status, 'cancelled');
    assert.equal(f.messages.length, 0);
  } finally { f.close(); }
});

test('notification survives crash before message insertion and crash after insertion before launch', async () => {
  const f = fixture();
  try {
    const { wait_id } = createTools(f.ctx()).wait_for_operations({ duration_seconds: 1 });
    const afterDeadline = Date.now() + 2000;
    const first = f.ctx();
    first.wakeSession = async () => { throw new Error('crash before message'); };
    await assert.rejects(tickOperationWaits(first, afterDeadline), /crash before message/);
    const saved = f.store.get('operation_waits', wait_id);
    assert.equal(saved.status, 'notified');
    assert.equal(saved.notification_id, `operation-wait:${wait_id}`);
    f.reopen();
    const second = f.ctx();
    second.wakeSession = async (sessionId, notificationId, text) => {
      f.store.put('orchestration_messages', notificationId, { session_id: sessionId, source: 'operation_wait', body: text });
      f.messages.push(text);
      throw new Error('crash before launch');
    };
    await assert.rejects(tickOperationWaits(second, afterDeadline), /crash before launch/);
    assert.equal(f.messages.length, 1);
    assert.equal(f.store.get('operation_waits', wait_id).status, 'notified');
    f.reopen();
    await tickOperationWaits(f.ctx(), afterDeadline);
    await tickOperationWaits(f.ctx(), afterDeadline);
    assert.equal(f.messages.length, 1);
    assert.deepEqual(f.launches, [`operation-wait:${wait_id}`]);
    assert.equal(f.store.list('orchestration_messages').length, 1);
    assert.equal(f.store.get('operation_waits', wait_id).status, 'delivered');
  } finally { f.close(); }
});

test('successful launch without a conversation checkpoint stays retryable after restart', async () => {
  const f = fixture();
  try {
    const { wait_id } = createTools(f.ctx()).wait_for_operations({ duration_seconds: 1 });
    const now = Date.now() + 2000;
    const first = f.ctx();
    first.wakeSession = async (id, notificationId, text) => {
      f.store.put('orchestration_messages', notificationId, { session_id: id, source: 'operation_wait', body: text });
      f.launches.push(notificationId);
    };
    await tickOperationWaits(first, now);
    assert.equal(f.store.get('operation_waits', wait_id).status, 'notified');
    assert.equal(f.store.get('conversations', 'caller'), undefined);
    f.reopen();
    await tickOperationWaits(f.ctx(), now);
    assert.equal(f.store.list('orchestration_messages').length, 1);
    assert.equal(f.store.get('operation_waits', wait_id).status, 'delivered');
    assert.equal(f.launches.length, 1);
  } finally { f.close(); }
});

test('crash after conversation checkpoint but before model response remains retryable', async () => {
  const f = fixture();
  try {
    const { wait_id } = createTools(f.ctx()).wait_for_operations({ duration_seconds: 1 });
    const now = Date.now() + 2000;
    const first = f.ctx();
    first.wakeSession = async (id, notificationId, text) => {
      f.store.put('orchestration_messages', notificationId, { session_id: id, source: 'operation_wait', body: text });
      f.store.put('conversations', id, { delivered: [notificationId], messages: [{ role: 'user', content: text }] });
    };
    await tickOperationWaits(first, now);
    assert.equal(f.store.get('operation_waits', wait_id).status, 'notified');
    assert.throws(() => acknowledgeOperationWait({ store: f.store }, 'caller', `operation-wait:${wait_id}`), /assistant response checkpoint/);
    f.reopen();
    await tickOperationWaits(f.ctx(), now);
    assert.equal(f.store.list('orchestration_messages').length, 1);
    assert.equal(f.store.get('operation_waits', wait_id).status, 'delivered');
  } finally { f.close(); }
});

test('restart reconciles response checkpoint before acknowledgement without relaunching', async () => {
  const f = fixture();
  try {
    const { wait_id } = createTools(f.ctx()).wait_for_operations({ duration_seconds: 1 });
    const now = Date.now() + 2000;
    const first = f.ctx();
    first.wakeSession = async (id, notificationId, text) => {
      f.store.put('orchestration_messages', notificationId, { session_id: id, source: 'operation_wait', body: text });
      f.store.put('conversations', id, { delivered: [notificationId], messages: [
        { role: 'user', content: text }, { role: 'assistant', content: 'Response checkpointed' },
      ] });
    };
    await tickOperationWaits(first, now);
    assert.equal(f.store.get('operation_waits', wait_id).status, 'notified');
    f.reopen();
    const reopened = f.ctx();
    reopened.wakeSession = async () => { throw new Error('must not relaunch'); };
    await tickOperationWaits(reopened, now);
    assert.equal(f.store.get('operation_waits', wait_id).status, 'delivered');
    assert.equal(f.store.list('orchestration_messages').length, 1);
  } finally { f.close(); }
});
