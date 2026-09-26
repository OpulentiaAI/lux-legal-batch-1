import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createTools, definitions } from '../runtime/tools/legal.mjs'
import { createAgentHarness } from '../runtime/legal-eval.mjs'
import { createRuntime } from '../runtime/core.mjs'
import { parseOptions } from '../eval/compose.mjs'

test('legal tools hydrate exactly model-visible sources from fixed corpus plugins', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'legal-tools-'))
  try {
    mkdirSync(join(workspace, 'corpus/chunks'), { recursive: true })
    mkdirSync(join(workspace, 'corpus/index'), { recursive: true })
    writeFileSync(join(workspace, 'corpus/chunks/one.md'), 'body')
    symlinkSync('/etc/hosts', join(workspace, 'corpus/chunks/escape.md'))
    writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), [
      { chunk_id: 'c1', path: 'corpus/chunks/one.md', doc_id: 'doc-1' },
      { chunk_id: 'escape', path: 'corpus/chunks/escape.md', doc_id: 'doc-1' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n')
    const ctx = { config: { corpusWorkspace: workspace }, evidence: new Map(), signal: AbortSignal.timeout(1000) }
    const calls = []
    const plugins = {
      search: { invoke: async (args) => { calls.push(args); return { content: { results: [
        { chunk_id: 'c1', score: 0.9, preview: 'Not the actual source' }, { chunk_id: 'missing', preview: 'fabricated' },
      ] } } } },
      chunk: { invoke: async ({ chunk_id }) => ({ content: { chunk_id, text: 'Exact complete source', doc: 'doc-1' } }) },
      documents: { invoke: async () => ({ content: { count: 1, documents: [{ doc_id: 'doc-1' }] } }) },
    }
    const tools = createTools(ctx, plugins)
    const result = await tools.lx_search({ query: 'legal' })
    assert.deepEqual(result.results, [{ chunk_id: 'c1', doc: 'doc-1', score: 0.9, text: 'Exact complete source' }])
    assert.equal(calls[0].signal, ctx.signal)
    assert.deepEqual([...ctx.evidence.values()], [{ id: 'c1', text: 'Exact complete source', doc: 'doc-1' }])
    assert.equal((await tools.lx_chunk({ chunk_id: 'c1' })).text, 'Exact complete source')
    assert.equal((await tools.lx_documents({})).count, 1)
    await assert.rejects(tools.lx_chunk({ chunk_id: 'missing' }), /Unknown corpus chunk/)
    await assert.rejects(tools.lx_chunk({ chunk_id: 'escape' }), /Chunk outside fixed corpus/)
    assert.deepEqual(Object.keys(definitions), ['lx_search', 'lx_chunk', 'lx_documents'])
    assert.deepEqual(Object.keys(tools), ['lx_search', 'lx_chunk', 'lx_documents'])

    let turns = 0
    const runtime = createRuntime({ config: { stateDir: join(workspace, 'state'), corpusWorkspace: workspace,
      allowedTools: ['lx_search', 'lx_chunk', 'lx_documents'], model: 'fake', maxSteps: 3,
      systemPrompt: 'Closed legal corpus only.' }, model: async (messages, options) => {
      assert.deepEqual(options.tools.map((tool) => tool.function.name).sort(), ['lx_chunk', 'lx_documents', 'lx_search'])
      if (turns++ === 0) return { choices: [{ message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lx_chunk', arguments: '{"chunk_id":"c1"}' } }] } }], usage: { total_tokens: 2 } }
      assert.match(messages.find((message) => message.role === 'tool').content, /body/)
      return { choices: [{ message: { role: 'assistant', content: 'Réponse [c1]' } }], usage: { total_tokens: 3 } }
    } })
    try {
      const session = await runtime.startSession({ prompt: 'Question juridique' })
      const completed = await runtime.waitSession(session.id)
      assert.equal(completed.status, 'completed')
      assert.equal(completed.usage.total_tokens, 5)
      assert.equal(runtime.context(session.id).evidence.get('c1').text, 'body')
      await assert.rejects(runtime.invoke(session.id, 'exec', { command: 'pwd' }), /forbidden by execution policy/)
      await assert.rejects(runtime.invoke(session.id, 'devin_ask_question', {}), /forbidden by execution policy/)
    } finally { await runtime.close() }
  } finally { rmSync(workspace, { recursive: true, force: true }) }
})

test('agent wrapper enforces closed universe and returns session evidence', async () => {
  let closed = false
  const harness = createAgentHarness({ workspace: '/fixed/corpus', model: 'example/model', runtimeFactory: ({ config }) => {
    assert.deepEqual(config.allowedTools, ['lx_search', 'lx_chunk', 'lx_documents'])
    assert.equal(config.corpusWorkspace, '/fixed/corpus')
    assert.equal(config.model, 'example/model')
    return {
      startSession: async ({ prompt }) => { assert.match(prompt, /Question : legal question/); return { id: 'session' } },
      waitSession: async () => ({ status: 'completed', output: 'Answer [c1]', usage: { total_tokens: 3 } }),
      context: () => ({ evidence: new Map([['c1', { id: 'c1', text: 'Exact text', doc: 'doc-1' }]]) }),
      store: { list: () => [{ session_id: 'session', type: 'tool_started', data: { name: 'lx_chunk' } }], get: () => ({ messages: [] }) },
      close: async () => { closed = true },
    }
  } })
  const result = await harness.run({ question: 'legal question', mode: 'agent' })
  assert.equal(result.sources[0].text, 'Exact text')
  assert.equal(result.metrics.toolCalls, 1)
  assert.equal(closed, true)
  assert.equal(parseOptions(['--mode', 'agent']).mode, 'agent')
  await assert.rejects(harness.run({ question: 'q', mode: 'rlm' }), /Agent mode/)
})
