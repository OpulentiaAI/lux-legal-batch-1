import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createRuntime } from '../core.mjs'
import { createStore } from '../store.mjs'

const command = process.execPath
const args = [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))]

test('operator approval probes stdio then authorizes real MCP invocation', async () => {
  const runtime = createRuntime({ store: createStore(':memory:'), config: { allowedMcpCommands: [{ command, args }] } })
  try {
    const session = runtime.allocate()
    const request = await runtime.invoke(session.id, 'opulent_mcp_server_manage', { action: 'install', name: 'approved-fixture', transport: 'stdio', command })
    assert.deepEqual(runtime.store.list('mcp_servers'), [])
    const installed = await runtime.approve(session.id, { kind: 'mcp', id: request.id, approve: true, value: { args, env: {} } })
    assert.equal(installed.approved, true)
    assert.equal(installed.enabled, true)
    const listed = await runtime.invoke(session.id, 'mcp_list_tools', { server: installed.id })
    assert.deepEqual(listed.tools.map(tool => tool.name), ['echo'])
    const result = await runtime.invoke(session.id, 'mcp_call_tool', { server: installed.id, name: 'echo', arguments: { text: 'approved-call' } })
    assert.notEqual(result.isError, true)
    assert.deepEqual(result.content, [{ type: 'text', text: 'approved-call' }])
  } finally { await runtime.close() }
})

test('stdio approval rejects unapproved args and credential values before provider launch', async () => {
  const runtime = createRuntime({ store: createStore(':memory:'), config: { allowedMcpCommands: [{ command, args }] } })
  try {
    const session = runtime.allocate()
    const request = await runtime.invoke(session.id, 'opulent_mcp_server_manage', { action: 'install', name: 'fixture', transport: 'stdio', command })
    await assert.rejects(runtime.approve(session.id, { kind: 'mcp', id: request.id, approve: true, value: { args: ['different'] } }), /explicitly allowlisted/)
    await assert.rejects(runtime.approve(session.id, { kind: 'mcp', id: request.id, approve: true, value: { args, env: { TOKEN: 'a secret value' } } }), /references only/)
    assert.deepEqual(runtime.store.list('mcp_servers'), [])
    assert.equal(runtime.store.get('mcp_server_requests', request.id).status, 'pending')
  } finally { await runtime.close() }
})
