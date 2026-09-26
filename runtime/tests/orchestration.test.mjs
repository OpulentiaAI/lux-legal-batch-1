import test from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../tools/orchestration.mjs';
import { createStore } from '../store.mjs';

function setup(overrides = {}) {
  const store = createStore(':memory:');
  const events = [];
  const calls = { started: [], cancelled: [], messaged: [] };
  store.put('sessions', 'parent', { id: 'parent', status: 'running' });
  const ctx = {
    sessionId: 'parent', store, workspace: '/home/user/workspace', config: { allowedRepos: ['owner/repo'] },
    emit(type, data) {
      const event = store.put('events', `event-${events.length}`, { session_id: 'parent', type, data, created_at: new Date().toISOString() });
      events.push(event);
      return event;
    },
    async startSession(args) {
      calls.started.push(args);
      return store.put('sessions', `child-${calls.started.length}`, { ...args, status: 'running', created_at: new Date().toISOString() });
    },
    async cancelSession(id) { calls.cancelled.push(id); },
    async messageSession(id, message) {
      calls.messaged.push({ id, message });
      return store.put('orchestration_messages', `message-${calls.messaged.length}`, { session_id: id, source: 'user', body: message, created_at: new Date().toISOString() });
    },
    ...overrides
  };
  return { store, events, calls, ctx, tools: createTools(ctx), database: { close: () => store.close() } };
}

test('task list persists in SQLite with scoped dependency edges and atomic updates', async () => {
  const { tools, store, database } = setup();
  const [a, b] = (await tools.task_create({ tasks: [{ subject: 'Implement' }, { subject: 'Verify' }] })).tasks;
  await tools.task_update({ updates: [{ task_id: b.id, add_blocked_by: [a.id] }, { task_id: a.id, status: 'in_progress' }] });
  assert.deepEqual((await tools.task_list({})).tasks.find(x => x.id === b.id).unresolved_blockers, [a.id]);
  assert.deepEqual((await tools.task_get({ task_id: a.id })).blocks, [b.id]);
  await assert.rejects(tools.task_update({ updates: [{ task_id: b.id, status: 'in_progress' }] }), /one task/);
  assert.equal(store.get('tasks', b.id).status, 'pending');
  await tools.task_update({ updates: [{ task_id: a.id, status: 'completed' }, { task_id: b.id, status: 'in_progress' }] });
  assert.deepEqual((await tools.task_list({})).tasks.find(x => x.id === b.id).unresolved_blockers, []);
  store.put('tasks', 'foreign', { owner_session_id: 'another', status: 'pending' });
  await assert.rejects(tools.task_get({ task_id: 'foreign' }), /not found/);
  database.close();
});

test('child workers are started, messaged, completed and cancelled with scoped history', async () => {
  const { tools, store, calls, database } = setup();
  await assert.rejects(tools.devin_session_create({ sessions: [{ prompt: 'Go', repos: ['another/repo'] }] }), /allowlist/);
  const { sessions } = await tools.devin_session_create({ sessions: [{ prompt: 'Go', repos: ['owner/repo'] }] });
  assert.equal(calls.started[0].parent_session_id, 'parent');
  const id = sessions[0].session_id;
  assert.equal((await tools.devin_session_interact({ action: 'get', session_id: `devin-${id}` })).status, 'running');
  await tools.devin_session_interact({ action: 'message', session_id: id, message: 'Status?' });
  assert.deepEqual(calls.messaged, [{ id, message: 'Status?' }]);
  assert.equal((await tools.devin_session_interact({ action: 'get_messages', session_id: id })).messages[0].body, 'Status?');
  store.put('sessions', id, { ...store.get('sessions', id), status: 'completed', output: 'Done' });
  assert.equal((await tools.read_subagent({ agent_id: id, block: true })).response, 'Done');
  const other = (await tools.devin_session_create({ sessions: [{ prompt: 'Next' }] })).sessions[0].session_id;
  assert.equal((await tools.devin_session_interact({ action: 'sleep', session_id: other })).status, 'sleeping');
  assert.deepEqual(calls.cancelled, [other]);
  store.put('sessions', 'foreign', { id: 'foreign', parent_session_id: 'elsewhere' });
  await assert.rejects(tools.devin_session_interact({ action: 'get', session_id: 'foreign' }), /not found/);
  database.close();
});

test('messages, blocker and legacy todo persist without leaking attachment paths', async () => {
  const { tools, store, events, database } = setup();
  await assert.rejects(tools.message_user({ message: 'File', attachments: ['/secret'], block_on_user: false }), /upload provider/);
  const sent = await tools.message_user({ message: 'Update', attachments: [], block_on_user: true });
  assert.equal(store.get('orchestration_messages', sent.message_id).body, 'Update');
  await tools.report_blocker({ headline: 'Approval needed', notify: 'user' });
  await tools.todo_write({ todos: [{ content: 'Wait', status: 'pending' }] });
  await tools.rename_title({ title: 'Orchestrating' });
  assert.equal(store.get('sessions', 'parent').title, 'Orchestrating');
  assert.equal(events.some(x => x.type === 'blocker_reported'), true);
  database.close();
});

test('user attachments become durable artifact pointers before message delivery', async () => {
  const uploads = [];
  const { tools, events, database } = setup({ invoke: async (name, args) => {
    uploads.push({ name, args });
    return { pointer: 'storage://artifact-1' };
  } });
  const result = await tools.message_user({ message: 'Report', attachments: ['/home/user/workspace/report.pdf'], block_on_user: false });
  assert.deepEqual(result.attachments, ['storage://artifact-1']);
  assert.equal(events.find(event => event.type === 'message_user').data.attachments[0], 'storage://artifact-1');
  assert.equal(uploads[0].name, 'upload_attachment');
  database.close();
});

test('workflow executes only in sandbox with broker, records completion and replay', async () => {
  const scripts = new Map([['/home/user/workspace/workflow.py', 'log("started")\nresult = agent("do task")']]);
  const brokerCalls = [];
  let closed = false;
  const sandbox = {
    files: { read: async path => scripts.get(path), write: async files => { for (const file of files) scripts.set(file.path, file.data); }, remove: async path => scripts.delete(path) },
    commands: { run: async (command, options) => {
      brokerCalls.push({ command, options });
      return { wait: async () => ({ exitCode: 0, stdout: 'finished', stderr: '' }), kill: async () => {} };
    } }
  };
  const { tools, store, database } = setup({ sandbox, createWorkflowBroker: async () => ({ url: 'http://broker.internal/run', token: 'scoped-token', close: async () => { closed = true; } }) });
  const run = await tools.run_workflow({ workflow_name: 'Fan-out', script_path: '/home/user/workspace/workflow.py' });
  const finished = await tools.get_workflow_output({ run_id: run.id, timeout_secs: 1 });
  assert.equal(finished.status, 'completed');
  assert.equal(finished.output, 'finished');
  assert.equal(closed, true);
  assert.match(scripts.get(`/tmp/${run.id}.py`) ?? brokerCalls[0].command, /python3/);
  assert.equal(brokerCalls[0].options.envs.WORKFLOW_BROKER_TOKEN, 'scoped-token');
  assert.equal(JSON.stringify(store.get('workflows', run.id)).includes('scoped-token'), false);
  database.close();
});

test('workflow refuses host execution without an authenticated broker', async () => {
  const { tools, database } = setup({ sandbox: { files: { read: async () => 'print(1)' }, commands: { run: async () => { throw new Error('must not run'); } } } });
  await assert.rejects(tools.run_workflow({ workflow_name: 'No-broker', script_path: '/tmp/source.py' }), /authenticated workflow broker/);
  database.close();
});

test('workflow abort cancels active child and preserves durable completed results', async () => {
  let complete;
  let killed = false;
  let closed = false;
  const sandbox = {
    files: { read: async () => 'import asyncio\nasync def main():\n await register_workflow({"name":"test","phases":[]})\nasyncio.run(main())', write: async () => {}, remove: async () => {} },
    commands: { run: async () => ({ wait: () => new Promise(resolve => { complete = resolve; }), kill: async () => { killed = true; complete({ exitCode: 1, stdout: '', stderr: 'cancelled' }); } }) }
  };
  const { tools, store, calls, database } = setup({ sandbox, createWorkflowBroker: async () => ({ url: 'http://broker.internal/run', token: 'scoped-token', close: async () => { closed = true; } }) });
  const run = await tools.run_workflow({ workflow_name: 'Cancelable', script_path: '/workspace/script.py' });
  await new Promise(resolve => setImmediate(resolve));
  store.put('sessions', 'child-active', { id: 'child-active', parent_session_id: 'parent', status: 'running' });
  store.put('sessions', 'child-late', { id: 'child-late', parent_session_id: 'parent', status: 'completed', output: { answer: 17 } });
  store.put('workflow_agents', 'active', { id: 'active', run_id: run.id, session_id: 'child-active', status: 'running' });
  store.put('workflow_agents', 'late', { id: 'late', run_id: run.id, session_id: 'child-late', status: 'running' });
  store.put('workflow_agents', 'done', { id: 'done', run_id: run.id, session_id: 'child-done', status: 'completed', result: { answer: 42 } });
  const stopped = await tools.kill_workflow({ run_id: run.id });
  assert.equal(stopped.status, 'cancelled');
  assert.equal(killed, true);
  assert.deepEqual(calls.cancelled, ['child-active']);
  assert.deepEqual(store.get('workflow_agents', 'done').result, { answer: 42 });
  assert.deepEqual(store.get('workflow_agents', 'late').result, { answer: 17 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, true);
  database.close();
});
