import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../core.mjs';
import { createEvaluationBroker } from '../eval-broker.mjs';
import { createStore } from '../store.mjs';

function offlineSandbox() {
  return {
    sandboxId: 'offline-script-contract',
    files: { makeDir: async () => {}, write: async entries => { for (const entry of entries) await writeFile(entry.path, entry.data); }, remove: path => rm(path, { force: true }) },
    commands: { run: async (line, options) => {
      const child = spawn('python3', line.split(' ').slice(1), { cwd: options.cwd, env: { ...process.env, ...options.envs } });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      return { wait: () => new Promise((resolve, reject) => { child.on('error', reject); child.on('close', exitCode => resolve({ stdout, stderr, exitCode })); }), kill: async () => child.kill() };
    } },
  };
}

test('model-facing definitions expose accurate facade forwarding and script helper signatures', async () => {
  const runtime = createRuntime({ store: createStore(':memory:'), config: {
    allowedTools: ['opulent_mcp', 'scripted_tools', 'mcp_list_tools', 'mcp_call_tool', 'mcp_tool'],
  } });
  try {
    const definitions = Object.fromEntries(runtime.tools().map(tool => [tool.name, tool]));
    const session = runtime.allocate();
    const local = await runtime.invoke(session.id, 'opulent_mcp', { command: 'list_tools' });
    assert.equal(local.tools.find(tool => tool.name === 'scripted_tools').description, definitions.scripted_tools.description);
    for (const name of ['mcp_list_tools', 'mcp_call_tool', 'mcp_tool', 'lx_search']) assert.match(definitions.opulent_mcp.description, new RegExp(name));
    assert.match(definitions.opulent_mcp.description, /cannot resolve arbitrary provider-side tool names directly/);
    assert.match(definitions.opulent_mcp.description, /separately configured, policy-allowed local lx_search/);
    for (const term of ['call_tool(name, args=None)', 'call_tool_sync(name, args=None)', 'tools.NAME(**kwargs)', 'list_tools()', 'search_tools(query)',
      'describe(name)', 'json.loads', 'statically resolvable', 'quoted literal', 'constant expressions', 'dynamically discovered',
      'run_workflow', 'opulent_mcp', 'authentication and approvals']) assert.ok(definitions.scripted_tools.description.includes(term), term);

    const calls = [];
    const ctx = runtime.context(session.id);
    for (const name of ['mcp_list_tools', 'mcp_call_tool', 'mcp_tool']) ctx.tools[name] = async args => { calls.push({ name, args }); return { forwarded: name }; };
    for (const [name, args] of [
      ['mcp_list_tools', { server: 'offline-example' }],
      ['mcp_call_tool', { server: 'offline-example', name: 'lx_search', arguments: { query: 'test' } }],
      ['mcp_tool', { command: 'list_tools', server: 'offline-example' }],
    ]) {
      assert.deepEqual(await runtime.invoke(session.id, 'opulent_mcp', { command: 'call_tool', tool_name: name, tool_args: JSON.stringify(args) }), { forwarded: name });
    }
    assert.deepEqual(calls, [
      { name: 'mcp_list_tools', args: { server: 'offline-example' } },
      { name: 'mcp_call_tool', args: { server: 'offline-example', name: 'lx_search', arguments: { query: 'test' } } },
      { name: 'mcp_tool', args: { command: 'list_tools', server: 'offline-example' } },
    ]);
    await assert.rejects(runtime.invoke(session.id, 'opulent_mcp', { command: 'call_tool', tool_name: 'lx_search', tool_args: '{}' }), /forbidden by execution policy/);
  } finally { await runtime.close(); }
});

test('offline scripted broker enforces helper syntax, static names, and blocked workflow route', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'script-contract-'));
  const broker = await createEvaluationBroker();
  const runtime = createRuntime({ store: createStore(':memory:'), config: {
    workspace, runtimeUrl: `http://127.0.0.1:${broker.port}`,
    allowedTools: ['scripted_tools', 'opulent_mcp', 'noop', 'run_workflow'],
  } });
  const detach = broker.attach(runtime);
  try {
    const session = runtime.allocate();
    runtime.context(session.id).sandbox = offlineSandbox();
    const script = `import asyncio, json
from opulent_tools import call_tool, call_tool_sync, tools, list_tools, search_tools, describe, ToolCallError
assert 'noop' in dict(list_tools())
assert 'noop' in dict(search_tools('do nothing'))
assert 'tools.noop' in describe('noop')
async def main():
    assert json.loads(await call_tool('noop', {})) == {}
    assert json.loads(call_tool_sync('noop', {})) == {}
    assert json.loads(await tools.noop()) == {}
    name = 'no' + 'op'
    assert json.loads(await call_tool(name, {})) == {}
    try:
        await call_tool('noop', unexpected=True)
    except TypeError as error:
        assert 'unexpected keyword' in str(error)
    else: raise AssertionError('call_tool accepted arbitrary tool kwargs')
    for discovered, _ in list_tools():
        try: await call_tool(discovered, {})
        except ToolCallError as error: assert 'quoted literal' in str(error)
        else: raise AssertionError('dynamic name reached broker')
    try: await call_tool('run_workflow', {})
    except ToolCallError as error: assert 'cannot be called' in str(error)
    else: raise AssertionError('workflow reached script broker')
    try: await call_tool('opulent_mcp', {'command': 'call_tool', 'tool_name': 'run_workflow', 'tool_args': '{}'})
    except ToolCallError as error: assert 'Script broker authorization failed' in str(error)
    else: raise AssertionError('workflow reached facade from script')
    print('offline script contract passed')
asyncio.run(main())`;
    const result = await runtime.invoke(session.id, 'scripted_tools', { script });
    assert.equal(result.stdout.trim(), 'offline script contract passed');
  } finally { detach(); await broker.close(); await runtime.close(); await rm(workspace, { recursive: true, force: true }); }
});
