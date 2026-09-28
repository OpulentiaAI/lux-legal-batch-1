import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evidenceV4 } from '../eval/grading-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

test('failed Harvey null-answer replay retains recorded evidence without synthesizing an answer', t => {
  const root = mkdtempSync(join(tmpdir(), 'grading-failed-harvey-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), artifacts = join(root, 'artifacts')
  mkdirSync(join(workspace, 'corpus/index'), { recursive: true })
  mkdirSync(join(workspace, 'corpus/chunks'), { recursive: true })
  mkdirSync(join(artifacts, 'harvey/run-1'), { recursive: true })
  mkdirSync(join(artifacts, 'broad'), { recursive: true })
  const id = 'doc-06:s0166:c0', text = 'The visible recorded rule.'
  writeFileSync(join(workspace, `corpus/chunks/${id}.txt`), text)
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), JSON.stringify({
    chunk_id: id, doc_id: 'doc-06', path: `corpus/chunks/${id}.txt`,
  }) + '\n')
  const argumentsText = JSON.stringify({ file_path: `/workspace/documents/chunks/${id}.txt`, offset: 0, limit: 20 })
  writeFileSync(join(artifacts, 'harvey/run-1/tool-results.jsonl'), JSON.stringify({
    tool: 'read', arguments: argumentsText, result: `[${id}]\n${text}\n`,
  }) + '\n')
  const row = { mode: 'harvey', answer: null, error: 'Answerer subprocess failed', failure_stage: 'answerer',
    trace: { failed: true }, sources: [{ id, doc: 'doc-06', chars: text.length, sha256: hash(text) }],
    audit: { finalAnswer: null, calls: [{ tool: 'read', arguments_sha256: hash(argumentsText) }] } }
  const evidence = evidenceV4({ workspace, artifacts })
  const replay = evidence.replay(row)
  assert.equal(replay.answer, null)
  assert.deepEqual(replay.trace, row.trace)
  assert.deepEqual(replay.sources.map(source => [source.id, source.kind, source.text]), [[id, 'full', text]])
  for (const changes of [
    { error: null }, { failure_stage: undefined }, { failure_stage: 'judge' },
    { audit: { ...row.audit, finalAnswer: 'Invented answer' } },
    { audit: { ...row.audit, finalAnswer: undefined } },
    { answer: 'Invented answer' },
  ]) assert.throws(() => evidence.replay({ ...row, ...changes }), /replay row/)
  assert.throws(() => evidence.replay({ ...row, audit: { ...row.audit,
    calls: [{ tool: 'read', arguments_sha256: hash('unrecorded arguments') }] } }), /run identity/)
  assert.throws(() => evidence.replay({ ...row, sources: [{ ...row.sources[0], sha256: hash('forged source') }] }), /source hash/)
})
