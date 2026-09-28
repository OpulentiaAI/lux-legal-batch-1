import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evidenceV4 } from '../eval/grading-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

test('Harvey omitted/null read ranges expose only the canonical returned lines', t => {
  const root = mkdtempSync(join(tmpdir(), 'harvey-read-default-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), artifacts = join(root, 'artifacts')
  mkdirSync(join(workspace, 'corpus/index'), { recursive: true })
  mkdirSync(join(workspace, 'corpus/chunks'), { recursive: true })
  mkdirSync(join(artifacts, 'harvey/run-1'), { recursive: true })
  mkdirSync(join(artifacts, 'broad'))
  const id = 'doc-08:s0480:c3', doc = 'doc-08', text = 'First line.\nSecond line.\nUnseen suffix.'
  writeFileSync(join(workspace, `corpus/chunks/${id}.txt`), text)
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), `${JSON.stringify({
    chunk_id: id, doc_id: doc, path: `corpus/chunks/${id}.txt`,
  })}\n`)
  const file = join(artifacts, 'harvey/run-1/tool-results.jsonl')
  const row = { mode: 'harvey', answer: 'Answer', metrics: {}, sources: [{ id, doc, chars: text.length, sha256: hash(text) }],
    audit: { finalAnswer: 'Answer', calls: [] } }
  const replay = (range, result) => {
    const argumentsText = JSON.stringify({ file_path: `/workspace/documents/chunks/${id}.txt`, ...range })
    writeFileSync(file, `${JSON.stringify({ tool: 'read', arguments: argumentsText, result })}\n`)
    row.audit.calls = [{ tool: 'read', arguments_sha256: hash(argumentsText) }]
    return evidenceV4({ workspace, artifacts }).replay(row).sources
  }
  const full = `[${id}]\n${text}\n`
  for (const range of [{}, { offset: null, limit: null }, { offset: 0, limit: null }]) {
    const sources = replay(range, full)
    assert.deepEqual(sources.map(item => [item.kind, item.text, item.origin.start]), [['full', text, 0]])
  }
  for (const range of [{ offset: 0, limit: 2 }, { offset: null, limit: 2 }, { limit: 2 }]) {
    const sources = replay(range, `[${id}]\nFirst line.`)
    assert.deepEqual(sources.map(item => [item.kind, item.text, item.origin.start]), [['excerpt', 'First line.', 0]])
    assert.ok(!sources.some(item => item.text.includes('Unseen suffix.')))
  }
  assert.deepEqual(replay({ offset: 2, limit: 1 }, 'Second line.').map(item =>
    [item.text, item.origin.start]), [['Second line.', text.indexOf('Second line.')]])
  assert.deepEqual(replay({ offset: 2, limit: null }, 'Second line.\nUnseen suffix.\n').map(item =>
    [item.text, item.origin.start]), [['Second line.\nUnseen suffix.', text.indexOf('Second line.')]])
  for (const range of [{ offset: -1 }, { offset: '0' }, { offset: 1.2 }, { limit: 0 }, { limit: '2' }, { limit: -1 }]) {
    assert.throws(() => replay(range, full), /Invalid evidence read range/)
  }
  assert.throws(() => replay({}, `${full}Forged suffix`), /Invalid evidence read contents/)
  assert.throws(() => replay({ limit: 2 }, full), /Invalid evidence read contents/)
  assert.throws(() => replay({ limit: 2 }, `[${id}]\nFirst line.\n`), /Invalid evidence read contents/)
  assert.throws(() => replay({ offset: null, limit: null }, full.slice(0, -1)), /Invalid evidence read contents/)
})
