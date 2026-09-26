import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadChunks, loadDocuments } from '../src/tp/manifest.ts'

test('manifest caches remain isolated across runtime corpus workspaces', () => {
  const roots = ['first', 'second'].map((name) => {
    const root = mkdtempSync(join(tmpdir(), `manifest-${name}-`))
    mkdirSync(join(root, 'corpus/index'), { recursive: true })
    writeFileSync(join(root, 'corpus/index/chunks.jsonl'), JSON.stringify({ chunk_id: name, path: `${name}.md` }))
    writeFileSync(join(root, 'corpus/index/documents.json'), JSON.stringify([{ doc_id: name }]))
    return root
  })
  try {
    assert.deepEqual([...loadChunks(roots[0]).keys()], ['first'])
    assert.deepEqual([...loadChunks(roots[1]).keys()], ['second'])
    assert.equal(loadDocuments(roots[0])[0].doc_id, 'first')
    assert.equal(loadDocuments(roots[1])[0].doc_id, 'second')
  } finally { roots.forEach((root) => rmSync(root, { recursive: true, force: true })) }
})
