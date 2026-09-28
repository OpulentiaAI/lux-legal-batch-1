import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { questionHash } from '../eval/compose.mjs'
import { preflightEvidenceV4, rejudgeEvidenceV4 } from '../eval/rejudge.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const gold = JSON.parse(readFileSync(new URL('../eval/gold.json', import.meta.url), 'utf8'))[0]
const id = 'doc-01:a:c0', doc = 'doc-01', text = 'A visible legal rule.'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'rejudge-harness-failures-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'project'), artifacts = join(root, 'artifacts')
  mkdirSync(join(workspace, 'corpus/chunks'), { recursive: true })
  mkdirSync(join(workspace, 'corpus/index'), { recursive: true })
  mkdirSync(join(artifacts, 'harvey'), { recursive: true })
  mkdirSync(join(artifacts, 'broad'), { recursive: true })
  writeFileSync(join(workspace, 'corpus/chunks/source.txt'), text)
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), JSON.stringify({ chunk_id: id, doc_id: doc, path: 'corpus/chunks/source.txt' }) + '\n')
  const answer = `The rule applies [${id}].`
  const call = { tool: 'lx_chunk', args: { chunk_id: id }, output: JSON.stringify({ chunk_id: id, doc, text }) }
  call.result = { error: false, sha256: hash(call.output) }
  const provenance = { fixture: true }
  writeFileSync(join(artifacts, 'broad/abcdef.json'), JSON.stringify({ provenance, calls: [call] }))
  const failure = { id: gold.id, q: gold.q, mode: 'harvey', answer: '', error: 'Evaluation operation failed', failure_stage: 'harness',
    metrics: { errors: 1, turns: 40 }, audit: { calls: [], finalAnswer: '' }, sources: [], trace: [{ stage: 'answer', ok: false }] }
  const broad = { id: gold.id, q: gold.q, mode: 'broad', answer, degraded: false, sources: [{ id, doc, chars: text.length, sha256: hash(text) }],
    audit: { provenance, evidenceArtifact: '/other/abcdef.json', finalAnswerHash: hash(answer),
      calls: [{ tool: call.tool, argsHash: hash(JSON.stringify(call.args)), result: call.result }] }, metrics: { errors: 0 } }
  const data = { provenance: { question_hash: questionHash([gold]), config: { model: 'fixture' } }, rows: [failure, broad] }
  const rawInput = { path: join(root, 'input.json'), text: JSON.stringify(data) }
  writeFileSync(rawInput.path, rawInput.text)
  return { root, workspace, artifacts, data, rawInput, failure, broad }
}

test('opt-in replay preserves unavailable answer without asking the judge or scoring it wrong', async t => {
  const setup = fixture(t)
  const { root, workspace, artifacts, data, rawInput, failure } = setup
  assert.throws(() => preflightEvidenceV4({ data, workspace, artifacts, limit: 1 }), /input row identities/)
  const preflight = preflightEvidenceV4({ data, workspace, artifacts, limit: 1, allowHarnessFailures: true })
  assert.equal(preflight.jobs.length, 2)
  assert.equal(preflight.verified.length, 1)
  assert.deepEqual(preflight.unavailable.map(job => [job.g.id, job.mode]), [[gold.id, 'harvey']])
  let calls = 0
  const inputs = { data, rawInput, workspace, artifacts, output: join(root, 'judged.json'), limit: 1,
    judgeModel: 'openai/gpt-6-luna', allowHarnessFailures: true, chat: async ({ messages }) => {
      calls++
      assert.match(messages[1].content, /A visible legal rule/)
      return { text: JSON.stringify({ verdict: 'correct', citation_ok: true, grounded: true,
        rubric: gold.rubric.map(item => ({ item, pass: true, note: 'Verified' })), note: 'Verified',
        adjudication: 'resolved', legal_truth: 'correct', document_compliance: 'met', criticisms: [] }) }
    } }
  const result = await rejudgeEvidenceV4(inputs)
  assert.equal(calls, 1)
  assert.equal(result.rows.length, 2)
  const missing = result.rows.find(row => row.mode === 'harvey')
  assert.deepEqual(missing, { id: gold.id, mode: 'harvey', q: gold.q, error: failure.error,
    failure_stage: 'harness', original_row_sha256: hash(JSON.stringify(failure)), metrics: failure.metrics })
  assert.equal(missing.verdict, undefined)
  assert.equal(missing.rubric_pass, undefined)
  assert.equal(result.rows.find(row => row.mode === 'broad').verdict, 'correct')
  assert.deepEqual(result.unavailable, [{ id: gold.id, mode: 'harvey', original_row_sha256: hash(JSON.stringify(failure)) }])
  assert.equal(result.provenance.config.allow_harness_failures, true)
  assert.equal(result.summary.harvey.planned, 1)
  assert.equal(result.summary.harvey.completed, 1)
  assert.equal(result.summary.harvey.evaluated, 0)
  assert.equal(result.summary.harvey.errors, 1)
  assert.equal(result.summary.harvey.wrong, 0)
  assert.equal(result.summary.harvey.unavailable_answers, 1)
  assert.equal(result.summary.harvey.evaluated_rubric_total, 0)
  assert.equal(result.summary.broad.evaluated, 1)
  assert.equal(result.summary.broad.evaluated_rubric_total, gold.rubric.length)
  await rejudgeEvidenceV4({ ...inputs, resume: true })
  assert.equal(calls, 1)
  await assert.rejects(rejudgeEvidenceV4({ ...inputs, resume: true, allowHarnessFailures: false }), /input row identities/)
  const altered = JSON.parse(readFileSync(inputs.output, 'utf8'))
  altered.rows.find(row => row.mode === 'harvey').error = 'Not the original failure'
  writeFileSync(inputs.output, JSON.stringify(altered))
  await assert.rejects(rejudgeEvidenceV4({ ...inputs, resume: true }), /resume provenance/)
})

test('opt-in rejects answer-stage failures, fabricated placeholders, bad metrics and row identities', t => {
  const { data, workspace, artifacts, failure, broad } = fixture(t)
  const check = () => preflightEvidenceV4({ data, workspace, artifacts, limit: 1, allowHarnessFailures: true })
  failure.failure_stage = 'answer'
  assert.throws(check, /input row identities/)
  failure.failure_stage = 'harness'
  failure.answer = 'Invented placeholder'
  assert.throws(check, /input row identities/)
  failure.answer = ''
  failure.metrics.errors = 0
  assert.throws(check, /input row identities/)
  failure.metrics.errors = 1
  failure.audit.finalAnswer = 'Hidden final answer'
  assert.throws(check, /input row identities/)
  failure.audit.finalAnswer = ''
  broad.q = 'Wrong question'
  assert.throws(check, /input row identities/)
  broad.q = gold.q
  data.rows[1] = failure
  assert.throws(check, /input row identities/)
})
