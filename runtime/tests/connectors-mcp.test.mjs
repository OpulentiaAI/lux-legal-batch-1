import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTools, probeMcp } from '../tools/connectors.mjs';

const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
const entry = { id: 'fixture', name: 'fixture', enabled: true, approved: true, transport: 'stdio', command: process.execPath, args: [fixture], env: {} };
const context = {
  config: { allowedMcpCommands: [{ command: process.execPath, args: [fixture] }] },
  store: { list: collection => collection === 'mcp_servers' ? [entry] : [] },
};

test('MCP SDK connects to configured stdio server and calls tools/resources', async () => {
  const tools = createTools(context);
  assert.equal((await tools.mcp_list_servers({}))[0].name, 'fixture');
  assert((await tools.mcp_list_tools({ server: 'fixture' })).tools.some(tool => tool.name === 'echo'));
  assert.equal((await tools.mcp_call_tool({ server: 'fixture', name: 'echo', arguments: { text: 'Hello' } })).content[0].text, 'Hello');
  assert.equal((await tools.mcp_read_resource({ server: 'fixture', uri: 'fixture://document' })).contents[0].text, 'Resource body');
});

test('MCP refuses unapproved command and arguments', async () => {
  const tools = createTools({ ...context, config: { allowedMcpCommands: [{ command: process.execPath, args: ['different'] }] } });
  await assert.rejects(tools.mcp_list_tools({ server: 'fixture' }), /not allowlisted/);
});

test('disabled and unapproved servers cannot launch their transport', async () => {
  for (const state of [{ enabled: false, approved: true }, { enabled: true, approved: false }, { enabled: undefined, approved: undefined }]) {
    const tools = createTools({
      ...context,
      store: { list: () => [{ ...entry, ...state, command: '/definitely/not/a/command' }] },
    });
    await assert.rejects(tools.mcp_list_tools({ server: 'fixture' }), /disabled or unapproved/);
    await assert.rejects(tools.mcp_call_tool({ server: 'fixture', name: 'echo', arguments: { text: 'No' } }), /disabled or unapproved/);
    assert.equal((await tools.mcp_list_servers({}))[0].enabled, false);
  }
});

test('candidate probe connects without storing or enabling candidate', async () => {
  const candidate = { ...entry, enabled: false, approved: false };
  const probed = await probeMcp({
    config: context.config,
    store: { list: () => assert.fail('Probe must not read published servers'), put: () => assert.fail('Probe must not publish a server') },
  }, candidate);
  assert.deepEqual(probed, { name: 'fixture', transport: 'stdio', tools: [{ name: 'echo' }] });
  assert.equal(candidate.enabled, false);
  assert.equal(candidate.approved, false);
});

test('HTTP MCP candidates require exact configured URL before any connection', async () => {
  const candidate = { name: 'remote', transport: 'http', url: 'https://example.com/mcp', enabled: false, approved: false };
  await assert.rejects(probeMcp({ config: { allowedMcpUrls: [] } }, candidate), /not allowlisted/);
  await assert.rejects(probeMcp({ config: { allowedMcpUrls: ['https://example.com/other'] } }, candidate), /not allowlisted/);
  await assert.rejects(probeMcp({ config: { allowedMcpUrls: ['https://example.com/mcp'] } }, { ...candidate, url: 'https://example.com/mcp?key=secret' }), /credentials or query/);
});
