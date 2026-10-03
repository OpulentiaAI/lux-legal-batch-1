import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareJevCriterion, normalizeJev, aggregateJev, COMPLETED_WORK_POLICY, JEV_POLICY } from '../eval/complex-v1/jev-grade-run.mjs'

const metricsProfile = 'completed-work-v6'
const raw = () => ({ model: 'typesafe-ai/jev', answers: {
  quality: { type: 'score', score: 1.5 }, accuracy: { type: 'score', score: 3 }, completeness: { type: 'score', score: 2.4 },
  claimsPresent: { type: 'boolean', probability: 1 }, satisfied: { type: 'boolean', probability: 0 },
  sourceCompliance: { type: 'boolean', probability: 1 }, unresolved: { type: 'boolean', probability: 0 },
} })

test('completed-work v6 measures substantive coverage separately from correctness and reliability', t => {
  const directory = mkdtempSync(join(tmpdir(), 'jev-completed-work-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, 'memo.md'), 'Both issues are addressed, but one rule is wrong.')
  const criterion = { id: 'c1', requirement: 'Address recognition and evidence requests.', pass: 'Both addressed accurately.', fail: 'A missing or false rule.', deliverables: ['memo.md'], sourceRefs: [], factRefs: [] }
  const bundle = { task: { id: 't', title: 'Advice', instructions: 'Apply the rules', scope: {} }, materials: new Map(), sources: [], rubric: { criteria: [criterion] } }
  const request = prepareJevCriterion(bundle, directory, 'c1', [], { metricsProfile })
  assert.equal(request.questions.completeness.type, 'score')
  assert.match(request.questions.completeness.instructions, /separately from correctness/)
  assert.match(request.questions.completeness.instructions, /Do not measure first-attempt reliability/)
  assert.match(request.questions.quality.instructions, /Do not use turn count, token use, latency/)
  assert.equal(prepareJevCriterion(bundle, directory, 'c1', []).questions.completeness, undefined)
  assert.notEqual(COMPLETED_WORK_POLICY.version, JEV_POLICY.version)
})

test('completed-work v6 normalizes completeness directly to 0–1 and requires the actual typed score', () => {
  const score = normalizeJev(raw(), { metricsProfile })
  assert.equal(score.quality, 0.5)
  assert.equal(score.accuracy, 1)
  assert.equal(score.completeness, 2.4 / 3)
  assert.equal(normalizeJev(raw()).completeness, undefined)
  const missing = raw()
  delete missing.answers.completeness
  assert.throws(() => normalizeJev(missing, { metricsProfile }), /Invalid Jev score: completeness/)
  const invalid = raw()
  invalid.answers.completeness.score = 4
  assert.throws(() => normalizeJev(invalid, { metricsProfile }), /Invalid Jev score: completeness/)
  assert.throws(() => normalizeJev(raw(), { metricsProfile: 'unknown' }), /Unknown Jev metrics profile/)
})

test('completed-work completeness trimming is independent for each system and metric', () => {
  const rows = Array.from({ length: 5 }, (_, index) => ['harvey', 'broad'].map(mode => ({
    taskId: `task-${index + 1}`, mode, status: 'graded', scores: {
      quality: [1, 0.3, 0.5, 0.1, 0.8][index], accuracy: 1, passProbability: 1, unresolved: false,
      completeness: (mode === 'harvey' ? [0, 0.4, 0.6, 0.8, 1] : [0.6, 0, 1, 0.4, 0.8])[index],
    },
  }))).flat()
  const result = aggregateJev(rows, { metricsProfile })
  assert.deepEqual(result.summaries.harvey.completeness.retained, ['task-2', 'task-3', 'task-4'])
  assert.deepEqual(result.summaries.broad.completeness.retained, ['task-4', 'task-1', 'task-5'])
  assert.deepEqual(result.summaries.harvey.quality.retained, ['task-2', 'task-3', 'task-5'])
  assert.equal(aggregateJev(rows).summaries.harvey.completeness, undefined)
})
