import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';
import { EFFECTIVE_TOOL_OVERLAY_VERSION } from '../effective-tool-definitions.mjs';

test('a model sees the workflow contract through targeted discovery after the full catalog truncates', async () => {
  let turns = 0;
  const seen = [];
  const runtime = createRuntime({ store: createStore(':memory:'), config: { initialTools: ['opulent_mcp'] },
    model: async (messages, { tools }) => {
      turns++;
      assert.deepEqual(tools.map(tool => tool.function.name), ['opulent_mcp']);
      assert.match(tools[0].function.description, /list_tools with tool_name='run_workflow'/);
      assert.match(tools[0].function.parameters.properties.tool_name.description, /without truncating/);
      const previous = messages.filter(message => message.role === 'tool').at(-1);
      if (previous) seen.push(JSON.parse(previous.content));
      if (turns === 1 || turns === 2) return { choices: [{ message: { role: 'assistant', tool_calls: [{
        id: `discovery-${turns}`, type: 'function', function: { name: 'opulent_mcp',
          arguments: JSON.stringify(turns === 1 ? { command: 'list_tools' } : { command: 'list_tools', tool_name: 'run_workflow' }) },
      }] } }] };
      return { choices: [{ message: { role: 'assistant', content: 'Read workflow contract' } }] };
    },
  });
  try {
    assert.match(EFFECTIVE_TOOL_OVERLAY_VERSION, /v3$/);
    const session = await runtime.startSession({ prompt: 'Discover the workflow contract.' });
    assert.equal((await runtime.waitSession(session.id)).status, 'completed');
    assert.equal(turns, 3);
    const raw = await runtime.invoke(session.id, 'opulent_mcp', { command: 'list_tools' });
    assert(JSON.stringify(raw).length > 80000, 'the real default catalog must exceed the model result limit');
    assert.equal(seen[0].truncated, true);
    assert.doesNotMatch(seen[0].prefix, /Complete minimal workflow\.py:/);
    assert.equal(seen[1].truncated, undefined);
    assert.deepEqual(seen[1].tools.map(tool => tool.name), ['run_workflow']);
    assert.match(seen[1].tools[0].description, /await register_workflow\(/);
    assert.match(seen[1].tools[0].description, /asyncio\.run\(main\(\)\)/);
    assert.match(seen[1].tools[0].inputSchema.properties.script_path.description, /exact UTF-8 bytes/);
    const result = runtime.store.get('conversations', session.id).messages.find(message => message.tool_call_id === 'discovery-2');
    assert(result.content.length < 80000);
    assert.equal(JSON.parse(result.content).tools[0].description, seen[1].tools[0].description);
  } finally { await runtime.close(); }
});

test('targeted discovery preserves canonical allowlist, exclusion and default-list behavior', async () => {
  const runtime = createRuntime({ store: createStore(':memory:'), config: {
    allowedTools: ['opulent_mcp', 'run_workflow', 'devin_docs'], initialTools: ['opulent_mcp'],
  } });
  try {
    const session = runtime.allocate();
    const listing = await runtime.invoke(session.id, 'opulent_mcp', { command: 'list_tools' });
    const targeted = await runtime.invoke(session.id, 'opulent_mcp', { command: 'list_tools', tool_name: 'run_workflow' });
    assert.deepEqual(listing, targeted);
    for (const name of ['opulent_mcp', 'devin_mcp', 'devin_docs', 'scripted_tools', 'not_registered', '']) {
      assert.deepEqual(await runtime.invoke(session.id, 'opulent_mcp', { command: 'list_tools', tool_name: name }), { tools: [] }, name);
    }
    assert.equal(runtime.context(session.id).scriptCatalog.some(tool => tool.name === 'run_workflow'), false);
  } finally { await runtime.close(); }
});
