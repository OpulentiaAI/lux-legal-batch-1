import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../core.mjs';
import { CAPY_TOOL_POLICY, capyInitialToolDefinitions, capyCodemodeListing, CAPY_TOOL_DEFINITIONS } from '../capy-policy.mjs';
import { capySessionIsTerminal } from '../capy-control.mjs';
import { capyFixture, completion, callsResponse } from './capy-runtime-fixture.mjs';

test('Capy definitions, handlers and discovery share the exact small policy', async t => {
  const { runtime } = await capyFixture(t);
  const session = runtime.allocate();
  assert.deepEqual(runtime.tools().map(row => row.name), CAPY_TOOL_POLICY.initialTools);
  assert.equal(capyInitialToolDefinitions().length, 10);
  assert.ok(JSON.stringify(capyInitialToolDefinitions()).length < 20000);
  assert.ok(capyCodemodeListing().length < 10000);
  assert.deepEqual(Object.keys(runtime.context(session.id).tools).sort(), [...CAPY_TOOL_POLICY.allowedTools].sort());
  assert.equal((runtime.config.systemPrompt.match(/<codemode>/g) ?? []).length, 1);
  for (const name of ['exec', 'scripted_tools', 'ipython', 'opulent_session_create', 'opulent_mcp', 'deploy', 'tool_search_tool_bm25']) await assert.rejects(runtime.invoke(session.id, name, {}), /forbidden/);
  assert.equal(CAPY_TOOL_DEFINITIONS.browser.codemodePath, 'capy.browser');
  assert.equal(CAPY_TOOL_DEFINITIONS.computer.codemodePath, 'capy.computer');
  assert.throws(() => createRuntime({ config: { runtimeCapabilities: ['capy-v1'], allowedTools: ['exec'] } }), /exact approved/);
  assert.throws(() => createRuntime({ config: { runtimeCapabilities: ['capy-v1'], allowedTools: [...CAPY_TOOL_POLICY.allowedTools.slice(0, -1), CAPY_TOOL_POLICY.allowedTools[0]] } }), /exact approved/);
  assert.throws(() => createRuntime({ config: { runtimeCapabilities: ['capy-v1'], initialTools: [...CAPY_TOOL_POLICY.initialTools.slice(0, -1), CAPY_TOOL_POLICY.initialTools[0]] } }), /lean initial/);
});

test('the real source-shaped profile preserves inline codemode guidance and appends one anchored listing block', async t => {
  const { runtime } = await capyFixture(t, { config: { instructionProfile: 'opulent-capy-v1' }, model: async messages => {
    assert.equal(messages[0].content, runtime.config.systemPrompt);
    assert.equal((messages[0].content.match(/^[ \t]*<codemode>/gm) ?? []).length, 1);
    return completion('Actual source-profile constructor verified');
  } });
  assert.ok(runtime.config.systemPrompt.slice(0, -capyCodemodeListing().length).includes('<codemode>'));
  assert.ok(runtime.config.systemPrompt.endsWith(capyCodemodeListing()));
  const row = await runtime.startSession({ prompt: 'Verify the real composed profile reaches the model' });
  assert.equal((await runtime.waitSession(row.id)).output, 'Actual source-profile constructor verified');
  assert.throws(() => createRuntime({ config: { runtimeCapabilities: ['capy-v1'], systemPrompt: 'Existing instructions\n<codemode>\npreconfigured listing\n</codemode>' } }), /owned by core/);
});

test('scoped task CRUD supports independent concurrency and safe dependency changes', async t => {
  const { runtime } = await capyFixture(t);
  const owner = runtime.allocate(), foreign = runtime.allocate();
  const { tasks } = await runtime.invoke(owner.id, 'task_create', { tasks: [{ subject: 'A' }, { subject: 'B' }, { subject: 'C' }] });
  const [a, b, c] = tasks;
  await runtime.invoke(owner.id, 'task_update', { updates: [{ task_id: a.id, status: 'in_progress' }, { task_id: b.id, status: 'in_progress' }] });
  await runtime.invoke(owner.id, 'task_update', { updates: [{ task_id: c.id, add_blocked_by: [a.id] }] });
  await assert.rejects(runtime.invoke(owner.id, 'task_update', { updates: [{ task_id: c.id, status: 'in_progress' }] }), /blocked/);
  await assert.rejects(runtime.invoke(owner.id, 'task_update', { updates: [{ task_id: a.id, add_blocked_by: [c.id] }] }), /cycle/);
  assert.deepEqual((await runtime.invoke(owner.id, 'task_get', { task_id: a.id })).blocked_by, []);
  await assert.rejects(runtime.invoke(foreign.id, 'task_get', { task_id: a.id }), /owned/);
  await runtime.invoke(owner.id, 'task_update', { updates: [{ task_id: a.id, status: 'deleted' }] });
  assert.deepEqual((await runtime.invoke(owner.id, 'task_get', { task_id: c.id })).blocked_by, []);
  assert.equal((await runtime.invoke(owner.id, 'task_list', {})).tasks.length, 2);
});

test('children inherit one lean policy and receive real provisioning before their model turn without depth caps', async t => {
  const { runtime, sandboxes } = await capyFixture(t, { config: { maxConcurrentSessions: 0, maxSessionDepth: 0 }, model: async (messages, options) => {
    assert.equal(options.tools.length, 10);
    assert.equal((messages[0].content.match(/<codemode>/g) ?? []).length, 1);
    assert.ok(sandboxes.length > 0);
    return completion('actual child findings');
  } });
  let owner = runtime.allocate({ title: 'Root' });
  const root = owner;
  for (let depth = 0; depth < 5; depth++) {
    const created = await runtime.invoke(owner.id, 'subagent_create', { tasks: [{ prompt: `Scoped depth ${depth}` }], start: { machine: 'fresh' } });
    assert.deepEqual(created.rejected, []);
    owner = await runtime.waitSession(created.tasks[0].id);
    assert.equal(owner.status, 'completed');
    assert.equal(owner.tool_policy, 'opulent-capy-v1');
    assert.ok(owner.sandbox_id);
  }
  assert.equal(sandboxes.length, 5);
  const leaf = await runtime.invoke(root.id, 'subagent_get', { path: '1.1.1.1.1' });
  assert.equal(leaf.output, 'actual child findings');
  const foreign = runtime.allocate();
  await assert.rejects(runtime.invoke(foreign.id, 'subagent_get', { path: leaf.id }), /Owned descendant/);
  assert.equal((await runtime.invoke(root.id, 'subagent_list', { limit: 100 })).items.length, 5);
});

test('message_user progress continues and terminal delivery stores real nonempty output', async t => {
  let turn = 0;
  const { runtime } = await capyFixture(t, { model: async () => ++turn === 1
    ? callsResponse(['message_user', { text: 'Tracing the sources.', state: 'working' }])
    : callsResponse(['message_user', { text: 'Completed with actual findings.', state: 'final' }], ['read', { path: 'not-started' }]) });
  const row = await runtime.startSession({ prompt: 'Do scoped work' });
  const final = await runtime.waitSession(row.id);
  assert.equal(turn, 2);
  assert.equal(final.status, 'completed');
  assert.equal(final.output, 'Completed with actual findings.');
  const transcript = runtime.store.get('conversations', row.id).messages;
  assert.match(transcript.filter(row => row.role === 'tool').at(-1).content, /not started.*terminal report/);
  assert.equal(runtime.store.list('capy_model_requests').filter(row => row.status === 'completed').length, 2);
});

test('parent reports enforce output schemas and preserve needs_you without fake completion', async t => {
  const { runtime } = await capyFixture(t, { model: async () => callsResponse(['message_agent', { text: '{"finding":"verified"}', state: 'final' }]) });
  const parent = runtime.allocate();
  const created = await runtime.invoke(parent.id, 'subagent_create', { tasks: [{ prompt: 'Return one real finding', schema: { type: 'object', required: ['finding'], additionalProperties: false, properties: { finding: { type: 'string' } } } }], start: { machine: 'fresh' } });
  const child = await runtime.waitSession(created.tasks[0].id);
  assert.equal(child.status, 'completed');
  assert.deepEqual(child.output, { finding: 'verified' });
  assert.ok(runtime.store.list('orchestration_messages').some(row => row.session_id === parent.id && row.body.includes('verified')));
  await assert.rejects(runtime.invoke(parent.id, 'message_user', { text: ' ', state: 'final' }), /nonempty/);
});

test('durable timer waits resume through the real scheduler and stopped descendants stay stopped', async t => {
  let turn = 0;
  const { runtime } = await capyFixture(t, { model: async () => ++turn === 1 ? callsResponse(['wait', { description: 'Waiting for a timer', duration_seconds: 1 }]) : completion('Timer resumed this session') });
  const row = await runtime.startSession({ prompt: 'Wait once, then return' });
  assert.equal((await runtime.waitSession(row.id)).status, 'sleeping');
  assert.equal(runtime.store.list('capy_waits')[0].status, 'waiting');
  await runtime.tick(row.id, new Date(Date.now() + 2000));
  assert.equal((await runtime.waitSession(row.id)).output, 'Timer resumed this session');
  const parent = runtime.allocate();
  const child = runtime.allocate({ prompt: 'Draft', parent_session_id: parent.id });
  const grandchild = runtime.allocate({ prompt: 'Draft grandchild', parent_session_id: child.id });
  await runtime.invoke(parent.id, 'subagent_stop', { paths: ['1'] });
  assert.equal(runtime.store.get('sessions', child.id).status, 'stopped');
  assert.equal(runtime.store.get('sessions', grandchild.id).status, 'stopped');
});

test('a final delivery with real child work pending resumes automatically without wait ceremony', async t => {
  let rootTurns = 0;
  const { runtime } = await capyFixture(t, { model: async messages => {
    if (messages[0].content.includes('You are a delegated child, not the lead coordinator')) {
      await new Promise(resolve => setTimeout(resolve, 150));
      return completion('Actual delayed child findings');
    }
    rootTurns++;
    if (rootTurns === 1) return callsResponse(['execute', { code: 'return await tools.subagent.create({tasks:[{prompt:"Perform owned delayed child work"}],start:{machine:"fresh"}});' }]);
    if (rootTurns === 2) return callsResponse(['message_user', { text: 'Initial final delivery, with a child still working.', state: 'final' }]);
    assert.match(JSON.stringify(messages), /Actual delayed child findings/);
    return completion('Final delivery incorporating the actual child result');
  } });
  const row = await runtime.startSession({ prompt: 'Delegate then deliver while the child is still working' });
  const final = await runtime.waitSession(row.id);
  assert.equal(rootTurns, 3);
  assert.equal(final.status, 'completed');
  assert.equal(final.pending_child_completion, false);
  assert.equal(final.output, 'Final delivery incorporating the actual child result');
  assert.ok(runtime.store.list('events').some(row => row.type === 'capy_final_delivered'));
  assert.equal(runtime.store.list('capy_waits').length, 0);
});

test('terminal codemode reports are truthfully restricted while working messages and directed sends remain available', async t => {
  const { runtime } = await capyFixture(t);
  const row = runtime.allocate();
  const refused = await runtime.invoke(row.id, 'execute', { code: 'await tools.message.user({text:"premature final",state:"final"}); await tools.capy.write({path:"must-not-exist",content:"bad"});' });
  assert.equal(refused.status, 'failed');
  assert.match(refused.error.message, /direct function call/);
  assert.ok(!runtime.store.list('capy_tool_results').some(result => result.name === 'write'));
  assert.equal(runtime.context(row.id).stopRequested, undefined);
  const working = await runtime.invoke(row.id, 'execute', { code: 'await tools.message.user({text:"Actual progress",state:"working"}); return 7;' });
  assert.equal(working.status, 'completed');
  assert.equal(working.value, 7);
  const stopped = await runtime.invoke(row.id, 'execute', { code: 'await tools.session.stop({}); await tools.capy.write({path:"must-not-exist",content:"bad"});' });
  assert.equal(stopped.status, 'completed');
  assert.deepEqual(stopped.value, { stopped: true });
  assert.ok(runtime.context(row.id).stopRequested);
  assert.ok(!runtime.store.list('capy_tool_results').some(result => result.name === 'write'));
});

test('a stopped codemode turn also refuses later direct model batch effects', async t => {
  const { runtime } = await capyFixture(t, { model: async () => callsResponse(
    ['execute', { code: 'await tools.session.stop({});' }],
    ['write', { path: 'must-not-exist', content: 'bad' }],
  ) });
  const row = await runtime.startSession({ prompt: 'Stop the turn before the next effect' });
  assert.equal((await runtime.waitSession(row.id)).status, 'sleeping');
  assert.ok(!runtime.store.list('capy_tool_results').some(result => result.name === 'write'));
  assert.match(runtime.store.get('conversations', row.id).messages.at(-1).content, /not started.*turn stopped/);
});

test('final delivery remains nonterminal while a child has only a durable timer and incorporates its actual resumed output', async t => {
  let rootTurns = 0, childTurns = 0;
  const { runtime } = await capyFixture(t, { model: async messages => {
    if (messages[0].content.includes('You are a delegated child, not the lead coordinator')) {
      return ++childTurns === 1 ? callsResponse(['wait', { description: 'Waiting for the child timer', duration_seconds: 60 }]) : completion('Actual findings after the durable child timer');
    }
    if (++rootTurns === 1) return callsResponse(['execute', { code: 'return await tools.subagent.create({tasks:[{prompt:"Wait then return actual child findings"}],start:{machine:"fresh"}});' }]);
    if (rootTurns === 2) return callsResponse(['message_user', { text: 'Initial delivery while the owned child waits.', state: 'final' }]);
    assert.match(JSON.stringify(messages), /Actual findings after the durable child timer/);
    return completion('Completed after the real child timer result');
  } });
  const row = await runtime.startSession({ prompt: 'Deliver while a child has a durable wait' });
  const sleeping = await runtime.waitSession(row.id);
  assert.equal(sleeping.status, 'sleeping');
  assert.equal(sleeping.pending_child_completion, true);
  assert.equal(capySessionIsTerminal(runtime.store, sleeping), false);
  await runtime.tick(row.id, new Date(Date.now() + 61000));
  const final = await runtime.waitSession(row.id);
  assert.equal(final.status, 'completed');
  assert.equal(rootTurns, 3);
  assert.equal(childTurns, 2);
  assert.equal(final.output, 'Completed after the real child timer result');
});

test('nested final deliveries resume each actual ancestor without terminating a running grandchild', async t => {
  let rootTurns = 0, middleTurns = 0;
  const { runtime } = await capyFixture(t, { model: async messages => {
    const assignment = messages.find(row => row.role === 'user').content;
    if (assignment === 'LEAF_ASSIGNMENT') {
      await new Promise(resolve => setTimeout(resolve, 150));
      return completion('Actual leaf result');
    }
    if (assignment === 'MIDDLE_ASSIGNMENT') {
      if (++middleTurns === 1) return callsResponse(['execute', { code: 'return await tools.subagent.create({tasks:[{prompt:"LEAF_ASSIGNMENT"}],start:{machine:"fresh"}});' }]);
      if (middleTurns === 2) return callsResponse(['message_user', { text: 'Middle initial delivery, leaf still running.', state: 'final' }]);
      assert.match(JSON.stringify(messages), /Actual leaf result/);
      return completion('Actual middle findings incorporating the leaf result');
    }
    if (++rootTurns === 1) return callsResponse(['execute', { code: 'return await tools.subagent.create({tasks:[{prompt:"MIDDLE_ASSIGNMENT"}],start:{machine:"fresh"}});' }]);
    if (JSON.stringify(messages).includes('Actual middle findings incorporating the leaf result')) return completion('Root incorporated the actual nested findings');
    return callsResponse(['message_user', { text: 'Root delivery while the owned hierarchy works.', state: 'final' }]);
  } });
  const row = await runtime.startSession({ prompt: 'ROOT_ASSIGNMENT' });
  const final = await runtime.waitSession(row.id);
  assert.equal(final.status, 'completed');
  assert.equal(final.output, 'Root incorporated the actual nested findings');
  const children = (await runtime.invoke(row.id, 'subagent_list', { limit: 100 })).items;
  assert.equal(children.length, 2);
  assert.ok(children.every(child => child.status === 'completed'));
  assert.equal(middleTurns, 3);
});

test('core hydrates shared fresh memory before model input, loads only indexes, and restores actual topic files on reattach', async t => {
  const memoryRoot = await mkdtemp(join(tmpdir(), 'capy-core-memory-'));
  const { runtime, sandboxes } = await capyFixture(t, { config: { capyMemory: {
    organizationId: 'fixture-approved-organization', userId: 'fixture-approved-user', projectId: 'fixture-fresh-project', scopes: ['project-user'], root: join(memoryRoot, '.capy', 'memory'),
  } }, model: async messages => {
    assert.match(messages[0].content, /<capy_memory_indexes>/);
    assert.match(messages[0].content, /verified-topic.md/);
    assert.ok(!JSON.stringify(messages).includes('PRIVATE_TOPIC_BODY_SENTINEL'));
    return completion('Index-only prompt verified');
  } });
  t.after(() => rm(memoryRoot, { recursive: true, force: true }));
  const seed = runtime.allocate();
  await runtime.invoke(seed.id, 'memory_save', { scope: 'project-user', file: 'verified-topic.md', title: 'Verified topic', description: 'Read the exact topic before using it.', body: 'PRIVATE_TOPIC_BODY_SENTINEL' });
  const row = await runtime.startSession({ prompt: 'Check the fresh scoped index without reading a topic' });
  assert.equal((await runtime.waitSession(row.id)).output, 'Index-only prompt verified');
  const mount = runtime.context(row.id).capyMemorySnapshot.mounts[0];
  assert.match(await readFile(join(mount.mountPath, 'verified-topic.md'), 'utf8'), /PRIVATE_TOPIC_BODY_SENTINEL/);
  await rm(join(memoryRoot, '.capy', 'memory'), { recursive: true, force: true });
  assert.equal(runtime.context(row.id).sandbox, undefined);
  const restored = await runtime.invoke(row.id, 'read', { path: join(mount.mountPath, 'verified-topic.md') });
  assert.match(restored.content, /PRIVATE_TOPIC_BODY_SENTINEL/);
  const child = await runtime.invoke(row.id, 'subagent_create', { tasks: [{ prompt: 'Check the inherited fresh memory index' }], start: { machine: 'fresh' } });
  assert.equal((await runtime.waitSession(child.tasks[0].id)).output, 'Index-only prompt verified');
  assert.equal(runtime.context(child.tasks[0].id).capyMemorySnapshot.mounts[0].mountPath, mount.mountPath);
  assert.equal(sandboxes.length, 3);
});

test('failed answerer requests retain an exact phase-linked record and unknown consumption without inventing a provider ID', async t => {
  let metadata;
  const { runtime } = await capyFixture(t, { model: async (_messages, options) => {
    metadata = { phase: options.phase, capy_request_record_id: options.capy_request_record_id };
    throw Object.assign(new Error('Provider failed'), { inferenceAttempts: [{ attempt: 1, status: 503 }] });
  } });
  const row = await runtime.startSession({ prompt: 'Exercise a failed provider request' });
  assert.equal((await runtime.waitSession(row.id)).status, 'failed');
  const [request] = runtime.store.list('capy_model_requests');
  assert.equal(request.phase, 'answerer');
  assert.equal(request.status, 'failed');
  assert.equal(request.response_id, null);
  assert.equal(request.usage_unknown, true);
  assert.deepEqual(request.request_attempts, [{ attempt: 1, status: 503 }]);
  assert.deepEqual(metadata, { phase: 'answerer', capy_request_record_id: request.id });
  assert.deepEqual(request.orchestration_message_ids, runtime.store.get('conversations', row.id).delivered);
  const failures = runtime.store.list('events').filter(row => row.type === 'model_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].data.phase, 'answerer');
  assert.equal(failures[0].data.capy_request_record_id, request.id);
  assert.equal(failures[0].data.request_id, null);
});

test('core uses the same model callable for bounded compaction and keeps exact returned IDs and usage separate from canonical history', async t => {
  let answererTurns = 0, summaryCalls = 0;
  const metadata = [];
  const { runtime, root } = await capyFixture(t, { model: async (messages, options) => {
    assert.equal(typeof options.capy_request_record_id, 'string');
    metadata.push({ phase: options.phase, id: options.capy_request_record_id });
    if (options.max_tokens !== undefined) {
      assert.equal(options.phase, 'context_compaction');
      assert.equal(options.model, 'mock-same-model');
      assert.equal(options.max_tokens, 8192);
      assert.ok(JSON.stringify(messages).length <= 160000);
      return { ...completion('Derived fixture summary; the preserved file remains the source.', `fixture-compactor-body-${++summaryCalls}`), inferenceAttempts: [{ attempt: 1, status: 200 }] };
    }
    assert.equal(options.phase, 'answerer');
    assert.ok(JSON.stringify(messages).length <= 300000);
    if (++answererTurns > 7) return completion('Completed with bounded derived context');
    const response = callsResponse(['read', { path: 'large-fixture.txt' }]);
    response.choices[0].message.tool_calls[0].id = `fixture-read-${answererTurns}`;
    return response;
  } });
  const source = 'Fixture file source text.\n'.repeat(2500);
  await writeFile(join(root, 'workspace', 'large-fixture.txt'), source);
  const row = await runtime.startSession({ prompt: 'Read a fixture repeatedly to exercise context bounds' });
  assert.equal((await runtime.waitSession(row.id)).status, 'completed');
  assert.ok(summaryCalls > 0);
  const raw = runtime.store.get('conversations', row.id).messages;
  assert.ok(JSON.stringify(raw).length > 300000);
  assert.equal(raw.filter(row => row.role === 'tool').length, 7);
  assert.ok(raw.filter(row => row.role === 'tool').every(row => JSON.parse(row.content).content === 'Fixture file source text.\n'.repeat(2000)));
  const requests = runtime.store.list('capy_model_requests');
  const summaries = requests.filter(row => row.phase === 'context_compaction');
  assert.equal(metadata.length, requests.length);
  assert.equal(new Set(metadata.map(row => row.id)).size, metadata.length);
  assert.ok(metadata.every(item => requests.some(row => row.id === item.id && row.phase === item.phase)));
  assert.equal(summaries.length, summaryCalls);
  for (const summary of summaries) {
    assert.equal(summary.status, 'completed');
    assert.match(summary.response_id, /^fixture-compactor-body-/);
    assert.equal(summary.max_tokens, 8192);
    assert.deepEqual(summary.orchestration_message_ids, runtime.store.get('conversations', row.id).delivered);
    assert.deepEqual(summary.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
    assert.deepEqual(summary.request_attempts, [{ attempt: 1, status: 200 }]);
    const usage = runtime.store.list('events').find(row => row.type === 'model_usage' && row.data.capy_request_record_id === summary.id);
    assert.equal(usage.data.phase, 'context_compaction');
    assert.equal(usage.data.response_id, summary.response_id);
    assert.deepEqual(usage.data.usage, summary.usage);
  }
  assert.ok(requests.filter(row => row.phase === 'answerer').every(row => JSON.stringify(row.messages).length <= 300000));
});

test('repaired, exhausted and unknown summary attempts retain per-response ledgers while conserving observed session usage', async t => {
  for (const outcome of ['repaired', 'exhausted', 'transport_failure']) await t.test(outcome, async t => {
    let answererTurns = 0, summaryCalls = 0;
    const bodies = new Map(), metadata = [];
    const rejectedUsage = { prompt_tokens: 7, completion_tokens: 8192, total_tokens: 8199, completion_tokens_details: { reasoning_tokens: 7957 } };
    const { runtime, root } = await capyFixture(t, { config: { contextCompaction: {
      enabled: true, maxInputChars: 35000, maxSummaryInputChars: 30000, maxSummaryChars: 2000, maxSummaryTokens: 8192, recentGroups: 2, maxBatches: 32,
    } }, model: async (messages, options) => {
      metadata.push(options.capy_request_record_id);
      if (options.phase === 'context_compaction') {
        assert.equal(options.max_tokens, 8192);
        assert.ok(JSON.stringify(messages).length <= 30000);
        if (++summaryCalls === 2 && outcome === 'transport_failure') throw Object.assign(new Error('Fixture connection lost'), { inferenceAttempts: [{ attempt: 1, status: 503 }] });
        const rejected = summaryCalls === 1 || outcome === 'exhausted';
        const response = rejected
          ? { id: `fixture-rejected-${summaryCalls}`, choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'Short truncated summary' } }], usage: rejectedUsage, inferenceAttempts: [{ attempt: 1, status: 200 }] }
          : { ...completion('Complete concise fixture summary', 'fixture-repaired'), inferenceAttempts: [{ attempt: 1, status: 200 }] };
        bodies.set(response.id, structuredClone(response));
        return response;
      }
      if (++answererTurns > 2) return completion('Bounded context delivered', 'fixture-final');
      const response = callsResponse(['read', { path: 'repair-ledger-fixture.txt' }]);
      response.id = `fixture-answerer-${answererTurns}`;
      response.choices[0].message.tool_calls[0].id = `fixture-read-${answererTurns}`;
      return response;
    } });
    await writeFile(join(root, 'workspace', 'repair-ledger-fixture.txt'), 'x'.repeat(20000) + '\n');
    const row = await runtime.startSession({ prompt: 'Verify bounded summary repair accounting' });
    const finished = await runtime.waitSession(row.id);
    assert.equal(finished.status, outcome === 'repaired' ? 'completed' : 'failed');
    assert.equal(summaryCalls, 2);
    const requests = runtime.store.list('capy_model_requests'), summaries = requests.filter(row => row.phase === 'context_compaction');
    assert.equal(summaries.length, 2);
    assert.equal(new Set(metadata).size, requests.length);
    const inputs = summaries.map(row => JSON.parse(row.messages[1].content));
    assert.equal(inputs[0].capySummaryContract.repair, null);
    assert.equal(inputs[1].capySummaryContract.repair.reason, 'truncated');
    assert.deepEqual(inputs[1].transcript, inputs[0].transcript);
    assert.equal(inputs[1].previousSummary, inputs[0].previousSummary);
    for (const request of summaries.filter(row => row.status === 'completed')) {
      assert.deepEqual(request.usage, bodies.get(request.response_id).usage);
      const event = runtime.store.list('events').find(row => row.type === 'model_usage' && row.data.capy_request_record_id === request.id);
      assert.equal(event.data.response_id, request.response_id);
      assert.deepEqual(event.data.usage, request.usage);
      assert.deepEqual(event.data.request_attempts, [{ attempt: 1, status: 200 }]);
    }
    const observed = {};
    for (const request of requests) for (const [key, value] of Object.entries(request.usage ?? {})) {
      if (typeof value === 'number') observed[key] = (observed[key] ?? 0) + value;
    }
    assert.deepEqual(finished.usage, observed);
    if (outcome === 'transport_failure') {
      const failed = summaries.find(row => row.status === 'failed');
      assert.equal(failed.response_id, null);
      assert.equal(failed.usage_unknown, true);
      assert.equal(failed.usage, undefined);
      assert.deepEqual(failed.request_attempts, [{ attempt: 1, status: 503 }]);
    }
    const raw = runtime.store.get('conversations', row.id);
    assert.equal(raw.messages.filter(row => row.role === 'tool').length, 2);
    assert.ok(!raw.messages.some(row => row.content?.includes('truncated summary')));
    if (outcome !== 'repaired') assert.equal(raw.context_checkpoint, undefined);
  });
});

test('resumed child completions at the same step number deliver new actual results through unique persisted notification IDs', async t => {
  let childTurns = 0;
  const { runtime } = await capyFixture(t, { model: async messages => {
    if (messages[0].content.includes('You are a delegated child, not the lead coordinator')) return completion(`Actual child result ${++childTurns}`);
    assert.match(JSON.stringify(messages), /Actual child result 1/);
    assert.match(JSON.stringify(messages), /Actual child result 2/);
    return completion('Parent received both actual child results');
  } });
  const parent = runtime.allocate();
  const created = await runtime.invoke(parent.id, 'subagent_create', { tasks: [{ prompt: 'Return the first finding' }], start: { machine: 'fresh' } });
  const first = await runtime.waitSession(created.tasks[0].id);
  await runtime.invoke(parent.id, 'subagent_message', { path: '1', text: 'Return a changed finding' });
  const second = await runtime.waitSession(first.id);
  assert.equal(first.steps, 1);
  assert.equal(second.steps, 1);
  assert.notEqual(first.capy_completion_id, second.capy_completion_id);
  const deliveries = runtime.store.list('orchestration_messages').filter(row => row.session_id === parent.id && row.source === 'subagent_completion');
  assert.equal(deliveries.length, 2);
  assert.notEqual(deliveries[0].id, deliveries[1].id);
  assert.match(deliveries[0].body, /Actual child result 1/);
  assert.match(deliveries[1].body, /Actual child result 2/);
  await runtime.messageSession(parent.id, 'Read the two delivered findings');
  assert.equal((await runtime.waitSession(parent.id)).output, 'Parent received both actual child results');
});

test('identical concurrent failed child requests retain distinct host correlation IDs', async t => {
  const seen = [];
  const { runtime } = await capyFixture(t, { model: async (messages, options) => {
    seen.push({ messages: JSON.stringify(messages), phase: options.phase, id: options.capy_request_record_id });
    await new Promise(resolve => setTimeout(resolve, 10));
    throw Object.assign(new Error('Concurrent provider failure'), { inferenceAttempts: [{ attempt: 1, status: 503 }] });
  } });
  const parent = runtime.allocate();
  const created = await runtime.invoke(parent.id, 'subagent_create', { tasks: Array.from({ length: 3 }, () => ({ prompt: 'Identical bounded child assignment' })), start: { machine: 'fresh' } });
  const failed = await Promise.all(created.tasks.map(row => runtime.waitSession(row.id)));
  assert.ok(failed.every(row => row.status === 'failed'));
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen.map(row => row.messages)).size, 1);
  assert.equal(new Set(seen.map(row => row.id)).size, 3);
  const requests = runtime.store.list('capy_model_requests');
  assert.equal(requests.length, 3);
  assert.ok(seen.every(item => item.phase === 'answerer' && requests.some(row => row.id === item.id && row.phase === 'answerer' && row.status === 'failed' && row.response_id === null && row.usage_unknown === true)));
});

test('failed compactor calls receive their exact host record ID and retain unknown consumption', async t => {
  let metadata;
  const { runtime, root } = await capyFixture(t, { config: { contextCompaction: {
    enabled: true, maxInputChars: 35000, maxSummaryInputChars: 30000, maxSummaryChars: 2000, maxSummaryTokens: 1000, recentGroups: 2, maxBatches: 32,
  } }, model: async (_messages, options) => {
    if (options.phase === 'context_compaction') {
      metadata = { phase: options.phase, capy_request_record_id: options.capy_request_record_id };
      assert.equal(options.max_tokens, 1000);
      throw Object.assign(new Error('Compactor provider failed'), { inferenceAttempts: [{ attempt: 1, status: 503 }] });
    }
    return callsResponse(['read', { path: 'compaction-fixture.txt' }]);
  } });
  await writeFile(join(root, 'workspace', 'compaction-fixture.txt'), 'x'.repeat(20000) + '\n');
  const row = await runtime.startSession({ prompt: 'Exercise failed compaction correlation' });
  assert.equal((await runtime.waitSession(row.id)).status, 'failed');
  const [request] = runtime.store.list('capy_model_requests').filter(row => row.phase === 'context_compaction');
  assert.equal(request.status, 'failed');
  assert.equal(request.response_id, null);
  assert.equal(request.usage_unknown, true);
  assert.deepEqual(request.orchestration_message_ids, runtime.store.get('conversations', row.id).delivered);
  assert.deepEqual(metadata, { phase: 'context_compaction', capy_request_record_id: request.id });
  const failures = runtime.store.list('events').filter(row => row.type === 'model_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].data.phase, 'context_compaction');
  assert.equal(failures[0].data.capy_request_record_id, request.id);
});

test('attachment reports verify unprivileged readability and actual target size instead of trusting visible stat metadata', async t => {
  const { runtime, root } = await capyFixture(t);
  const row = runtime.allocate();
  const file = join(root, 'workspace', 'document.txt');
  await writeFile(file, 'Actual readable document contents');
  await symlink(file, join(root, 'workspace', 'document-alias'));
  const report = await runtime.invoke(row.id, 'message_user', { text: 'Actual attachment metadata', state: 'working', files: [{ path: 'document-alias', title: 'Document' }] });
  assert.equal(report.files[0].path, file);
  assert.equal(report.files[0].bytes, Buffer.byteLength('Actual readable document contents'));
  assert.equal(report.files[0].sandbox_id, runtime.store.get('sessions', row.id).sandbox_id);
  await chmod(file, 0o000);
  await assert.rejects(runtime.invoke(row.id, 'message_user', { text: 'Unreadable attachment', state: 'working', files: [{ path: 'document-alias' }] }), /not a readable regular VM file/);
  assert.ok(!runtime.store.list('events').some(row => row.type === 'capy_user_message' && row.data.text === 'Unreadable attachment'));
});

test('an explicitly changed Capy source fingerprint invalidates retained summaries while an unchanged fingerprint reuses them', async t => {
  let answererTurns = 0;
  const summaries = [];
  const { runtime, root } = await capyFixture(t, { config: { contextCompaction: {
    enabled: true, maxInputChars: 35000, maxSummaryInputChars: 30000, maxSummaryChars: 2000, maxSummaryTokens: 1000, recentGroups: 2, maxBatches: 32, policyFingerprint: 'fixture-corpus-instructions-runtime-v1',
  } }, model: async (messages, options) => {
    if (options.phase === 'context_compaction') {
      summaries.push(JSON.parse(messages[1].content));
      return completion('Derived stable fixture summary', `fixture-summary-${summaries.length}`);
    }
    if (++answererTurns > 2) return completion('Bounded context delivered');
    const response = callsResponse(['read', { path: 'fingerprint-fixture.txt' }]);
    response.choices[0].message.tool_calls[0].id = `fingerprint-read-${answererTurns}`;
    return response;
  } });
  await writeFile(join(root, 'workspace', 'fingerprint-fixture.txt'), 'x'.repeat(20000) + '\n');
  const row = await runtime.startSession({ prompt: 'Check retained-summary source binding' });
  assert.equal((await runtime.waitSession(row.id)).status, 'completed');
  const original = runtime.store.get('conversations', row.id).context_checkpoint;
  const stableIndex = summaries.length;
  await runtime.messageSession(row.id, 'Continue under the unchanged source fingerprint');
  assert.equal((await runtime.waitSession(row.id)).status, 'completed');
  const stable = runtime.store.get('conversations', row.id).context_checkpoint;
  assert.equal(stable.provenance.policyFingerprintDigest, original.provenance.policyFingerprintDigest);
  assert.equal(summaries.length, stableIndex);
  assert.deepEqual(stable, original);
  const changedIndex = summaries.length;
  runtime.config.contextCompaction.policyFingerprint = 'fixture-corpus-instructions-runtime-v2';
  await runtime.messageSession(row.id, 'Continue under an explicitly changed source fingerprint');
  assert.equal((await runtime.waitSession(row.id)).status, 'completed');
  const changed = runtime.store.get('conversations', row.id).context_checkpoint;
  assert.notEqual(changed.provenance.policyFingerprintDigest, stable.provenance.policyFingerprintDigest);
  assert.equal(summaries[changedIndex].previousSummary, null);
  assert.ok(summaries[changedIndex].transcript.some(row => row.role === 'assistant' && row.tool_calls?.some(call => call.id === 'fingerprint-read-1')));
});

test('request snapshots distinguish an identical but not-yet-delivered message ID without changing model options or prompt text', async t => {
  let enter, release, turns = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { runtime } = await capyFixture(t, { model: async (_messages, options) => {
    if (++turns === 1) enter();
    assert.equal(options.orchestration_message_ids, undefined);
    if (turns === 1) await gate;
    return completion('Actual continued fixture output');
  } });
  const text = 'Identical text in distinct real queued messages';
  const row = await runtime.startSession({ prompt: text });
  let second;
  try {
    await entered;
    second = await runtime.messageSession(row.id, text);
    const [started] = runtime.store.list('capy_model_requests');
    assert.equal(started.orchestration_message_ids.length, 1);
    assert.ok(!started.orchestration_message_ids.includes(second.id));
  } finally { release(); }
  assert.equal((await runtime.waitSession(row.id)).status, 'completed');
  const requests = runtime.store.list('capy_model_requests');
  assert.equal(requests.length, 2);
  assert.ok(requests.every(row => row.status === 'completed'));
  assert.ok(!requests[0].orchestration_message_ids.includes(second.id));
  assert.ok(requests[1].orchestration_message_ids.includes(second.id));
  assert.equal(requests[0].messages.filter(row => row.role === 'user' && row.content === text).length, 1);
  assert.equal(requests[1].messages.filter(row => row.role === 'user' && row.content === text).length, 2);
});
