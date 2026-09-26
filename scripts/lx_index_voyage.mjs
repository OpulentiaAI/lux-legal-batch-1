#!/usr/bin/env node
/** Rebuild the corpus into dedicated Voyage namespaces; never touches legacy indexes. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RETRIEVAL_PROFILE, EMBED_MODEL, DIMENSIONS, CHUNK_NS, DOC_NS, REQUIRED_ENV, EMBED_DOCUMENT_INPUT_TYPE, embed,
} from '../src/tp/client.ts'

const FTS_FR = { language: 'french', stemming: true, remove_stopwords: true, case_sensitive: false, ascii_folding: true }
const CHUNK_SCHEMA = {
  text: { type: 'string', full_text_search: FTS_FR, regex: true },
  doc: { type: 'string', full_text_search: false },
  doc_title: { type: 'string', full_text_search: FTS_FR },
  kind: { type: 'string' }, article: { type: 'string' },
  path: { type: 'string', full_text_search: FTS_FR, regex: true },
  lang: { type: 'string' }, pages: { type: 'string' },
}
const DOC_SCHEMA = {
  text: { type: 'string', full_text_search: FTS_FR }, doc: { type: 'string' },
  doc_title: { type: 'string', full_text_search: FTS_FR }, kind: { type: 'string' },
  year: { type: 'int' }, authors: { type: '[]string' },
}

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function noteBody(path) {
  const raw = readFileSync(path, 'utf8')
  const end = raw.indexOf('\n---', 4)
  return (end === -1 ? raw : raw.slice(end + 4)).trim()
}

function chunkRow(root, chunk) {
  const text = noteBody(resolve(root, chunk.path))
  return {
    id: chunk.chunk_id, text: text.slice(0, 4000),
    doc: chunk.doc_id, doc_title: chunk.doc_title, kind: chunk.kind,
    article: chunk.article || '', path: (chunk.structure || []).join(' > '),
    lang: 'fr', pages: chunk.pages || '', embeddingInput: text.slice(0, 8000), sourceHash: hash(text),
  }
}

function documentRow(doc) {
  return {
    id: doc.doc_id,
    text: `${doc.title} — ${doc.kind} (${doc.language || 'fr'}). Topics: ${(doc.topics || []).join(', ')}. ${doc.note || ''}`,
    doc: doc.doc_id, doc_title: doc.title, kind: doc.kind,
    year: doc.year || 0, authors: doc.authors || [],
  }
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(state))
  renameSync(temp, path)
}

async function upsert(namespace, rows, schema, key, base) {
  const body = JSON.stringify({ upsert_rows: rows, distance_metric: 'cosine_distance', schema })
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`${base}/v2/namespaces/${namespace}`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body,
    })
    if (response.ok) return
    if (![429, 500, 502, 503].includes(response.status) || attempt === 3) {
      throw new Error(`turbopuffer upsert ${response.status}`)
    }
    await new Promise((done) => setTimeout(done, 1000 * 2 ** attempt))
  }
}

function batches(items, size, maxChars = 240_000) {
  const result = []
  let batch = []
  let chars = 0
  for (const item of items) {
    const length = item.row.embeddingInput.length
    if (batch.length && (batch.length >= size || chars + length > maxChars)) {
      result.push(batch)
      batch = []
      chars = 0
    }
    batch.push(item)
    chars += length
  }
  if (batch.length) result.push(batch)
  return result
}

export async function migrate({ root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), doc, batch = 64, maxChunks = Infinity, maxDocs = Infinity, stateFile } = {}) {
  if (RETRIEVAL_PROFILE !== 'voyage') throw new Error('set LX_RETRIEVAL_PROFILE=voyage before indexing')
  if (![batch, maxChunks, maxDocs].every((n) => n === Infinity || Number.isSafeInteger(n) && n > 0)) {
    throw new Error('batch and sample limits must be positive integers')
  }
  for (const name of REQUIRED_ENV) {
    if (!process.env[name]) throw new Error(`missing env ${name}`)
  }
  const base = `https://${process.env.TURBOPUFFER_REGION}.turbopuffer.com`
  const key = process.env.TURBOPUFFER_API_KEY
  const index = join(root, 'corpus/index')
  const statePath = stateFile ? resolve(stateFile) : join(index, 'voyage4-1024-state.json')
  const signature = hash({ region: process.env.TURBOPUFFER_REGION, model: EMBED_MODEL, dimensions: DIMENSIONS,
    inputType: EMBED_DOCUMENT_INPUT_TYPE, chunkNamespace: CHUNK_NS, docNamespace: DOC_NS,
    chunkSchema: CHUNK_SCHEMA, docSchema: DOC_SCHEMA })

  const docs = JSON.parse(readFileSync(join(index, 'documents.json'), 'utf8'))
    .filter((item) => !doc || item.doc_id === doc).slice(0, maxDocs)
  const chunks = readFileSync(join(index, 'chunks.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((item) => !doc || item.doc_id === doc).slice(0, maxChunks)
  if (doc && docs.length === 0 && chunks.length === 0) throw new Error(`unknown document ${doc}`)
  const docRows = docs.map((item) => {
    const row = documentRow(item)
    return { ...row, embeddingInput: row.text, sourceHash: hash(item) }
  })
  const chunkRows = chunks.map((item) => chunkRow(root, item))
  const selection = hash({ doc: doc || null, maxChunks, maxDocs,
    docs: docRows.map(({ id, sourceHash }) => [id, sourceHash]),
    chunks: chunkRows.map(({ id, sourceHash }) => [id, sourceHash]) })
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {
    signature, selection, chunks: {}, docs: {}, complete: false,
  }
  if (state.signature !== signature || state.selection !== selection) {
    throw new Error('Voyage checkpoint config, selection, or corpus text changed; use a fresh checkpoint')
  }
  saveState(statePath, state)

  async function indexRows(source, namespace, schema, checkpoint) {
    const pending = source.map((row) => ({ row, digest: hash({ model: EMBED_MODEL, dimensions: DIMENSIONS,
      inputType: EMBED_DOCUMENT_INPUT_TYPE, row }) }))
      .filter(({ row, digest }) => checkpoint[row.id] !== digest)
    let done = 0
    for (const part of batches(pending, batch)) {
      const vectors = await embed(part.map(({ row }) => row.embeddingInput), undefined, 'document')
      if (vectors.length !== part.length || vectors.some((v) => v.length !== DIMENSIONS)) {
        throw new Error('ai-gateway returned unexpected embedding count or dimensions')
      }
      await upsert(namespace, part.map(({ row }, i) => {
        const { embeddingInput, sourceHash, ...attrs } = row
        return { ...attrs, vector: vectors[i] }
      }), schema, key, base)
      for (const { row, digest } of part) checkpoint[row.id] = digest
      saveState(statePath, state)
      done += part.length
      console.log(`${namespace}: ${done}/${pending.length} rows upserted`)
    }
    if (!pending.length) console.log(`${namespace}: up to date`)
  }

  await indexRows(docRows, DOC_NS, DOC_SCHEMA, state.docs)
  await indexRows(chunkRows, CHUNK_NS, CHUNK_SCHEMA, state.chunks)
  state.complete = !doc && maxDocs === Infinity && maxChunks === Infinity
  saveState(statePath, state)
  console.log(`Voyage corpus complete: ${state.complete}`)
  return { docs: docs.length, chunks: chunks.length, statePath }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = {}
    for (const arg of process.argv.slice(2)) {
      const match = /^--(doc|batch|max-chunks|max-docs|state)=(.+)$/.exec(arg)
      if (!match) throw new Error(`unknown option ${arg}`)
      const key = { doc: 'doc', batch: 'batch', 'max-chunks': 'maxChunks', 'max-docs': 'maxDocs', state: 'stateFile' }[match[1]]
      args[key] = key === 'doc' || key === 'stateFile' ? match[2] : Number(match[2])
    }
    await migrate(args)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
