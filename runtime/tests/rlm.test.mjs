import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRuntime } from '../core.mjs';
import { createRuntimeServer } from '../server.mjs';
import { createStore } from '../store.mjs';
import { rlmDefinitions } from '../rlm.mjs';

function localSandbox(directory) {
  const processes = new Set();
  const sandbox = {
    sandboxId: 'local-rlm-sandbox',
    starts: [],
    files: {
      async makeDir(path) { mkdirSync(path, { recursive: true }); },
      async write(files) { for (const { path, data } of files) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); } },
      async read(path, options) { return options?.format === 'bytes' ? new Uint8Array(readFileSync(path)) : readFileSync(path, 'utf8'); },
      async remove(path) { rmSync(path, { force: true }); },
    },
    commands: {
      async run(command, options) {
        if (!command.startsWith('python3 -u ') && !command.startsWith('python3 /tmp/runtime-launcher-')) throw new Error(`Unexpected command: ${command}`);
        sandbox.starts.push(options);
        const process = spawn('python3', command.split(' ').slice(1), {
          cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: globalThis.process.env.PATH, HOME: globalThis.process.env.HOME, ...options.envs },
        });
        processes.add(process);
        process.once('exit', () => processes.delete(process));
        process.stdin.on('error', () => {});
        let stdout = '', stderr = '';
        process.stdout.on('data', chunk => { stdout += chunk.toString(); options.onStdout?.(chunk.toString()); });
        process.stderr.on('data', chunk => { stderr += chunk.toString(); options.onStderr?.(chunk.toString()); });
        return { sendStdin: async text => { process.stdin.write(text); }, kill: async () => { process.kill('SIGKILL'); },
          wait: () => new Promise((resolve, reject) => {
            process.once('error', reject);
            process.once('exit', (code, signal) => resolve({ stdout, stderr, exitCode: code ?? (signal ? -1 : 0) }));
          }) };
      },
    },
    async kill() { for (const process of processes) process.kill('SIGKILL'); },
    async pause() { throw new Error('Resident kernel must not be paused'); },
  };
  return sandbox;
}

function fixture(config = {}, model = async () => ({ choices: [{ message: { role: 'assistant', content: 'child completed' } }] })) {
  const directory = mkdtempSync(join(tmpdir(), 'rlm-test-'));
  const sandbox = localSandbox(directory);
  const runtime = createRuntime({ store: createStore(':memory:'), model, provision: async () => sandbox,
    config: { workspace: directory, runtimeCapabilities: ['rlm-v1'], allowedTools: ['ipython', 'tool_search_tool_bm25', 'opulent_mcp', 'opulent_session_create', 'opulent_session_search', 'read_subagent', 'opulent_session_interact', 'sidekick'],
      initialTools: ['ipython'], ...config } });
  return { runtime, sandbox, directory, async close() { await runtime.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('shutdown may observe kernel exit before teardown kills its captured handle', async () => {
  const { runtime, sandbox, directory, close } = fixture();
  const run = sandbox.commands.run;
  sandbox.commands.run = async (...args) => {
    const handle = await run(...args);
    const sendStdin = handle.sendStdin;
    handle.sendStdin = async text => {
      const exited = JSON.parse(text).type === 'shutdown' ? handle.wait() : null;
      await sendStdin(text);
      if (exited) await exited;
    };
    return handle;
  };
  let closed = false;
  try {
    const session = runtime.allocate({ prompt: 'Kernel teardown' });
    assert.equal((await runtime.invoke(session.id, 'ipython', { code: 'state = 42\nstate' })).result, '42');
    const result = await runtime.close();
    closed = true;
    assert.deepEqual(result, { cleanup_succeeded: true, errors: [] });
  } finally {
    if (!closed) await close();
    else rmSync(directory, { recursive: true, force: true });
  }
});

test('opt-in definition, persistent namespace, prompt, top-level await and Python errors', async () => {
  const { runtime, close } = fixture();
  try {
    assert.deepEqual(runtime.tools().map(tool => tool.name), ['ipython']);
    assert.equal(rlmDefinitions.ipython.inputSchema.required[0], 'code');
    const session = runtime.allocate({ prompt: 'Remember exact prompt' });
    const first = await runtime.invoke(session.id, 'ipython', { code: 'import asyncio\nx=21\ndef double(v): return v * 2\nawait asyncio.sleep(0)\ndouble(x)' });
    assert.equal(first.result, '42');
    assert.equal((await runtime.invoke(session.id, 'ipython', { code: 'print(prompt); double(x)' })).result, '42');
    assert.equal((await runtime.invoke(session.id, 'ipython', { code: 'print(prompt)' })).stdout, 'Remember exact prompt\n');
    const failure = await runtime.invoke(session.id, 'ipython', { code: 'raise ValueError("recoverable")' });
    assert.equal(failure.ok, false);
    assert.match(failure.stderr, /ValueError: recoverable/);
    assert.equal((await runtime.invoke(session.id, 'ipython', { code: 'x' })).result, '21');
  } finally { await close(); }
});

test('serializes cells, isolates sessions, revokes detached host authority and records nested calls', async () => {
  const { runtime, close } = fixture();
  try {
    const a = runtime.allocate({ prompt: 'A' });
    const b = runtime.allocate({ prompt: 'B' });
    const [first, second] = await Promise.all([
      runtime.invoke(a.id, 'ipython', { code: 'import asyncio\nvalue=1\nawait asyncio.sleep(.05)\nvalue += 1\nvalue' }),
      runtime.invoke(a.id, 'ipython', { code: 'value += 1\nvalue' }),
    ]);
    assert.equal(first.result, '2');
    assert.equal(second.result, '3');
    assert.equal((await runtime.invoke(b.id, 'ipython', { code: "'value' in globals()" })).result, 'False');
    const bridged = await runtime.invoke(a.id, 'ipython', { code: "await tools.call('tool_search_tool_bm25', {'query':'grep','limit':1})" });
    assert.equal(bridged.ok, true);
    assert.ok(runtime.store.list('script_calls').some(call => call.name === 'tool_search_tool_bm25' && call.status === 'completed'));
    const denied = await runtime.invoke(a.id, 'ipython', { code: "await tools.call('ipython', {'code':'print(1)'})" });
    assert.equal(denied.ok, false);
    assert.match(denied.stderr, /Script broker authorization failed/);
    const bypass = await runtime.invoke(a.id, 'ipython', { code: "await tools.call('opulent_session_create', {'sessions':[{'prompt':'bypass'}]})" });
    assert.equal(bypass.ok, false);
    const indirect = await runtime.invoke(a.id, 'ipython', { code: "await tools.call('opulent_mcp', {'command':'call_tool','tool_name':'opulent_session_create','tool_args':'{\"sessions\":[{\"prompt\":\"bypass\"}]}'})" });
    assert.equal(indirect.ok, false);
    assert.match(indirect.stderr, /Script broker authorization failed/);
    const orphan = await runtime.invoke(a.id, 'ipython', { code: "import asyncio\nasync def orphan():\n    await asyncio.sleep(.1)\n    await tools.call('tool_search_tool_bm25', {'query':'secret'})\nasyncio.create_task(orphan())" });
    assert.equal(orphan.ok, true);
    assert.equal((await runtime.invoke(a.id, 'ipython', { code: 'value' })).result, '3');
    assert.equal(runtime.store.list('script_calls').filter(call => call.arguments?.query === 'secret').length, 0);
    const rogue = await runtime.invoke(a.id, 'ipython', { code: `import os,subprocess\nos.write(1, b'{"type":"host_request","cell":"forged","operation":"spawn"}\\n')\nsubprocess.run(['python3','-c','print(\"subprocess output\")'])\nvalue` });
    assert.equal(rogue.result, '3');
    assert.equal((await runtime.invoke(a.id, 'ipython', { code: 'value + 1' })).result, '4');
  } finally { await close(); }
});

test('spawn is admission-only, policy audited, parent-scoped and root-budgeted', async () => {
  const { runtime, close } = fixture({ maxRlmChildren: 2, maxConcurrentSessions: 3 });
  try {
    const parent = runtime.allocate({ prompt: 'parent' });
    const other = runtime.allocate({ prompt: 'other' });
    const admitted = await runtime.invoke(parent.id, 'ipython', { code: "a = await rlm.spawn('first task', name='first')\nb = await rlm.spawn('second task', name='second')\n(a, b)" });
    assert.equal(admitted.ok, true, admitted.stderr);
    assert.match(admitted.result, /rlm_child_id/);
    assert.equal(runtime.store.list('sessions').filter(row => row.parent_session_id === parent.id).length, 2);
    assert.equal(runtime.store.list('script_calls').filter(call => call.name === 'opulent_session_create' && call.status === 'completed').length, 2);
    const overBudget = await runtime.invoke(parent.id, 'ipython', { code: "await rlm.spawn('third task', name='third')" });
    assert.equal(overBudget.ok, false);
    assert.match(overBudget.stderr, /total child budget exhausted/);
    assert.equal((await runtime.invoke(other.id, 'ipython', { code: `await rlm.result('${runtime.store.list('sessions').find(row => row.parent_session_id === parent.id).id}')` })).ok, false);
    const child = runtime.store.list('sessions').find(row => row.parent_session_id === parent.id);
    await runtime.waitSession(child.id);
    const result = await runtime.invoke(parent.id, 'ipython', { code: 'await rlm.result(a["rlm_child_id"])' });
    assert.match(result.result, /child completed/);
    const recursive = await runtime.invoke(child.id, 'ipython', { code: "await rlm.spawn('nested task', name='nested')" });
    assert.equal(recursive.ok, false);
    assert.match(recursive.stderr, /total child budget exhausted/);
  } finally { await close(); }
});

test('spawn requires the child-creation policy permission; cancel is scoped', async () => {
  const denied = fixture({ allowedTools: ['ipython'] });
  try {
    const parent = denied.runtime.allocate({ prompt: 'parent' });
    const attempt = await denied.runtime.invoke(parent.id, 'ipython', { code: "await rlm.spawn('not allowed', name='worker')" });
    assert.equal(attempt.ok, false);
    assert.match(attempt.stderr, /Tool forbidden by execution policy: opulent_session_create/);
    assert.equal(denied.runtime.store.list('sessions').length, 1);
  } finally { await denied.close(); }

  const { runtime, close } = fixture({}, async () => { await new Promise(resolve => setTimeout(resolve, 100));
    return { choices: [{ message: { role: 'assistant', content: 'eventually' } }] }; });
  try {
    const parent = runtime.allocate({ prompt: 'parent' });
    const other = runtime.allocate({ prompt: 'other' });
    const spawned = await runtime.invoke(parent.id, 'ipython', { code: "worker = await rlm.spawn('work', name='worker')\nworker['rlm_child_id']" });
    const childId = spawned.result.slice(1, -1);
    const deniedOther = await runtime.invoke(other.id, 'ipython', { code: `await rlm.cancel('${childId}')` });
    assert.equal(deniedOther.ok, false);
    assert.match(deniedOther.stderr, /Child not found in this parent session/);
    const cancelled = await runtime.invoke(parent.id, 'ipython', { code: 'await rlm.cancel(worker["rlm_child_id"])' });
    assert.equal(cancelled.ok, true, cancelled.stderr);
    assert.match(cancelled.result, /'status': 'cancelled'/);
    assert.equal(runtime.store.get('sessions', childId).status, 'terminated');
  } finally { await close(); }
});

test('simultaneous child admissions share one bounded root budget', async () => {
  const { runtime, close } = fixture({ maxRlmChildren: 1, maxConcurrentSessions: 3 });
  try {
    const parent = runtime.allocate({ prompt: 'parallel' });
    const result = await runtime.invoke(parent.id, 'ipython', { code: "import asyncio\nrequests=[rlm.spawn('one',name='one'),rlm.spawn('two',name='two')]\nanswers=await asyncio.gather(*requests,return_exceptions=True)\n(len([a for a in answers if isinstance(a,dict)]),len([a for a in answers if isinstance(a,Exception)]))" });
    assert.equal(result.result, '(1, 1)');
    assert.equal(runtime.store.list('sessions').filter(row => row.parent_session_id === parent.id).length, 1);
  } finally { await close(); }
});

test('unrestricted mode admits more than 16 children, more than 64 calls, and direct sidekick', async () => {
  const { runtime, close } = fixture({ unrestrictedTools: true, maxRlmChildren: 1, maxRlmHostCallsPerCell: 1,
    maxScriptToolCalls: 1, maxConcurrentScriptToolCalls: 1, maxSessionDepth: 0, maxConcurrentSessions: 1,
    allowedTools: ['ipython', 'noop', 'wait', 'sidekick', 'opulent_session_create', 'opulent_session_search', 'read_subagent', 'opulent_session_interact'] });
  try {
    const parent = runtime.allocate({ prompt: 'unrestricted' });
    const admitted = await runtime.invoke(parent.id, 'ipython', { code: "children = [await rlm.spawn('task', name=f'worker-{i}') for i in range(17)]\nlen(children)" });
    assert.equal(admitted.result, '17', admitted.stderr);
    const direct = await runtime.invoke(parent.id, 'ipython', { code: "await tools.call('sidekick', {'message':'another task', 'block':False})" });
    assert.equal(direct.ok, true, direct.stderr);
    assert.equal(runtime.store.list('sessions').filter(row => row.parent_session_id === parent.id).length, 18);
    const calls = await runtime.invoke(parent.id, 'ipython', { code: "for i in range(70):\n    await tools.call('noop', {})\nprint('70 calls succeeded')" });
    assert.equal(calls.stdout, '70 calls succeeded\n', calls.stderr);
    assert.equal(runtime.store.list('script_calls').filter(call => call.name === 'noop' && call.status === 'completed').length, 70);
    assert.ok(runtime.store.list('script_runs').some(run => run.max_tool_calls === null && run.max_concurrent_tool_calls === null));
    const concurrent = await runtime.invoke(parent.id, 'ipython', { code: "import asyncio\nawait asyncio.gather(*[tools.call('wait', {'seconds':.03, 'message':'concurrent'}) for _ in range(2)])" });
    assert.equal(concurrent.ok, true, concurrent.stderr);
    assert.equal(runtime.store.list('script_calls').filter(call => call.name === 'wait' && call.status === 'completed').length, 2);
    const childId = runtime.store.list('sessions').find(row => row.parent_session_id === parent.id && row.title === 'worker-0').id;
    const recursive = await runtime.invoke(childId, 'ipython', { code: "await rlm.spawn('nested task', name='nested')" });
    assert.equal(recursive.ok, true, recursive.stderr);
    assert.equal(runtime.store.list('sessions').filter(row => row.depth === 2).length, 1);
  } finally { await close(); }
});

test('unrestricted tools still enforce configured allowlists, repositories, and workflow approval', async () => {
  const denied = fixture({ unrestrictedTools: true, allowedTools: ['ipython', 'noop'] });
  try {
    const parent = denied.runtime.allocate({ prompt: 'policy' });
    const attempt = await denied.runtime.invoke(parent.id, 'ipython', { code: "await tools.call('sidekick', {'message':'forbidden','block':False})" });
    assert.equal(attempt.ok, false);
    assert.match(attempt.stderr, /Tool forbidden by execution policy: sidekick/);
    assert.equal(denied.runtime.store.list('sessions').length, 1);
  } finally { await denied.close(); }

  const { runtime, sandbox, directory, close } = fixture({ unrestrictedTools: true, requireWorkflowApproval: true,
    approvedWorkflowHashes: [], allowedRepos: [], allowedTools: ['ipython', 'opulent_session_create', 'run_workflow'] });
  try {
    const parent = runtime.allocate({ prompt: 'approval' });
    const escapedRepo = await runtime.invoke(parent.id, 'ipython', { code: "await tools.call('opulent_session_create', {'sessions':[{'prompt':'child','repos':['outside/repo']}]})" });
    assert.equal(escapedRepo.ok, false);
    assert.match(escapedRepo.stderr, /repository outside allowlist/);
    await sandbox.files.write([{ path: `${directory}/workflow.py`, data: "print('not approved')\n" }]);
    const unapproved = await runtime.invoke(parent.id, 'ipython', { code: `await tools.call('run_workflow', {'workflow_name':'unapproved','script_path':${JSON.stringify(`${directory}/workflow.py`)}})` });
    assert.equal(unapproved.ok, false);
    assert.match(unapproved.stderr, /Workflow source is not operator-approved/);
    assert.equal(runtime.store.list('workflows').length, 0);
  } finally { await close(); }
});

test('unrestricted scripted_tools Python reaches a previously blocked permitted host tool', async () => {
  const { runtime, close } = fixture({ unrestrictedTools: true, allowedTools: ['ipython', 'scripted_tools', 'message_user'] });
  const server = createRuntimeServer(runtime, { token: 'test-runtime-broker-token-at-least-32-characters' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  runtime.config.runtimeUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const session = runtime.allocate({ prompt: 'script transport' });
    const script = "from opulent_tools import call_tool_sync\nprint(call_tool_sync('message_user', {'message':'shim reached host','block_on_user':False,'attachments':[]}))";
    const result = await runtime.invoke(session.id, 'scripted_tools', { script });
    assert.match(result.stdout, /message_id/);
    assert.ok(runtime.store.list('orchestration_messages').some(message => message.session_id === session.id && message.body === 'shim reached host'));
    assert.ok(runtime.store.list('script_calls').some(call => call.name === 'message_user' && call.status === 'completed'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await close();
  }
});

test('spawned model worker starts outside the parent nested-tool policy and uses its own ipython', async () => {
  const model = async messages => {
    const tool = messages.findLast(message => message.role === 'tool');
    if (tool) return { choices: [{ message: { role: 'assistant', content: `child Python result: ${JSON.parse(tool.content).result}` } }] };
    return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'child-cell', type: 'function',
      function: { name: 'ipython', arguments: JSON.stringify({ code: 'child_value = 6 * 7\nchild_value' }) } }] } }] };
  };
  const { runtime, sandbox, close } = fixture({ sandboxTimeoutMs: 125000 }, model);
  try {
    const parent = runtime.allocate({ prompt: 'parent' });
    const spawn = await runtime.invoke(parent.id, 'ipython', { code: "worker = await rlm.spawn('run child Python', name='worker')\nworker['rlm_child_id']" });
    assert.equal(spawn.ok, true, spawn.stderr);
    const childId = spawn.result.slice(1, -1);
    const child = await runtime.waitSession(childId);
    assert.equal(child.status, 'completed', child.error);
    assert.equal(child.output, 'child Python result: 42');
    assert.equal((await runtime.invoke(parent.id, 'ipython', { code: 'await rlm.result(worker["rlm_child_id"])' })).ok, true);
    assert.ok(sandbox.starts.length >= 2);
    assert.ok(sandbox.starts.every(options => options.timeoutMs === 125000));
  } finally { await close(); }
});

test('timeout invalidates kernel without faking persistence; overflow file contains full output', async () => {
  const { runtime, directory, close } = fixture();
  try {
    const session = runtime.allocate({ prompt: 'large' });
    const large = await runtime.invoke(session.id, 'ipython', { code: "print('A' * 20000)" });
    assert.equal(large.ok, true);
    assert.ok(large.overflow_path);
    const { readFileSync } = await import('node:fs');
    assert.match(readFileSync(large.overflow_path, 'utf8'), /A{20000}/);
    assert.ok(large.stdout.length <= 12000);
    await assert.rejects(runtime.invoke(session.id, 'ipython', { code: 'import time; time.sleep(1)', timeout_secs: .01 }), /timed out/);
    await assert.rejects(runtime.invoke(session.id, 'ipython', { code: 'print(prompt)' }), /state lost/);
    assert.ok(directory);
  } finally { await close(); }
});

test('session cancellation interrupts an active cell and terminates its kernel', async () => {
  const { runtime, close } = fixture();
  try {
    const session = runtime.allocate({ prompt: 'cancel' });
    const running = runtime.invoke(session.id, 'ipython', { code: 'import time\ntime.sleep(10)', timeout_secs: 30 });
    while (!runtime.context(session.id).rlm.resident()) await new Promise(resolve => setTimeout(resolve, 5));
    await runtime.cancelSession(session.id);
    await assert.rejects(running, /cancelled|state lost/i);
    assert.equal(runtime.context(session.id).rlm.resident(), false);
    assert.equal(runtime.store.get('sessions', session.id).status, 'cancelled');
  } finally { await close(); }
});

test('restarted control plane refuses to silently recreate a lost Python namespace', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rlm-restart-'));
  const path = join(directory, 'state.db');
  const config = { workspace: directory, runtimeCapabilities: ['rlm-v1'], allowedTools: ['ipython'], initialTools: ['ipython'] };
  const first = createRuntime({ store: createStore(path), config, provision: async () => localSandbox(directory) });
  let second;
  try {
    const session = first.allocate({ prompt: 'persist' });
    assert.equal((await first.invoke(session.id, 'ipython', { code: 'state = 17\nstate' })).result, '17');
    await first.close();
    second = createRuntime({ store: createStore(path), config, provision: async () => { throw new Error('Must not provision replacement kernel'); } });
    await assert.rejects(second.invoke(session.id, 'ipython', { code: 'state' }), /kernel state lost/);
  } finally {
    if (second) await second.close();
    else await first.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});
