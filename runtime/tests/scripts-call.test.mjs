import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';
import { createEvaluationBroker } from '../eval-broker.mjs';

async function fixture(t, config = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'scripts-call-'));
  const broker = await createEvaluationBroker();
  const runtime = createRuntime({ store: createStore(':memory:'), config: {
    workspace, runtimeUrl: `http://127.0.0.1:${broker.port}`,
    allowedTools: ['scripted_tools', 'read', 'noop', 'request_secret', 'opulent_mcp'],
    maxScriptToolCalls: 64, maxConcurrentScriptToolCalls: 8,
    ...config,
  } });
  const detach = broker.attach(runtime);
  const children = new Set();
  t.after(async () => {
    for (const child of children) child.kill();
    detach();
    await broker.close();
    await runtime.close();
    await rm(workspace, { recursive: true, force: true });
  });
  const session = runtime.allocate();
  const ctx = runtime.context(session.id);
  ctx.sandbox = {
    sandboxId: 'local-scripts-call-test',
    files: {
      write: async entries => { for (const entry of entries) await writeFile(entry.path, entry.data); },
      remove: path => rm(path, { force: true }),
    },
    commands: { run: async (line, options = {}) => {
      const child = spawn('python3', line.split(' ').slice(1), { cwd: options.cwd ?? workspace, env: { ...process.env, ...options.envs } });
      children.add(child);
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const result = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', exitCode => { children.delete(child); resolve({ stdout, stderr, exitCode }); });
      });
      return options.background ? { wait: () => result, kill: async () => child.kill() } : result;
    } },
    kill: async () => {},
  };
  await writeFile(join(workspace, 'sample.txt'), 'first line\nsecond line café\n');
  return { runtime, session, ctx, run: body => runtime.invoke(session.id, 'scripted_tools', { timeout_secs: 10, script: `import asyncio, json
from opulent_tools import tools, call_tool, ToolCallError, list_tools
from devin_tools import tools as legacy_tools
async def main():
${body}
asyncio.run(main())` }) };
}

test('async tools.call reads through the scoped broker and preserves keyword syntax and JSON-string results', async t => {
  const { runtime, run } = await fixture(t);
  const result = await run(`    positional = await tools.call('read', {'file_path': 'sample.txt'})
    keyword = await tools.read(file_path='sample.txt', offset=2, limit=1)
    original = await call_tool('read', {'file_path': 'sample.txt'})
    assert tools is legacy_tools
    omitted = await tools.call('noop')
    explicit_none = await tools.call('noop', None)
    assert all(isinstance(value, str) for value in (positional, keyword, original, omitted, explicit_none))
    assert json.loads(positional) == json.loads(original)
    assert json.loads(keyword) == {'content': 'second line café\\n', 'total_lines': 2}
    assert omitted == explicit_none == '{}'
    print(positional)`);
  assert.deepEqual(JSON.parse(result.stdout), { content: 'first line\nsecond line café\n', total_lines: 2 });
  assert.equal(result.stderr, '');
  assert.deepEqual(runtime.store.list('script_calls').map(call => [call.name, call.status]), [
    ...Array(3).fill(['read', 'completed']), ...Array(2).fill(['noop', 'completed']),
  ]);
  assert.equal(runtime.store.list('script_runs')[0].status, 'completed');
});

test('tools.call supports concurrent async reads without serializing broker calls', async t => {
  const { runtime, ctx, run } = await fixture(t, { maxConcurrentScriptToolCalls: 2 });
  const read = ctx.tools.read;
  let release, entered = 0, active = 0, peak = 0;
  const bothEntered = new Promise(resolve => { release = resolve; });
  ctx.tools.read = async args => {
    entered++;
    active++;
    peak = Math.max(peak, active);
    if (entered === 2) release();
    await bothEntered;
    try { return await read(args); } finally { active--; }
  };
  try {
    const result = await run(`    results = await asyncio.gather(
        tools.call('read', {'file_path': 'sample.txt', 'offset': 1, 'limit': 1}),
        tools.call('read', {'file_path': 'sample.txt', 'offset': 2, 'limit': 1}))
    assert all(isinstance(value, str) for value in results)
    print(json.dumps([json.loads(value) for value in results], ensure_ascii=False))`);
    assert.deepEqual(JSON.parse(result.stdout), [
      { content: 'first line\n', total_lines: 2 }, { content: 'second line café\n', total_lines: 2 },
    ]);
    assert.equal(peak, 2);
    assert.deepEqual(runtime.store.list('script_calls').map(call => [call.name, call.status]), [['read', 'completed'], ['read', 'completed']]);
  } finally { release(); }
});

test('tools.call preserves broker string, array and null result serialization', async t => {
  const { ctx, run } = await fixture(t);
  const values = ['{"already":"serialized"}', ['café', 2], null];
  ctx.tools.noop = async () => values.shift();
  const result = await run(`    serialized = await tools.call('noop')
    array = await tools.call('noop')
    empty = await tools.call('noop')
    assert serialized == '{"already":"serialized"}'
    assert json.loads(array) == ['café', 2]
    assert empty == 'null'
    assert all(isinstance(value, str) for value in (serialized, array, empty))
    print('serialization passed')`);
  assert.equal(result.stdout.trim(), 'serialization passed');
  assert.equal(values.length, 0);
});

test('tools.call rejects malformed names, argument objects and schemas before contacting the broker', async t => {
  const { runtime, run } = await fixture(t);
  const result = await run(`    cases = [
        (lambda: tools.call('read', []), TypeError, 'argument object'),
        (lambda: tools.call('read', 'sample.txt'), TypeError, 'argument object'),
        (lambda: tools.call('read', False), TypeError, 'argument object'),
        (lambda: tools.call(123, {}), TypeError, 'name and argument object'),
        (lambda: tools.call(None, {}), TypeError, 'name and argument object'),
        (lambda: tools.call(), TypeError, 'name'),
        (lambda: tools.call('read', {}, {}), TypeError, 'positional arguments'),
        (lambda: tools.call('read'), ToolCallError, 'read.file_path is required'),
        (lambda: tools.call('read', None), ToolCallError, 'read.file_path is required'),
        (lambda: tools.call('read', {'file_path': 123}), ToolCallError, 'read.file_path must be string'),
        (lambda: tools.call('read', {'file_path': 'sample.txt', 'offset': '2'}), ToolCallError, 'read.offset must be integer'),
        (lambda: tools.call('noop', {'unexpected': True}), ToolCallError, 'noop.unexpected is not allowed'),
        (lambda: tools.call('noop', args=[], extra=True), TypeError, 'unexpected keyword argument'),
    ]
    for invoke, kind, message in cases:
        try: await invoke()
        except kind as exc: assert message in str(exc), str(exc)
        else: raise AssertionError('malformed call reached the broker')
    print('malformed calls rejected')`);
  assert.equal(result.stdout.trim(), 'malformed calls rejected');
  assert.deepEqual(runtime.store.list('script_calls'), []);
  assert.deepEqual(runtime.store.list('events').filter(event => event.type === 'tool_started').map(event => event.data.name), ['scripted_tools']);
});

test('tools.call rejects unknown, session-disallowed and blocked tool names', async t => {
  const { runtime, run } = await fixture(t);
  const blocked = ['scripted_tools', 'message_user', 'stop', 'report_blocker', 'test_mode', 'list_secrets', 'request_secret', 'suggest_save_secret', 'recording_start', 'recording_stop', 'annotate_recording', 'run_workflow'];
  const result = await run(`    cases = [
        (lambda: tools.call('not_a_tool', {}), 'not available in this session'),
        (lambda: tools.call('grep', {}), 'not available in this session'),
        (lambda: tools.call('call', {}), 'not available in this session'),
${blocked.map(name => `        (lambda: tools.call('${name}', {}), 'cannot be called from a script'),`).join('\n')}
    ]
    for invoke, message in cases:
        try: await invoke()
        except ToolCallError as exc: assert message in str(exc), str(exc)
        else: raise AssertionError('unavailable call reached the broker')
    print('unavailable calls rejected')`);
  assert.equal(result.stdout.trim(), 'unavailable calls rejected');
  assert.deepEqual(runtime.store.list('script_calls'), []);
});

test('tools.call resolves statically known tool names using the existing constant analysis', async t => {
  const { runtime, run } = await fixture(t);
  const result = await run(`    name = 'read'
    names = ['read']
    values = [
        await tools.call(name, {'file_path': 'sample.txt'}),
        await tools.call(names[0], {'file_path': 'sample.txt'}),
        await tools.call('re' + 'ad', {'file_path': 'sample.txt'}),
        await tools.call(f"r{'ead'}", {'file_path': 'sample.txt'}),
        await tools.call(''.join(['re', 'ad']), {'file_path': 'sample.txt'}),
    ]
    assert all(json.loads(value) == {'content': 'first line\\nsecond line café\\n', 'total_lines': 2} for value in values)
    print('static names passed')`);
  assert.equal(result.stdout.trim(), 'static names passed');
  assert.deepEqual(runtime.store.list('script_calls').map(call => [call.name, call.status]), Array(5).fill(['read', 'completed']));
});

test('tools.call rejects dynamic names, laundered aliases and unresolved calls sharing a literal site', async t => {
  const { runtime, run } = await fixture(t);
  const result = await run(`    dynamic = json.loads('"read"')
    conditional = 'read'
    if True: conditional = dynamic
    namespace = tools
    alias = tools.call
    read_alias = tools.read
    call_alias = call_tool
    cases = [
        lambda: tools.call(dynamic, {'file_path': 'sample.txt'}),
        lambda: tools.call(conditional, {'file_path': 'sample.txt'}),
        lambda: alias('read', {'file_path': 'sample.txt'}),
        lambda: namespace.call('read', {'file_path': 'sample.txt'}),
        lambda: legacy_tools.call('read', {'file_path': 'sample.txt'}),
        lambda: getattr(tools, 'call')('read', {'file_path': 'sample.txt'}),
        lambda: read_alias(file_path='sample.txt'),
        lambda: call_alias('read', {'file_path': 'sample.txt'}),
        lambda: tools.call(*['read', {'file_path': 'sample.txt'}]),
        lambda: tools.call(name='read', args={'file_path': 'sample.txt'}),
        lambda: (tools.call(dynamic, {'file_path': 'sample.txt'}), tools.call('read', {'file_path': 'sample.txt'})),
        lambda: (tools.call(dynamic, {'file_path': 'sample.txt'}), tools.read(file_path='sample.txt')),
    ]
    for invoke in cases:
        try: await invoke()
        except ToolCallError as exc: assert 'quoted literal' in str(exc), str(exc)
        else: raise AssertionError('dynamic or aliased call reached the broker')
    for discovered, _ in list_tools():
        try: await tools.call(discovered, {})
        except ToolCallError as exc: assert 'quoted literal' in str(exc), str(exc)
        else: raise AssertionError('catalog-derived tool name reached the broker')
    def forwarded(name): return tools.call(name, {'file_path': 'sample.txt'})
    try: await forwarded('read')
    except ToolCallError as exc: assert 'quoted literal' in str(exc), str(exc)
    else: raise AssertionError('forwarded name reached the broker')
    print('dynamic names and aliases rejected')`);
  assert.equal(result.stdout.trim(), 'dynamic names and aliases rejected');
  assert.deepEqual(runtime.store.list('script_calls'), []);
});

test('tools.call retains broker budgets, revoked runtime tokens and nested blocked-tool checks', async t => {
  const { runtime, session, ctx, run } = await fixture(t, { maxScriptToolCalls: 2 });
  const begin = ctx.beginScriptExecution;
  let execution;
  ctx.beginScriptExecution = () => { execution = begin(); return execution; };
  const result = await run(`    assert await tools.call('noop') == '{}'
    try:
        await tools.call('opulent_mcp', {'command': 'call_tool', 'tool_name': 'request_secret', 'tool_args': '{}'})
    except ToolCallError as exc: assert 'authorization failed' in str(exc), str(exc)
    else: raise AssertionError('nested blocked tool reached its handler')
    try: await tools.call('noop')
    except ToolCallError as exc: assert 'budget exhausted' in str(exc), str(exc)
    else: raise AssertionError('call budget was bypassed')
    print('broker safeguards retained')`);
  assert.equal(result.stdout.trim(), 'broker safeguards retained');
  assert.deepEqual(runtime.store.list('script_calls').map(call => [call.name, call.status]), [['noop', 'completed'], ['opulent_mcp', 'failed'], ['noop', 'failed']]);
  await assert.rejects(runtime.scriptCall(session.id, execution.token, 'noop', {}), /authorization failed/);
  await assert.rejects(runtime.scriptCall(session.id, ctx.config.scriptToken, 'noop', {}), /authorization failed/);
  assert.equal(runtime.store.list('script_runs')[0].status, 'completed');
});
