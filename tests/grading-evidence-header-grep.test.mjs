import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evidenceV4 } from '../eval/grading-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

test('Harvey grep recognizes only its exact line-one header, never as legal evidence', t => {
  const root = mkdtempSync(join(tmpdir(), 'grading-header-grep-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), artifacts = join(root, 'artifacts')
  mkdirSync(join(workspace, 'corpus/index'), { recursive: true })
  mkdirSync(join(workspace, 'corpus/chunks'), { recursive: true })
  mkdirSync(join(artifacts, 'harvey/run-1'), { recursive: true })
  mkdirSync(join(artifacts, 'broad'), { recursive: true })
  const id = 'doc-01:a:c0', text = 'First legal rule.\nSecond legal rule.'
  writeFileSync(join(workspace, 'corpus/chunks/source.txt'), text)
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), JSON.stringify({ chunk_id: id,
    doc_id: 'doc-01', path: 'corpus/chunks/source.txt' }) + '\n')
  const args = JSON.stringify({ command: `grep -rn '^\\[${id}' chunks/*.txt` })
  const call = { tool: 'bash', arguments: args, result: '' }
  const artifact = join(artifacts, 'harvey/run-1/tool-results.jsonl')
  const row = { id: 'q01', mode: 'harvey', answer: 'Fixture answer', sources: [],
    audit: { finalAnswer: 'Fixture answer', calls: [{ tool: 'bash', arguments_sha256: hash(args) }] } }
  const evidence = evidenceV4({ workspace, artifacts })
  const replay = result => {
    call.result = result
    writeFileSync(artifact, JSON.stringify(call) + '\n')
    return evidence.replay(row).sources
  }
  assert.deepEqual(replay(`chunks/${id}.txt:1:[${id}]`), [])
  const visible = replay(`chunks/${id}.txt:1:[${id}]\nchunks/${id}.txt:3:Second legal rule.`)
  assert.deepEqual(visible.map(source => [source.kind, source.text, source.origin.line]),
    [['excerpt', 'Second legal rule.', 3]])
  assert.equal(visible[0].origin.start, text.indexOf('Second legal rule.'))
  for (const bad of [
    `chunks/${id}.txt:1:[doc-02:other:c0]`,
    `chunks/${id}.txt:1:Forged rule.`,
    `chunks/${id}.txt:0:[${id}]`,
  ]) assert.throws(() => replay(bad), /grep coordinate/)
  assert.throws(() => replay(`chunks/${id}.txt:1:[${id}]\nchunks/${id}.txt:3:Forged rule.`), /grep contents/)
})
