import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, catalog } from '../core.mjs';
import { createStore } from '../store.mjs';
import { createTools as scriptTools } from '../tools/scripts.mjs';

const oldNames = Object.keys(catalog.aliases).filter(name => name.startsWith('devin_') && !(name in catalog.tools) && catalog.aliases[name].startsWith('opulent_'));

test('all renamed tools have one canonical model-visible definition and hidden legacy dispatch', async () => {
  assert.equal(oldNames.length, 14);
  const runtime = createRuntime({ store: createStore(':memory:') });
  try {
    const session = runtime.allocate();
    const visible = runtime.tools().map(tool => tool.name);
    assert.equal(visible.length, 97);
    assert.ok(!visible.some(name => name.startsWith('devin_')));
    for (const old of oldNames) {
      assert.ok(visible.includes(catalog.aliases[old]));
      assert.ok(!Object.keys(runtime.context(session.id).tools).includes(old));
    }
    const names = (await runtime.invoke(session.id, 'tool_search_tool_bm25', { query: 'opulent session', limit: 50 })).map(tool => tool.name);
    assert.ok(names.includes('opulent_session_create'));
    assert.ok(!names.some(name => name.startsWith('devin_')));
    assert.deepEqual(await runtime.invoke(session.id, 'devin_knowledge_manage', { action: 'folders' }), {});
    assert.deepEqual(await runtime.invoke(session.id, 'opulent_knowledge_manage', { action: 'folders' }), {});
    await assert.rejects(runtime.invoke(session.id, 'opulent_mcp', { command: 'call_tool', tool_name: 'devin_mcp', tool_args: '{}' }), /Recursive/);
  } finally { await runtime.close(); }
});

test('legacy alias cannot bypass canonical allowlist or script-broker authorization', async () => {
  const runtime = createRuntime({ store: createStore(':memory:'), config: { allowedTools: ['opulent_knowledge_manage'] } });
  try {
    const session = runtime.allocate();
    assert.deepEqual(runtime.tools().map(tool => tool.name), ['opulent_knowledge_manage']);
    assert.deepEqual(await runtime.invoke(session.id, 'devin_knowledge_manage', { action: 'folders' }), {});
    await assert.rejects(runtime.invoke(session.id, 'devin_mcp', { command: 'list_tools' }), /forbidden by execution policy: opulent_mcp/);
  } finally { await runtime.close(); }
});

test('model turns receive canonical names only and historic calls still execute', async () => {
  let definitions;
  const runtime = createRuntime({ store: createStore(':memory:'), model: async (_, options) => {
    definitions = options.tools;
    return { choices: [{ message: { role: 'assistant', content: 'Done' } }] };
  } });
  try {
    const session = await runtime.startSession({ prompt: 'List available tools' });
    await runtime.waitSession(session.id);
    assert.equal(definitions.length, 97);
    assert.ok(definitions.some(tool => tool.function.name === 'opulent_session_create'));
    assert.ok(!definitions.some(tool => tool.function.name.startsWith('devin_')));
  } finally { await runtime.close(); }
});

test('public schemas use Opulent labels and canonical argument keys', () => {
  for (const tool of Object.values(catalog.tools)) {
    const visible = JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
    assert.doesNotMatch(visible, /\bdevin\b/i);
  }
  assert.ok(catalog.tools.opulent_billing_tag_manage.inputSchema);
});

test('script bridge advertises opulent_tools and keeps old import for persisted scripts', async () => {
  let shim;
  const sandbox = { files: { write: async entries => { shim = entries[1].data; }, remove: async () => {} }, commands: { run: async () => ({ wait: async () => ({ stdout: '', stderr: '', exitCode: 0 }) }) } };
  await scriptTools({ sandbox, workspace: '/home/user/workspace', sessionId: 's', config: { runtimeUrl: 'https://runtime.example', scriptToken: 'scoped' } }).scripted_tools({ script: 'from opulent_tools import tools' });
  assert.match(shim, /sys\.modules\['opulent_tools'\]=module/);
  assert.match(shim, /sys\.modules\['devin_tools'\]=module/);
});
