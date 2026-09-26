import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';

function runtimeFixture(overrides = {}) {
  const store = createStore(':memory:');
  let provisioned = 0;
  let paused = 0;
  const clones = [];
  const scripts = new Map([['/home/user/workspace/workflow.py', 'import asyncio\nasync def main():\n await register_workflow({"name":"smoke","phases":[{"title":"check","detail":"verify"}]})\n value = await agent("Return a result",phase="check",schema={"type":"object","required":["answer"]})\n log(value)\nasyncio.run(main())']]);
  const sandbox = {
    sandboxId: 'sandbox-test',
    files: { makeDir: async () => {}, read: async path => scripts.get(path), write: async items => { for (const item of items) scripts.set(item.path, item.data); }, remove: async path => scripts.delete(path) },
    git: { clone: async (url, options) => { clones.push({ url, options }); } },
    commands: { run: async () => ({ wait: async () => ({ exitCode: 0, stdout: 'done', stderr: '' }), kill: async () => {} }) },
    pause: async () => { paused++; }, kill: async () => {}
  };
  const model = async (messages) => {
    const prompt = messages.filter(x => x.role === 'user').at(-1)?.content;
    if (prompt === 'Return a result') return { choices: [{ message: { role: 'assistant', content: '{"answer":42}' } }] };
    return { choices: [{ message: { role: 'assistant', content: 'Done' } }] };
  };
  const runtime = createRuntime({ store, model, storage: {}, config: { runtimeUrl: 'https://runtime.example', allowedRepos: ['owner/repo'], stateDir: ':memory:' },
    provision: async () => { provisioned++; return sandbox; }, ...overrides });
  return { runtime, store, scripts, sandbox, clones, counts: () => ({ provisioned, paused }) };
}

test('real dispatcher starts model-backed child and persists one message per delivery', async () => {
  const { runtime, store, clones } = runtimeFixture();
  try {
    const root = await runtime.startSession({ prompt: 'Ready' });
    await runtime.waitSession(root.id);
    const created = await runtime.invoke(root.id, 'devin_session_create', { sessions: [{ prompt: 'Return a result', repos: ['owner/repo'],
      structured_output_schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'number' } } } }] });
    const id = created.sessions[0].session_id;
    await runtime.waitSession(id);
    const details = await runtime.invoke(root.id, 'devin_session_interact', { action: 'get', session_id: id });
    assert.equal(details.status, 'completed');
    assert.deepEqual(details.output, { answer: 42 });
    assert.equal(store.get('sessions', id).parent_session_id, root.id);
    assert.equal(clones.length, 1);
    assert.equal(clones[0].url, 'https://github.com/owner/repo.git');
    assert.equal(clones[0].options.path, '/home/user/workspace');
    assert.equal(clones[0].url.includes('@'), false);
    if (clones[0].options.password) assert.equal(clones[0].options.dangerouslyStoreCredentials, false);
    assert.equal((await runtime.invoke(root.id, 'devin_session_interact', { action: 'get_messages', session_id: id })).messages.length, 1);
    await assert.rejects(runtime.invoke(root.id, 'devin_session_interact', { action: 'message', session_id: id, message: 'Again' }), /finished session/);
    assert.equal(store.list('orchestration_messages').filter(x => x.session_id === id).length, 1);
    const childEvents = await runtime.invoke(root.id, 'devin_session_events', { action: 'list', session_id: id });
    assert(childEvents.events.some(event => event.type === 'session_completed'));
  } finally { await runtime.close(); }
});

test('real core broker authenticates requests and runs schema-checked child worker', async () => {
  const { runtime, store } = runtimeFixture();
  try {
    const root = await runtime.startSession({ prompt: 'Ready' });
    await runtime.waitSession(root.id);
    const runId = 'wfr-' + 'a'.repeat(32);
    const broker = runtime.context(root.id).createWorkflowBroker({ runId, sessionId: root.id });
    await assert.rejects(runtime.workflowCall(runId, 'wrong-token', { operation: 'agent', run_id: runId, call_id: 'one', prompt: 'Return a result' }), /authorization/);
    const result = await runtime.workflowCall(runId, broker.token, { operation: 'agent', run_id: runId, call_id: 'one', prompt: 'Return a result',
      options: { phase: 'check', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'number' } } } } });
    assert.deepEqual(result, { answer: 42 });
    const replay = await runtime.workflowCall(runId, broker.token, { operation: 'agent', run_id: runId, call_id: 'one', prompt: 'Return a result', options: {} });
    assert.deepEqual(replay, result);
    assert.equal(store.list('sessions').filter(x => x.parent_session_id === root.id).length, 1);
    await runtime.workflowCall(runId, broker.token, { operation: 'log', run_id: runId, message: 'Checkpoint' });
    assert.equal(store.list('workflow_logs')[0].message, 'Checkpoint');
    await broker.close();
    await assert.rejects(runtime.workflowCall(runId, broker.token, { operation: 'register', run_id: runId }), /authorization/);
  } finally { await runtime.close(); }
});

test('broker replay replaces interrupted child and deduplicates concurrent call IDs', async () => {
  let childCompletions = 0;
  const { runtime, store } = runtimeFixture({ model: async messages => {
    const prompt = messages.filter(x => x.role === 'user').at(-1)?.content;
    if (prompt === 'Return a result') {
      childCompletions++;
      await new Promise(resolve => setTimeout(resolve, 15));
      return { choices: [{ message: { role: 'assistant', content: '{"answer":42}' } }] };
    }
    return { choices: [{ message: { role: 'assistant', content: 'Done' } }] };
  } });
  try {
    const root = await runtime.startSession({ prompt: 'Ready' });
    await runtime.waitSession(root.id);
    const runId = 'wfr-' + 'b'.repeat(32);
    const broker = runtime.context(root.id).createWorkflowBroker({ runId, sessionId: root.id });
    store.put('sessions', 'old-child', { parent_session_id: root.id, status: 'interrupted', prompt: 'Return a result' });
    store.put('workflow_agents', `${runId}:same-call`, { run_id: runId, session_id: 'old-child', status: 'running', phase: 'check' });
    const request = { operation: 'agent', run_id: runId, call_id: 'same-call', prompt: 'Return a result',
      options: { phase: 'check', schema: { type: 'object', required: ['answer'] } } };
    const responses = await Promise.all(Array.from({ length: 3 }, () => runtime.workflowCall(runId, broker.token, request)));
    assert.deepEqual(responses, [{ answer: 42 }, { answer: 42 }, { answer: 42 }]);
    assert.equal(childCompletions, 1);
    const agent = store.get('workflow_agents', `${runId}:same-call`);
    assert.equal(agent.status, 'completed');
    assert.notEqual(agent.session_id, 'old-child');
    assert.equal(store.list('sessions').filter(row => row.parent_session_id === root.id && row.id !== 'old-child').length, 1);
    await broker.close();
  } finally { await runtime.close(); }
});

test('workflow dispatcher provisions E2B worker and uses only a scoped broker token', async () => {
  const { runtime, scripts, counts } = runtimeFixture();
  try {
    const root = await runtime.startSession({ prompt: 'Ready' });
    await runtime.waitSession(root.id);
    const run = await runtime.invoke(root.id, 'run_workflow', { workflow_name: 'smoke', script_path: '/home/user/workspace/workflow.py', timeout_secs: 1 });
    const result = await runtime.invoke(root.id, 'get_workflow_output', { run_id: run.id, timeout_secs: 1 });
    assert.equal(result.status, 'completed');
    assert.equal(result.output, 'done');
    assert.equal(counts().provisioned, 1);
    assert(scripts.has('/home/user/workspace/workflow.py'));
  } finally { await runtime.close(); }
});

test('blocking message and stop events halt the actual model worker', async () => {
  for (const [name, args] of [
    ['message_user', { message: 'Await review', attachments: [], block_on_user: true }],
    ['stop', {}]
  ]) {
    const { runtime, store } = runtimeFixture({ model: async messages => ({ choices: [{ message: messages.some(x => x.role === 'tool')
      ? { role: 'assistant', content: 'Should not execute' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) });
    try {
      const root = await runtime.startSession({ prompt: 'Wait' });
      const settled = await runtime.waitSession(root.id);
      assert.equal(settled.status, 'sleeping');
      assert(store.list('events').some(event => event.session_id === root.id && event.type === (name === 'stop' ? 'stop_requested' : 'message_user')));
    } finally { await runtime.close(); }
  }
});

test('sidekick and testing agent reuse a completed child session for later handoffs', async () => {
  const { runtime, store } = runtimeFixture();
  try {
    const root = await runtime.startSession({ prompt: 'Ready' });
    await runtime.waitSession(root.id);
    const sidekick = await runtime.invoke(root.id, 'sidekick', { message: 'First task', block: false });
    await runtime.waitSession(sidekick.agent_id);
    const again = await runtime.invoke(root.id, 'sidekick', { message: 'Second task', block: false });
    assert.equal(again.agent_id, sidekick.agent_id);
    await runtime.waitSession(sidekick.agent_id);
    assert.deepEqual(store.list('orchestration_messages').filter(x => x.session_id === sidekick.agent_id).map(x => x.body), ['First task', 'Second task']);
    const testing = await runtime.invoke(root.id, 'testing_agent', { message: 'Check UI', user_testing_request: 'Please check UI' });
    await runtime.waitSession(testing.agent_id);
    const retest = await runtime.invoke(root.id, 'testing_agent', { message: 'Check again' });
    assert.equal(retest.agent_id, testing.agent_id);
    await runtime.waitSession(testing.agent_id);
    assert.equal(store.list('sessions').filter(x => x.parent_session_id === root.id).length, 2);
  } finally { await runtime.close(); }
});
