import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const normalize = (text) => text.normalize('NFKC').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').toLowerCase()

test('the frozen gold set has evidence in its declared documents', () => {
  const gold = JSON.parse(readFileSync(resolve(root, 'eval/gold.json'), 'utf8'))
  const chunks = readFileSync(resolve(root, 'corpus/index/chunks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const documents = new Map()
  for (const row of chunks) {
    const raw = readFileSync(resolve(root, row.path), 'utf8')
    const end = raw.indexOf('\n---', 4)
    const text = normalize(end === -1 ? raw : raw.slice(end + 4))
    if (!documents.has(row.doc_id)) documents.set(row.doc_id, [])
    documents.get(row.doc_id).push(text)
  }
  assert.equal(new Set(chunks.map((row) => row.chunk_id)).size, chunks.length)
  assert.equal(new Set(gold.map((row) => row.id)).size, gold.length)
  for (const row of gold) {
    assert.ok(row.q && row.evidence && row.docs.length && row.rubric.length, row.id)
    assert.ok(row.docs.some((doc) => documents.get(doc)?.some((text) => text.includes(normalize(row.evidence)))), `${row.id}: evidence missing from expected documents`)
  }
})
