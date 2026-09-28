import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { questionHash } from '../eval/compose.mjs'
import { preflightEvidenceV4 } from '../eval/rejudge.mjs'

test('recorded harness exception may omit answer without becoming a judge job', t => {
  const root = mkdtempSync(join(tmpdir(), 'absent-answer-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const artifacts = join(root, 'artifacts')
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, 'corpus/chunks'), { recursive: true })
  mkdirSync(join(artifacts, 'harvey'), { recursive: true })
  mkdirSync(join(artifacts, 'broad'), { recursive: true })
  const gold = JSON.parse(readFileSync(new URL('../eval/gold.json', import.meta.url)))[0]
  const row = { id: gold.id, q: gold.q, mode: 'harvey', failure_stage: 'harness',
    error: 'Evaluation operation failed', metrics: { errors: 1 }, audit: { calls: [], finalAnswer: null } }
  const data = { provenance: { question_hash: questionHash([gold]), config: {} }, rows: [row] }
  const inputs = { data, workspace, artifacts, limit: 1 }
  assert.throws(() => preflightEvidenceV4(inputs), /input row identities/)
  const result = preflightEvidenceV4({ ...inputs, allowHarnessFailures: true })
  assert.equal(result.verified.length, 0)
  assert.equal(result.unavailable.length, 1)
  assert.equal(Object.hasOwn(row, 'answer'), false)
  for (const answer of [null, false, 0, ' ', 'placeholder']) {
    row.answer = answer
    assert.throws(() => preflightEvidenceV4({ ...inputs, allowHarnessFailures: true }), /input row identities/)
  }
})
