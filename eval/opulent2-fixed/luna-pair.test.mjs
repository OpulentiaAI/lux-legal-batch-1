import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import './offline-guard.mjs'
import { LUNA_EXPERIMENT } from '../../runtime/opulent2-luna-policy.mjs'
import { runExperiment, seedCheckpoint } from './runner.mjs'
import { LAUNCH, digest, immutable, privateDirectory } from './io.mjs'

function fixture(t) {
  privateDirectory(LAUNCH)
  const directory = mkdtempSync(join(LAUNCH, 'luna-pair-offline-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const release = { experiment: LUNA_EXPERIMENT, stage: 'comparison', tasks: [1, 2].map(n => ({ id: `offline-task-${n}`, publicFingerprint: 'public-fixture', rubricSha256: `rubric-fixture-${n}` })) }
  const checkpoint = seedCheckpoint({ release })
  const calls = []
  const execute = arm => async context => {
    calls.push([arm, context.taskId])
    const snapshot = { sha256: `snapshot-${context.taskId}`, parentSha256: context.previousSnapshot?.sha256 ?? null }
    return { validation: { executionValid: true, cleanup: { allOwnedAbsent: true } },
      inputSnapshotSha256: context.previousSnapshot?.sha256 ?? null,
      snapshot: arm === 'opulent2' ? snapshot : null,
      handoff: arm === 'opulent2' ? { contentSha256: snapshot.sha256 } : null,
      receipt: { synthetic: true } }
  }
  const run = overrides => runExperiment({ checkpoint, executeOpulent2: execute('opulent2'), executeHarvey: execute('harvey'), save() {}, assertUnchanged() {}, ...overrides })
  const grade = row => {
    const artifact = immutable(join(directory, `${row.taskId}-synthetic-judgments.json`), { note: 'Offline synthetic grade artifact; no live judgment or measured score.' })
    row.pairGrade = immutable(join(directory, `${row.taskId}-parent-fixture.json`), {
      version: 'opulent2-fixed-pair-grade-v1', issuer: 'parent', taskId: row.taskId,
      opulent2CompletedSha256: row.opulent2.completedSha256, harveyCompletedSha256: row.harvey.completedSha256,
      rubricSha256: release.tasks.find(task => task.id === row.taskId).rubricSha256,
      fullGradingCompleted: true, reference: 'Synthetic offline boundary test, not actual parent grading', artifacts: [artifact] })
  }
  return { checkpoint, calls, run, grade }
}

test('Luna executes only one pair and blocks the next until hash-bound independent grading', async t => {
  const f = fixture(t)
  await f.run()
  assert.equal(f.checkpoint.status, 'awaiting-independent-pair-grading')
  assert.deepEqual(f.calls, [['opulent2', 'offline-task-1'], ['harvey', 'offline-task-1']])
  await f.run()
  assert.equal(f.calls.length, 2)
  f.grade(f.checkpoint.rows[0])
  await f.run()
  assert.deepEqual(f.calls.slice(2), [['opulent2', 'offline-task-2'], ['harvey', 'offline-task-2']])
  assert.equal(f.checkpoint.rows[1].opulent2.completed.inputSnapshotSha256, 'snapshot-offline-task-1')
  assert.equal(f.checkpoint.status, 'awaiting-independent-pair-grading')
  f.grade(f.checkpoint.rows[1])
  await f.run()
  assert.equal(f.checkpoint.status, 'execution-completed')
  assert.equal(f.calls.length, 4)
})

test('recovering an unfinished counterpart retains the clean completed arm and stays on the pair', async t => {
  const f = fixture(t)
  await assert.rejects(f.run({ executeHarvey: async () => { throw new Error('Synthetic offline unfinished arm') } }), AggregateError)
  assert.equal(f.checkpoint.rows[0].opulent2.status, 'completed')
  assert.equal(f.checkpoint.rows[0].harvey.status, 'failed')
  await f.run()
  assert.deepEqual(f.calls, [['opulent2', 'offline-task-1'], ['harvey', 'offline-task-1']])
  assert.equal(f.checkpoint.rows[0].opulent2.attempts.length, 1)
  assert.equal(f.checkpoint.rows[0].harvey.attempts.length, 2)
  assert.equal(f.checkpoint.rows[1].opulent2.status, 'planned')
})

test('tampered completed output or grading receipt cannot unlock a later task', async t => {
  const f = fixture(t)
  await f.run()
  f.grade(f.checkpoint.rows[0])
  f.checkpoint.rows[0].opulent2.completed.snapshot.sha256 = 'tampered-state'
  await assert.rejects(f.run(), assert.AssertionError)
  assert.equal(f.calls.length, 2)
})
