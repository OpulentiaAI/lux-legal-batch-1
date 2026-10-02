import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareJevCriterion, normalizeJev, aggregateJev } from '../eval/complex-v1/jev-grade-run.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const response = () => ({ model: 'typesafe-ai/jev', answers: {
  quality: { type: 'score', score: 2.4, confidence: 0.8 }, accuracy: { type: 'score', score: 2.7, confidence: 0.9 },
  claimsPresent: { type: 'boolean', probability: 0.99 }, satisfied: { type: 'boolean', probability: 0.8 },
  sourceCompliance: { type: 'boolean', probability: 0.2 }, unresolved: { type: 'boolean', probability: 0.1 },
} })

test('criterion state includes every public material and complete reference bodies without inventing visibility', t => {
  const output = mkdtempSync(join(tmpdir(), 'jev-grounded-'))
  t.after(() => rmSync(output, { recursive: true, force: true }))
  writeFileSync(join(output, 'memo.md'), 'Scoped advice')
  writeFileSync(join(output, 'unrelated.md'), 'Do not promote unrelated deliverables')
  const source = { id: 'law:a', text: 'Full authoritative source text.', role: 'reference', sha256: hash('Full authoritative source text.') }
  const criterion = { id: 'c1', requirement: 'Apply the rule', pass: 'Qualified correct application', fail: 'False rule',
    deliverables: ['memo.md'], sourceRefs: [{ id: source.id }], factRefs: [{ file: 'materials/client.md' }] }
  const bundle = { task: { id: 't', title: 'Advice', instructions: 'Apply law', scope: { companyForm: 'SARL', jurisdiction: 'Luxembourg', asOf: '2026-05-29' } },
    rubric: { criteria: [criterion] }, sources: [source], materials: new Map([['materials/client.md', 'Main client facts'], ['materials/other.md', 'Other relevant scenario context']]) }
  const request = prepareJevCriterion(bundle, output, 'c1', [])
  const state = JSON.parse(request.state)
  assert.equal(state.publicMaterials.length, 2)
  assert.equal(state.publicMaterials[1].text, 'Other relevant scenario context')
  assert.equal(state.referenceSources[0].text, source.text)
  assert.equal(state.referenceSources[0].role, 'reference')
  assert.deepEqual(state.visibleSources, [])
  assert.deepEqual(state.outputs.map(item => item.file), ['memo.md'])
  assert.ok(!request.state.includes('Do not promote unrelated'))
  assert.match(request.questions.sourceCompliance.instructions, /hidden reference never proves consultation/)
  assert.match(request.questions.quality.instructions, /Do not use turn count, token use, latency/)
  assert.ok(!request.questions.quality.instructions.includes('Return one strict JSON object'))
  assert.throws(() => prepareJevCriterion(bundle, output, 'c1', [source]), /visible source role/)
})

test('typed interpolated scores normalize to 0–1 and absent claims never receive perfect accuracy', () => {
  const graded = normalizeJev(response())
  assert.equal(graded.quality, 2.4 / 3)
  assert.equal(graded.accuracy, 2.7 / 3)
  assert.equal(graded.passProbability, 0.8)
  assert.equal(graded.sourceComplianceProbability, 0.2)
  const missing = response()
  missing.answers.claimsPresent.probability = 0
  assert.equal(normalizeJev(missing).accuracy, null)
  const invalid = response()
  invalid.answers.quality.score = 4
  assert.throws(() => normalizeJev(invalid), /Invalid Jev score/)
  const invalidProbability = response()
  invalidProbability.answers.satisfied.probability = -1
  assert.throws(() => normalizeJev(invalidProbability), /Invalid Jev boolean/)
  assert.throws(() => normalizeJev({ ...response(), model: 'another-model' }), /Unexpected Jev model/)
})

test('full results remain paired while trimming independently by system and metric', () => {
  const quality = { harvey: [0.1, 0.2, 0.5, 0.8, 0.9], broad: [0.4, 0.9, 0.1, 0.7, 0.3] }
  const accuracy = { harvey: [0.9, 0.2, 0.1, 0.3, 0.8], broad: [0.2, 0.4, 0.6, 0.8, 1] }
  const rows = Object.keys(quality).flatMap(mode => quality[mode].map((value, index) => ({ taskId: `task-${index + 1}`, mode, status: 'graded',
    scores: { quality: value, accuracy: accuracy[mode][index], passProbability: 0.8, unresolved: false }, metrics: { tokens: 10000000 } })))
  const result = aggregateJev(rows)
  assert.equal(result.paired.length, 5)
  assert.ok(Math.abs(result.summaries.harvey.quality.trimmed - 0.5) < 1e-10)
  assert.deepEqual(result.summaries.harvey.quality.dropped, ['task-1', 'task-5'])
  assert.deepEqual(result.summaries.broad.quality.dropped, ['task-3', 'task-2'])
  assert.deepEqual(result.summaries.harvey.accuracy.dropped, ['task-3', 'task-1'])
  assert.deepEqual(result.summaries.broad.accuracy.dropped, ['task-1', 'task-5'])
  assert.equal(result.summaries.harvey.quality.coverage, 5)
  assert.equal(result.summaries.harvey.quality.retained.length, 3)
  assert.match(result.alignment, /pending independent/)
})

test('judge failures and unresolved criteria remain separate from observed quality and execution', () => {
  const rows = [{ taskId: 't', mode: 'harvey', status: 'graded', scores: { quality: 1, accuracy: 0.7, passProbability: 1, unresolved: false } },
    { taskId: 't', mode: 'harvey', status: 'graded', scores: { quality: 0.1, accuracy: 0.2, passProbability: 0, unresolved: true } },
    { taskId: 't', mode: 'harvey', status: 'judgeFailure' }, { taskId: 't', mode: 'broad', status: 'answererFailure' }]
  const result = aggregateJev(rows)
  assert.equal(result.paired[0].harvey.quality, 1)
  assert.equal(result.paired[0].harvey.resolved, 1)
  assert.equal(result.paired[0].harvey.unresolved, 1)
  assert.equal(result.paired[0].harvey.failures, 1)
  assert.equal(result.paired[0].broad.quality, null)
  assert.equal(result.summaries.harvey.quality.trimmed, null)
})
