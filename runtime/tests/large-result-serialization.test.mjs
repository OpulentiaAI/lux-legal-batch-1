import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { createRuntime, catalog } from '../core.mjs'
import { createStore } from '../store.mjs'
import { createBroadHarness } from '../broad-legal-eval.mjs'

const workspace = resolve(new URL('../..', import.meta.url).pathname)

async function modelVisibleResult(value) {
  let runtime, content, turns = 0
  const sandbox = { sandboxId: 'result-fixture', files: { makeDir: async () => {} }, pause: async () => {}, kill: async () => {} }
  runtime = createRuntime({ store: createStore(':memory:'), config: { allowedTools: ['find_file_by_name'] },
    provision: async () => sandbox, model: async messages => {
      if (!turns++) {
        const session = runtime.store.list('sessions')[0]
        runtime.context(session.id).tools.find_file_by_name = async () => value
        return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: 'find', type: 'function', function: { name: 'find_file_by_name', arguments: '{"pattern":"**/*"}' } },
        ] } }] }
      }
      content = messages.find(message => message.role === 'tool').content
      return { choices: [{ message: { role: 'assistant', content: 'Done' } }] }
    } })
  try {
    const session = await runtime.startSession({ prompt: 'Find files' })
    assert.equal((await runtime.waitSession(session.id)).status, 'completed')
    return content
  } finally { await runtime.close() }
}

test('small tool result remains byte-for-byte unchanged', async () => {
  const value = { matches: ['a.txt', 'emoji-🙂.txt'], count: 2 }
  assert.equal(await modelVisibleResult(value), JSON.stringify(value))
  const boundary = { text: 'x'.repeat(80000 - JSON.stringify({ text: '' }).length) }
  assert.equal((await modelVisibleResult(boundary)).length, 80000)
  assert.equal(await modelVisibleResult(boundary), JSON.stringify(boundary))
  assert.equal(JSON.parse(await modelVisibleResult({ text: `${boundary.text}x` })).truncated, true)
})

test('large escaped Unicode result is a valid bounded JSON envelope with the exact serialized prefix', async () => {
  const value = { matches: ['[doc:a]', '🙂"\\\n'.repeat(20000), 'unseen-final-file'], count: 3 }
  const raw = JSON.stringify(value)
  assert(raw.length > 80000)
  const content = await modelVisibleResult(value)
  assert(content.length <= 80000)
  const visible = JSON.parse(content)
  assert.deepEqual(Object.keys(visible).sort(), ['prefix', 'truncated'])
  assert.equal(visible.truncated, true)
  assert(raw.startsWith(visible.prefix))
  assert(visible.prefix.length > 30000)
  assert(!visible.prefix.includes('unseen-final-file'))
})

test('truncated file output remains a successful partial observation, never hydrated to a full source', async () => {
  const source = { id: 'doc:a', doc: 'doc', text: 'Première ligne.\nDeuxième ligne complète.', path: 'chunks/doc:a.txt' }
  const content = await modelVisibleResult({ matches: [`[${source.id}]`, '🙂"\\\n'.repeat(20000), source.text] })
  const root = mkdtempSync(join(tmpdir(), 'partial-result-audit-'))
  const messages = [
    { role: 'assistant', tool_calls: [{ id: 'find', function: { name: 'find_file_by_name', arguments: '{"pattern":"**/*"}' } }] },
    { role: 'tool', tool_call_id: 'find', content },
  ]
  try {
    const harness = createBroadHarness({ workspace, artifactsDir: root,
      corpus: { directory: '/safe/export', hash: 'partial-evidence', count: 1, sources: [source] },
      modelFactory: () => async () => { throw new Error('No model calls in audit fixture') },
      runtimeFactory: () => ({ startSession: async () => ({ id: 'partial' }),
        waitSession: async () => ({ status: 'completed', output: 'No full source observed' }),
        store: { get: () => ({ messages }), list: () => [] }, context: () => ({ evidence: new Map() }), close: async () => {} }) })
    const result = await harness.run({ mode: 'broad', question: 'Partial observation' })
    assert.deepEqual(result.sources, [])
    assert.equal(result.metrics.errors, 0)
    assert.equal(result.audit.calls[0].result.error, false)
    messages[1].content = await modelVisibleResult(source)
    const full = await harness.run({ mode: 'broad', question: 'Full observation' })
    assert.deepEqual(full.sources, [{ id: source.id, doc: source.doc, text: source.text }])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('runtime-local facade cannot dispatch forbidden native corpus handlers', async () => {
  assert.match(catalog.tools.opulent_mcp.description, /Runtime-local connector facade/)
  assert.match(catalog.tools.opulent_mcp.description, /mcp_call_tool with server, name and arguments/)
  assert.doesNotMatch(catalog.tools.opulent_mcp.description, /wiki docs/)
  const runtime = createRuntime({ store: createStore(':memory:'), config: { allowedTools: ['opulent_mcp', 'mcp_call_tool'], corpusWorkspace: workspace } })
  try {
    const session = runtime.allocate()
    await assert.rejects(runtime.invoke(session.id, 'lx_search', { query: 'test' }), /forbidden by execution policy: lx_search/)
    await assert.rejects(runtime.invoke(session.id, 'opulent_mcp', { command: 'call_tool', tool_name: 'lx_search', tool_args: '{"query":"test"}' }), /forbidden by execution policy: lx_search/)
  } finally { await runtime.close() }
})
