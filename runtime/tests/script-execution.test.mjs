import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';
import { DEFAULT_INSTRUCTION_PROMPT, renderInstructions } from '../instructions/render.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

test('explicit instruction profile applies to parent and child unless systemPrompt overrides it', async () => {
  for (const [config, expected] of [
    [{}, DEFAULT_INSTRUCTION_PROMPT],
    [{ instructionProfile: 'opulent-knowledge-v3' }, renderInstructions({ profile: 'opulent-knowledge-v3' }).systemPrompt],
    [{ instructionProfile: 'opulent-knowledge-v3', systemPrompt: 'Explicit prompt' }, 'Explicit prompt'],
  ]) {
    const seen = [];
    const runtime = createRuntime({ store: createStore(':memory:'), config, model: async messages => {
      seen.push(messages[0].content);
      return { choices: [{ message: { role: 'assistant', content: 'Done' } }] };
    } });
    try {
      const parent = await runtime.startSession({ prompt: 'Parent' });
      await runtime.waitSession(parent.id);
      const child = await runtime.context(parent.id).startSession({ prompt: 'Child' });
      await runtime.waitSession(child.id);
      assert.deepEqual(seen, [expected, expected]);
    } finally { await runtime.close(); }
  }
});

test('structured desktop failure preserves partial result and distinguishes invocation from action outcome', async () => {
  const runtime = createRuntime({ store: createStore(':memory:') });
  const session = runtime.allocate();
  const ctx = runtime.context(session.id);
  ctx.sandbox = { kill: async () => {} };
  ctx.computer = {};
  const partial = { status: 'failed', completed_actions: 1, action_records: [{ index: 0, ok: true }], failure: { index: 1, phase: 'unknown' } };
  ctx.tools.computer = async () => partial;
  try {
    assert.deepEqual(await runtime.invoke(session.id, 'computer', { actions: [{ action: 'screenshot' }] }), partial);
    const finished = runtime.store.list('events').find(event => event.type === 'tool_finished');
    assert.deepEqual(finished.data, { name: 'computer', invocation_ok: true, ok: false, action_outcome: 'failed' });
    ctx.tools.computer = async () => ({ results: [] });
    await runtime.invoke(session.id, 'computer', { actions: [{ action: 'screenshot' }] });
    assert.deepEqual(runtime.store.list('events').filter(event => event.type === 'tool_finished').at(-1).data, { name: 'computer', ok: true });
  } finally { await runtime.close(); }
});

test('scoped budget, concurrency and nested facade deny calls without replaying earlier effects', async () => {
  const runtime = createRuntime({ store: createStore(':memory:'), config: {
    maxScriptToolCalls: 7, maxConcurrentScriptToolCalls: 2, allowedTools: ['list_knowledge_notes', 'opulent_mcp', 'scripted_tools', 'request_secret'],
  } });
  const session = runtime.allocate();
  const ctx = runtime.context(session.id);
  const hold = deferred(), entered = deferred();
  let effects = 0;
  ctx.tools.list_knowledge_notes = async args => {
    effects++;
    if (args.wait) { entered.resolve(); await hold.promise; }
    return { count: effects, value: args.value };
  };
  const run = ctx.beginScriptExecution();
  try {
    assert.equal((await runtime.scriptCall(session.id, run.token, 'list_knowledge_notes', {})).count, 1);
    const first = runtime.scriptCall(session.id, run.token, 'list_knowledge_notes', { wait: true });
    await entered.promise;
    const second = runtime.scriptCall(session.id, run.token, 'list_knowledge_notes', { wait: true });
    await assert.rejects(runtime.scriptCall(session.id, run.token, 'list_knowledge_notes', {}), /concurrent tool call limit/);
    hold.resolve();
    await Promise.all([first, second]);
    assert.equal((await runtime.scriptCall(session.id, run.token, 'opulent_mcp', { command: 'call_tool', tool_name: 'list_knowledge_notes', tool_args: '{}' })).count, 4);
    await assert.rejects(runtime.scriptCall(session.id, run.token, 'opulent_mcp', { command: 'call_tool', tool_name: 'request_secret', tool_args: '{}' }), /authorization failed/);
    await assert.rejects(runtime.scriptCall(session.id, run.token, 'grep', {}), /forbidden by execution policy/);
    await assert.rejects(runtime.scriptCall(session.id, run.token, 'list_knowledge_notes', {}), /budget exhausted/);
    assert.equal(effects, 4);
    assert.deepEqual(runtime.store.list('script_calls').map(row => [row.call_id, row.status]), [
      [1, 'completed'], [2, 'completed'], [3, 'completed'], [4, 'failed'], [5, 'completed'], [6, 'failed'], [7, 'failed'], [8, 'failed'],
    ]);
    run.finish('failed');
    await assert.rejects(runtime.scriptCall(session.id, run.token, 'list_knowledge_notes', {}), /authorization failed/);
    const next = ctx.beginScriptExecution();
    await assert.rejects(runtime.scriptCall(session.id, run.token, 'list_knowledge_notes', {}), /authorization failed/);
    await assert.rejects(runtime.scriptCall(session.id, ctx.config.scriptToken, 'list_knowledge_notes', {}), /authorization failed/);
    assert.equal((await runtime.scriptCall(session.id, next.token, 'list_knowledge_notes', {})).count, 5);
    const other = runtime.allocate();
    await assert.rejects(runtime.scriptCall(other.id, next.token, 'list_knowledge_notes', {}), /authorization failed/);
    next.finish('completed');
  } finally { hold.resolve(); run.finish('failed'); await runtime.close(); }
});

test('termination marks an in-flight effect uncertain and persists no arguments, results or bearer token', async () => {
  const runtime = createRuntime({ store: createStore(':memory:'), config: { maxScriptToolCalls: 2 } });
  const session = runtime.allocate();
  const ctx = runtime.context(session.id);
  const entered = deferred(), release = deferred();
  let effects = 0;
  ctx.secrets.set('PRIVATE', 'sensitive-payload');
  const run = ctx.beginScriptExecution();
  ctx.tools.list_knowledge_notes = async () => { effects++; entered.resolve(); await release.promise; return { secret: 'sensitive-payload', broker: run.token }; };
  try {
    const call = runtime.scriptCall(session.id, run.token, 'list_knowledge_notes', { value: 'sensitive-payload' });
    await entered.promise;
    run.finish('failed');
    assert.equal(runtime.store.list('script_calls')[0].status, 'uncertain');
    release.resolve();
    assert.deepEqual(await call, { secret: '[redacted]', broker: '[redacted]' });
    assert.equal(runtime.store.list('script_calls')[0].status, 'uncertain');
    assert.equal(effects, 1);
    const ledger = JSON.stringify([runtime.store.list('script_runs'), runtime.store.list('script_calls')]);
    assert(!ledger.includes(run.token));
    assert(!ledger.includes('sensitive-payload'));
    assert.equal(runtime.store.list('script_calls')[0].arguments.value, '[redacted]');
    assert(!JSON.stringify(runtime.store.list('events')).includes(run.token));
    assert.match(run.summary(), /1 uncertain/);
  } finally { release.resolve(); run.finish('failed'); await runtime.close(); }
});

test('concurrent programs retain isolated budgets and cannot spend another program’s calls', async () => {
  const runtime = createRuntime({ store: createStore(':memory:'), config: { maxScriptToolCalls: 1, maxConcurrentScriptToolCalls: 1 } });
  const session = runtime.allocate();
  const ctx = runtime.context(session.id);
  const first = ctx.beginScriptExecution(), second = ctx.beginScriptExecution();
  try {
    await Promise.all([
      runtime.scriptCall(session.id, first.token, 'list_knowledge_notes', {}),
      runtime.scriptCall(session.id, second.token, 'list_knowledge_notes', {}),
    ]);
    await assert.rejects(runtime.scriptCall(session.id, first.token, 'list_knowledge_notes', {}), /budget exhausted/);
    await assert.rejects(runtime.scriptCall(session.id, second.token, 'list_knowledge_notes', {}), /budget exhausted/);
    assert.deepEqual(runtime.store.list('script_calls').filter(row => row.status === 'completed').map(row => [row.run_id, row.call_id]), [[first.id, 1], [second.id, 1]]);
  } finally { first.finish('completed'); second.finish('completed'); await runtime.close(); }
});

test('completed ledger records returned IDs and bounds large redacted results', async () => {
  const runtime = createRuntime({ store: createStore(':memory:'), config: { maxScriptToolCalls: 2 } });
  const session = runtime.allocate();
  const ctx = runtime.context(session.id);
  ctx.tools.list_knowledge_notes = async () => ({ id: 'record-42', password: 'hidden-password', payload: 'x'.repeat(6000) });
  const run = ctx.beginScriptExecution();
  try {
    await runtime.scriptCall(session.id, run.token, 'list_knowledge_notes', { credential: 'hidden-credential' });
    const call = runtime.store.list('script_calls')[0];
    assert.equal(call.arguments.credential, '[redacted]');
    assert.equal(call.result.truncated, true);
    assert.match(call.result.prefix, /record-42/);
    assert(!JSON.stringify(call).includes('hidden-password'));
    assert(!JSON.stringify(call).includes('hidden-credential'));
    assert.match(call.result.sha256, /^[a-f0-9]{64}$/);
    run.finish('completed');
  } finally { run.finish('failed'); await runtime.close(); }
});

test('ledger removes unknown bearer/basic values and authenticated URL parameters, preserving public URLs', async () => {
  const runtime = createRuntime({ store: createStore(':memory:'), config: { maxScriptToolCalls: 2 } });
  const session = runtime.allocate();
  const ctx = runtime.context(session.id);
  const source = 'https://public.example/source?article=42&lang=en';
  const credentialUrl = 'https://public.example/source?article=42&access_token=opaque-query#token=opaque-fragment';
  ctx.tools.list_knowledge_notes = async () => ({ id: 'record-42', source, link: credentialUrl, header: 'Bearer opaque-unknown', basic: 'Basic YWxhZGRpbjpvcGVuc2VzYW1l' });
  const run = ctx.beginScriptExecution();
  try {
    await runtime.scriptCall(session.id, run.token, 'list_knowledge_notes', { note: 'Bearer unknown-input', source });
    const call = runtime.store.list('script_calls')[0];
    assert.equal(call.arguments.note, 'Bearer [redacted]');
    assert.equal(call.arguments.source, source);
    assert.equal(call.result.source, source);
    assert.equal(call.result.link, 'https://public.example/source?article=42&access_token=[redacted]#token=[redacted]');
    assert.equal(call.result.header, 'Bearer [redacted]');
    assert.equal(call.result.basic, 'Basic [redacted]');
    assert(!JSON.stringify(call).includes('opaque-'));
    ctx.tools.list_knowledge_notes = async () => { throw new Error('Authorization: Basic dXNlcjpwYXNz at https://public.example/source?api_key=opaque-error&article=42'); };
    await assert.rejects(runtime.scriptCall(session.id, run.token, 'list_knowledge_notes', {}));
    const failed = runtime.store.list('script_calls')[1];
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /Basic \[redacted\]/);
    assert.match(failed.error, /api_key=\[redacted\]&article=42/);
    assert(!failed.error.includes('opaque-error'));
    run.finish('completed');
  } finally { run.finish('failed'); await runtime.close(); }
});

test('script timeout retains prior completion and points to an uncertain call without raw secrets', async () => {
  const runtime = createRuntime({ store: createStore(':memory:'), config: { runtimeUrl: 'http://localhost:3333', maxScriptToolCalls: 2 } });
  const session = runtime.allocate();
  const ctx = runtime.context(session.id);
  const entered = deferred(), release = deferred();
  const secret = 'never-in-ledger';
  ctx.secrets.set('PRIVATE', secret);
  ctx.tools.list_knowledge_notes = async () => { entered.resolve(); await release.promise; return []; };
  const run = ctx.beginScriptExecution();
  await runtime.scriptCall(session.id, run.token, 'opulent_mcp', { command: 'list_tools' });
  run.finish('completed');
  ctx.sandbox = {
    files: { write: async () => {}, remove: async () => {} },
    commands: { run: async (_command, opts) => {
      const pending = runtime.scriptCall(session.id, opts.envs.RUNTIME_SCRIPT_TOKEN, 'list_knowledge_notes', { value: secret });
      await entered.promise;
      return { wait: async () => { await pending; return { stdout: '', stderr: '', exitCode: 0 }; }, kill: async () => {} };
    } },
    kill: async () => {},
  };
  try {
    await assert.rejects(ctx.tools.scripted_tools({ script: 'print(1)', timeout_secs: 0.01 }), error => {
      assert.match(error.message, /Script timed out/);
      assert.match(error.message, /ledger: 0 completed, 0 failed, 1 uncertain/);
      assert(!error.message.includes(secret));
      return true;
    });
    release.resolve();
    assert.equal(runtime.store.list('script_calls').at(-1).status, 'uncertain');
  } finally { release.resolve(); await runtime.close(); }
});

test('cancelling a script revokes its bearer token and leaves pending calls uncertain', async () => {
  const runtime = createRuntime({ store: createStore(':memory:'), config: { runtimeUrl: 'http://localhost:3333', maxScriptToolCalls: 2 } });
  const session = runtime.allocate();
  const ctx = runtime.context(session.id);
  const entered = deferred(), release = deferred();
  let pending, token, kills = 0;
  ctx.tools.list_knowledge_notes = async () => { entered.resolve(); await release.promise; return []; };
  ctx.sandbox = {
    files: { write: async () => {}, remove: async () => {} },
    commands: { run: async (_command, opts) => {
      token = opts.envs.RUNTIME_SCRIPT_TOKEN;
      pending = runtime.scriptCall(session.id, token, 'list_knowledge_notes', {});
      await entered.promise;
      return { wait: () => pending, kill: async () => { kills++; } };
    } },
    kill: async () => {},
  };
  try {
    const script = ctx.tools.scripted_tools({ script: 'print(1)' });
    await entered.promise;
    ctx.controller.abort(new Error('Cancelled'));
    await assert.rejects(script, /Cancelled.*ledger: 0 completed, 0 failed, 1 uncertain/);
    assert.equal(kills, 1);
    await assert.rejects(runtime.scriptCall(session.id, token, 'list_knowledge_notes', {}), /authorization failed/);
    release.resolve();
    await pending;
    assert.equal(runtime.store.list('script_calls')[0].status, 'uncertain');
  } finally { release.resolve(); await runtime.close(); }
});
