import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareCorpus, captureVisibleSources } from '../eval/comparison-corpus.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'comparison-corpus-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'corpus/index'), { recursive: true })
  mkdirSync(join(root, 'corpus/chunks'), { recursive: true })
  writeFileSync(join(root, 'corpus/index/chunks.jsonl'), JSON.stringify({ chunk_id: 'doc-01:a:c0', doc_id: 'doc-01', path: 'corpus/chunks/a.md' }) + '\n')
  writeFileSync(join(root, 'corpus/index/documents.json'), JSON.stringify([{ doc_id: 'doc-01', title: 'Statute', raw_file: 'private.pdf' }]))
  writeFileSync(join(root, 'corpus/chunks/a.md'), '---\ntype: chunk\n---\nActual source text.\n')
  writeFileSync(join(root, 'gold.json'), 'SECRET RUBRIC')
  return root
}

test('exports only canonical corpus text and permitted metadata with stable identity', t => {
  const workspace = fixture(t)
  const a = prepareCorpus({ workspace, directory: join(workspace, 'export-a') })
  const b = prepareCorpus({ workspace, directory: join(workspace, 'export-b') })
  assert.equal(a.hash, b.hash)
  assert.equal(a.count, 1)
  assert.deepEqual(readdirSync(a.directory).sort(), ['README.txt', 'chunks', 'documents.json', 'index.json'])
  assert.equal(readFileSync(join(a.directory, a.sources[0].path), 'utf8'), '[doc-01:a:c0]\nActual source text.\n')
  assert.ok(!readFileSync(join(a.directory, 'documents.json'), 'utf8').includes('private.pdf'))
  assert.throws(() => prepareCorpus({ workspace, directory: a.directory }), /empty/)
})

test('rejects a corpus path that escapes through a symlink', t => {
  const workspace = fixture(t)
  rmSync(join(workspace, 'corpus/chunks/a.md'))
  symlinkSync(join(workspace, 'gold.json'), join(workspace, 'corpus/chunks/a.md'))
  assert.throws(() => prepareCorpus({ workspace, directory: join(workspace, 'export') }), /outside/)
})

test('never hydrates unseen citations or partial tool excerpts', () => {
  const sources = [{ id: 'doc-01:a:c0', doc: 'doc-01', text: 'Actual source text.' }]
  assert.deepEqual(captureVisibleSources('[doc-01:a:c0]', sources), [])
  assert.deepEqual(captureVisibleSources('[doc-01:a:c0]\nActual source', sources), [])
  assert.deepEqual(captureVisibleSources('1: [doc-01:a:c0]\n2: Actual source text.', sources), sources)
})
