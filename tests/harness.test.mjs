import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createHarness } from '../src/harness/index.ts'

function fixture(ids) {
  const workspace = mkdtempSync(join(tmpdir(), 'legal-harness-'))
  mkdirSync(join(workspace, 'corpus/index'), { recursive: true })
  mkdirSync(join(workspace, 'corpus/notes'), { recursive: true })
  const rows = ids.map((id) => {
    const path = `corpus/notes/${id}.md`
    writeFileSync(join(workspace, path), `---\nchunk_id: ${id}\n---\nEvidence for ${id}`)
    return { chunk_id: id, path, doc_id: 'doc-06', doc_title: '1915 Law', structure: [], ns: 'test' }
  })
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n'))
  return { workspace, close: () => rmSync(workspace, { recursive: true, force: true }) }
}

test('standard retrieves only original query top five, hydrates from its own workspace', async () => {
  const one = fixture(['a', 'b', 'c', 'd', 'e', 'f'])
  const two = fixture(['z'])
  try {
    const calls = []
    const search = async (args) => {
      calls.push(args)
      return { content: { results: ['a', 'b', 'c', 'd', 'e', 'f'].map((chunk_id) => ({ chunk_id })) } }
    }
    const chat = async (args) => {
      assert.equal(args.role, 'composer')
      assert.match(args.messages[1].content, /Evidence for a/)
      assert.doesNotMatch(args.messages[1].content, /Evidence for f/)
      return { text: 'Answer [a]', usage: { inputTokens: 15, outputTokens: 3 } }
    }
    const run = await createHarness({ workspace: one.workspace, chat, search }).run({ question: 'Original?', mode: 'standard' })
    assert.deepEqual(calls.map(({ signal, ...args }) => args), [{ query: 'Original?', limit: 5, expand: false }])
    assert.ok(calls[0].signal instanceof AbortSignal)
    assert.deepEqual(run.sources.map((source) => source.id), ['a', 'b', 'c', 'd', 'e'])
    assert.equal(run.answer, 'Answer [a]')
    assert.equal(run.metrics.usage.inputTokens, 15)
    assert.equal(run.metrics.sourceCoverage, 5 / 6)
    assert.equal(run.metrics.characterCoverage, run.metrics.visibleCharacters / run.metrics.corpusCharacterCount)
    const second = await createHarness({ workspace: two.workspace, chat: async () => ({ text: 'Z [z]' }), search: async () => ({ content: { results: [{ chunk_id: 'z' }] } }) }).run({ question: 'Second?', mode: 'standard' })
    assert.deepEqual(second.sources.map((source) => source.id), ['z'])
  } finally { one.close(); two.close() }
})

test('malformed plan falls back to original query and records failure', async () => {
  const data = fixture(['one'])
  try {
    const queries = []
    const harness = createHarness({
      workspace: data.workspace,
      chat: async ({ role }) => ({ text: role === 'planner' ? '{broken' : role === 'reader' ? '{"findings":[]}' : 'Answer [one]' }),
      search: async ({ query }) => { queries.push(query); return { content: { results: [{ chunk_id: 'one' }] } } },
    })
    assert.deepEqual(harness.tools.list(), ['inventory', 'search', 'read'])
    assert.match(harness.tools.describe('read'), /Hydrate/)
    assert.equal((await harness.tools.invoke('read', { id: 'one' })).text, 'Evidence for one')
    const inventory = await harness.tools.invoke('inventory', {})
    inventory.clear()
    assert.equal((await harness.tools.invoke('read', { id: 'one' })).id, 'one')
    const run = await harness.run({ question: 'Original', mode: 'rlm' })
    assert.deepEqual(queries, ['Original'])
    assert.equal(run.metrics.errors, 1)
    assert.equal(run.trace.find((entry) => entry.stage === 'planner')?.error, 'planner returned no queries array')
  } finally { data.close() }
})

test('rejects symlink escape and empty chunk without supplying either to model', async () => {
  const data = fixture(['valid', 'escape', 'empty'])
  const outside = mkdtempSync(join(tmpdir(), 'legal-outside-'))
  try {
    writeFileSync(join(outside, 'secret.md'), 'external')
    rmSync(join(data.workspace, 'corpus/notes/escape.md'))
    symlinkSync(join(outside, 'secret.md'), join(data.workspace, 'corpus/notes/escape.md'))
    writeFileSync(join(data.workspace, 'corpus/notes/empty.md'), '---\nmetadata\n---\n')
    const run = await createHarness({
      workspace: data.workspace,
      chat: async () => ({ text: 'Answer [valid]' }),
      search: async () => ({ content: { results: ['escape', 'empty', 'valid'].map((chunk_id) => ({ chunk_id })) } }),
    }).run({ question: 'Question', mode: 'standard' })
    assert.deepEqual(run.sources.map((source) => source.id), ['valid'])
    assert.equal(run.metrics.missingChunks, 2)
    assert.ok(run.trace.some((entry) => entry.error?.includes('outside corpus')))
  } finally { data.close(); rmSync(outside, { recursive: true, force: true }) }
})

test('caps planned queries and model-visible sources despite expanded result lists', async () => {
  const ids = Array.from({ length: 30 }, (_, index) => `id${index}`)
  const data = fixture(ids)
  try {
    const run = await createHarness({
      workspace: data.workspace,
      chat: async ({ role }) => ({ text: role === 'planner' ? JSON.stringify({ queries: ['q1', 'q2', 'q3', 'q4', 'q5'] }) : role === 'reader' ? '{"findings":[]}' : 'Answer' }),
      search: async () => ({ content: { results: ids.map((chunk_id) => ({ chunk_id })) } }),
    }).run({ question: 'Original', mode: 'rlm' })
    assert.equal(run.metrics.queries, 4)
    assert.equal(run.sources.length, 12)
    assert.equal(run.metrics.sourceCoverage, 12 / 30)
  } finally { data.close() }
})

test('allocates primary ranked hits before sibling context under the source cap', async () => {
  const primary = Array.from({ length: 12 }, (_, index) => `p${index}`)
  const siblings = Array.from({ length: 4 }, (_, index) => `s${index}`)
  const data = fixture([...primary, ...siblings])
  try {
    const byQuery = Object.fromEntries(['Original', 'q1', 'q2', 'q3'].map((query, index) => [query, {
      results: primary.slice(index * 3, index * 3 + 3).map((chunk_id, position) => ({
        chunk_id, context: position === 0 ? [{ chunk_id: siblings[index] }] : [],
      })),
    }]))
    const run = await createHarness({
      workspace: data.workspace,
      chat: async ({ role }) => ({ text: role === 'planner' ? '{"queries":["q1","q2","q3"]}' : role === 'reader' ? '{"findings":[]}' : 'Answer' }),
      search: async ({ query }) => ({ content: byQuery[query] }),
    }).run({ question: 'Original', mode: 'rlm' })
    assert.deepEqual(new Set(run.sources.map((source) => source.id)), new Set(primary))
    assert.equal(run.sources.some((source) => source.id.startsWith('s')), false)
  } finally { data.close() }
})

test('RLM includes original, shares deduped hit and sibling coverage, and runs bounded parallel readers', async () => {
  const fixtureData = fixture(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  try {
    const calls = []
    let active = 0
    let peak = 0
    const chat = async ({ role, messages, signal }) => {
      assert.ok(signal instanceof AbortSignal)
      calls.push({ role, content: messages[1].content })
      if (role === 'planner') return { text: JSON.stringify({ queries: ['sub1', 'sub2', 'sub3', 'sub4', 'sub1'] }) }
      if (role === 'reader') {
        active++
        peak = Math.max(peak, active)
        const id = /\[([a-g])\]/.exec(messages[1].content)?.[1]
        await new Promise((resolve) => setTimeout(resolve, id === 'a' ? 20 : 2))
        active--
        return { text: JSON.stringify({ findings: [{ claim: `Supported ${id}`, citations: [id] }, { claim: 'Fabricated', citations: ['unknown'] }] }), usage: { outputTokens: 2 } }
      }
      assert.match(messages[1].content, /Reader findings/)
      assert.doesNotMatch(messages[1].content, /Fabricated/)
      assert.ok(messages[1].content.indexOf('Supported a') < messages[1].content.indexOf('Supported e'))
      return { text: 'Synthesis [a] [d]' }
    }
    const byQuery = {
      Original: [{ chunk_id: 'a', context: [{ chunk_id: 'b' }] }, { chunk_id: 'c' }],
      sub1: [{ chunk_id: 'a', context: [{ chunk_id: 'd' }] }],
      sub2: [{ chunk_id: 'e' }],
      sub3: [{ chunk_id: 'f', context: [{ chunk_id: 'g' }] }],
    }
    const search = async ({ query, expand }) => {
      assert.equal(expand, true)
      return { content: { results: byQuery[query] } }
    }
    const run = await createHarness({ workspace: fixtureData.workspace, chat, search }).run({ question: 'Original', mode: 'rlm' })
    assert.equal(run.metrics.queries, 4)
    assert.equal(run.metrics.readerCalls, 4)
    assert.equal(run.metrics.citedFindings, 4)
    assert.equal(peak, 3)
    assert.deepEqual(run.sources.map((source) => source.id), ['a', 'e', 'f', 'c', 'd', 'g', 'b'])
    assert.deepEqual(run.trace.filter((entry) => entry.stage === 'reader-input').flatMap((entry) => entry.ids).sort(), run.sources.map((source) => source.id).sort())
    assert.equal(calls.filter((call) => call.role === 'composer').length, 1)
  } finally { fixtureData.close() }
})

test('timed out requests receive abort signals and cannot change completed trace', async () => {
  const data = fixture(['one'])
  try {
    let signal
    const run = await createHarness({
      workspace: data.workspace, timeoutMs: 10,
      chat: async () => ({ text: 'Unused' }),
      search: async ({ signal: requestSignal }) => {
        signal = requestSignal
        return new Promise(() => {})
      },
    }).run({ question: 'Original', mode: 'standard' })
    assert.equal(signal.aborted, true)
    assert.equal(run.metrics.errors, 1)
    assert.match(run.trace.find((entry) => entry.stage === 'search')?.error, /timed out/)
    assert.deepEqual(run.sources, [])
  } finally { data.close() }
})

test('missing chunks and failed search are traced without exposing previews as sources', async () => {
  const data = fixture(['valid'])
  try {
    const run = await createHarness({
      workspace: data.workspace,
      chat: async ({ role }) => role === 'planner' ? { text: '{"queries":["broken"]}' } : role === 'reader' ? { text: '{"findings":[]}' } : { text: 'Only [valid]' },
      search: async ({ query }) => query === 'broken'
        ? { content: 'search unavailable', isError: true }
        : { content: { results: [{ chunk_id: 'missing', preview: 'Do not trust me' }, { chunk_id: 'valid' }] } },
    }).run({ question: 'original', mode: 'rlm' })
    assert.deepEqual(run.sources.map((source) => source.id), ['valid'])
    assert.equal(run.metrics.missingChunks, 1)
    assert.equal(run.metrics.errors, 2)
    assert.ok(run.trace.some((entry) => entry.stage === 'search' && entry.error))
  } finally { data.close() }
})
