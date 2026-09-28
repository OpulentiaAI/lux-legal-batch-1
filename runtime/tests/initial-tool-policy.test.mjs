import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, catalog } from '../core.mjs';
import { createStore } from '../store.mjs';
import {
  SUPPLIED_INITIAL_TOOL_NAMES, SUPPLIED_INITIAL_TOOL_NORMALIZATION,
  SUPPLIED_INITIAL_TOOL_SOURCE_NAMES, SUPPLIED_INITIAL_TOOL_SOURCE_SHA256,
  suppliedInitialToolsFor,
} from '../initial-tool-policy.mjs';

test('supplied inventory has explicit, reviewable normalization and a scripted doorway', () => {
  assert.equal(SUPPLIED_INITIAL_TOOL_SOURCE_NAMES.length, 59);
  assert.equal(SUPPLIED_INITIAL_TOOL_SOURCE_SHA256, '5000280d0ec521b340d9e9bfb2d9813ce1ac2b51155f47f6d519916e423e6519');
  assert.deepEqual(SUPPLIED_INITIAL_TOOL_NORMALIZATION.aliases, { devin_mcp: 'opulent_mcp' });
  assert.deepEqual(Object.keys(SUPPLIED_INITIAL_TOOL_NORMALIZATION.excluded).sort(), ['devin_docs', 'read_environment_config', 'update_environment_config']);
  assert.equal(SUPPLIED_INITIAL_TOOL_NAMES.length, 57);
  assert(SUPPLIED_INITIAL_TOOL_NAMES.includes('scripted_tools'));
  assert(!SUPPLIED_INITIAL_TOOL_NAMES.some(name => name.startsWith('devin_') || catalog.excluded[name] || !catalog.tools[name]));
  assert.deepEqual(suppliedInitialToolsFor(['opulent_mcp', 'scripted_tools', 'mcp_call_tool']), ['opulent_mcp', 'scripted_tools']);
});

test('explicit initial tool names must be canonical and permitted by dispatcher policy', async () => {
  for (const initialTools of [['devin_mcp'], ['devin_docs'], ['read_environment_config'], ['not_registered'], ['read', 'read']]) {
    assert.throws(() => createRuntime({ store: createStore(':memory:'), config: { allowedTools: ['read', 'opulent_mcp'], initialTools } }), /noncanonical initial tool|Duplicate initial tool/);
  }
  assert.throws(() => createRuntime({ store: createStore(':memory:'), config: { allowedTools: ['read'], initialTools: ['write'] } }), /not allowed by execution policy/);
  assert.throws(() => createRuntime({ store: createStore(':memory:'), config: { allowedTools: ['read'], initialTools: 'supplied-initial-tools-v1' } }), /not allowed by execution policy/);
  const runtime = createRuntime({ store: createStore(':memory:'), config: { allowedTools: SUPPLIED_INITIAL_TOOL_NAMES, initialTools: 'supplied-initial-tools-v1' } });
  try {
    assert.deepEqual(runtime.tools().map(tool => tool.name).sort(), [...SUPPLIED_INITIAL_TOOL_NAMES].sort());
    assert.equal(runtime.initialToolProvenance.sourceSha256, SUPPLIED_INITIAL_TOOL_SOURCE_SHA256);
    assert.deepEqual(runtime.initialToolProvenance.initialTools, SUPPLIED_INITIAL_TOOL_NAMES);
  } finally { await runtime.close(); }
});

test('direct model calls cannot escape initial visibility, while scoped scripts retain allowed schemas and calls', async () => {
  let turns = 0;
  const seen = [];
  const runtime = createRuntime({ store: createStore(':memory:'), config: {
    allowedTools: ['opulent_mcp', 'scripted_tools', 'list_knowledge_notes', 'message_user'],
    initialTools: ['opulent_mcp', 'scripted_tools'],
  }, model: async (messages, { tools }) => {
    seen.push(tools.map(tool => tool.function.name));
    if (++turns === 1) return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'direct', type: 'function', function: { name: 'list_knowledge_notes', arguments: '{}' } }] } }] };
    if (turns === 2) return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'alias', type: 'function', function: { name: 'devin_mcp', arguments: '{"command":"list_tools"}' } }] } }] };
    return { choices: [{ message: { role: 'assistant', content: 'done' } }] };
  } });
  try {
    const session = await runtime.startSession({ prompt: 'Check visibility' });
    assert.equal((await runtime.waitSession(session.id)).status, 'completed');
    assert.deepEqual(seen, [['opulent_mcp', 'scripted_tools'], ['opulent_mcp', 'scripted_tools'], ['opulent_mcp', 'scripted_tools']]);
    const conversation = runtime.store.get('conversations', session.id).messages;
    assert.match(conversation.find(message => message.tool_call_id === 'direct').content, /not visible for direct model calls/);
    assert.match(conversation.find(message => message.tool_call_id === 'alias').content, /not visible for direct model calls/);
    assert.equal(runtime.store.list('events').filter(event => event.type === 'tool_started').length, 0);
    const ctx = runtime.context(session.id);
    assert.deepEqual(ctx.scriptCatalog.map(tool => tool.name), ['opulent_mcp', 'list_knowledge_notes']);
    assert(ctx.scriptCatalog.find(tool => tool.name === 'list_knowledge_notes').inputSchema);
    assert.deepEqual(await runtime.scriptCall(session.id, ctx.config.scriptToken, 'list_knowledge_notes', {}), []);
    await assert.rejects(runtime.scriptCall(session.id, ctx.config.scriptToken, 'message_user', { message: 'no', block_on_user: true, attachments: [] }), /Script broker authorization failed/);
  } finally { await runtime.close(); }
});

test('local facade exposes permitted resource and child schemas, dispatches through policy, and denies recursion', async () => {
  const childVisible = [];
  const runtime = createRuntime({ store: createStore(':memory:'), config: {
    allowedTools: ['opulent_mcp', 'opulent_session_create', 'opulent_knowledge_manage', 'list_knowledge_notes', 'message_user'],
    initialTools: ['opulent_mcp'],
  }, model: async (_, options) => {
    childVisible.push(options.tools.map(tool => tool.function.name));
    return { choices: [{ message: { role: 'assistant', content: 'child done' } }] };
  } });
  try {
    const session = runtime.allocate();
    const listed = await runtime.invoke(session.id, 'opulent_mcp', { command: 'list_tools' });
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['list_knowledge_notes', 'message_user', 'opulent_knowledge_manage', 'opulent_session_create']);
    assert(listed.tools.find(tool => tool.name === 'opulent_session_create').inputSchema.properties.sessions);
    assert(listed.tools.find(tool => tool.name === 'opulent_knowledge_manage').description);
    assert(!listed.tools.some(tool => tool.name === 'opulent_mcp' || tool.name === 'write' || tool.name.startsWith('devin_')));
    await assert.rejects(runtime.invoke(session.id, 'opulent_mcp', { command: 'call_tool', tool_name: 'write', tool_args: '{}' }), /forbidden by execution policy/);
    await assert.rejects(runtime.invoke(session.id, 'opulent_mcp', { command: 'call_tool', tool_name: 'devin_mcp' }), /Recursive/);
    const ctx = runtime.context(session.id);
    await assert.rejects(runtime.scriptCall(session.id, ctx.config.scriptToken, 'opulent_mcp', { command: 'call_tool', tool_name: 'message_user', tool_args: JSON.stringify({ message: 'no', block_on_user: true, attachments: [] }) }), /Script broker authorization failed/);
    const created = await runtime.invoke(session.id, 'opulent_mcp', { command: 'call_tool', tool_name: 'opulent_session_create', tool_args: JSON.stringify({ sessions: [{ prompt: 'Finish child' }] }) });
    const child = await runtime.waitSession(created.sessions[0].session_id);
    assert.equal(child.parent_session_id, session.id);
    assert.equal(child.status, 'completed');
    assert.deepEqual(childVisible, [['opulent_mcp']]);
  } finally { await runtime.close(); }
});
