import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';
import { renderInstructions, DEFAULT_INSTRUCTION_PROMPT } from '../instructions/render.mjs';

const response = (content, usage = {}) => ({ choices: [{ message: { role: 'assistant', content } }], usage });

test('only v7 children receive the bounded role override, retaining their assigned prompt and schema', async () => {
  for (const config of [
    {}, { instructionProfile: 'opulent-context-v6' }, { instructionProfile: 'opulent-knowledge-v3', systemPrompt: 'Explicit prompt' },
    { instructionProfile: 'opulent-capability-v7' }, { instructionProfile: 'opulent-capability-v7', systemPrompt: 'Produce every public-task deliverable.' },
  ]) {
    const seen = [];
    const runtime = createRuntime({ store: createStore(':memory:'), config, model: async messages => {
      seen.push(messages);
      return response(messages[0].content.includes('Return final output as JSON matching:') ? '{"findings":"Bounded authorities"}' : 'Lead complete');
    } });
    try {
      const root = await runtime.startSession({ prompt: 'Complete all lead deliverables' });
      await runtime.waitSession(root.id);
      const schema = { type: 'object', additionalProperties: false, required: ['findings'], properties: { findings: { type: 'string' } } };
      const assigned = 'Research only the assigned limitation issue and return source identities and quotations.';
      const child = await runtime.context(root.id).startSession({ prompt: assigned, schema });
      assert.deepEqual((await runtime.waitSession(child.id)).output, { findings: 'Bounded authorities' });
      const base = config.systemPrompt ?? (config.instructionProfile ? renderInstructions({ profile: config.instructionProfile }).systemPrompt : DEFAULT_INSTRUCTION_PROMPT);
      assert.equal(seen[0][0].content, base);
      assert(seen[1][0].content.startsWith(base));
      assert.equal(seen[1].find(message => message.role === 'user').content, assigned);
      assert.equal(seen[1][0].content.endsWith(`Return final output as JSON matching: ${JSON.stringify(schema)}`), true);
      assert.equal(seen[1][0].content.includes('## Delegated child role and completion contract'), config.instructionProfile === 'opulent-capability-v7');
      if (config.instructionProfile === 'opulent-capability-v7') {
        assert.match(seen[1][0].content, /All evidence, authentication, approval, repository scope and secret protections still apply/);
        assert.match(seen[1][0].content, /without duplicating the lead's entire workflow/);
      }
    } finally { await runtime.close(); }
  }
});

test('quiesce drains active descendants and abort usage while leaving completed VMs collectible', async t => {
  const store = createStore(':memory:');
  const sandboxes = new Map();
  let entered, aborted, release;
  const workerEntered = new Promise(resolve => { entered = resolve; });
  const abortEntered = new Promise(resolve => { aborted = resolve; });
  const finishResponse = new Promise(resolve => { release = resolve; });
  let lateSpawnError, completedChild;
  const runtime = createRuntime({ store, config: { allowedRepos: ['fixture/repo'], runtimeCapabilities: ['operation-waits-v1'] },
    provision: async () => {
      const id = `fixture-vm-${sandboxes.size}`;
      const sandbox = { sandboxId: id, kills: 0, files: { makeDir: async () => {}, read: async () => 'Saved memo' },
        git: { clone: async () => {} }, pause: async () => {}, kill: async () => { sandbox.kills++; } };
      sandboxes.set(id, sandbox);
      return sandbox;
    }, connect: async id => sandboxes.get(id), model: async (messages, { signal }) => {
      const prompt = messages.find(message => message.role === 'user').content;
      if (prompt === 'In-flight child') {
        entered();
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        try { await runtime.context(completedChild.id).startSession({ prompt: 'Too late' }); }
        catch (error) { lateSpawnError = error.message; }
        aborted();
        await finishResponse;
        return response('Must not become a completed answer', { prompt_tokens: 7, completion_tokens: 2 });
      }
      if (prompt === 'Pending timer' || prompt === 'Intentional sleep') return { choices: [{ message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'sleep', type: 'function', function: prompt === 'Pending timer'
          ? { name: 'wait_for_operations', arguments: '{"duration_seconds":1}' }
          : { name: 'stop', arguments: '{}' } }] } }] };
      return response(prompt, { prompt_tokens: 3 });
    } });
  let closed = false;
  t.after(async () => { release(); if (!closed) await runtime.close(); });
  const root = await runtime.startSession({ prompt: 'Lead done', repos: ['fixture/repo'] });
  assert.equal((await runtime.waitSession(root.id)).status, 'completed');
  completedChild = await runtime.context(root.id).startSession({ prompt: 'Research done', repos: ['fixture/repo'] });
  await runtime.waitSession(completedChild.id);
  const active = await runtime.context(completedChild.id).startSession({ prompt: 'In-flight child', repos: ['fixture/repo'] });
  await workerEntered;
  const sleeping = await runtime.context(root.id).startSession({ prompt: 'Pending timer' });
  assert.equal((await runtime.waitSession(sleeping.id)).status, 'sleeping');
  const legacy = await runtime.context(root.id).startSession({ prompt: 'Intentional sleep' });
  assert.equal((await runtime.waitSession(legacy.id)).status, 'sleeping');
  let settled = false;
  const pending = runtime.quiesce().finally(() => { settled = true; });
  await abortEntered;
  await flush();
  assert.equal(settled, false);
  assert.match(lateSpawnError, /Runtime is quiescing/);
  assert.equal(store.list('sessions').some(row => row.prompt === 'Too late'), false);
  release();
  await pending;
  await runtime.quiesce();
  assert.equal(store.get('sessions', root.id).status, 'completed');
  assert.equal(store.get('sessions', root.id).output, 'Lead done');
  assert.equal(store.get('sessions', completedChild.id).status, 'completed');
  assert.equal(store.get('sessions', active.id).status, 'cancelled');
  assert.deepEqual(store.get('sessions', active.id).usage, { prompt_tokens: 7, completion_tokens: 2 });
  assert(store.list('events').some(row => row.session_id === active.id && row.type === 'model_usage' && row.data.usage.prompt_tokens === 7));
  assert.equal(store.get('sessions', sleeping.id).status, 'cancelled');
  assert.equal(store.list('operation_waits').find(row => row.session_id === sleeping.id).status, 'cancelled');
  assert.equal(store.get('sessions', legacy.id).status, 'sleeping');
  assert.equal(store.get('sessions', active.id).sandbox_id, null);
  const activeIds = store.get('sessions', active.id).sandbox_ids;
  assert.equal(activeIds.length, 1);
  assert.equal(sandboxes.get(activeIds[0]).kills, 1);
  assert(store.list('events').some(row => row.session_id === active.id && row.type === 'sandbox_created' && row.data.sandbox_id === activeIds[0]));
  const rootVm = sandboxes.get(store.get('sessions', root.id).sandbox_id);
  const childVm = sandboxes.get(store.get('sessions', completedChild.id).sandbox_id);
  assert.equal(rootVm.kills, 0);
  assert.equal(childVm.kills, 0);
  runtime.context(root.id).tools.read = async args => ({ content: await runtime.context(root.id).sandbox.files.read(args.file_path) });
  assert.deepEqual(await runtime.invoke(root.id, 'read', { file_path: '/home/user/workspace/memo.md' }), { content: 'Saved memo' });
  assert.deepEqual(store.get('sessions', root.id).sandbox_ids, [rootVm.sandboxId]);
  const closeStore = store.close;
  let finalSessions;
  store.close = () => { finalSessions = store.list('sessions'); closeStore(); };
  const result = await runtime.close();
  closed = true;
  assert.equal(result.cleanup_succeeded, true);
  assert.equal(rootVm.kills, 1);
  assert.equal(childVm.kills, 1);
  assert.equal(finalSessions.find(row => row.id === root.id).status, 'completed');
  assert.equal(finalSessions.find(row => row.id === completedChild.id).output, 'Research done');
});

test('native abort failure is settled and marked as unknown usage before quiesce returns', async t => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const runtime = createRuntime({ store: createStore(':memory:'), model: async (_, { signal }) => {
    entered();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    const error = new DOMException('Native request aborted', 'AbortError');
    error.inferenceAttempts = [{ status: null, elapsedMs: 12, failure: 'AbortError', usageUnknown: true }];
    throw error;
  } });
  t.after(() => runtime.close());
  const child = await runtime.startSession({ prompt: 'In flight' });
  await ready;
  await runtime.quiesce();
  assert.equal(runtime.store.get('sessions', child.id).status, 'cancelled');
  const failure = runtime.store.list('events').find(row => row.type === 'model_failed');
  assert.equal(failure.data.usage_unknown, true);
  assert.deepEqual(failure.data.request_attempts, [{ status: null, elapsedMs: 12, failure: 'AbortError', usageUnknown: true }]);
  assert.equal(runtime.store.list('events').filter(row => row.type === 'model_usage').length, 0);
});

test('quiesce also drains an already-started script broker child read and its ledger', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runtime = createRuntime({ store: createStore(':memory:'), config: { runtimeCapabilities: ['operation-waits-v1'], maxScriptToolCalls: 10 },
    model: async messages => messages.find(message => message.role === 'user').content === 'Child'
      ? { choices: [{ message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'timer', type: 'function', function: { name: 'wait_for_operations', arguments: '{"duration_seconds":1}' } }] } }] }
      : response('Lead done') });
  t.after(() => runtime.close());
  const root = await runtime.startSession({ prompt: 'Lead' });
  await runtime.waitSession(root.id);
  const child = await runtime.context(root.id).startSession({ prompt: 'Child' });
  await runtime.waitSession(child.id);
  const execution = runtime.context(root.id).beginScriptExecution();
  const call = runtime.scriptCall(root.id, execution.token, 'read_subagent', { agent_id: child.id, block: true, timeout: 10 });
  let settled = false;
  const pending = runtime.quiesce().finally(() => { settled = true; });
  await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(250);
  assert.equal((await call).status, 'cancelled');
  await pending;
  execution.finish('completed');
  assert.equal(runtime.store.list('script_calls')[0].status, 'completed');
  assert(runtime.store.list('events').some(row => row.type === 'tool_finished' && row.data.name === 'read_subagent'));
});

test('quiesce settles a background workflow without cancelling its completed owner', async t => {
  let finish, removeEntered, releaseRemove;
  const result = new Promise(resolve => { finish = resolve; });
  const removing = new Promise(resolve => { removeEntered = resolve; });
  const removed = new Promise(resolve => { releaseRemove = resolve; });
  let commandKills = 0, sandboxKills = 0;
  const sandbox = { sandboxId: 'fixture-workflow', files: { makeDir: async () => {}, read: async () => 'print("workflow")', write: async () => {},
    remove: async () => { removeEntered(); await removed; } }, commands: { run: async () => ({ wait: () => result,
      kill: async () => { commandKills++; finish({ exitCode: 137 }); } }) }, kill: async () => { sandboxKills++; } };
  const runtime = createRuntime({ store: createStore(':memory:'), config: { runtimeUrl: 'https://broker.example.test' },
    provision: async () => sandbox, connect: async () => sandbox, model: async () => response('Lead done') });
  t.after(async () => { releaseRemove(); await runtime.close(); });
  const root = await runtime.startSession({ prompt: 'Lead' });
  await runtime.waitSession(root.id);
  const workflow = await runtime.invoke(root.id, 'run_workflow', { workflow_name: 'fixture', script_path: '/home/user/workspace/workflow.py' });
  let settled = false;
  const pending = runtime.quiesce().finally(() => { settled = true; });
  await removing;
  assert.equal(settled, false);
  assert.equal(sandboxKills, 0);
  releaseRemove();
  await pending;
  assert.equal(commandKills, 1);
  assert.equal(runtime.store.get('sessions', root.id).status, 'completed');
  assert.equal(runtime.store.get('workflows', workflow.id).status, 'cancelled');
  assert(runtime.store.list('events').some(row => row.type === 'workflow_finished' && row.data.status === 'cancelled'));
});

test('failed cleanup stays visible, keeps the actual VM identity, and close reports failure compatibly', async t => {
  const store = createStore(':memory:');
  const sandbox = { sandboxId: 'fixture-failed-cleanup', files: { makeDir: async () => {} },
    kill: async () => { throw new Error('Provider kill failed'); } };
  const runtime = createRuntime({ store, provision: async () => sandbox, connect: async () => sandbox });
  let closed = false;
  t.after(async () => { if (!closed) await runtime.close(); });
  const root = runtime.allocate();
  runtime.context(root.id).tools.read = async () => ({ content: 'Fixture' });
  await runtime.invoke(root.id, 'read', { file_path: '/home/user/workspace/memo.md' });
  await assert.rejects(runtime.quiesce(), /Runtime quiescence cleanup failed/);
  assert.equal(store.get('sessions', root.id).sandbox_id, sandbox.sandboxId);
  assert.deepEqual(store.get('sessions', root.id).sandbox_ids, [sandbox.sandboxId]);
  assert(store.list('events').some(row => row.type === 'sandbox_kill_failed'));
  const closeStore = store.close;
  let events;
  store.close = () => { events = store.list('events'); closeStore(); };
  const result = await runtime.close();
  closed = true;
  assert.equal(result.cleanup_succeeded, false);
  assert(result.errors.some(error => error.includes('Provider kill failed')));
  assert(events.some(row => row.type === 'runtime_cleanup_failed'));
});
