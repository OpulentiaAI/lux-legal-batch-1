import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const original = { ...process.env }
const fetchOriginal = globalThis.fetch
const restore = () => {
  process.env = { ...original }
  globalThis.fetch = fetchOriginal
}

test('legacy defaults, overrides and Jina routing are unchanged', async () => {
  try {
    delete process.env.LX_RETRIEVAL_PROFILE
    process.env.LX_TP_NAMESPACE = 'custom-chunks'
    process.env.LX_TP_DOC_NAMESPACE = 'custom-docs'
    process.env.AI_GATEWAY_API_KEY = 'gateway-secret'
    process.env.JINA_API_KEY = 'jina-secret'
    const client = await import('../src/tp/client.ts?legacy-test')
    assert.equal(client.RETRIEVAL_PROFILE, 'legacy')
    assert.deepEqual([client.EMBED_MODEL, client.DIMENSIONS, client.CHUNK_NS, client.DOC_NS],
      ['openai/text-embedding-3-large', 3072, 'custom-chunks', 'custom-docs'])
    assert.equal(client.EMBED_QUERY_INPUT_TYPE, null)
    assert.equal(client.EMBED_DOCUMENT_INPUT_TYPE, null)
    assert.ok(client.REQUIRED_ENV.includes('JINA_API_KEY'))
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://ai-gateway.vercel.sh/v1/embeddings')
      assert.deepEqual(JSON.parse(options.body), { model: client.EMBED_MODEL, dimensions: 3072, input: ['query'] })
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }))
    }
    assert.deepEqual(await client.embed(['query']), [[1]])
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://api.jina.ai/v1/rerank')
      assert.equal(options.headers.Authorization, 'Bearer jina-secret')
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }))
    }
    assert.deepEqual(await client.rerank('q', ['doc']), [{ index: 0, relevance_score: 0.9 }])
  } finally { restore() }
})

test('Voyage uses isolated namespaces, paired embedding types and Gateway rerank', async () => {
  try {
    process.env.LX_RETRIEVAL_PROFILE = 'voyage'
    process.env.LX_TP_NAMESPACE = 'legacy-override'
    process.env.LX_TP_DOC_NAMESPACE = 'legacy-doc-override'
    process.env.AI_GATEWAY_API_KEY = 'gateway-secret'
    delete process.env.JINA_API_KEY
    const client = await import('../src/tp/client.ts?voyage-test')
    assert.deepEqual([client.RETRIEVAL_PROFILE, client.EMBED_MODEL, client.RERANK_MODEL, client.DIMENSIONS],
      ['voyage', 'voyage/voyage-4-large', 'voyage/rerank-2.5', 1024])
    assert.deepEqual([client.CHUNK_NS, client.DOC_NS], ['lx-corpus-voyage4-1024', 'lx-documents-voyage4-1024'])
    assert.deepEqual([client.EMBED_QUERY_INPUT_TYPE, client.EMBED_DOCUMENT_INPUT_TYPE], ['query', 'document'])
    assert.ok(!client.REQUIRED_ENV.includes('JINA_API_KEY'))
    const requests = []
    globalThis.fetch = async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body), auth: options.headers.Authorization })
      return new Response(JSON.stringify(url.endsWith('/embeddings')
        ? { data: [{ index: 0, embedding: [1] }] }
        : { results: [{ index: 0, relevance_score: 0.8 }] }))
    }
    await client.embed(['query'])
    await client.embed(['doc'], undefined, 'document')
    await client.rerank('query', ['doc'])
    assert.deepEqual(requests.map((r) => r.body.input_type), ['query', 'document', undefined])
    assert.equal(requests[2].url, 'https://ai-gateway.vercel.sh/v2/rerank')
    assert.deepEqual(requests[2].body, { model: client.RERANK_MODEL, query: 'query', documents: ['doc'] })
    assert.ok(requests.every((r) => r.auth === 'Bearer gateway-secret'))
    globalThis.fetch = async () => new Response('sensitive response body', { status: 401 })
    await assert.rejects(client.rerank('query', ['doc']), (error) => {
      assert.equal(error.message, 'ai-gateway rerank 401')
      return true
    })
  } finally { restore() }
})

test('unknown retrieval profile fails closed', async () => {
  try {
    process.env.LX_RETRIEVAL_PROFILE = 'typo'
    await assert.rejects(import('../src/tp/client.ts?invalid-test'), /unsupported LX_RETRIEVAL_PROFILE/)
  } finally { restore() }
})

test('Voyage migration checkpoints exact text, sample selection and completion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'voyage-index-'))
  try {
    process.env.LX_RETRIEVAL_PROFILE = 'voyage'
    process.env.AI_GATEWAY_API_KEY = 'gateway-secret'
    process.env.TURBOPUFFER_API_KEY = 'tp-secret'
    process.env.TURBOPUFFER_REGION = 'gcp-us-central1'
    const index = join(root, 'corpus/index')
    mkdirSync(join(root, 'corpus/chunks'), { recursive: true })
    mkdirSync(index, { recursive: true })
    writeFileSync(join(index, 'documents.json'), JSON.stringify([
      { doc_id: 'doc-01', title: 'First', kind: 'law', topics: [] },
      { doc_id: 'doc-02', title: 'Second', kind: 'law', topics: [] },
    ]))
    writeFileSync(join(index, 'chunks.jsonl'), [1, 2].map((i) => JSON.stringify({
      chunk_id: `chunk-${i}`, path: `corpus/chunks/${i}.md`, doc_id: `doc-0${i}`,
      doc_title: `Title ${i}`, kind: 'law', structure: ['Section'],
    })).join('\n'))
    writeFileSync(join(root, 'corpus/chunks/1.md'), '---\ntitle: First\n---\nBody one')
    writeFileSync(join(root, 'corpus/chunks/2.md'), '---\ntitle: Second\n---\nBody two')
    const { migrate } = await import('../scripts/lx_index_voyage.mjs?migration-test')
    const calls = []
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body)
      calls.push({ url, body })
      if (url.endsWith('/embeddings')) {
        assert.equal(body.input_type, 'document')
        return new Response(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: Array(1024).fill(0) })) }))
      }
      assert.match(url, /lx-(documents|corpus)-voyage4-1024$/)
      assert.equal(body.distance_metric, 'cosine_distance')
      return new Response('{}')
    }
    const sampleState = join(index, 'sample-state.json')
    await migrate({ root, maxDocs: 1, maxChunks: 1, stateFile: sampleState })
    const sample = JSON.parse(readFileSync(sampleState, 'utf8'))
    assert.equal(sample.complete, false)
    assert.equal(Object.keys(sample.docs).length, 1)
    assert.equal(Object.keys(sample.chunks).length, 1)
    const callCount = calls.length
    await migrate({ root, maxDocs: 1, maxChunks: 1, stateFile: sampleState })
    assert.equal(calls.length, callCount)
    await assert.rejects(migrate({ root, maxDocs: 2, maxChunks: 1, stateFile: sampleState }), /checkpoint config, selection, or corpus text changed/)
    writeFileSync(join(root, 'corpus/chunks/1.md'), '---\ntitle: First\n---\nChanged body')
    await assert.rejects(migrate({ root, maxDocs: 1, maxChunks: 1, stateFile: sampleState }), /checkpoint config, selection, or corpus text changed/)
    await migrate({ root, batch: 2 })
    const full = JSON.parse(readFileSync(join(index, 'voyage4-1024-state.json'), 'utf8'))
    assert.equal(full.complete, true)
    assert.equal(Object.keys(full.docs).length, 2)
    assert.equal(Object.keys(full.chunks).length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
    restore()
  }
})

test('failed upsert leaves checkpoint incomplete and retries the same rows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'voyage-retry-'))
  try {
    process.env.LX_RETRIEVAL_PROFILE = 'voyage'
    process.env.AI_GATEWAY_API_KEY = 'gateway-secret'
    process.env.TURBOPUFFER_API_KEY = 'tp-secret'
    process.env.TURBOPUFFER_REGION = 'gcp-us-central1'
    mkdirSync(join(root, 'corpus/index'), { recursive: true })
    writeFileSync(join(root, 'corpus/index/documents.json'), JSON.stringify([
      { doc_id: 'doc-01', title: 'One', kind: 'law' },
    ]))
    writeFileSync(join(root, 'corpus/index/chunks.jsonl'), '')
    const { migrate } = await import('../scripts/lx_index_voyage.mjs?retry-test')
    const statePath = join(root, 'corpus/index/voyage4-1024-state.json')
    let fail = true
    let upserts = 0
    globalThis.fetch = async (url, options) => {
      if (url.endsWith('/embeddings')) return new Response(JSON.stringify({ data: [{ index: 0, embedding: Array(1024).fill(0) }] }))
      upserts++
      if (fail) return new Response('private upstream error', { status: 400 })
      return new Response('{}')
    }
    await assert.rejects(migrate({ root }), (error) => {
      assert.equal(error.message, 'turbopuffer upsert 400')
      return true
    })
    const checkpoint = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(checkpoint.complete, false)
    assert.deepEqual(checkpoint.docs, {})
    fail = false
    await migrate({ root })
    assert.equal(upserts, 2)
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).complete, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    restore()
  }
})
