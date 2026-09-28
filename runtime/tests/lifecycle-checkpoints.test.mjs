import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function answer(content, tool_calls) {
  return { choices: [{ message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) } }] };
}

function call(id, title) {
  return { id, type: 'function', function: { name: 'devin_playbook_manage', arguments: JSON.stringify({ action: 'create', title, content: 'Instructions' }) } };
}

test('a message arriving during final inference is delivered before completion', async () => {
  const entered = deferred(), release = deferred();
  let calls = 0;
  const runtime = createRuntime({ store: createStore(':memory:'), model: async messages => {
    calls++;
    if (calls === 1) { entered.resolve(); await release.promise; return answer('Initial answer'); }
    assert.equal(messages.at(-2).content, 'Initial answer');
    assert.equal(messages.at(-1).content, 'Follow up');
    return answer('Follow-up answer');
  } });
  try {
    const session = await runtime.startSession({ prompt: 'Initial' });
    await entered.promise;
    const followup = await runtime.messageSession(session.id, 'Follow up');
    release.resolve();
    assert.equal((await runtime.waitSession(session.id)).output, 'Follow-up answer');
    assert.equal(calls, 2);
    assert(runtime.store.get('conversations', session.id).delivered.includes(followup.id));
  } finally { release.resolve(); await runtime.close(); }
});

test('a message arriving during asynchronous sandbox cleanup starts after cleanup', async () => {
  const pausing = deferred(), release = deferred();
  let calls = 0, pauses = 0;
  const sandbox = { sandboxId: 'cleanup-test', files: { makeDir: async () => {} }, git: { clone: async () => {} },
    pause: async () => { pauses++; if (pauses === 1) { pausing.resolve(); await release.promise; } }, kill: async () => {} };
  const runtime = createRuntime({ store: createStore(':memory:'), config: { allowedRepos: ['owner/repo'] }, provision: async () => sandbox, connect: async () => sandbox,
    model: async messages => answer(++calls === 1 ? 'Initial' : `Saw ${messages.at(-1).content}`),
  });
  try {
    const session = await runtime.startSession({ prompt: 'Initial', repos: ['owner/repo'] });
    await pausing.promise;
    const followup = await runtime.messageSession(session.id, 'Follow up');
    release.resolve();
    const settled = await runtime.waitSession(session.id);
    assert.equal(settled.output, 'Saw Follow up');
    assert.equal(calls, 2);
    assert(runtime.store.get('conversations', session.id).delivered.includes(followup.id));
  } finally { release.resolve(); await runtime.close(); }
});

test('workflow broker waits through a child continuation queued during cleanup', async () => {
  const pausing = deferred(), release = deferred();
  let calls = 0, pauses = 0;
  const sandbox = { sandboxId: 'workflow-child-double', files: { makeDir: async () => {} }, git: { clone: async () => {} },
    pause: async () => { if (++pauses === 1) { pausing.resolve(); await release.promise; } }, kill: async () => {} };
  const store = createStore(':memory:');
  const runtime = createRuntime({ store, config: { runtimeUrl: 'https://runtime.example', allowedRepos: ['owner/repo'] },
    provision: async () => sandbox, connect: async () => sandbox,
    model: async messages => {
      const latest = messages.filter(message => message.role === 'user').at(-1)?.content;
      if (latest === 'Root') return answer('Root ready');
      calls++;
      return answer(latest === 'Follow up' ? 'Final child result' : 'First child result');
    },
  });
  try {
    const root = await runtime.startSession({ prompt: 'Root' });
    await runtime.waitSession(root.id);
    const runId = 'wfr-late-child';
    const broker = runtime.context(root.id).createWorkflowBroker({ runId, sessionId: root.id });
    const result = runtime.workflowCall(runId, broker.token, {
      operation: 'agent', run_id: runId, call_id: 'one', prompt: 'First', options: { repos: ['owner/repo'] },
    });
    await pausing.promise;
    const [child] = store.list('sessions').filter(row => row.parent_session_id === root.id);
    const followup = await runtime.messageSession(child.id, 'Follow up');
    release.resolve();
    assert.equal(await result, 'Final child result');
    assert.equal(calls, 2);
    assert(store.get('conversations', child.id).delivered.includes(followup.id));
    assert.equal(store.get('workflow_agents', `${runId}:one`).result, 'Final child result');
    await broker.close();
  } finally { release.resolve(); await runtime.close(); }
});

test('completed first tool survives a second interrupted effect; resume marks uncertainty without replay', async () => {
  const started = deferred(), release = deferred();
  const store = createStore(':memory:');
  let calls = 0;
  const first = createRuntime({ store, model: async () => answer(null, [call('first', 'First'), call('second', 'Second')]) });
  let snapshot;
  try {
    const session = await first.startSession({ prompt: 'Create two' });
    const ctx = first.context(session.id);
    const original = ctx.tools.opulent_playbook_manage;
    ctx.tools.opulent_playbook_manage = async args => {
      calls++;
      if (args.title === 'Second') { started.resolve(); await release.promise; }
      return original(args);
    };
    await started.promise;
    snapshot = {
      session: store.get('sessions', session.id),
      conversation: store.get('conversations', session.id),
      queued: store.list('orchestration_messages'),
      playbooks: store.list('playbooks'),
    };
    assert.equal(snapshot.conversation.pending_tool_call_id, 'second');
    assert.equal(snapshot.conversation.messages.filter(message => message.role === 'tool').length, 1);
    assert.equal(snapshot.playbooks.length, 1);
    await first.cancelSession(session.id);
    release.resolve();
    await first.waitSession(session.id);
  } finally { release.resolve(); await first.close(); }

  const resumedStore = createStore(':memory:');
  resumedStore.put('sessions', snapshot.session.id, snapshot.session);
  resumedStore.put('conversations', snapshot.session.id, snapshot.conversation);
  for (const message of snapshot.queued) resumedStore.put('orchestration_messages', message.id, message);
  for (const playbook of snapshot.playbooks) resumedStore.put('playbooks', playbook.id, playbook);
  const resumed = createRuntime({ store: resumedStore, model: async messages => {
    const replies = messages.filter(message => message.role === 'tool');
    assert.equal(replies.length, 2);
    assert.equal(replies[0].tool_call_id, 'first');
    assert.equal(replies[1].tool_call_id, 'second');
    assert.match(replies[1].content, /side effects are uncertain/);
    return answer('Inspected after interruption');
  } });
  try {
    assert.equal(resumedStore.get('sessions', snapshot.session.id).status, 'interrupted');
    await resumed.messageSession(snapshot.session.id, 'Resume and inspect');
    assert.equal((await resumed.waitSession(snapshot.session.id)).output, 'Inspected after interruption');
    assert.equal(resumedStore.list('playbooks').length, 1);
    assert.equal(calls, 2);
  } finally { await resumed.close(); }
});

test('cancellation during inference does not complete or consume queued input', async () => {
  const entered = deferred(), release = deferred();
  let calls = 0;
  const runtime = createRuntime({ store: createStore(':memory:'), model: async () => {
    calls++; entered.resolve(); await release.promise; return answer('Cancelled response');
  } });
  try {
    const session = await runtime.startSession({ prompt: 'Initial' });
    await entered.promise;
    const followup = await runtime.messageSession(session.id, 'Follow up');
    await runtime.cancelSession(session.id);
    release.resolve();
    assert.equal((await runtime.waitSession(session.id)).status, 'cancelled');
    assert.equal(calls, 1);
    assert(!runtime.store.get('conversations', session.id).delivered.includes(followup.id));
  } finally { release.resolve(); await runtime.close(); }
});

test('a queued message does not bypass a blocking tool sleep', async () => {
  const entered = deferred(), release = deferred();
  let calls = 0;
  const runtime = createRuntime({ store: createStore(':memory:'), model: async () => {
    calls++;
    return calls === 1
      ? answer(null, [{ id: 'block', type: 'function', function: { name: 'message_user', arguments: JSON.stringify({ message: 'Await approval', attachments: [], block_on_user: true }) } }])
      : answer('Resumed after explicit input');
  } });
  try {
    const session = await runtime.startSession({ prompt: 'Request approval' });
    const ctx = runtime.context(session.id);
    const original = ctx.tools.message_user;
    ctx.tools.message_user = async args => { entered.resolve(); await release.promise; return original(args); };
    await entered.promise;
    const premature = await runtime.messageSession(session.id, 'Arrived before sleep');
    release.resolve();
    assert.equal((await runtime.waitSession(session.id)).status, 'sleeping');
    assert.equal(calls, 1);
    assert(!runtime.store.get('conversations', session.id).delivered.includes(premature.id));
    await runtime.messageSession(session.id, 'Explicit wake after sleep');
    assert.equal((await runtime.waitSession(session.id)).status, 'completed');
    assert.equal(calls, 2);
    assert(runtime.store.get('conversations', session.id).delivered.includes(premature.id));
  } finally { release.resolve(); await runtime.close(); }
});

test('late queued input cannot exceed the model-call budget', async () => {
  const entered = deferred(), release = deferred();
  let calls = 0;
  const runtime = createRuntime({ store: createStore(':memory:'), config: { maxSteps: 1 }, model: async () => {
    calls++; entered.resolve(); await release.promise; return answer('First response');
  } });
  try {
    const session = await runtime.startSession({ prompt: 'Initial' });
    await entered.promise;
    const followup = await runtime.messageSession(session.id, 'Follow up');
    release.resolve();
    const settled = await runtime.waitSession(session.id);
    assert.equal(settled.status, 'failed');
    assert.match(settled.error, /step budget exhausted/);
    assert.equal(calls, 1);
    assert(!runtime.store.get('conversations', session.id).delivered.includes(followup.id));
  } finally { release.resolve(); await runtime.close(); }
});

test('a failed provision with a newly queued message retries at most once', async () => {
  const entered = deferred(), release = deferred();
  let attempts = 0;
  const runtime = createRuntime({ store: createStore(':memory:'), config: { allowedRepos: ['owner/repo'] },
    provision: async () => { attempts++; if (attempts === 1) { entered.resolve(); await release.promise; } throw new Error('provision unavailable'); },
    model: async () => { throw new Error('model must not run'); },
  });
  try {
    const session = await runtime.startSession({ prompt: 'Initial', repos: ['owner/repo'] });
    await entered.promise;
    const followup = await runtime.messageSession(session.id, 'Follow up');
    release.resolve();
    const settled = await runtime.waitSession(session.id);
    assert.equal(settled.status, 'failed');
    assert.equal(attempts, 2);
    assert(!runtime.store.get('conversations', session.id)?.delivered?.includes(followup.id));
  } finally { release.resolve(); await runtime.close(); }
});

test('an explicit message after step exhaustion gets a fresh bounded turn', async () => {
  let calls = 0;
  const runtime = createRuntime({ store: createStore(':memory:'), config: { maxSteps: 1 }, model: async messages => {
    calls++;
    if (calls === 1) return { ...answer(null, [{ id: 'list', type: 'function', function: { name: 'list_knowledge_notes', arguments: '{}' } }]), usage: { total_tokens: 2 } };
    assert.equal(messages.at(-1).content, 'Explicit resume');
    return { ...answer('Resumed'), usage: { total_tokens: 3 } };
  } });
  try {
    const session = await runtime.startSession({ prompt: 'List notes' });
    assert.equal((await runtime.waitSession(session.id)).status, 'failed');
    await runtime.messageSession(session.id, 'Explicit resume');
    const resumed = await runtime.waitSession(session.id);
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.output, 'Resumed');
    assert.equal(resumed.error, null);
    assert.equal(resumed.steps, 1);
    assert.equal(resumed.usage.total_tokens, 5);
    assert.equal(calls, 2);
  } finally { await runtime.close(); }
});

test('model receives bounded images after all tool replies while durable transcript keeps adjacency', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vXcAAAAASUVORK5CYII=';
  let calls = 0;
  const runtime = createRuntime({ store: createStore(':memory:'), config: { modelInputImageMaxCount: 1 },
    provision: async () => ({ sandboxId: 'image-double', files: { makeDir: async () => {} }, pause: async () => {}, kill: async () => {} }),
    model: async messages => {
    if (++calls === 1) return answer(null, [
      { id: 'image-1', type: 'function', function: { name: 'generate_image', arguments: '{"prompt":"first"}' } },
      { id: 'image-2', type: 'function', function: { name: 'generate_image', arguments: '{"prompt":"second"}' } },
    ]);
    const tail = messages.slice(-4);
    assert.deepEqual(tail.map(message => message.role), ['assistant', 'tool', 'tool', 'user']);
    assert.equal(tail[1].tool_call_id, 'image-1');
    assert.equal(tail[2].tool_call_id, 'image-2');
    assert.match(tail[1].content, /provided separately/);
    assert.match(tail[2].content, /count limit/);
    assert(!tail[1].content.includes(png));
    assert.equal(tail[3].content[1].image_url.url, `data:image/png;base64,${png}`);
    return answer('Saw one image');
    } });
  try {
    const session = await runtime.startSession({ prompt: 'Make two images' });
    runtime.context(session.id).tools.generate_image = async () => ({ image_base64: png, mime_type: 'image/png' });
    assert.equal((await runtime.waitSession(session.id)).output, 'Saw one image');
    const conversation = runtime.store.get('conversations', session.id);
    assert.deepEqual(conversation.messages.slice(-5, -1).map(message => message.role), ['assistant', 'tool', 'tool', 'user']);
    assert.deepEqual(conversation.pending_image_observations, []);
    assert.equal(calls, 2);
  } finally { await runtime.close(); }
});

test('validated local MCP facade delivers image observations, including its legacy alias', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vXcAAAAASUVORK5CYII=';
  for (const facade of ['opulent_mcp', 'devin_mcp']) {
    let calls = 0;
    const runtime = createRuntime({ store: createStore(':memory:'), config: { allowedTools: ['opulent_mcp', 'generate_image'] },
      provision: async () => ({ sandboxId: 'facade-double', files: { makeDir: async () => {} }, pause: async () => {}, kill: async () => {} }),
      model: async messages => {
        if (++calls === 1) return answer(null, [{ id: 'facade-image', type: 'function', function: { name: facade,
          arguments: JSON.stringify({ command: 'call_tool', tool_name: 'generate_image', tool_args: '{"prompt":"fixture"}' }) } }]);
        assert.deepEqual(messages.slice(-2).map(message => message.role), ['tool', 'user']);
        assert.match(messages.at(-2).content, /provided separately/);
        assert.equal(messages.at(-1).content[1].image_url.url, `data:image/png;base64,${png}`);
        return answer('Image inspected');
      },
    });
    try {
      const session = await runtime.startSession({ prompt: 'Generate an image through facade' });
      runtime.context(session.id).tools.generate_image = async () => ({ image_base64: png, mime_type: 'image/png' });
      assert.equal((await runtime.waitSession(session.id)).output, 'Image inspected');
      assert.equal(calls, 2);
    } finally { await runtime.close(); }
  }
});

test('interrupted image batch restores prior observation only after unresolved replies', async () => {
  const store = createStore(':memory:');
  const runtime = createRuntime({ store, model: async messages => {
    assert.deepEqual(messages.slice(-5).map(message => message.role), ['assistant', 'tool', 'tool', 'user', 'user']);
    assert.match(messages.at(-3).content, /side effects are uncertain/);
    assert.equal(messages.at(-2).content[1].image_url.url, 'data:image/png;base64,test');
    return answer('Uncertain effect disclosed');
  } });
  try {
    const session = runtime.allocate({ prompt: 'Create images' });
    store.put('sessions', session.id, { ...session, status: 'interrupted', steps: 1 });
    store.put('conversations', session.id, {
      messages: [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Create images' },
        { role: 'assistant', content: null, tool_calls: [call('first', 'First'), call('second', 'Second')] },
        { role: 'tool', tool_call_id: 'first', content: '{"image_observation":"provided separately"}' },
      ],
      delivered: [], pending_tool_call_id: 'second',
      pending_image_observations: [{ role: 'user', content: [{ type: 'text', text: 'Untrusted image' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,test' } }] }],
      pending_image_usage: { images: 1, bytes: 3 },
    });
    await runtime.messageSession(session.id, 'Resume');
    assert.equal((await runtime.waitSession(session.id)).output, 'Uncertain effect disclosed');
    assert.deepEqual(store.get('conversations', session.id).pending_image_observations, []);
  } finally { await runtime.close(); }
});

test('opt-in compaction projects model context but retains the full durable transcript and usage', async () => {
  const store = createStore(':memory:');
  let summaries = 0, calls = 0;
  const runtime = createRuntime({ store, config: { model: 'test/summary-model', contextCompaction: {
    enabled: true, maxInputChars: 850, maxSummaryInputChars: 750, maxSummaryChars: 90,
    maxSummaryTokens: 64, recentGroups: 2, maxBatches: 12,
  } }, model: async (messages, options) => {
    if (!options.tools) {
      summaries++;
      return { ...answer('Earlier findings summarized.'), usage: { total_tokens: 12 } };
    }
    calls++;
    assert(messages.some(message => typeof message.content === 'string' && message.content.includes('Derived summary')));
    assert(JSON.stringify(messages).length <= 850);
    return answer('Done');
  } });
  try {
    const session = runtime.allocate({ prompt: 'Investigate' });
    const history = [
      { role: 'system', content: 'System instructions' }, { role: 'user', content: 'Investigate' },
      ...Array.from({ length: 8 }, (_, index) => ({ role: 'assistant', content: `Earlier finding ${index}: ${'evidence '.repeat(8)}` })),
      { role: 'assistant', content: 'Latest finding' },
    ];
    store.put('conversations', session.id, { messages: history, delivered: [] });
    await runtime.messageSession(session.id, 'Continue');
    const settled = await runtime.waitSession(session.id);
    assert.equal(settled.output, 'Done');
    assert.equal(calls, 1);
    assert(summaries > 0);
    assert.equal(settled.usage.total_tokens, summaries * 12);
    const durable = store.get('conversations', session.id);
    assert.deepEqual(durable.messages.slice(0, history.length), history);
    assert(durable.context_checkpoint?.summary);
    const compacted = store.list('events').find(event => event.session_id === session.id && event.type === 'context_compacted');
    assert(compacted.data.before_chars > compacted.data.after_chars);
    assert.equal(compacted.data.prefix_digest, durable.context_checkpoint.prefixDigest);
    assert.equal(compacted.data.usage.total_tokens, summaries * 12);
  } finally { await runtime.close(); }
});

test('failed compaction reports completed summary usage without replacing full history', async () => {
  const store = createStore(':memory:');
  let summaries = 0;
  const runtime = createRuntime({ store, config: { model: 'test/summary-model', contextCompaction: {
    enabled: true, maxInputChars: 850, maxSummaryInputChars: 750, maxSummaryChars: 90,
    maxSummaryTokens: 64, recentGroups: 2, maxBatches: 12,
  } }, model: async (_, options) => {
    assert.equal(options.tools, undefined);
    if (++summaries === 2) throw new Error('summary provider failed');
    return { ...answer('Earlier findings summarized.'), usage: { total_tokens: 12 } };
  } });
  try {
    const session = runtime.allocate({ prompt: 'Investigate' });
    const history = [
      { role: 'system', content: 'System instructions' }, { role: 'user', content: 'Investigate' },
      ...Array.from({ length: 8 }, (_, index) => ({ role: 'assistant', content: `Earlier finding ${index}: ${'evidence '.repeat(8)}` })),
    ];
    store.put('conversations', session.id, { messages: history, delivered: [] });
    await runtime.messageSession(session.id, 'Continue');
    const settled = await runtime.waitSession(session.id);
    assert.equal(settled.status, 'failed');
    assert.equal(summaries, 2);
    assert.equal(settled.usage.total_tokens, 12);
    assert.deepEqual(store.get('conversations', session.id).messages.slice(0, history.length), history);
    assert.equal(store.get('conversations', session.id).context_checkpoint, undefined);
    const failed = store.list('events').find(event => event.session_id === session.id && event.type === 'context_compaction_failed');
    assert.equal(failed.data.usage.total_tokens, 12);
  } finally { await runtime.close(); }
});

test('compaction checkpoint redacts injected session secrets before SQLite persistence', async () => {
  const secret = 'private-checkpoint-secret-7d2e';
  const store = createStore(':memory:');
  const runtime = createRuntime({ store, config: { model: 'test/summary-model', contextCompaction: {
    enabled: true, maxInputChars: 850, maxSummaryInputChars: 750, maxSummaryChars: 90,
    maxSummaryTokens: 64, recentGroups: 2, maxBatches: 12,
  } }, model: async (_messages, options) => options.tools ? answer('Done') : answer(`Earlier finding: ${secret}`) });
  try {
    const session = runtime.allocate({ prompt: 'Investigate' });
    await runtime.context(session.id).injectSessionSecret({ sessionId: session.id, name: 'CHECKPOINT_SECRET', value: secret });
    const history = [
      { role: 'system', content: 'System instructions' }, { role: 'user', content: 'Investigate' },
      ...Array.from({ length: 8 }, (_, index) => ({ role: 'assistant', content: `Earlier finding ${index}: ${'evidence '.repeat(8)}` })),
    ];
    store.put('conversations', session.id, { messages: history, delivered: [] });
    await runtime.messageSession(session.id, 'Continue');
    assert.equal((await runtime.waitSession(session.id)).status, 'completed');
    const durable = store.get('conversations', session.id);
    assert.match(durable.context_checkpoint.summary, /\[redacted\]/);
    assert(!JSON.stringify(durable).includes(secret));
    assert(!JSON.stringify(store.list('events')).includes(secret));
  } finally { await runtime.close(); }
});

test('oversized tool output exposes a confined paged artifact whose last line can be read', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'runtime-overflow-loop-'));
  const store = createStore(':memory:');
  let calls = 0, pointer;
  const sandbox = { sandboxId: 'overflow-double', files: {
    makeDir: async path => mkdirSync(path, { recursive: true }),
    write: async entries => { for (const entry of entries) writeFileSync(entry.path, entry.data); },
    remove: async path => unlinkSync(path),
  }, commands: { run: async command => {
    const match = /^python3 (\/tmp\/runtime-files-[\w-]+\.py) (\/tmp\/runtime-files-[\w-]+\.json)$/.exec(command);
    assert(match);
    return { stdout: execFileSync('python3', match.slice(1), { encoding: 'utf8' }) };
  } }, pause: async () => {}, kill: async () => {} };
  const runtime = createRuntime({ store, config: { workspace, allowedTools: ['list_knowledge_notes', 'read'] },
    provision: async () => sandbox, connect: async () => sandbox, model: async messages => {
      if (++calls === 1) return answer(null, [{ id: 'large', type: 'function', function: { name: 'list_knowledge_notes', arguments: '{}' } }]);
      if (calls === 2) {
        pointer = JSON.parse(messages.at(-1).content);
        assert.equal(pointer.truncated, true);
        assert.equal(pointer.encoding, 'jsonl-string-chunks');
        assert(pointer.lines > 1);
        assert(pointer.overflow_path.startsWith('.opulent-tool-results/'));
        assert(!messages.at(-1).content.includes('TAIL_MARKER'));
        return answer(null, [{ id: 'tail', type: 'function', function: { name: 'read',
          arguments: JSON.stringify({ file_path: pointer.overflow_path, offset: pointer.lines, limit: 2_000 }) } }]);
      }
      const tail = JSON.parse(messages.at(-1).content);
      assert(JSON.parse(tail.content).includes('TAIL_MARKER'));
      assert.equal(tail.overflow_paging.requested_limit, 2_000);
      assert.equal(tail.overflow_paging.limit, 2);
      assert.equal(tail.overflow_paging.limit_capped, true);
      assert.equal(tail.overflow_paging.next_offset, null);
      assert(messages.at(-1).content.length < 80_000);
      return answer('Tail checked');
    },
  });
  try {
    const session = await runtime.startSession({ prompt: 'Inspect a long result' });
    runtime.context(session.id).tools.list_knowledge_notes = async () => ({ text: 'A'.repeat(90_000) + 'TAIL_MARKER' });
    assert.equal((await runtime.waitSession(session.id)).output, 'Tail checked');
    assert.equal(calls, 3);
    const [record] = store.list('tool_result_overflows');
    assert.equal(record.session_id, session.id);
    assert.equal(record.status, 'available');
    assert.equal(record.sha256, pointer.sha256);
    writeFileSync(join(workspace, 'ordinary.txt'), 'ordinary content');
    const ordinary = await runtime.invoke(session.id, 'read', { file_path: 'ordinary.txt', limit: 2_000 });
    assert.equal(ordinary.content, 'ordinary content');
    assert.equal(ordinary.overflow_paging, undefined);
  } finally { await runtime.close(); rmSync(workspace, { recursive: true, force: true }); }
});

test('overflow provisioning failure exposes bounded failure, not a false retrieval pointer', async () => {
  const store = createStore(':memory:');
  let calls = 0;
  const runtime = createRuntime({ store, config: { allowedTools: ['list_knowledge_notes', 'read'] },
    provision: async () => { throw new Error('provider unavailable'); },
    model: async messages => {
      if (++calls === 1) return answer(null, [{ id: 'large', type: 'function', function: { name: 'list_knowledge_notes', arguments: '{}' } }]);
      const result = JSON.parse(messages.at(-1).content);
      assert.equal(result.overflow_error, 'sandbox_unavailable');
      assert.equal(result.overflow_path, undefined);
      assert.equal(result.truncated, true);
      return answer('Unavailable artifact disclosed');
    },
  });
  try {
    const session = await runtime.startSession({ prompt: 'Inspect a long result' });
    runtime.context(session.id).tools.list_knowledge_notes = async () => ({ text: 'A'.repeat(90_000) + 'TAIL_MARKER' });
    assert.equal((await runtime.waitSession(session.id)).output, 'Unavailable artifact disclosed');
    assert.equal(store.list('tool_result_overflows')[0].status, 'unavailable');
    assert.equal(calls, 2);
  } finally { await runtime.close(); }
});
